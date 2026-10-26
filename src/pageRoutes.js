'use strict';
/**
 * 御社専用ページ(公開・ログイン不要)
 *   GET  /r/:token            専用ページ(閲覧を記録)
 *   POST /r/:token/request    「詳しい簡易レポートを希望する」
 *   GET  /r/:token/thanks     申込完了
 *   POST /r/:token/seen       画面の操作が届いた印(スクロール・タップ。メールの自動巡回との見分け)
 *   GET  /r/:token/optout     「今後の案内は不要」の確認
 *   POST /r/:token/optout     配信不要を記録
 * トークンは英数字10文字だけ受け付け、それ以外・存在しないものは404。検索に載せない(noindex)・第三者のスクリプトなし。
 */
const crypto = require('crypto');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const C = require('./pageCore');
const P = require('./pages');
const { jstDateJa } = require('./outreach');

const VIEWS = path.join(__dirname, '..', 'views', 'page');
// 申込の入力上限
const LIM = { name: 100, email: 255, phone: 20, message: 500 };
const EMAIL_RE = /^[^\s@<>"',;:()\[\]\\]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
// 指摘(finding_key)に対応する診断項目。ページの「その他の確認項目」から主な指摘を除くのに使う
const FINDING_TO_CHECK = { no_https: 'https_redirect', mixed: 'mixed', https_redirect: 'https_redirect', cert_expired: 'cert', cert_soon: 'cert', js_libs: 'js_libs', cms: 'cms', headers: 'headers', tls_version: 'tls_version' };
const STATUS_ORDER = { bad: 0, warn: 1 };

/** 軽いレート制限(IP単位・メモリ上)。windowMs の間に max 回まで */
function limiter(windowMs, max) {
  const hits = new Map();
  return (key, nowMs = Date.now()) => {
    const arr = (hits.get(key) || []).filter((t) => nowMs - t < windowMs);
    arr.push(nowMs);
    hits.set(key, arr);
    if (hits.size > 5000) { for (const [k, v] of hits) if (!v.some((t) => nowMs - t < windowMs)) hits.delete(k); }
    return arr.length > max;
  };
}

/** 申込フォームの検査。戻り: { ok, values, errors:{項目:文言} } */
function validateLead(body) {
  const b = body || {};
  const str = (v, n, nfkc = false) => [...(nfkc ? String(v === undefined || v === null ? '' : v).normalize('NFKC') : String(v === undefined || v === null ? '' : v)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()].slice(0, n).join('');
  const values = { name: str(b.name, LIM.name), email: str(b.email, LIM.email, true), phone: str(b.phone, LIM.phone, true), message: str(b.message, LIM.message) };
  const errors = {};
  if (!values.name) errors.name = 'ご担当者名をご入力ください。';
  if (!values.email) errors.email = 'メールアドレスをご入力ください。';
  else if (!EMAIL_RE.test(values.email)) errors.email = 'メールアドレスの形式をご確認ください。';
  if (values.phone) {
    const digits = values.phone.replace(/[^0-9]/g, '');
    if (!/^[0-9+()\-\s]+$/.test(values.phone) || digits.length < 9 || digits.length > 11) errors.phone = '電話番号の形式をご確認ください(ご入力は任意です)。';
  }
  return { ok: !Object.keys(errors).length, values, errors };
}

/** ページの表示用データ。確認をおすすめする項目(要確認・要対応を同じ言い方で)と、問題が見つからなかった件数 */
function viewModel(page, { env = process.env } = {}) {
  const items = P.parseFindings(page.findings_json);
  const mainCheck = FINDING_TO_CHECK[page.finding_key] || '';
  const recommended = items.filter((x) => x.status === 'warn' || x.status === 'bad').sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  return {
    company: page.company_name, domain: page.domain, dateJa: jstDateJa(page.created_at ? new Date(page.created_at) : new Date()),
    sentence: page.finding_sentence || '',
    variant: C.variantOf(page.token, env),
    main: items.find((x) => x.key === mainCheck && x.status !== 'ok') || null,
    others: recommended.filter((x) => x.key !== mainCheck),
    okCount: items.filter((x) => x.status === 'ok').length,
    hasItems: items.length > 0,
    optedOut: !!page.opt_out_at,
    requested: !!page.lead_at,
    token: page.token,
  };
}

function senderInfo(templates) {
  try {
    const c = (templates || require('./outreach').loadTemplates()).config || {};
    return { company: c['差出人会社'] || '', name: c['担当者名'] || '', tel: c['電話'] || '', mail: c['返信先メールアドレス'] || '' };
  } catch { return { company: '', name: '', tel: '', mail: '' }; }
}

/**
 * app に /r/ 以下を登録する。
 * deps: { store(createPageStore), secret, notify(info), now, sender, serviceName, operatorName, getIp(req), env, limits }
 */
function registerPages(app, deps = {}) {
  const env = deps.env || process.env;
  const secret = deps.secret || env.WEBDOCK_SECRET || 'dev-insecure-secret-change-me';
  if (!deps.secret && !env.WEBDOCK_SECRET) console.warn('[pages] WEBDOCK_SECRET が未設定です。必ず設定してください。');
  const store = deps.store;
  const now = deps.now || (() => Date.now());
  const sender = deps.sender || senderInfo();
  const notify = deps.notify || (async () => {});
  const getIp = deps.getIp || ((req) => String(req.ip || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/i, ''));
  const base = { SERVICE_NAME: deps.serviceName || env.SERVICE_NAME || 'WEBドック', OPERATOR_NAME: deps.operatorName || env.OPERATOR_NAME || '株式会社エストック', sender };
  const lim = deps.limits || {};
  const getLimit = limiter(lim.getWindowMs || 10 * 60 * 1000, lim.getMax || 90);
  const postLimit = limiter(lim.postWindowMs || 60 * 60 * 1000, lim.postMax || 20);
  const seenLimit = limiter(lim.seenWindowMs || 10 * 60 * 1000, lim.seenMax || 60);
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '16kb' }));

  // すべてのページ: 検索に載せない・保存しない・外部読み込みを許さない
  router.use((req, res, next) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.locals.nonce = nonce;
    res.set({
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; style-src 'self'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    });
    next();
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const render = (res, view, data, status = 200) => ejs.renderFile(path.join(VIEWS, view + '.ejs'), { ...base, nonce: res.locals.nonce, ...data })
    .then((html) => res.status(status).type('html').send(html));
  const notFound = (res) => render(res, 'notfound', { pageTitle: 'ページが見つかりません' }, 404);

  /** トークンを検査してページを引く。不正・存在しない・レート超過は応答を返して null */
  async function load(req, res, limit) {
    const token = req.params.token;
    const ip = getIp(req);
    if (limit(ip, now())) { res.status(429).type('text/plain').send('アクセスが集中しています。しばらくしてからお試しください。'); return null; }
    if (!C.isToken(token)) { await notFound(res); return null; }
    const page = await store.get(token);
    if (!page) { await notFound(res); return null; }
    return page;
  }

  const pageData = (page, extra = {}) => ({
    pageTitle: `${page.company_name} 御中 | 御社サイトの確認結果`,
    ...viewModel(page, { env }),
    reqToken: C.makeFormToken(secret, 'request', page.token, now()),
    form: { name: '', email: '', phone: '', message: '' }, errors: {}, error: null, viewToken: C.makeViewToken(secret, page.token, 0),
    ...extra,
  });

  router.get('/:token', wrap(async (req, res) => {
    const page = await load(req, res, getLimit);
    if (!page) return;
    const uaClass = C.classifyUa(req.headers['user-agent'], req.method);
    if (req.method === 'HEAD') { await store.recordView(page, { uaClass }); return res.status(200).type('html').end(); }
    const r = await store.recordView(page, { uaClass, ip: getIp(req), ua: req.headers['user-agent'], referer: req.headers.referer, variant: C.variantOf(page.token, env) });
    return render(res, 'show', pageData(page, { viewToken: C.makeViewToken(secret, page.token, r.viewId) }));
  }));

  router.post('/:token/request', wrap(async (req, res) => {
    const page = await load(req, res, postLimit);
    if (!page) return;
    const body = req.body || {};
    const vtIn = C.verifyViewToken(secret, page.token, body.vt) !== null ? body.vt : undefined;
    const redo = (error, extra = {}, status = 400) => render(res, 'show', pageData(page, { error, ...(vtIn ? { viewToken: vtIn } : {}), ...extra }), status);
    // ぼっと対策: 見えない欄に入力があれば、成功したように見せて何もしない
    if (String(body.website || '').trim() !== '') return res.redirect(303, `/r/${page.token}/thanks`);
    const ft = C.verifyFormToken(secret, 'request', page.token, body.ft, now());
    if (!ft.ok) {
      return redo(ft.reason === 'expired' ? 'ページを開いてから時間が経ちました。お手数ですが、もう一度ご入力のうえ送信してください。' : '確認用の情報が正しくありません。ページを開き直してください。',
        { form: validateLead(body).values });
    }
    const v = validateLead(body);
    if (!v.ok) return redo('入力内容をご確認ください。', { form: v.values, errors: v.errors });
    const viewId = C.verifyViewToken(secret, page.token, body.vt) || 0;
    const ip = getIp(req);
    const r = await store.submitLead(page, v.values, { ip, ua: req.headers['user-agent'], viewId, variant: C.variantOf(page.token, env) });
    if (!r.duplicate) {
      try {
        await notify({ company: page.company_name, domain: page.domain, ...v.values, pageUrl: C.pageUrl(page.token, env), stocStoreId: page.stoc_store_id, batchCode: page.stoc_batch_code, stocOk: r.stoc, stocError: r.error });
      } catch (e) { console.error('[pages] 通知に失敗:', e.message); }
    }
    return res.redirect(303, `/r/${page.token}/thanks`);
  }));

  router.get('/:token/thanks', wrap(async (req, res) => {
    const page = await load(req, res, getLimit);
    if (!page) return;
    return render(res, 'thanks', { pageTitle: 'お申し込みを受け付けました', company: page.company_name, token: page.token });
  }));

  router.post('/:token/seen', wrap(async (req, res) => {
    const page = await load(req, res, seenLimit);
    if (!page) return;
    const viewId = C.verifyViewToken(secret, page.token, (req.body || {}).vt);
    if (viewId === null) return res.status(400).end();
    const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
    await store.recordActivity(page, viewId, { scroll: n(req.body.s), seconds: n(req.body.d) });
    return res.status(204).end();
  }));

  router.get('/:token/optout', wrap(async (req, res) => {
    const page = await load(req, res, getLimit);
    if (!page) return;
    return render(res, 'optout', { pageTitle: '今後のご案内の停止', company: page.company_name, domain: page.domain, token: page.token, optedOut: !!page.opt_out_at,
      optToken: C.makeFormToken(secret, 'optout', page.token, now()), error: null });
  }));
  router.post('/:token/optout', wrap(async (req, res) => {
    const page = await load(req, res, postLimit);
    if (!page) return;
    const ft = C.verifyFormToken(secret, 'optout', page.token, (req.body || {}).ft, now());
    if (!ft.ok) {
      return render(res, 'optout', { pageTitle: '今後のご案内の停止', company: page.company_name, domain: page.domain, token: page.token, optedOut: false,
        optToken: C.makeFormToken(secret, 'optout', page.token, now()), error: 'ページを開いてから時間が経ったか、確認用の情報が正しくありません。もう一度お試しください。' }, 400);
    }
    await store.optOut(page, { ip: getIp(req) });
    return render(res, 'optout_done', { pageTitle: '今後のご案内を停止しました', company: page.company_name, token: page.token });
  }));

  // /r/ 以下のそれ以外(形式の違うトークン・知らないパス)は404
  router.use((req, res) => notFound(res));
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    console.error('[pages] error:', err && err.message);
    if (res.headersSent) return res.end();
    res.status(500).type('text/plain').send('エラーが発生しました。しばらくしてからもう一度お試しください。');
  });

  app.use('/r', router);
  return { router };
}

module.exports = { registerPages, validateLead, viewModel, limiter, senderInfo, EMAIL_RE, LIM, FINDING_TO_CHECK };
