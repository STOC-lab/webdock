'use strict';
/**
 * ブログ・お知らせの更新状況を、公開されているフィード/サイトマップ/WP REST から調べる(受け身の確認だけ)。
 *
 *   detectBlogActivity({ finalUrl, body }, fetchFn, opts) → { latestAt:Date|null, posts90d:number|null, source:'rss'|'atom'|'sitemap'|'wp-json'|null, note, external }
 *
 *  - fetchFn(url) → { status, body }(src/safeFetch.js の fetchHomepage をそのまま使える。URL検査・IP固定・リダイレクト再検査つき)
 *  - 追加の取得は最大 MAX_EXTRA_FETCHES(=3)回。内訳: トップに <link rel="alternate"> があればそれ(最大2本)、
 *    なければ /feed/ → (WordPressらしければ wp-json、そうでなければ ?feed=rss2) → sitemap.xml → …(回数の上限まで)。最初に日付が取れたところで止める。
 *  - トップページ以外の取得は robots.txt を守る(opts.fetchRobots があるとき。robots.txt 自体の取得は上の3回に数えない)。
 *  - 外部ブログ(ameblo / note / はてな / livedoor 等)へのリンクは取得せず、source を 'external:<名前>' として external に記録するだけ。
 *  - 未来(1日より先)と2000年より前の日付は無視する。
 */

const MAX_EXTRA_FETCHES = 3;
const SITEMAP_MAX_BYTES = 1024 * 1024;
const DAY = 86400000;
const MIN_DATE = Date.UTC(2000, 0, 1);
const POST_PATH_RE = /\/blog|\/news|\/topics|\/info|\/column|\/post|\/archives|\/\d{4}\//i;

/* ---------- 日付 ---------- */

function parseDate(s) {
  if (s === undefined || s === null) return null;
  const t = String(s).trim();
  if (!t) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

/** 有効な日付(ms)だけ通す。未来(+1日超)と2000年より前は捨てる */
function validMs(ms, nowMs) {
  return ms !== null && Number.isFinite(ms) && ms >= MIN_DATE && ms <= nowMs + DAY;
}

function decode(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0*39;/g, "'");
}

function tagText(block, tag) {
  const m = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '\\s*>', 'i').exec(block);
  return m ? decode(m[1]).trim() : null;
}

function blocks(xml, tag) {
  const out = [];
  const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '\\s*>', 'gi');
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

/* ---------- 解析(文字列 → { dates:number[] , ... }) ---------- */

/** RSS 2.0 / RSS 1.0(RDF) / Atom。記事の日付(ms)の配列を返す。フィードでなければ null */
function parseFeed(text, nowMs) {
  const xml = String(text || '');
  const head = xml.slice(0, 3000);
  let kind = null, items = [];
  if (/<feed\b/i.test(head)) {
    kind = 'atom';
    items = blocks(xml, 'entry').map((b) => tagText(b, 'published') || tagText(b, 'updated') || tagText(b, 'dc:date'));
  } else if (/<rss\b|<rdf:RDF\b/i.test(head)) {
    kind = 'rss';
    items = blocks(xml, 'item').map((b) => tagText(b, 'pubDate') || tagText(b, 'dc:date') || tagText(b, 'published') || tagText(b, 'updated'));
  } else return null;
  const dates = items.map(parseDate).filter((ms) => validMs(ms, nowMs));
  return { kind, dates, itemCount: items.length };
}

/** WordPress REST API(/wp-json/wp/v2/posts?_fields=date)。JSONでなければ null */
function parseWpJson(text, nowMs) {
  let j;
  try { j = JSON.parse(String(text || '')); } catch { return null; }
  if (!Array.isArray(j)) return null;
  const dates = j.map((x) => (x && typeof x === 'object' ? parseDate(x.date || x.date_gmt) : null)).filter((ms) => validMs(ms, nowMs));
  return { kind: 'wp-json', dates, itemCount: j.length };
}

/** サイトマップ(urlset / sitemapindex)。戻り: { index:boolean, entries:[{loc, ms}] } 。どちらでもなければ null */
function parseSitemap(text) {
  const xml = String(text || '');
  const head = xml.slice(0, 3000);
  const index = /<sitemapindex\b/i.test(head);
  if (!index && !/<urlset\b/i.test(head)) return null;
  const tag = index ? 'sitemap' : 'url';
  const entries = blocks(xml, tag).map((b) => ({ loc: tagText(b, 'loc') || '', ms: parseDate(tagText(b, 'lastmod')) }));
  return { index, entries };
}

/* ---------- 集計 ---------- */

function summarize(dates, nowMs) {
  if (!dates.length) return null;
  const cut = nowMs - 90 * DAY;
  return { latestAt: new Date(Math.max(...dates)), posts90d: dates.filter((ms) => ms >= cut).length };
}

function pathOf(loc) {
  try { return new URL(loc).pathname; } catch { return String(loc); }
}

/** サイトマップから集計。urlset は記事らしいパスの lastmod だけ数える(1件もなければ全URLで数えて注記)。index は子の lastmod の最大だけ(再帰しない) */
function summarizeSitemap(sm, nowMs) {
  const valid = sm.entries.filter((e) => validMs(e.ms, nowMs));
  if (!valid.length) return null;
  if (sm.index) {
    // 記事用らしい子(post-sitemap 等)があればそれを優先
    const postLike = valid.filter((e) => /post|news|blog|topics|article|column|info/i.test(pathOf(e.loc)));
    const use = postLike.length ? postLike : valid;
    return { latestAt: new Date(Math.max(...use.map((e) => e.ms))), posts90d: null, note: 'sitemap index(子の更新日のみ・件数は数えない)' };
  }
  const postLike = sm.entries.filter((e) => POST_PATH_RE.test(pathOf(e.loc)));
  let note = '';
  let use;
  if (postLike.length) use = postLike.filter((e) => validMs(e.ms, nowMs));
  else { use = valid; note = '記事らしいURLがなく全URLの更新日で数えた'; }
  if (!use.length) return { latestAt: null, posts90d: 0, note: note || '記事らしいURLに更新日なし' };
  const r = summarize(use.map((e) => e.ms), nowMs);
  return { ...r, note };
}

/* ---------- 外部ブログ ---------- */

// [ホスト名の判定, 記録する短い名前(blog_source は VARCHAR(20): 'external:' + 名前 が20字以内になるように)]
const EXTERNAL_BLOGS = [
  [/(^|\.)ameblo\.jp$/i, 'ameblo.jp'],
  [/(^|\.)note\.(com|mu)$/i, 'note.com'],
  [/(^|\.)(hatenablog\.(com|jp)|hateblo\.jp|hatenadiary\.(com|jp))$/i, 'hatenablog'],
  [/(^|\.)livedoor\.(jp|biz)$/i, 'livedoor'],
  [/(^|\.)blog\.fc2\.com$/i, 'fc2'],
  [/(^|\.)seesaa\.net$/i, 'seesaa'],
  [/(^|\.)exblog\.jp$/i, 'exblog'],
  [/(^|\.)jugem\.jp$/i, 'jugem'],
  [/(^|\.)cocolog-nifty\.com$/i, 'nifty'],
  [/(^|\.)blogspot\.com$/i, 'blogspot'],
];

/** トップページ内のリンクから外部ブログを探す。戻り: '短い名前' か null(取得はしない) */
function detectExternalBlog(body) {
  const html = String(body || '');
  const re = /href\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    let u;
    try { u = new URL(decode(m[1])); } catch { continue; }
    for (const [rx, name] of EXTERNAL_BLOGS) {
      if (!rx.test(u.hostname)) continue;
      // ameblo / note は「ユーザーのページ」まで入っているリンクだけ(トップや共有ボタンのリンクは除く)
      if ((name === 'ameblo.jp' || name === 'note.com') && (u.pathname === '/' || u.pathname === '' || /^\/(intent|share|login|signup|hashtag)\b/.test(u.pathname))) continue;
      return name;
    }
  }
  return null;
}

/* ---------- フィード発見 ---------- */

function discoverFeedLinks(body, baseUrl) {
  const out = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(String(body || '')))) {
    const tag = m[0];
    const attr = (n) => { const x = new RegExp('\\b' + n + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag); return x ? decode(x[1] ?? x[2] ?? x[3] ?? '') : ''; };
    if (!/\balternate\b/i.test(attr('rel'))) continue;
    const type = attr('type').toLowerCase();
    if (type !== 'application/rss+xml' && type !== 'application/atom+xml') continue;
    const href = attr('href');
    if (!href) continue;
    if (/comment/i.test(href) || /comment/i.test(attr('title'))) continue; // コメントのフィードは記事ではない
    let abs;
    try { abs = new URL(href, baseUrl).toString(); } catch { continue; }
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

const looksWordPress = (body) => /wp-content|wp-includes|wp-json|wordpress/i.test(String(body || '').slice(0, 400000));

/* ---------- 本体 ---------- */

async function detectBlogActivity(home, fetchFn, opts = {}) {
  const now = opts.now ? +new Date(opts.now) : Date.now();
  const max = opts.maxFetches || MAX_EXTRA_FETCHES;
  const res = { latestAt: null, posts90d: null, source: null, note: '', external: detectExternalBlog(home && home.body) };
  let base;
  try { base = new URL(home.finalUrl); } catch { return res; }
  const origin = base.origin;
  let used = 0;
  let robots = null; // null=未取得
  const tried = new Set();

  const allowed = async (url) => {
    if (!opts.fetchRobots) return true;
    if (robots === null) {
      try { robots = require('./formFinder').parseRobots(await opts.fetchRobots(origin)); } catch { robots = []; }
    }
    return !require('./formFinder').isDisallowed(robots, url);
  };

  async function get(url) {
    if (tried.has(url) || used >= max) return null;
    let u;
    try { u = new URL(url); } catch { return null; }
    if (u.hostname.replace(/^www\./i, '').toLowerCase() !== base.hostname.replace(/^www\./i, '').toLowerCase()) return null; // 別ホストは取りに行かない
    tried.add(url);
    if (!(await allowed(url))) return null;
    used++;
    try {
      const r = await fetchFn(url);
      if (!r || r.status < 200 || r.status >= 300 || typeof r.body !== 'string') return null;
      return r.body;
    } catch { return null; }
  }

  const tryFeed = async (url) => {
    const body = await get(url);
    if (body === null) return false;
    const f = parseFeed(body, now);
    if (!f) return false;
    const s = summarize(f.dates, now);
    if (!s) return false;
    Object.assign(res, s, { source: f.kind });
    return true;
  };
  const tryWp = async () => {
    const body = await get(origin + '/wp-json/wp/v2/posts?per_page=20&_fields=date');
    if (body === null) return false;
    const f = parseWpJson(body, now);
    const s = f && summarize(f.dates, now);
    if (!s) return false;
    Object.assign(res, s, { source: 'wp-json' });
    return true;
  };
  const trySitemap = async () => {
    const body = await get(origin + '/sitemap.xml');
    if (body === null || Buffer.byteLength(body) > SITEMAP_MAX_BYTES) return false;
    const sm = parseSitemap(body);
    const s = sm && summarizeSitemap(sm, now);
    if (!s || !s.latestAt) return false;
    Object.assign(res, { latestAt: s.latestAt, posts90d: s.posts90d, source: 'sitemap', note: s.note || '' });
    return true;
  };

  const links = discoverFeedLinks(home.body, home.finalUrl).slice(0, 2);
  for (const l of links) if (await tryFeed(l)) return res;
  if (used >= max) return res;
  // 見つからない/読めないとき: /feed/ → (WordPressらしければ wp-json、そうでなければ ?feed=rss2) → sitemap.xml → 残りの候補
  const wp = looksWordPress(home.body);
  const steps = [() => tryFeed(origin + '/feed/')];
  if (wp) steps.push(tryWp, trySitemap, () => tryFeed(origin + '/?feed=rss2'));
  else steps.push(() => tryFeed(origin + '/?feed=rss2'), trySitemap, tryWp);
  for (const step of steps) {
    if (used >= max) break;
    if (await step()) return res;
  }
  return res;
}

/** DBに書く blog_source の値: 内部の取得元があればそれ、なければ外部ブログ('external:<名前>') */
function blogSourceValue(r) {
  if (r && r.source) return r.source;
  if (r && r.external) return ('external:' + r.external).slice(0, 20);
  return null;
}

module.exports = {
  detectBlogActivity, parseFeed, parseWpJson, parseSitemap, summarizeSitemap, detectExternalBlog, discoverFeedLinks,
  blogSourceValue, MAX_EXTRA_FETCHES, SITEMAP_MAX_BYTES, POST_PATH_RE,
};
