'use strict';

try { require('dotenv').config(); } catch { /* dotenv任意 */ }

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const { fetchHomepage, withHttpProbe } = require('./safeFetch');
const { runChecks } = require('./checks');
const db = require('./db');
const { verifyTurnstile } = require('./turnstile');
const { notifyLead } = require('./notify');
const { PREFECTURES, routeByPrefecture, COMPANY_INFO } = require('./regions');
const { registerAdminWarehouse } = require('./adminWarehouse');
const { groupItems, buildRequestText, BUCKETS, BUCKET_ORDER, statusLabel } = require('./reportBuckets');
const { loadTemplates, jstDateJa } = require('./outreach');

const PORT = Number(process.env.PORT || 3020);
const SERVICE_NAME = process.env.SERVICE_NAME || 'WEBドック';
const OPERATOR_NAME = process.env.OPERATOR_NAME || '株式会社エストック';
const SECRET = process.env.WEBDOCK_SECRET || 'dev-insecure-secret-change-me';
const SALES_PIN = process.env.SALES_PIN || 'stoc'; // 営業・商談版の合言葉。本番は必ず変更

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.set('trust proxy', 'loopback'); // 同じ機械のnginxだけを信用(外から直接つないだ相手のX-Forwarded-Forは無視)
app.locals.SERVICE_NAME = SERVICE_NAME;
app.locals.OPERATOR_NAME = OPERATOR_NAME;
app.locals.TURNSTILE_SITEKEY = process.env.TURNSTILE_SITEKEY || '';

// ---- 簡易レート制限(IP単位)----
const rl = new Map(); // ip -> [timestamps]
const RL_WINDOW = 60 * 60 * 1000;
const RL_MAX = 10;
function rateLimited(ip) {
  const now = Date.now();
  const arr = (rl.get(ip) || []).filter((t) => now - t < RL_WINDOW);
  arr.push(now);
  rl.set(ip, arr);
  return arr.length > RL_MAX;
}

// ---- 同一ドメイン10分キャッシュ ----
const scanCache = new Map(); // domain -> { id, at }
const CACHE_TTL = 10 * 60 * 1000;

function karteToken(scanId) {
  return crypto.createHmac('sha256', SECRET).update('karte:' + scanId).digest('hex').slice(0, 24);
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
}
function domainOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// ---- 営業・商談版(/sales)の合言葉認証 ----
const SALES_COOKIE = crypto.createHmac('sha256', SECRET).update('sales-auth:' + SALES_PIN).digest('hex').slice(0, 32);
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function salesAuthed(req) {
  return parseCookies(req).sales_auth === SALES_COOKIE;
}
// 重要度の高い順に並べる(要精密検査→要注意→判定不可→異常なし)
const SEVERITY = { bad: 0, warn: 1, unknown: 2, ok: 3 };
function sortBySeverity(results) {
  return [...results].sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status]);
}

app.get('/', (req, res) => res.render('index', { error: null }));
app.get('/about', (req, res) => res.render('about'));

app.post('/scan', async (req, res) => {
  const ip = clientIp(req);
  let input = (req.body.url || '').trim();
  if (input && !/^https?:\/\//i.test(input)) input = 'https://' + input;

  const token = req.body['cf-turnstile-response'];
  const okHuman = await verifyTurnstile(token, ip);
  if (!okHuman) return res.status(400).render('index', { error: '認証に失敗しました。もう一度お試しください。' });

  if (rateLimited(ip)) return res.status(429).render('index', { error: '短時間に診断が集中しています。しばらく待ってからお試しください。' });

  const domain = domainOf(input);
  const cached = domain && scanCache.get(domain);
  if (cached && Date.now() - cached.at < CACHE_TTL) {
    return res.redirect('/result/' + cached.id);
  }

  try {
    const page = await withHttpProbe(await fetchHomepage(input));
    const { results, counts, score, grade } = await runChecks(page);
    const id = await db.saveScan({ domain, url: page.finalUrl, score, grade, result: { results, counts, score, grade, finalUrl: page.finalUrl }, ip });
    if (domain) scanCache.set(domain, { id, at: Date.now() });
    res.redirect('/result/' + id);
  } catch (e) {
    const msg = e && e.userSafe ? e.message : '診断中にエラーが発生しました。URLをご確認のうえ、もう一度お試しください。';
    res.status(400).render('index', { error: msg });
  }
});

app.get('/result/:id', async (req, res) => {
  const scan = await db.getScan(req.params.id);
  if (!scan) return res.status(404).render('index', { error: '診断結果が見つかりませんでした。' });
  res.render('result', { scan, token: karteToken(scan.id), prefectures: PREFECTURES });
});

app.post('/lead', async (req, res) => {
  const ip = clientIp(req);
  const { scan_id, company, contact_name, email, phone, prefecture } = req.body;
  if (!company || !contact_name || !email || !phone || !prefecture) {
    const scan = await db.getScan(scan_id);
    return res.status(400).render('result', { scan, token: karteToken(scan_id), prefectures: PREFECTURES, leadError: 'すべての項目をご入力ください。' });
  }
  const scan = await db.getScan(scan_id);
  const domain = scan ? scan.domain : null;
  const { company: assignedCompany } = routeByPrefecture(prefecture);
  let leadId = null;
  try {
    leadId = await db.saveLead({ scan_id, company, contact_name, email, phone, prefecture, assigned_company: assignedCompany, domain, ip });
    await notifyLead({ leadId, company, contact_name, email, phone, prefecture, assignedCompany, domain, scanId: scan_id, score: scan && scan.score, grade: scan && scan.grade });
  } catch (e) {
    // 保存失敗でもカルテは見せる(機会損失を避ける)。通知失敗はログのみ。
    console.error('lead save/notify error:', e.message);
  }
  res.redirect(`/karte/${scan_id}?t=${karteToken(scan_id)}&c=${assignedCompany}`);
});

app.get('/karte/:id', async (req, res) => {
  if (req.query.t !== karteToken(req.params.id)) {
    return res.status(403).render('index', { error: '詳しい結果をご覧いただくには、フォームからお申し込みください。' });
  }
  const scan = await db.getScan(req.params.id);
  if (!scan) return res.status(404).render('index', { error: '診断結果が見つかりませんでした。' });
  const company = COMPANY_INFO[req.query.c] ? req.query.c : null;
  res.render('karte', { scan, company, companyInfo: company ? COMPANY_INFO[company] : null });
});

// ===== 営業・商談版 =====

// 入口(未認証ならPIN入力、認証済みならURL入力画面)
app.get('/sales', (req, res) => {
  if (!salesAuthed(req)) return res.render('sales_login', { error: null });
  res.render('sales', { error: null });
});

// 合言葉の照合
app.post('/sales/login', (req, res) => {
  const pin = (req.body.pin || '').trim();
  if (pin !== SALES_PIN) {
    return res.status(401).render('sales_login', { error: '合言葉が違います。' });
  }
  // 署名付きクッキーを発行(12時間)
  res.setHeader('Set-Cookie', `sales_auth=${SALES_COOKIE}; HttpOnly; SameSite=Lax; Max-Age=43200; Path=/sales`);
  res.redirect('/sales');
});

app.get('/sales/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'sales_auth=; HttpOnly; Max-Age=0; Path=/sales');
  res.redirect('/sales');
});

// その場診断 → フォームなしで即フルカルテ
app.post('/sales/scan', async (req, res) => {
  if (!salesAuthed(req)) return res.status(401).render('sales_login', { error: 'もう一度ログインしてください。' });
  const ip = clientIp(req);
  let input = (req.body.url || '').trim();
  if (input && !/^https?:\/\//i.test(input)) input = 'https://' + input;
  try {
    const page = await withHttpProbe(await fetchHomepage(input));
    const { results, counts, score, grade } = await runChecks(page);
    const scan = {
      domain: domainOf(input), url: page.finalUrl,
      score, grade, result: { results, counts, score, grade, finalUrl: page.finalUrl },
    };
    // 記録は残す(営業現地診断)。失敗しても画面は出す。
    try { await db.saveScan({ ...scan, source: 'sales', ip }); } catch (e) { console.error('sales saveScan:', e.message); }
    res.render('sales_result', { scan, items: sortBySeverity(results), companyInfo: COMPANY_INFO, inputUrl: input });
  } catch (e) {
    const msg = e && e.userSafe ? e.message : '診断中にエラーが発生しました。URLをご確認ください。';
    res.status(400).render('sales', { error: msg });
  }
});

// ---- お客様用 簡易レポート(印刷・PDF保存用)----
const reportCache = new Map(); // 正規化URL -> { at, scan }
const REPORT_TTL = 30 * 60 * 1000;
function reportKey(input) {
  try { const u = new URL(input); return u.protocol + '//' + u.host.toLowerCase() + u.pathname; } catch { return input; }
}
function reportSender() {
  try {
    const c = loadTemplates().config || {};
    return { company: c['差出人会社'] || '', name: c['担当者名'] || '', tel: c['電話'] || '', mail: c['返信先メールアドレス'] || '' };
  } catch { return { company: '', name: '', tel: '', mail: '' }; }
}
// 担当者名は「森澤 梓」→ 苗字だけ(フッター用)
function surnameOf(name) { return String(name || '').trim().split(/\s+/)[0]; }

app.get('/sales/report', async (req, res) => {
  if (!salesAuthed(req)) return res.status(401).render('sales_login', { error: 'もう一度ログインしてください。' });
  let input = String(req.query.url || '').trim();
  if (input && !/^https?:\/\//i.test(input)) input = 'https://' + input;
  if (!input) return res.status(400).render('sales', { error: 'URLを入力してください。' });
  try {
    const key = reportKey(input);
    let hit = reportCache.get(key);
    if (!hit || Date.now() - hit.at > REPORT_TTL) {
      const page = await withHttpProbe(await fetchHomepage(input)); // SSRF対策済みの取得
      const { results, counts, score, grade } = await runChecks(page);
      hit = { at: Date.now(), scan: { domain: domainOf(input), url: page.finalUrl, results, counts, score, grade, scannedAt: new Date() } };
      reportCache.set(key, hit);
      if (reportCache.size > 200) { for (const [k, v] of reportCache) if (Date.now() - v.at > REPORT_TTL) reportCache.delete(k); }
    }
    const company = String(req.query.company || '').trim().slice(0, 100);
    res.render('report', reportViewModel(hit.scan, company, input));
  } catch (e) {
    const msg = e && e.userSafe ? e.message : '診断中にエラーが発生しました。URLをご確認ください。';
    res.status(400).render('sales', { error: msg });
  }
});

function reportViewModel(scan, company, input) {
  const g = groupItems(scan.results);
  const siteItems = [...g.urgent, ...g.partial, ...g.renewal];
  const sender = reportSender();
  return {
    scan, company, input, g, BUCKETS, BUCKET_ORDER, statusLabel, sender, surname: surnameOf(sender.name),
    dateJa: jstDateJa(scan.scannedAt),
    siteRequest: buildRequestText(siteItems, 'site', company ? company + ' 御中' : ''),
    dnsRequest: buildRequestText(g.dns, 'dns', company ? company + ' 御中' : ''),
  };
}

// 倉庫の管理画面(WAREHOUSE_ADMIN_PASS と ADMIN_ALLOW_IPS の両方が設定されたときだけ有効。未設定なら /admin は404)
registerAdminWarehouse(app);

app.get('/healthz', (req, res) => res.json({ ok: true }));

db.init().then(() => {
  app.listen(PORT, () => console.log(`${SERVICE_NAME} listening on :${PORT} (mysql=${db.usingMysql()})`));
}).catch((e) => { console.error('DB init failed:', e); process.exit(1); });
