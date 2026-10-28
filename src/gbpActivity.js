'use strict';
/**
 * GBP(Googleビジネスプロフィール)の「更新日」を、Googleマップの店舗画面から読む。
 *  - オーナー返信・最新情報(投稿)・口コミ の「3 週間前」のような相対表記を、概算の日付にする
 *  - Playwright(任意の追加部品)で1件ずつ開く。ボット検知の回避はしない。確認画面が出たらその実行では中止する
 *
 * 画面の文言は変わりやすいので、探すキーワードは下の配列にまとめてあります(外れたら足してください)。
 * 実画面の確認には cli/gbp-debug.js を使います。
 */
const fs = require('fs');
const path = require('path');
const { toJstDate, daysAgo } = require('./freshness');

/* ---------- キーワード(実画面で外れたらここに足す) ---------- */

const OWNER_REPLY_KEYWORDS = ['オーナーからの返信', 'オーナーの返信', 'オーナーによる返信', '店舗からの返信', 'Response from the owner'];
const POST_HEADINGS = ['オーナーからの最新情報', '最新情報', 'アップデート', '最新の情報', 'Updates from', 'From the owner'];
const REVIEW_HEADINGS = ['クチコミ', '口コミ', 'レビュー', 'Reviews'];
// 最新情報の欄が終わる目印(見出しのあとにこれが出たら、そこまでを最新情報の範囲とする)
const POST_SECTION_STOPS = [...REVIEW_HEADINGS, '基本情報', 'よくある質問', '関連する検索', '写真と動画', 'Q&A'];
const REPLY_WINDOW = 40;   // 「オーナーからの返信」のあと、何文字以内の相対時刻を返信の時刻とみなすか
const POST_WINDOW = 400;   // 「最新情報」の見出しのあと、何文字までを最新情報の範囲とするか
const POST_TAB_NAMES = /最新情報|アップデート|Updates/;
const REVIEW_TAB_NAMES = /クチコミ|口コミ|レビュー|Reviews/;
const SORT_BUTTON_NAMES = /並べ替え|Sort/;
const SORT_NEWEST_NAMES = /新しい順|最新|Newest/;
const CONSENT_REJECT_NAMES = /すべて拒否|Reject all/;
// 確認画面(ボット検知など)の目印
const BLOCK_URL_PARTS = ['/sorry/', '/sorry?', 'google.com/sorry'];
const BLOCK_TEXTS = ['通常と異なるトラフィック', '通常とは異なるトラフィック', 'reCAPTCHA', '私はロボットではありません', 'unusual traffic', 'not a robot'];

const DEFAULT_TIMEOUT_MS = 40000;
const MISSING_PLAYWRIGHT = 'Playwrightが未導入のためGBPは調べていません(npm i playwright && npx playwright install --with-deps chromium)';
const BLOCKED_STOPPED = 'Googleの確認画面が出たため中止';

/* ---------- URL ---------- */

/** 倉庫の行 → 開くGoogleマップのURL。cid → place_id → gmap_url(Googleのマップだけ)の順。無ければ '' */
function gbpUrlOf(row) {
  const r = row || {};
  const cid = String(r.cid === undefined || r.cid === null ? '' : r.cid).trim();
  if (/^\d{5,25}$/.test(cid)) return `https://www.google.com/maps?cid=${cid}&hl=ja`;
  const pid = String(r.placeId || r.place_id || '').trim();
  if (/^[A-Za-z0-9_-]{10,200}$/.test(pid)) return `https://www.google.com/maps/place/?q=place_id:${pid}&hl=ja`;
  const g = String(r.gmapUrl || r.gmap_url || '').trim();
  if (g) {
    try {
      const u = new URL(g);
      const host = u.hostname.toLowerCase();
      const isGoogle = /(^|\.)google\.(com|co\.jp|[a-z]{2,3})$/.test(host);
      if ((u.protocol === 'https:' || u.protocol === 'http:') && isGoogle && (host.startsWith('maps.') || u.pathname.startsWith('/maps'))) return g;
    } catch { /* URLでなければ使わない */ }
  }
  return '';
}

/* ---------- 相対表記(「3 週間前」など)の読み取り ---------- */

const halfWidth = (s) => String(s || '')
  .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/[  　]/g, ' ');

const REL_SOURCE = '(たった今|昨日|先週|先月|昨年|去年|(\\d+)\\s*(分|時間|日|週間|か月|ヶ月|カ月|ケ月|ヵ月|箇月|年)\\s*前)';
const DAY = 86400e3;

function fromMatch(m, now) {
  const word = m[1];
  const n = m[2] === undefined ? 0 : Number(m[2]);
  const unit = m[3] || '';
  let approxDays, precision, raw, at = null;
  if (word === 'たった今') { approxDays = 0; precision = 'day'; raw = word; }
  else if (word === '昨日') { approxDays = 1; precision = 'day'; raw = word; }
  else if (word === '先週') { approxDays = 7; precision = 'week'; raw = word; }
  else if (word === '先月') { approxDays = 30; precision = 'month'; raw = word; }
  else if (word === '昨年' || word === '去年') { approxDays = 365; precision = 'year'; raw = word; }
  else {
    raw = `${n} ${unit}前`;
    if (unit === '分') { at = new Date(now.getTime() - n * 60e3); precision = 'day'; }
    else if (unit === '時間') { at = new Date(now.getTime() - n * 3600e3); precision = 'day'; }
    else if (unit === '日') { approxDays = n; precision = 'day'; }
    else if (unit === '週間') { approxDays = n * 7; precision = 'week'; }
    else if (unit === '年') { approxDays = n * 365; precision = 'year'; }
    else { approxDays = n * 30; precision = 'month'; } // か月 など
  }
  if (at) approxDays = Math.max(0, daysAgo(at, now));
  const base = new Date(now.getTime() - approxDays * DAY);
  const date = new Date(toJstDate(base) + 'T00:00:00+09:00');
  return { date, raw, approxDays, precision };
}

/** 「3 週間前」「昨日」などを概算の日付にする。分からなければ null。全角・空白の揺れに対応 */
function parseRelativeJa(text, now = new Date()) {
  const m = new RegExp(REL_SOURCE).exec(halfWidth(text));
  return m ? fromMatch(m, now) : null;
}

/** 本文の中の相対表記をすべて拾う。戻り: [{ index, end, ...parseRelativeJa の結果 }] */
function findRelatives(text, now) {
  const out = [];
  const re = new RegExp(REL_SOURCE, 'g');
  let m;
  while ((m = re.exec(text))) out.push({ index: m.index, end: m.index + m[0].length, ...fromMatch(m, now) });
  return out;
}

/* ---------- 画面の本文から「投稿・返信・口コミ」を取り出す ---------- */

const around = (text, a, b, w = 30) => text.slice(Math.max(0, a - w), Math.min(text.length, b + w)).replace(/\s*[\r\n]+\s*/g, ' / ');
const newest = (list) => list.reduce((best, x) => (!best || x.approxDays < best.approxDays || (x.approxDays === best.approxDays && x.index < best.index) ? x : best), null);
const strip = (x) => (x ? { date: x.date, raw: x.raw, approxDays: x.approxDays, precision: x.precision } : null);

function allIndexes(text, kw) {
  const out = [];
  let i = text.indexOf(kw);
  while (i >= 0) { out.push(i); i = text.indexOf(kw, i + kw.length); }
  return out;
}

/**
 * 店舗画面の本文(innerText) → { post, ownerReply, review, debug }
 *  ownerReply: 「オーナーからの返信」の直後(40文字以内)の相対時刻のうち最も新しいもの
 *  post: 「最新情報」などの見出しのあと、次の欄までにある相対時刻のうち最も新しいもの
 *  review: 口コミ欄の相対時刻(返信・最新情報の時刻は除く)のうち最も新しいもの
 */
function extractGbpActivity(panelText, now = new Date()) {
  const text = halfWidth(panelText);
  const rels = findRelatives(text, now);
  const used = new Set(); // 返信・最新情報として使った相対時刻(口コミからは除く)
  const found = { ownerReply: [], post: [], review: [] };

  // オーナー返信
  const replies = [];
  for (const kw of OWNER_REPLY_KEYWORDS) {
    for (const i of allIndexes(text, kw)) {
      const from = i + kw.length;
      const r = rels.find((x) => x.index >= from && x.index <= from + REPLY_WINDOW);
      if (r) { replies.push(r); found.ownerReply.push(kw); }
    }
  }
  replies.forEach((r) => used.add(r.index));

  // 最新情報(投稿)
  const posts = [];
  for (const kw of POST_HEADINGS) {
    for (const i of allIndexes(text, kw)) {
      const from = i + kw.length;
      let to = Math.min(text.length, from + POST_WINDOW);
      for (const stop of POST_SECTION_STOPS) {
        const s = text.indexOf(stop, from);
        if (s >= 0 && s < to) to = s;
      }
      const inside = rels.filter((x) => x.index >= from && x.end <= to && !used.has(x.index));
      if (inside.length) { posts.push(...inside); found.post.push(kw); }
    }
  }
  posts.forEach((r) => used.add(r.index));

  // 口コミ(見出しより後ろの、返信・最新情報ではない相対時刻)
  let reviewStart = -1;
  for (const kw of REVIEW_HEADINGS) {
    const i = text.indexOf(kw);
    if (i >= 0 && (reviewStart < 0 || i < reviewStart)) { reviewStart = i; }
    if (i >= 0) found.review.push(kw);
  }
  const reviews = reviewStart < 0 ? [] : rels.filter((x) => x.index >= reviewStart && !used.has(x.index));

  const pick = { ownerReply: newest(replies), post: newest(posts), review: newest(reviews) };
  const ctx = (x) => (x ? around(text, x.index, x.end) : '');
  return {
    post: strip(pick.post),
    ownerReply: strip(pick.ownerReply),
    review: strip(pick.review),
    debug: {
      headings: { ownerReply: [...new Set(found.ownerReply)], post: [...new Set(found.post)], review: [...new Set(found.review)] },
      candidates: { ownerReply: replies.length, post: posts.length, review: reviews.length },
      contexts: { post: ctx(pick.post), ownerReply: ctx(pick.ownerReply), review: ctx(pick.review) },
    },
  };
}

/** 確認画面(ボット検知・同意以外の確認)か。url と本文で判定 */
function isBlockedPage({ url = '', text = '' } = {}) {
  const u = String(url);
  if (BLOCK_URL_PARTS.some((p) => u.includes(p))) return true;
  const t = String(text);
  return BLOCK_TEXTS.some((k) => t.includes(k));
}

const isConsentUrl = (url) => { try { return new URL(url).hostname.toLowerCase() === 'consent.google.com'; } catch { return false; } };

/* ---------- ブラウザで読む ---------- */

// ブラウザの中で動く関数(名前は偽ページでのテストにも使う)
function readPanelTextInPage() {
  const mains = Array.prototype.slice.call(document.querySelectorAll('[role="main"]'));
  const m = mains.filter((e) => e.querySelector('h1'))[0] || mains[0] || document.body;
  return (m && m.innerText) || '';
}
function readBodyTextInPage() { return (document.body && document.body.innerText) || ''; }
function scrollPanelInPage() {
  const root = document.querySelector('[role="main"]') || document.body;
  const els = [root].concat(Array.prototype.slice.call(root.querySelectorAll('div')))
    .filter((e) => e.scrollHeight > e.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(e).overflowY));
  els.sort((a, b) => b.scrollHeight - a.scrollHeight);
  els.slice(0, 2).forEach((e) => { e.scrollTop = e.scrollTop + 1500; });
  return els.length;
}

const contexts = new WeakMap(); // ブラウザ -> 使い回す context

async function getContext(browser) {
  if (!contexts.has(browser)) {
    contexts.set(browser, await browser.newContext({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 900 } }));
  }
  return contexts.get(browser);
}

const wait = (page, ms) => page.waitForTimeout(ms);
/** 失敗しても続ける(画面の作りが変わっていても全体は止めない) */
async function soft(fn) { try { return await fn(); } catch { return undefined; } }

/** 役割と名前で探して、あれば押す。押したら true */
async function clickByRole(page, role, name, timeout = 3000) {
  const loc = page.getByRole(role, { name }).first();
  if (!(await loc.count())) return false;
  await loc.click({ timeout });
  return true;
}

async function readText(page) {
  const t = await page.evaluate(readPanelTextInPage);
  return String(t || '');
}

function safeName(row) {
  const base = String(row.cid || row.placeId || (row.store_id ? 'store' + row.store_id : '') || 'store');
  return base.replace(/[^\w.-]/g, '_').slice(0, 80) || 'store';
}

/**
 * 1店舗ぶんのGBPの動きを読む。page は1店舗ごとに新しく開いて閉じる。
 * 戻り: { url, ok, blocked, post, ownerReply, review, note, debug }
 */
async function fetchGbpActivity(row, { browser, now = new Date(), debugDir = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = gbpUrlOf(row);
  const result = { url, ok: false, blocked: false, post: null, ownerReply: null, review: null, note: '', debug: { finalUrl: '', tabs: [], headings: {}, contexts: {}, files: {}, textLength: 0 } };
  if (!url) { result.note = 'GoogleマップのURLがありません'; return result; }
  if (!browser) { result.note = MISSING_PLAYWRIGHT; return result; }

  let page = null;
  let timer = null;
  let timedOut = false;
  const work = (async () => {
    const ctx = await getContext(browser);
    page = await ctx.newPage();
    const dbg = result.debug;
    const saveDebug = async (text) => {
      if (!debugDir) return;
      fs.mkdirSync(debugDir, { recursive: true });
      const base = path.join(debugDir, safeName(row));
      await soft(() => page.screenshot({ path: base + '.png' }));
      fs.writeFileSync(base + '.txt', text || '');
      dbg.files = { png: base + '.png', txt: base + '.txt' };
    };
    const blockedNow = async () => {
      const text = await soft(() => page.evaluate(readBodyTextInPage));
      return isBlockedPage({ url: page.url(), text: text || '' });
    };

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // 同意画面(consent.google.com)なら「すべて拒否」を押す。押せなければ失敗
    if (isConsentUrl(page.url())) {
      const pressed = await soft(() => clickByRole(page, 'button', CONSENT_REJECT_NAMES, 5000));
      if (!pressed) { dbg.finalUrl = page.url(); await saveDebug(''); result.note = 'Googleの同意画面を通過できませんでした'; return; }
      await soft(() => page.waitForLoadState('domcontentloaded', { timeout: 15000 }));
      await wait(page, 1500);
    }
    dbg.finalUrl = page.url();
    if (await blockedNow()) {
      result.blocked = true; result.note = 'Googleの確認画面が出ました';
      dbg.finalUrl = page.url();
      await saveDebug('');
      return;
    }

    // 店舗パネル(見出し)が出るのを待つ
    const gotH1 = await soft(async () => { await page.waitForSelector('h1', { timeout: 15000 }); return true; });
    await wait(page, 1000);

    const parts = [];
    const first = await soft(() => readText(page));
    if (first) parts.push(first);

    // 「最新情報」のタブがあれば開く(無ければ概要の本文だけで見る)
    if (await soft(() => clickByRole(page, 'tab', POST_TAB_NAMES))) {
      dbg.tabs.push('最新情報');
      await wait(page, 1500);
      const t = await soft(() => readText(page));
      if (t) parts.push('\n----(最新情報タブ)----\n' + t);
    }

    // 「クチコミ」タブ → 並べ替え「新しい順」 → 少しスクロール
    if (await soft(() => clickByRole(page, 'tab', REVIEW_TAB_NAMES))) {
      dbg.tabs.push('クチコミ');
      await wait(page, 1500);
      if (await soft(() => clickByRole(page, 'button', SORT_BUTTON_NAMES))) {
        await wait(page, 600);
        const picked = (await soft(() => clickByRole(page, 'menuitemradio', SORT_NEWEST_NAMES)))
          || (await soft(() => clickByRole(page, 'menuitem', SORT_NEWEST_NAMES)));
        if (picked) { dbg.tabs.push('新しい順'); await wait(page, 1500); }
      }
      for (let i = 0; i < 2; i++) { await soft(() => page.evaluate(scrollPanelInPage)); await wait(page, 1000); }
      const t = await soft(() => readText(page));
      if (t) parts.push('\n----(クチコミタブ)----\n' + t);
    }

    dbg.finalUrl = page.url();
    if (await blockedNow()) {
      result.blocked = true; result.note = 'Googleの確認画面が出ました';
      await saveDebug(parts.join('\n'));
      return;
    }

    const text = parts.join('\n');
    dbg.textLength = text.length;
    await saveDebug(text);
    if (!text.trim()) { result.note = '店舗の画面を読めませんでした'; return; }

    const ex = extractGbpActivity(text, now);
    result.post = ex.post; result.ownerReply = ex.ownerReply; result.review = ex.review;
    dbg.headings = ex.debug.headings; dbg.contexts = ex.debug.contexts; dbg.candidates = ex.debug.candidates;
    result.ok = true;
    if (!gotH1) result.note = '店舗名の見出しが見つかりませんでした(画面が読めていない可能性があります)';
    else if (!ex.post && !ex.ownerReply && !ex.review) result.note = '投稿・返信・口コミの日付は見つかりませんでした';
  })();
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => { timedOut = true; result.note = `時間切れ(${Math.round(timeoutMs / 1000)}秒)`; result.ok = false; resolve('timeout'); }, timeoutMs);
  });
  try {
    await Promise.race([work, timeout]);
  } catch (e) {
    result.ok = false;
    result.note = 'GBPを読めませんでした: ' + String(e && e.message ? e.message : e).split('\n')[0].slice(0, 120);
  } finally {
    clearTimeout(timer);
    work.catch(() => {}); // 時間切れのあとの失敗は無視
    if (page) await soft(() => page.close());
  }
  // 時間切れのあとに裏で動いている処理が結果を書き換えないよう、コピーを返す
  if (timedOut) return { ...result, ok: false, blocked: false, post: null, ownerReply: null, review: null, debug: { ...result.debug } };
  return result;
}

/* ---------- 直列キュー(待ち・停止・キャッシュ) ---------- */

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GBPを1件ずつ読む係。check(row) は呼んだ順に1件ずつ実行し、店舗の間に minWaitMs〜maxWaitMs のランダム待ちを入れる。
 * 確認画面が出たら、以降はすべて「中止」を返す(その実行ではもう開かない)。同じcid/place_id/URLは1回だけ読む。
 * launch: () => browser(テスト用に差し替え可)。fetch / sleep / random も差し替え可。
 */
function createGbpChecker({ headless = true, minWaitMs = 4000, maxWaitMs = 8000, launch, fetch = fetchGbpActivity, sleep = sleepMs, random = Math.random,
  now = () => new Date(), debugDir = '', timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {} } = {}) {
  let browser = null;
  let launchFailure = '';   // 起動できなかった理由(以降は調べない)
  let stopped = false;      // 確認画面で中止
  let aborted = false;      // 利用者の中断
  let fetched = 0;
  let queue = Promise.resolve();
  const cache = new Map();
  const stats = { fetched: 0, cached: 0, blocked: false, unavailable: false };

  const empty = (row, extra) => ({ url: gbpUrlOf(row), ok: false, blocked: false, post: null, ownerReply: null, review: null, note: '', debug: {}, ...extra });

  async function ensureBrowser() {
    if (browser) return browser;
    if (launchFailure) return null;
    try {
      if (launch) browser = await launch();
      else {
        let pw;
        try { pw = require('playwright'); } catch { launchFailure = MISSING_PLAYWRIGHT; log(launchFailure); stats.unavailable = true; return null; }
        browser = await pw.chromium.launch({ headless });
      }
    } catch (e) {
      launchFailure = 'GBP用のブラウザを起動できませんでした(npx playwright install --with-deps chromium を実行してください): ' + String(e && e.message ? e.message : e).split('\n')[0].slice(0, 120);
      log(launchFailure); stats.unavailable = true;
      return null;
    }
    return browser;
  }

  async function runOne(row) {
    const url = gbpUrlOf(row);
    if (!url) return empty(row, { note: 'GoogleマップのURLがありません' });
    const key = String(row.cid || row.placeId || url);
    if (cache.has(key)) { stats.cached++; return cache.get(key); }
    if (aborted) return empty(row, { aborted: true, note: '中断しました' });
    if (stopped) return empty(row, { blocked: true, note: BLOCKED_STOPPED });
    const b = await ensureBrowser();
    if (!b) return empty(row, { note: launchFailure });
    if (fetched > 0) await sleep(minWaitMs + Math.floor(random() * Math.max(0, maxWaitMs - minWaitMs)));
    if (aborted) return empty(row, { aborted: true, note: '中断しました' });
    if (stopped) return empty(row, { blocked: true, note: BLOCKED_STOPPED });
    fetched++; stats.fetched++;
    let r;
    try { r = await fetch(row, { browser: b, now: now(), debugDir, timeoutMs }); } catch (e) { r = empty(row, { note: 'GBPを読めませんでした' }); }
    if (r.blocked) {
      stopped = true; stats.blocked = true;
      r = { ...r, note: BLOCKED_STOPPED };
      log('Googleの確認画面が出ました。この実行ではGBPの確認を中止します(以降の店舗はGBPなしで進めます。時間をおいてからやり直してください)。');
      return r;
    }
    cache.set(key, r);
    return r;
  }

  return {
    check(row) {
      const p = queue.then(() => runOne(row));
      queue = p.catch(() => {});
      return p;
    },
    /** 利用者の中断: これから読む分はすべて読まずに返す */
    stop() { aborted = true; },
    async close() {
      await queue;
      const b = browser; browser = null;
      if (b) await soft(() => b.close());
    },
    get stats() { return { ...stats }; },
  };
}

module.exports = {
  gbpUrlOf, parseRelativeJa, extractGbpActivity, isBlockedPage, fetchGbpActivity, createGbpChecker,
  OWNER_REPLY_KEYWORDS, POST_HEADINGS, REVIEW_HEADINGS, POST_SECTION_STOPS, BLOCK_TEXTS, MISSING_PLAYWRIGHT, BLOCKED_STOPPED,
  readPanelTextInPage, scrollPanelInPage, readBodyTextInPage,
};
