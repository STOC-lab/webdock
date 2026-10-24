'use strict';

/**
 * 問い合わせフォーム探し(純粋ロジック)。
 * 通常の訪問者と同じように「トップページ+可能性の高いページ最大3つ」を見るだけで、
 * フォームの送信は一切しない。DBには触れない。
 * ページ取得は src/safeFetch.js の fetchHomepage を使い、URL/IP安全規則をすべて通す。
 */

const fs = require('fs');
const path = require('path');
const { fetchHomepage, fetchHead } = require('./safeFetch');

const MAX_PAGES = 4;          // 1サイトで取得するページ数の上限(トップ+候補3)
const MAX_CANDIDATES = 3;

/** 自社サイトではないホスト(これらは「フォームなし」扱い) */
const NON_OWN_SITE_HOSTS = [
  'instagram.com', 'facebook.com', 'line.me', 'lin.ee', 'twitter.com', 'x.com',
  'tiktok.com', 'youtube.com', 'ameblo.jp', 'beauty.hotpepper.jp', 'hotpepper.jp',
  'tabelog.com', 'minne.com', 'google.com', 'goo.gl', 'maps.app.goo.gl',
  // ブログサービス: サービス側のコメント欄・ファン申請などのフォームしか無く、お問い合わせ窓口ではない
  'exblog.jp', 'hatenablog.com', 'hatenablog.jp', 'hateblo.jp', 'hatenadiary.jp', 'hatenadiary.com',
  'livedoor.blog', 'blog.jp', 'livedoor.jp', 'blog.livedoor.jp', 'fc2.com', 'blog.goo.ne.jp',
  'seesaa.net', 'jugem.jp', 'note.com', 'blogspot.com', 'muragon.com', 'blog.so-net.ne.jp', 'cocolog-nifty.com',
];

/** 許可する外部フォームサービス(ホスト, 任意のパス接頭辞) */
const FORM_SERVICES = [
  { host: 'docs.google.com', path: '/forms' },
  { host: 'forms.gle' },
  { host: 'form.run' },
  { host: 'ssl.form-mailer.jp' },
  { host: 'form-mailer.jp' },
  { host: 'formzu.net' },
  { host: 'ws.formzu.net' },
  { host: 'tayori.com' },
  { host: 'f.msgs.jp' },
  { host: 'share.hsforms.com' },
  { host: 'forms.office.com' },
];

const TEXT_RE = /お問い合わせ|お問合せ|問い合わせ|問合せ|お問合わせ|コンタクト|contact|inquiry|ご相談|資料請求|見積|お見積/i;
const PATH_RE = /contact|inquiry|toiawase|otoiawase|form|mail|soudan/i;
const EXCLUDE_RE = /予約|reserve|booking|recruit|採用|entry|login|cart|privacy|プライバシー|個人情報/i;

function stripWww(h) { return String(h || '').toLowerCase().replace(/^www\./, ''); }

function hostOf(url) {
  try { return stripWww(new URL(url).hostname); } catch { return ''; }
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0*39;/g, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

function stripTags(html) {
  return decodeEntities(
    String(html)
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

function getAttr(tag, name) {
  const m = tag.match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  return m ? decodeEntities(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) : null;
}

/** 外部フォームサービスのURLか */
function isFormServiceUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  return FORM_SERVICES.some((s) => h === s.host && (!s.path || u.pathname.startsWith(s.path)));
}

/** <a href> を絶対URLで列挙(#除去、mailto/tel/javascript除外) */
function extractLinks(html, baseUrl) {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let m;
  const src = String(html || '').replace(/<!--[\s\S]*?-->/g, ' ');
  while ((m = re.exec(src))) {
    const href = getAttr(m[1], 'href');
    if (!href) continue;
    const h = href.trim();
    if (!h || /^(mailto:|tel:|javascript:|data:|sms:)/i.test(h) || h.startsWith('#')) continue;
    let u;
    try { u = new URL(h, baseUrl); } catch { continue; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    u.hash = '';
    let text = stripTags(m[2]);
    const imgs = [...m[2].matchAll(/<img\b[^>]*>/gi)].map((x) => x[0]);
    const first = imgs[0];
    if (first) { const a = getAttr(first, 'alt'); if (a) text = (text + ' ' + a).trim(); }
    if (!text) {
      // 画像リンクなど: 画像のalt/title/aria-label → aタグ自身のtitle/aria-label
      const parts = [];
      for (const t of imgs) for (const n of ['alt', 'title', 'aria-label']) { const v = getAttr(t, n); if (v && v.trim()) parts.push(v.trim()); }
      for (const n of ['title', 'aria-label']) { const v = getAttr(m[1], n); if (v && v.trim()) parts.push(v.trim()); }
      text = parts.join(' ').trim();
    }
    out.push({ url: u.toString(), text });
  }
  return out;
}

/** 問い合わせページ候補としての点数。0なら候補ではない。 */
function scoreContactLink(link, siteHost) {
  let u;
  try { u = new URL(link.url); } catch { return 0; }
  const text = link.text || '';
  const pathStr = (() => { try { return decodeURIComponent(u.pathname + u.search); } catch { return u.pathname + u.search; } })();
  if (EXCLUDE_RE.test(text) || EXCLUDE_RE.test(pathStr)) return 0;

  if (isFormServiceUrl(link.url)) return 20;

  if (hostOf(link.url) !== stripWww(siteHost)) return 0; // 他の外部ホストは対象外

  let score = 0;
  if (TEXT_RE.test(text)) score += 10;
  if (PATH_RE.test(pathStr)) score += 5;
  if (score === 0) return 0;
  return score + 3; // 同一サイト加点
}

/** ページ内のフォーム判定 */
function detectForm(html) {
  const src = String(html || '').replace(/<!--[\s\S]*?-->/g, ' ');
  const hasCaptcha = /g-recaptcha|recaptcha\/api\.js|hcaptcha|challenges\.cloudflare\.com\/turnstile/i.test(src);

  let onsite = false;
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi;
  let m;
  while ((m = formRe.exec(src))) {
    const inner = m[2];
    const inputs = [...inner.matchAll(/<input\b[^>]*>/gi)].map((x) => x[0]);
    const types = inputs.map((t) => (getAttr(t, 'type') || 'text').toLowerCase());
    if (types.includes('password')) continue; // ログイン
    const hasTextarea = /<textarea\b/i.test(inner);
    // WordPressのコメント欄は除外
    const action = (getAttr(m[1], 'action') || '').toLowerCase();
    if (action.includes('wp-comments-post')) continue;
    // コメント欄・ファン申請・トラックバックのフォームはお問い合わせではない(送ると公開されるおそれ)
    if (/comment|trackback|fan_?(apply|request)|fanform/i.test(action)) continue;
    // 検索のみ(テキスト入力1つで名前が s|q|keyword|search)
    if (!hasTextarea) {
      const textInputs = inputs.filter((t, i) => ['text', 'search'].includes(types[i]));
      if (textInputs.length === 1 && types.every((t) => ['text', 'search', 'submit', 'button', 'image', 'hidden'].includes(t))) {
        const name = (getAttr(textInputs[0], 'name') || '').toLowerCase();
        if (/^(s|q|keyword|search)$/.test(name)) continue;
      }
    }
    const hasEmail = types.includes('email');
    const hasSubmit = types.some((t) => t === 'submit' || t === 'image') ||
      [...inner.matchAll(/<button\b([^>]*)>/gi)].some((b) => {
        const t = (getAttr(b[1], 'type') || 'submit').toLowerCase();
        return t === 'submit';
      });
    if (hasTextarea || (hasEmail && hasSubmit)) { onsite = true; break; }
  }
  if (onsite) return { hasContactForm: true, hasCaptcha, kind: 'onsite' };

  for (const im of src.matchAll(/<iframe\b[^>]*>/gi)) {
    const s = getAttr(im[0], 'src') || getAttr(im[0], 'data-src');
    if (s && isFormServiceUrl(s.startsWith('//') ? 'https:' + s : s)) {
      return { hasContactForm: true, hasCaptcha, kind: 'external' };
    }
  }
  return { hasContactForm: false, hasCaptcha, kind: 'none' };
}

/** Cloudflareメール保護の16進文字列を復号(先頭1バイトが鍵、以降を鍵とXOR) */
function decodeCfEmail(hex) {
  const h = String(hex || '');
  if (h.length < 4 || h.length % 2 || !/^[0-9a-f]+$/i.test(h)) return '';
  const key = parseInt(h.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < h.length; i += 2) out += String.fromCharCode(parseInt(h.slice(i, i + 2), 16) ^ key);
  return out;
}

/** HTML中の /cdn-cgi/l/email-protection#HEX と data-cfemail="HEX" をすべて復号 */
function decodeCfEmails(src) {
  const out = [];
  const add = (hex) => { const a = decodeCfEmail(hex); if (a.includes('@')) out.push(a); };
  for (const m of String(src).matchAll(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi)) add(m[1]);
  for (const m of String(src).matchAll(/data-cfemail\s*=\s*["']?([0-9a-f]+)/gi)) add(m[1]);
  return out;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PLACEHOLDER_RE = /(^|[@.])example\.(com|jp|org|net)$|sample|^xxx+@|@xxx|your-?e?-?mail|^test@|^name@|^email@|^mail@mail\./i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|css|js)$/i;

/** メールアドレス抽出(mailto: と本文テキスト) */
function extractEmails(html, siteHost) {
  const src = String(html || '').replace(/<!--[\s\S]*?-->/g, ' ');
  const found = [];
  for (const m of src.matchAll(/<a\b[^>]*>/gi)) {
    const href = getAttr(m[0], 'href');
    if (href && /^mailto:/i.test(href.trim())) {
      let addr = href.trim().slice(7).split('?')[0];
      try { addr = decodeURIComponent(addr); } catch { /* そのまま */ }
      for (const a of addr.split(/[,;]/)) found.push(a.trim());
    }
  }
  for (const a of decodeCfEmails(src)) found.push(a);
  for (const m of stripTags(src).matchAll(EMAIL_RE)) found.push(m[0]);

  const seen = new Set();
  const list = [];
  for (let e of found) {
    e = e.toLowerCase().replace(/[.,;:]+$/, '');
    const mm = e.match(/^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/);
    if (!mm) continue;
    if (IMAGE_EXT_RE.test(e) || /@\d+x\./.test(e)) continue;
    if (PLACEHOLDER_RE.test(e)) continue;
    if (seen.has(e)) continue;
    seen.add(e);
    list.push(e);
  }
  const sh = stripWww(siteHost);
  const same = (e) => {
    if (!sh) return false;
    const d = e.split('@')[1];
    return d === sh || d.endsWith('.' + sh) || sh.endsWith('.' + d);
  };
  // 別ドメインの会社アドレス(制作会社・ポータル運営会社など)は、お店宛てではない可能性が高いので捨てる。
  // 残すのは「サイトと同じドメイン」か「個人・小規模店がよく使うフリーメール/携帯メール」だけ。
  const free = (e) => FREE_MAIL_DOMAINS.has(e.split('@')[1]);
  return [...list.filter(same), ...list.filter((e) => !same(e) && free(e))];
}

const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.co.jp', 'ymail.ne.jp', 'icloud.com', 'me.com', 'mac.com',
  'outlook.com', 'outlook.jp', 'hotmail.com', 'hotmail.co.jp', 'live.jp', 'live.com', 'msn.com',
  'docomo.ne.jp', 'ezweb.ne.jp', 'au.com', 'softbank.ne.jp', 'i.softbank.jp', 'ybb.ne.jp',
  'nifty.com', 'biglobe.ne.jp', 'ocn.ne.jp', 'so-net.ne.jp', 'plala.or.jp', 'eonet.ne.jp',
]);

const IG_RESERVED = new Set(['p', 'reel', 'reels', 'explore', 'accounts', 'share', 'stories', 'tv', 'about', 'developer', 'direct', 'web', 'sharer', 'sharer.php', 'legal', 'privacy', 'directory', 'oauth']);

/** Instagramプロフィールの最初の1件を https://www.instagram.com/<account>/ に正規化 */
function extractInstagram(html) {
  const re = /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)/gi;
  let m;
  const src = String(html || '').replace(/<!--[\s\S]*?-->/g, ' ');
  while ((m = re.exec(src))) {
    const acct = m[1].replace(/\.+$/, '');
    if (!acct || IG_RESERVED.has(acct.toLowerCase())) continue;
    return `https://www.instagram.com/${acct}/`;
  }
  return null;
}

function isNonOwnSite(host) {
  const h = stripWww(host);
  return NON_OWN_SITE_HOSTS.some((n) => h === n || (n !== 'google.com' && h.endsWith('.' + n)));
}

/* ---------- 営業管理と共有する「自社サイトではない」一覧 ---------- */
const BUNDLED_TERMS_FILE = path.join(__dirname, '..', 'rules', 'non_own_site_terms.txt');
const SERVER_TERMS_FILE = '/var/www/stoc-sales-engine/app/Helpers/non_own_site_terms.txt';

function defaultTermsFile() {
  if (process.env.NON_OWN_TERMS_FILE) return process.env.NON_OWN_TERMS_FILE;
  try { if (fs.existsSync(SERVER_TERMS_FILE)) return SERVER_TERMS_FILE; } catch { /* 無視 */ }
  return BUNDLED_TERMS_FILE;
}

/** 一覧テキストを解析。#@url / #@host で以降の語の判定方法を切り替え(初期は url)。 */
function parseNonOwnTerms(text) {
  const rules = { url: [], host: [] };
  const seen = { url: new Set(), host: new Set() };
  let mode = 'url';
  for (const raw of String(text || '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const sw = line.toLowerCase();
      if (sw === '#@url') mode = 'url';
      else if (sw === '#@host') mode = 'host';
      continue;
    }
    line = line.replace(/^https?:/i, '').replace(/^\/\//, '').trim().toLowerCase();
    if (!line || seen[mode].has(line)) continue;
    seen[mode].add(line);
    rules[mode].push(line);
  }
  return rules;
}

const termsCache = new Map();
function loadNonOwnTerms(file) {
  const f = file || defaultTermsFile();
  if (termsCache.has(f)) return termsCache.get(f);
  let rules;
  try { rules = parseNonOwnTerms(fs.readFileSync(f, 'utf8')); }
  catch {
    try { rules = parseNonOwnTerms(fs.readFileSync(BUNDLED_TERMS_FILE, 'utf8')); } catch { rules = { url: [], host: [] }; }
  }
  termsCache.set(f, rules);
  return rules;
}

const NOTE_LIST = '自社サイトではない(一覧)';
const NOTE_BUILTIN = '自社サイトではない(地図・公共・掲載ページ)';
const NOTE_ORG = '団体の窓口のため除外';
const NOTE_JS = '要ブラウザ確認(JSで作られたサイト)';
const ORG_TITLE_RE = /協会|師会|医師会|組合|連合会|商工会|振興会|商店街|事務局|ポータル/;
const LISTING_KEYWORDS = ['clinic', 'shop', 'shops', 'store', 'detail', 'article', 'search', 'member', 'kikan', 'salon', 'info_', 'shopcms', 'floor', 'tenant', '/s/', '/t0', 'list'];
const INDEXISH = new Set(['index.html', 'index.htm', 'index.php', 'home', 'top']);

function pathSegments(u) {
  let segs = u.pathname.split('/').filter(Boolean);
  if (segs.length === 1 && INDEXISH.has(segs[0].toLowerCase())) segs = [];
  return segs;
}

function parseUrl(url) { try { return new URL(url); } catch { return null; } }

/** 共有一覧(ファイル)に該当するか */
function matchesNonOwnList(url, termsFile) {
  const u = parseUrl(url);
  if (!u) return false;
  const rules = loadNonOwnTerms(termsFile);
  const full = u.href.toLowerCase();
  const h = u.hostname.toLowerCase();
  if (rules.url.some((t) => full.includes(t))) return true;
  return rules.host.some((t) => h === t || h.endsWith('.' + t));
}

/** 地図・公共機関・掲載ページ(他者サイト内の店舗一覧ページ)か */
function matchesBuiltinNonOwn(url) {
  const u = parseUrl(url);
  if (!u) return false;
  const h = u.hostname.toLowerCase();
  const p = u.pathname.toLowerCase();
  // Googleマップ
  if (/(^|\.)google\.[a-z.]+$/.test(h) && p.startsWith('/maps')) return true;
  if (/^maps\.google\./.test(h) || h === 'maps.app.goo.gl') return true;
  if (h === 'goo.gl' && p.startsWith('/maps')) return true;
  // 官公庁・自治体
  if (h.endsWith('.lg.jp') || h.endsWith('.go.jp') || /(^|\.)(pref|town|city|vill)\./.test(h)) return true;
  // 掲載ページ
  if (h === 'sites.google.com') return false;
  const segs = pathSegments(u);
  const q = u.search.length > 1;
  // 3階層以上深いページは、ほかのサイトの中の掲載ページとみなす(店が自分のHPとして深いページを登録することはまず無い)
  if (segs.length >= 3) return true;
  if (segs.length >= 2 || (segs.length >= 1 && q)) {
    if (h.endsWith('.or.jp')) return true;
    const hay = (p + u.search).toLowerCase();
    let dec = hay;
    try { dec = decodeURIComponent(hay); } catch { /* そのまま */ }
    if (LISTING_KEYWORDS.some((k) => dec.includes(k))) return true;
  }
  return false;
}

/** 自社サイトでない理由(なければ null) */
function nonOwnReason(url, opts = {}) {
  const h = hostOf(url);
  if (h && isNonOwnSite(h)) return NOTE_LIST;
  if (matchesNonOwnList(url, opts.termsFile)) return NOTE_LIST;
  if (matchesBuiltinNonOwn(url)) return NOTE_BUILTIN;
  return null;
}

/* ---------- JSサイトビルダー ---------- */
const JS_BUILDER_HOSTS = [
  'wixsite.com', 'wix.com', 'editorx.io', 'sites.google.com', 'jimdosite.com', 'jimdofree.com', 'jimdo.com',
  'amebaownd.com', 'studio.site', 'strikingly.com', 'mystrikingly.com', 'peraichi.com', 'goope.jp',
  'crayonsite.net', 'crayonsite.com', 'kujira.biz', 'kaginawa.jp', 'gorp.jp',
];

function isJsBuilder(host, body) {
  const h = String(host || '').toLowerCase();
  if (JS_BUILDER_HOSTS.some((n) => h === n || h.endsWith('.' + n))) return true;
  const src = String(body || '');
  for (const m of src.matchAll(/<meta\b[^>]*>/gi)) {
    if (/generator/i.test(getAttr(m[0], 'name') || '') && /Wix|Jimdo|STUDIO|Strikingly|Ameba Ownd/i.test(getAttr(m[0], 'content') || '')) return true;
  }
  return /<script\b[^>]*\bsrc\s*=\s*["']?[^"'>\s]*(static\.parastorage\.com|wixstatic|jimdocdn|cdn\.studio\.design)/i.test(src);
}

/** ページの<title>と最初の<h1>/<h2>のテキストが団体の窓口らしいか */
function isOrgPage(body) {
  const src = String(body || '').replace(/<!--[\s\S]*?-->/g, ' ');
  const parts = [];
  const t = src.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (t) parts.push(stripTags(t[1]));
  const h = src.match(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]\s*>/i);
  if (h) parts.push(stripTags(h[1]));
  return ORG_TITLE_RE.test(parts.join(' '));
}

/** robots.txt から User-agent: * の Disallow を取り出す */
function parseRobots(text) {
  const rules = [];
  let inStar = false, sawRule = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k === 'user-agent') {
      if (sawRule) { inStar = false; sawRule = false; }
      if (v === '*') inStar = true;
    } else if (k === 'disallow') {
      sawRule = true;
      if (inStar && v) rules.push(v);
    } else if (k === 'allow') {
      sawRule = true;
    }
  }
  return rules;
}

function isDisallowed(rules, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const p = u.pathname + u.search;
  return rules.some((r) => {
    const prefix = r.replace(/\*.*$/, '').replace(/\$$/, '');
    return prefix !== '' && p.startsWith(prefix);
  });
}

async function defaultFetchRobots(origin) {
  return fetchHead(origin + '/robots.txt', 16384, 4000);
}

function mergeEmails(acc, list) {
  for (const e of list) if (!acc.includes(e)) acc.push(e);
}

/**
 * 1サイトを調べる。フォーム送信はしない。
 * 戻り値: { status:'url_found'|'no_form'|'unknown'|'error', inquiryUrl, hasCaptcha, kind, emails, instagram, checkedPages, note }
 */
async function findContact(websiteUrl, opts = {}) {
  const fetchPage = opts.fetchPage || fetchHomepage;
  const fetchRobots = opts.fetchRobots || defaultFetchRobots;
  const result = { status: 'no_form', inquiryUrl: null, hasCaptcha: false, kind: 'none', emails: [], instagram: null, checkedPages: 0, note: '' };

  const startHost = hostOf(websiteUrl);
  const startReason = nonOwnReason(websiteUrl, opts);
  if (startReason) {
    result.note = startReason;
    return result;
  }

  let pagesFetched = 0;
  const emails = [];
  let instagram = null;
  const collect = (page, siteHost) => {
    mergeEmails(emails, extractEmails(page.body, siteHost));
    if (!instagram) instagram = extractInstagram(page.body);
  };
  const finish = () => {
    const sh = result._siteHost || startHost;
    result.emails = emails.slice().sort((a, b) => {
      const sa = a.split('@')[1].endsWith(sh) ? 0 : 1;
      const sb = b.split('@')[1].endsWith(sh) ? 0 : 1;
      return sa - sb;
    });
    result.instagram = instagram;
    result.checkedPages = pagesFetched;
    delete result._siteHost;
    return result;
  };

  let top;
  try {
    pagesFetched++;
    top = await fetchPage(websiteUrl);
  } catch (e) {
    result.status = 'error';
    result.note = e && e.userSafe ? e.message : '取得に失敗しました';
    result.checkedPages = pagesFetched;
    return result;
  }
  if (!top || top.status >= 400) {
    result.status = 'error';
    result.note = `HTTP ${top ? top.status : '?'}`;
    result.checkedPages = pagesFetched;
    return result;
  }

  const finalUrl = top.finalUrl || websiteUrl;
  const siteHost = hostOf(finalUrl) || startHost;
  result._siteHost = siteHost;

  // リダイレクト先が自社サイトでない場合
  const finalReason = nonOwnReason(finalUrl, opts);
  if (finalReason) {
    result.note = finalReason;
    return finish();
  }

  // 店舗のURLがサイト直下でない(他者サイト内のページの)場合、団体の窓口フォームを拾わないようにする
  const deepStart = (() => { const u = parseUrl(websiteUrl); const f = parseUrl(finalUrl); return (u && pathSegments(u).length >= 1) || (f && pathSegments(f).length >= 1); })();
  let jsSite = isJsBuilder(siteHost, top.body);
  let orgRejected = 0;
  const noFormEnd = (note) => {
    if (orgRejected) { result.note = NOTE_ORG; return finish(); }
    if (jsSite) { result.status = 'unknown'; result.note = NOTE_JS; return finish(); }
    result.note = note;
    return finish();
  };

  collect(top, siteHost);
  const topForm = detectForm(top.body);
  if (topForm.hasContactForm && deepStart && isOrgPage(top.body)) {
    orgRejected++;
  } else if (topForm.hasContactForm) {
    result.status = 'url_found';
    result.inquiryUrl = finalUrl;
    result.hasCaptcha = topForm.hasCaptcha;
    result.kind = topForm.kind;
    result.note = 'トップページにフォームあり';
    return finish();
  }

  // 候補ランキング
  const links = extractLinks(top.body, finalUrl);
  const seen = new Set([finalUrl.replace(/\/$/, '')]);
  const scored = [];
  links.forEach((l, idx) => {
    const key = l.url.replace(/\/$/, '');
    if (seen.has(key)) return;
    const s = scoreContactLink(l, siteHost);
    if (s <= 0) return;
    seen.add(key);
    scored.push({ ...l, score: s, idx });
  });
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const candidates = scored.slice(0, MAX_CANDIDATES);

  if (!candidates.length) {
    return noFormEnd('問い合わせ候補リンクなし');
  }

  let robotsRules = null;
  let skipped = 0;
  for (const c of candidates) {
    if (isFormServiceUrl(c.url)) {
      result.status = 'url_found';
      result.inquiryUrl = c.url;
      result.kind = 'external';
      result.note = '外部フォームサービス';
      return finish();
    }
    if (pagesFetched >= MAX_PAGES) break;

    if (robotsRules === null) {
      try { robotsRules = parseRobots(await fetchRobots(new URL(finalUrl).origin)); } catch { robotsRules = []; }
    }
    if (isDisallowed(robotsRules, c.url)) { skipped++; continue; }

    let page;
    try {
      pagesFetched++;
      page = await fetchPage(c.url);
    } catch { continue; }
    if (!page || page.status >= 400) continue;
    collect(page, siteHost);
    if (!jsSite && isJsBuilder('', page.body)) jsSite = true;
    const f = detectForm(page.body);
    const pageUrl = page.finalUrl || c.url;
    if (deepStart && isOrgPage(page.body)) { orgRejected++; continue; }
    if (f.hasContactForm) {
      result.status = 'url_found';
      result.inquiryUrl = pageUrl;
      result.hasCaptcha = f.hasCaptcha;
      result.kind = f.kind;
      result.note = f.kind === 'external' ? '埋め込み外部フォーム' : '';
      return finish();
    }
    // ページから外部フォームサービスへのリンクがある場合
    const ext = extractLinks(page.body, pageUrl).find((l) => isFormServiceUrl(l.url) && !EXCLUDE_RE.test(l.text));
    if (ext) {
      result.status = 'url_found';
      result.inquiryUrl = ext.url;
      result.kind = 'external';
      result.hasCaptcha = f.hasCaptcha;
      result.note = '外部フォームサービス';
      return finish();
    }
  }

  return noFormEnd(`候補${candidates.length}件確認、フォームなし` + (skipped ? `(robots除外${skipped}件)` : ''));
}

module.exports = {
  extractLinks, scoreContactLink, detectForm, extractEmails, extractInstagram,
  findContact, NON_OWN_SITE_HOSTS, FORM_SERVICES, isNonOwnSite, isFormServiceUrl,
  parseRobots, isDisallowed, hostOf, MAX_PAGES,
  parseNonOwnTerms, loadNonOwnTerms, defaultTermsFile, nonOwnReason, matchesBuiltinNonOwn, matchesNonOwnList,
  isJsBuilder, isOrgPage, decodeCfEmail, decodeCfEmails,
};
