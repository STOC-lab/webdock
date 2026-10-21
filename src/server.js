'use strict';

try { require('dotenv').config(); } catch { /* dotenv任意 */ }

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const { fetchHomepage } = require('./safeFetch');
const { runChecks } = require('./checks');
const db = require('./db');
const { verifyTurnstile } = require('./turnstile');
const { notifyLead } = require('./notify');
const { PREFECTURES, routeByPrefecture, COMPANY_INFO } = require('./regions');

const PORT = Number(process.env.PORT || 3020);
const SERVICE_NAME = process.env.SERVICE_NAME || 'WEBドック';
const OPERATOR_NAME = process.env.OPERATOR_NAME || '株式会社エストック';
const SECRET = process.env.WEBDOCK_SECRET || 'dev-insecure-secret-change-me';

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.set('trust proxy', true);
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
    const page = await fetchHomepage(input);
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

app.get('/healthz', (req, res) => res.json({ ok: true }));

db.init().then(() => {
  app.listen(PORT, () => console.log(`${SERVICE_NAME} listening on :${PORT} (mysql=${db.usingMysql()})`));
}).catch((e) => { console.error('DB init failed:', e); process.exit(1); });
