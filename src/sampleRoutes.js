'use strict';
/**
 * 見本ページ(公開・ログイン不要だが、検索に載せない・一覧を作らない)
 *   GET /s/:code          見本ページ(5桁の数字のみ。開かれた回数を記録。ボットは数えない)
 *   GET /s/img/:group/:slot  見本で使う写真(管理画面からアップロードしたもの)
 * 存在しない・削除済み(status=deleted)・形式の違うコードは404。店の最新データ(shops)をその場で読んで描画する。
 */
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const C = require('./pageCore');
const SP = require('./samplePages');
const Photos = require('./samplePhotos');
const Cat = require('./sampleCategories');
const { limiter } = require('./pageRoutes');

const VIEW = path.join(__dirname, '..', 'views', 'sample', 'lp.ejs');

/** 線画アイコン(参照実装 make_lp2.py の ico と同じ) */
const ICONS = {
  pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  heart: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>',
  pulse: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  heartpulse: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/><path d="M3.2 12H9l.5-1 2 4.5 2-7 1.5 3.5h5.3"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M12 11h4M12 16h4M8 11h.01M8 16h.01"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8"/>',
  train: '<rect x="4" y="3" width="16" height="16" rx="2"/><path d="M4 11h16M12 3v8M8 19l-2 3M18 22l-2-3M8 15h.01M16 15h.01"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3Z"/><circle cx="12" cy="13" r="3"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
};
function ico(name, size = 22) {
  const p = ICONS[name] || '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 見本ページのHTMLを作る。業種が合わなければ null */
async function renderSample(page, shop, env = process.env) {
  const v = SP.buildView(page, shop);
  if (!v) return null;
  const p = Photos.urlsFor(v.groupId, env);
  // 特徴カードの丸写真: 専用の写真が無ければ基本の3枚で代用する(参照実装と同じ)。施術案内カードは無ければアイコン表示
  p.f_explain = p.f_explain || p.hero;
  p.f_counsel = p.f_counsel || p.reception;
  p.f_room = p.f_room || p.room;
  return ejs.renderFile(VIEW, { v, photos: p, ico, esc });
}

/** app に /s/ 以下を登録する。deps: { store, env, getIp(req), limits } */
function registerSamples(app, deps = {}) {
  const env = deps.env || process.env;
  const store = deps.store;
  const getIp = deps.getIp || ((req) => String(req.ip || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/i, ''));
  const getLimit = limiter((deps.limits || {}).windowMs || 10 * 60 * 1000, (deps.limits || {}).max || 90);
  const router = express.Router();

  // すべて: 検索に載せない・保存しない。フォント(Google Fonts)と地図の埋め込み(Googleマップ)だけ外部を許す
  router.use((req, res, next) => {
    res.set({
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-src https://www.google.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    next();
  });
  const notFound = (res) => res.status(404).type('text/plain').send('Not Found');
  const limited = (req, res) => {
    if (getLimit(getIp(req), Date.now())) { res.status(429).type('text/plain').send('アクセスが集中しています。しばらくしてからお試しください。'); return true; }
    return false;
  };

  router.get('/img/:group/:slot', (req, res) => {
    const f = Cat.groupById(req.params.group) && Photos.find(req.params.group, req.params.slot, env);
    if (!f) return notFound(res);
    res.set({ 'Content-Type': f.type, 'Cache-Control': 'private, max-age=300' });
    res.sendFile(f.file, { dotfiles: 'allow' }, (err) => { if (err && !res.headersSent) notFound(res); });
  });

  router.get('/:code', async (req, res) => {
    try {
      if (limited(req, res)) return;
      if (!SP.CODE_RE.test(req.params.code)) return notFound(res);
      const hit = await store.getByCode(req.params.code);
      if (!hit || hit.page.status === 'deleted') return notFound(res);
      const html = await renderSample(hit.page, hit.shop, env);
      if (html === null) return notFound(res);
      // 開かれた記録(ボット・HEADは数えない)。記録に失敗しても見本は出す
      if (C.classifyUa(req.headers['user-agent'], req.method) === 'human') {
        try { await store.recordOpen(hit.page.id); } catch (e) { console.error('[sample] 開封の記録に失敗:', e && e.message); }
      }
      res.status(200).type('html').send(html);
    } catch (e) {
      console.error('[sample] error:', e && e.message);
      if (!res.headersSent) res.status(500).type('text/plain').send('エラーが発生しました。しばらくしてからもう一度お試しください。');
    }
  });

  router.use((req, res) => notFound(res));
  app.use('/s', router);
  return { router };
}

module.exports = { registerSamples, renderSample, ico, esc };
