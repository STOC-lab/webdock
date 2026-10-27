'use strict';

/**
 * サイトの「最終更新日」の判定(ブログ・お知らせ・新着情報・NEWSなど)。
 * 外から見えるページだけを使い、フォーム送信などはしない。
 * 取得は必ず safeFetch.fetchHomepage(SSRF対策済み)を通す。テストでは fetchPage に偽の関数を渡す。
 *
 * 使い方: const r = await detectLatestPost('https://example.co.jp/');
 *   r = { date: Date|null, source: 'rss'|'wordpress'|'news_page'|'top_page'|'sitemap'|null, url, title, note }
 */

const { fetchHomepage, sameSiteHost } = require('./safeFetch');

const JST_MS = 9 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const MIN_YEAR = 2000;

// ニュース系のキーワード(リンクの文字列・href・日付の直前の文字に使う)
const NEWS_WORDS = 'お知らせ|新着|ニュース|NEWS|News|ブログ|BLOG|Blog|トピックス|TOPICS|インフォメーション|information';
const NEWS_LINK_RE = new RegExp(NEWS_WORDS + '|/news|/blog|/info|/topics', 'i');
const NEAR_RE = new RegExp(NEWS_WORDS, 'i');
const NEAR_CHARS = 300;
const SITEMAP_URL_RE = /\/news|\/blog|\/info|\/topics|\/archives|\/\d{4}\/\d{2}\//i;
const SKIP_EXT_RE = /\.(?:pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp[34]|css|js)(?:[?#]|$)/i;

/* ---------- 日付の道具(日本時間) ---------- */

/** Date → 日本時間の 'YYYY-MM-DD' */
function toJstDate(d) {
  const t = new Date(d.getTime() + JST_MS);
  return t.toISOString().slice(0, 10);
}

/** 日本時間の日付どうしの差(整数日)。date が古いほど大きい */
function daysAgo(date, now = new Date()) {
  const a = Date.parse(toJstDate(now) + 'T00:00:00Z');
  const b = Date.parse(toJstDate(date) + 'T00:00:00Z');
  return Math.round((a - b) / DAY_MS);
}

/** 全角数字・全角の区切りを半角にする(文字数は変わらないので位置はそのまま使える) */
function halfWidth(s) {
  return String(s)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[．]/g, '.').replace(/[／]/g, '/').replace(/[－−]/g, '-');
}

/** 年月日から日本時間0時の Date を作る。妥当でなければ null */
function jstDateOf(y, m, d) {
  if (!(y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const t = Date.UTC(y, m - 1, d);
  const chk = new Date(t);
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== m - 1 || chk.getUTCDate() !== d) return null;
  return new Date(t - JST_MS);
}

/** 採用してよい日付か(2000年以降・未来すぎない) */
function plausible(date, now) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return false;
  if (Number(toJstDate(date).slice(0, 4)) < MIN_YEAR) return false;
  return date.getTime() <= now.getTime() + DAY_MS; // 未来(イベント告知・営業カレンダー)は捨てる
}

const YMD_RE = /(?<!\d)((?:19|20)\d{2})\s*[.\/\-年]\s*(\d{1,2})\s*[.\/\-月]\s*(\d{1,2})\s*日?(?!\d)/g;

/** 本文から「年月日が揃った日付」を全部拾う。戻り: [{ date, index, end }](妥当なものだけ) */
function extractDates(text, now = new Date()) {
  const s = halfWidth(text);
  const out = [];
  YMD_RE.lastIndex = 0;
  let m;
  while ((m = YMD_RE.exec(s))) {
    const date = jstDateOf(Number(m[1]), Number(m[2]), Number(m[3]));
    if (date && plausible(date, now)) out.push({ date, index: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** フィード・JSON・sitemap の日付文字列(RFC822・ISO日時・日付だけ)を Date にする。だめなら null */
function parseDateValue(v, now = new Date()) {
  const s = halfWidth(String(v || '').trim());
  if (!s) return null;
  let date = null;
  if (/\d{1,2}:\d{2}/.test(s) || /^[A-Za-z]{3},/.test(s)) {
    const rfc = /^[A-Za-z]{3},/.test(s);
    const t = Date.parse(rfc || /(?:Z|[+-]\d{2}:?\d{2})\s*$/.test(s) ? s : s.replace(' ', 'T') + '+09:00');
    if (!isNaN(t)) date = new Date(t);
  }
  if (!date) {
    const e = extractDates(s, new Date(8.64e15 - 1));
    if (e.length) date = e[0].date;
  }
  if (!date) return null;
  // 時刻つきのときは日本時間の0時に丸める(日単位で比べるため)
  const d0 = Date.parse(toJstDate(date) + 'T00:00:00+09:00');
  date = new Date(d0);
  return plausible(date, now) ? date : null;
}

/* ---------- HTML・XMLの道具 ---------- */

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
}

function cdata(s) { return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'); }

/** HTML → 文字(スクリプト・スタイル・コメントを除き、タグは改行に。<time datetime> は日付を本文に出す) */
function htmlToText(html) {
  let s = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["'][^>]*>/gi, ' $1 ');
  s = s.replace(/<[^>]*>/g, '\n');
  return decodeEntities(s).replace(/[ \t\u00a0\u3000]+/g, ' ');
}

function attr(tag, name) {
  const m = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag);
  return m ? decodeEntities(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) : '';
}

function tagText(block, name) {
  const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i').exec(block);
  return m ? decodeEntities(cdata(m[1]).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
}

/** 日付の直後の文字から、記事タイトルらしきものを取る(見つからなければ '') */
function titleAfter(text, end) {
  const rest = text.slice(end, end + 200).split('\n').map((x) => x.trim()).filter(Boolean);
  const t = (rest[0] || '').replace(/^[\s|｜\-\u2013:：・\]】)）]+/, '').trim();
  return t.slice(0, 80);
}

/* ---------- 本体 ---------- */

/**
 * 最新の投稿日を探す。取得は合計 maxRequests 回まで、全体 timeoutMs で打ち切り。
 * 各取得の失敗は握りつぶして次へ進む。
 */
async function detectLatestPost(siteUrl, { fetchPage = fetchHomepage, now = new Date(), maxRequests = 6, timeoutMs = 30000 } = {}) {
  const started = Date.now();
  let used = 0;
  const notes = [];
  const cands = []; // { date, source, url, title }
  let siteHost = '';

  const timeLeft = () => timeoutMs - (Date.now() - started);

  /** 1回取得(回数・時間の上限つき)。失敗・2xx以外・別サイトへの転送は null */
  async function get(url) {
    if (used >= maxRequests) { notes.push('取得回数の上限'); return null; }
    const left = timeLeft();
    if (left <= 0) { notes.push('時間切れ'); return null; }
    used++;
    let timer;
    try {
      const page = await Promise.race([
        Promise.resolve().then(() => fetchPage(url)),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), left); }),
      ]);
      if (!page || typeof page.body !== 'string' || !(page.status >= 200 && page.status < 300)) return null;
      const fu = page.finalUrl || url;
      if (siteHost) {
        try { if (!sameSiteHost(new URL(fu).hostname, siteHost)) return null; } catch { return null; }
      }
      return { ...page, finalUrl: fu };
    } catch { return null; } finally { clearTimeout(timer); }
  }

  const add = (date, source, url, title) => { if (date) cands.push({ date, source, url: url || '', title: title || '' }); };
  const abs = (href, base) => { try { const u = new URL(href, base); u.hash = ''; return u.toString(); } catch { return ''; } };
  const sameSite = (u) => { try { return /^https?:$/.test(new URL(u).protocol) && sameSiteHost(new URL(u).hostname, siteHost); } catch { return false; } };

  // 1. トップページ
  const top = await get(siteUrl);
  if (!top) return { date: null, source: null, url: '', title: '', note: '取得できず(トップページ)' };
  const base = top.finalUrl;
  try { siteHost = new URL(base).hostname; } catch { return { date: null, source: null, url: '', title: '', note: '取得できず(URLが不正)' }; }
  const html = top.body;
  const origin = new URL(base).origin;
  const isWp = /wp-content|wp-includes|rel\s*=\s*["']https:\/\/api\.w\.org\/?["']/i.test(html);

  // 2. RSS / Atom
  let feedUrl = '';
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\balternate\b/i.test(attr(tag, 'rel'))) continue;
    if (!/application\/(?:rss|atom)\+xml/i.test(attr(tag, 'type'))) continue;
    const href = attr(tag, 'href');
    if (!href || /comment/i.test(href + attr(tag, 'title'))) continue; // コメントのフィードは除く
    feedUrl = abs(href, base);
    if (feedUrl) break;
  }
  if (!feedUrl && isWp) feedUrl = origin + '/feed/';
  if (feedUrl && sameSite(feedUrl)) {
    const fp = await get(feedUrl);
    if (fp) {
      let best = null;
      for (const m of fp.body.matchAll(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi)) {
        const b = m[0];
        const d = parseDateValue(tagText(b, 'pubDate') || tagText(b, 'dc:date') || tagText(b, 'updated') || tagText(b, 'published'), now);
        if (!d || (best && best.date >= d)) continue;
        let link = tagText(b, 'link');
        if (!link) {
          for (const lm of b.matchAll(/<link\b[^>]*>/gi)) {
            const rel = attr(lm[0], 'rel');
            if (!rel || /alternate/i.test(rel)) { link = attr(lm[0], 'href'); if (link) break; }
          }
        }
        best = { date: d, url: link ? abs(link, fp.finalUrl) : fp.finalUrl, title: tagText(b, 'title') };
      }
      if (best) add(best.date, 'rss', best.url, best.title);
    }
  }

  // 3. WordPress REST API
  if (isWp) {
    const wp = await get(origin + '/wp-json/wp/v2/posts?per_page=1&_fields=date,link,title');
    if (wp) {
      try {
        const j = JSON.parse(wp.body);
        const p = Array.isArray(j) ? j[0] : null;
        if (p) {
          const d = parseDateValue(p.date, now);
          const t = p.title && typeof p.title === 'object' ? p.title.rendered : p.title;
          add(d, 'wordpress', typeof p.link === 'string' ? p.link : wp.finalUrl, decodeEntities(String(t || '').replace(/<[^>]*>/g, '')).trim());
        }
      } catch { /* JSONでなければ無視 */ }
    }
  }

  // 4. お知らせ・ブログ系のリンク先(最大2つ)
  const links = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = attr(m[1], 'href');
    if (!href || /^(?:#|mailto:|tel:|javascript:)/i.test(href)) continue;
    const label = decodeEntities(m[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!NEWS_LINK_RE.test(label) && !NEWS_LINK_RE.test(href)) continue;
    const u = abs(href, base);
    if (!u || SKIP_EXT_RE.test(u) || !sameSite(u)) continue;
    if (u === base || u === origin + '/' || links.includes(u)) continue;
    links.push(u);
    if (links.length >= 2) break;
  }
  for (const u of links) {
    const p = await get(u);
    if (!p) continue;
    const text = htmlToText(p.body);
    const ds = extractDates(text, now);
    if (!ds.length) continue;
    const top1 = ds.reduce((a, b) => (b.date > a.date ? b : a));
    add(top1.date, 'news_page', p.finalUrl, titleAfter(text, top1.end));
  }

  // 5. トップページ本文: 直前300文字以内にニュース系の語がある日付だけ
  {
    const text = htmlToText(html);
    let best = null;
    for (const d of extractDates(text, now)) {
      const before = text.slice(Math.max(0, d.index - NEAR_CHARS), d.index);
      if (!NEAR_RE.test(before)) continue;
      if (!best || d.date > best.date) best = d;
    }
    if (best) add(best.date, 'top_page', base, titleAfter(text, best.end));
  }

  // 6. ここまでで日付が無ければ sitemap.xml を見る
  if (!cands.length) {
    const sm = await get(origin + '/sitemap.xml');
    if (sm) {
      let body = sm.body;
      if (/<sitemapindex\b/i.test(body)) {
        const child = [...body.matchAll(/<sitemap\b[\s\S]*?<\/sitemap>/gi)]
          .map((m) => tagText(m[0], 'loc')).find((l) => /post|news|blog/i.test(l) && sameSite(l));
        const cp = child ? await get(child) : null;
        body = cp ? cp.body : '';
      }
      let best = null;
      for (const m of body.matchAll(/<url\b[\s\S]*?<\/url>/gi)) {
        const loc = tagText(m[0], 'loc');
        if (!loc || !SITEMAP_URL_RE.test(loc)) continue;
        const d = parseDateValue(tagText(m[0], 'lastmod'), now);
        if (d && (!best || d > best.date)) best = { date: d, url: loc };
      }
      if (best) add(best.date, 'sitemap', best.url, '');
    }
  }

  if (!cands.length) {
    const why = notes.length ? `日付が見つからない(${[...new Set(notes)].join('・')})` : '日付が見つからない';
    return { date: null, source: null, url: '', title: '', note: why };
  }
  const best = cands.reduce((a, b) => (b.date > a.date ? b : a)); // 同日なら先に見つけた方(RSS優先)
  return { date: best.date, source: best.source, url: best.url, title: best.title, note: '' };
}

module.exports = { detectLatestPost, toJstDate, daysAgo, extractDates, parseDateValue };
