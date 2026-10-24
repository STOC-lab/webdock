'use strict';

/**
 * 問い合わせフォーム探し(純粋ロジック)。
 * 通常の訪問者と同じように「トップページ+可能性の高いページ最大3つ」を見るだけで、
 * フォームの送信は一切しない。DBには触れない。
 * ページ取得は src/safeFetch.js の fetchHomepage を使い、URL/IP安全規則をすべて通す。
 */

const { fetchHomepage, fetchHead } = require('./safeFetch');

const MAX_PAGES = 4;          // 1サイトで取得するページ数の上限(トップ+候補3)
const MAX_CANDIDATES = 3;

/** 自社サイトではないホスト(これらは「フォームなし」扱い) */
const NON_OWN_SITE_HOSTS = [
  'instagram.com', 'facebook.com', 'line.me', 'lin.ee', 'twitter.com', 'x.com',
  'tiktok.com', 'youtube.com', 'ameblo.jp', 'beauty.hotpepper.jp', 'hotpepper.jp',
  'tabelog.com', 'minne.com', 'google.com', 'goo.gl', 'maps.app.goo.gl',
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
    const alt = m[2].match(/<img\b[^>]*>/i);
    if (alt) { const a = getAttr(alt[0], 'alt'); if (a) text = (text + ' ' + a).trim(); }
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
 * 戻り値: { status:'url_found'|'no_form'|'error', inquiryUrl, hasCaptcha, kind, emails, instagram, checkedPages, note }
 */
async function findContact(websiteUrl, opts = {}) {
  const fetchPage = opts.fetchPage || fetchHomepage;
  const fetchRobots = opts.fetchRobots || defaultFetchRobots;
  const result = { status: 'no_form', inquiryUrl: null, hasCaptcha: false, kind: 'none', emails: [], instagram: null, checkedPages: 0, note: '' };

  const startHost = hostOf(websiteUrl);
  if (startHost && isNonOwnSite(startHost)) {
    result.note = '自社サイトではない';
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
  if (isNonOwnSite(siteHost)) {
    result.note = '自社サイトではない';
    return finish();
  }

  collect(top, siteHost);
  const topForm = detectForm(top.body);
  if (topForm.hasContactForm) {
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
    result.note = '問い合わせ候補リンクなし';
    return finish();
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
    const f = detectForm(page.body);
    const pageUrl = page.finalUrl || c.url;
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

  result.note = `候補${candidates.length}件確認、フォームなし` + (skipped ? `(robots除外${skipped}件)` : '');
  return finish();
}

module.exports = {
  extractLinks, scoreContactLink, detectForm, extractEmails, extractInstagram,
  findContact, NON_OWN_SITE_HOSTS, FORM_SERVICES, isNonOwnSite, isFormServiceUrl,
  parseRobots, isDisallowed, hostOf, MAX_PAGES,
};
