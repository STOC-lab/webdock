'use strict';

/**
 * 会社概要ページから会社の規模(従業員数・資本金・上場)を読み取る(純粋ロジック)。
 * ページを見る(GET)だけで、フォームの送信は一切しない。DBには触れない。
 * 取得は formFinder と同じ作法: robots.txt を守り、1サイトで追加取得は最大2ページまで。
 */

const { fetchHomepage } = require('./safeFetch');
const {
  extractLinks, stripTags, parseRobots, isDisallowed, hostOf, nonOwnReason,
} = require('./formFinder');

const MAX_PROFILE_FETCH = 2;

/* ---------- 会社概要リンクの点数 ---------- */
const PROFILE_JP_RE = /会社概要|会社案内|企業情報|企業概要|会社情報|事業所概要|事業概要|当社について|弊社について|私たちについて|会社紹介|企業紹介/;
const PROFILE_EN_TEXT_RE = /\b(about|company|corporate|profile|outline|overview)\b/i;
const PROFILE_PATH_RE = /about|company|corporate|profile|outline|gaiyo|gaiyou|kaisha|corp/i;
const RECRUIT_RE = /recruit|採用|求人|saiyo|career|キャリア/i;
const NOT_PROFILE_RE = /privacy|プライバシー|個人情報|sitemap|サイトマップ|login|cart|policy|ポリシー|規約/i;
const NOT_HTML_RE = /\.(pdf|jpe?g|png|gif|zip|docx?|xlsx?|pptx?|mp4)$/i;

/** 会社概要ページ候補としての点数。0なら候補ではない。 */
function scoreProfileLink(link) {
  let u;
  try { u = new URL(link.url); } catch { return 0; }
  const text = link.text || '';
  let p = u.pathname + u.search;
  try { p = decodeURIComponent(p); } catch { /* そのまま */ }
  if (NOT_HTML_RE.test(u.pathname)) return 0;
  if (NOT_PROFILE_RE.test(text) || NOT_PROFILE_RE.test(p)) return 0;

  let score = 0;
  if (PROFILE_JP_RE.test(text)) score += 10;
  else if (PROFILE_EN_TEXT_RE.test(text)) score += 8;
  if (PROFILE_JP_RE.test(p)) score += 6;
  else if (PROFILE_PATH_RE.test(p)) score += 5;
  if (RECRUIT_RE.test(text) || RECRUIT_RE.test(p)) {
    // 採用ページにも従業員数が載ることがあるので、低い点数で候補に残す
    return score > 0 ? Math.min(score, 3) : 2;
  }
  return score;
}

/* ---------- 数値の読み取り ---------- */
const FW_DIGITS = '０１２３４５６７８９';
function normalizeNum(s) {
  return String(s)
    .replace(/[０-９]/g, (c) => String(FW_DIGITS.indexOf(c)))
    .replace(/[,，]/g, '')
    .replace(/．/g, '.')
    .replace(/：/g, ':');
}

/** 年月日・「現在」などの日付表記を取り除く(年を人数と取り違えないため) */
function removeDates(s) {
  return s
    .replace(/(?:令和|平成|昭和)?\d{1,4}\s*年(?:\s*\d{1,2}\s*月)?(?:\s*\d{1,2}\s*日)?(?:\s*(?:現在|時点))?/g, ' ')
    .replace(/\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?(?:\s*(?:現在|時点))?/g, ' ')
    .replace(/\d{4}[./]\d{1,2}(?:[./]\d{1,2})?(?:\s*(?:現在|時点))?/g, ' ')
    .replace(/[RHS]\d{1,2}[./]\d{1,2}(?:\s*(?:現在|時点))?/g, ' ')
    .replace(/(?:現在|時点)/g, ' ');
}

const CAT = '正社員|正規|非正規|社員|パートタイム|パート|アルバイト|バイト|契約社員|契約|嘱託|派遣社員|派遣|臨時|常勤|非常勤|男性|女性|男|女|役員|技能実習生|外国人';
const NUM_TOKEN_RE = new RegExp('(?:(' + CAT + ')[\\s:()（）・]*)?約?\\s*(\\d+(?:\\.\\d+)?)\\s*(名|人)?', 'g');
const TOTAL_RE = /(?:合計|総計|総数|累計|(?<![぀-鿿])計)[\s:()（）]*約?\s*(\d+)/;

/** 従業員数の値(セルの中身)から人数を読む。読めなければ null。 */
function parseEmployeeValue(raw) {
  let s = normalizeNum(stripTags(String(raw || '')));
  // 内訳(「うち男性15名」など)のかっこ書きは数えない
  s = s.replace(/[（(][^）)]*?(?:うち|内訳|内数|内、|内:)[^）)]*[）)]/g, ' ');
  s = removeDates(s).replace(/\s+/g, ' ').trim();
  if (!s) return null;

  // 単体(当社)とグループ(連結)が両方あれば、単体側の区間だけを見る
  s = s.replace(/当社グループ/g, 'グループ');
  const own = s.search(/単体|提出会社|当社/);
  const grp = s.search(/グループ|連結|関係会社/);
  if (own >= 0 && grp >= 0) {
    const end = grp > own ? grp : s.length;
    s = s.slice(own, end).replace(/単体|提出会社|当社/, ' ');
  }

  const t = TOTAL_RE.exec(s);
  if (t) return validEmployees(Number(t[1]));

  const toks = [];
  NUM_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = NUM_TOKEN_RE.exec(s))) {
    if (m[3] || m[1]) toks.push({ label: m[1] || null, unit: m[3] || null, n: Number(m[2]) });
  }
  if (toks.length >= 2 && toks.every((x) => x.label)) {
    return validEmployees(Math.round(toks.reduce((a, x) => a + x.n, 0)));
  }
  const firstUnit = toks.find((x) => x.unit);
  if (firstUnit) return validEmployees(Math.round(firstUnit.n));
  if (toks.length) return validEmployees(Math.round(toks[0].n));
  // 単位なしの数字だけ(「25」)
  const bare = s.match(/^約?\s*(\d+)$/);
  if (bare) return validEmployees(Number(bare[1]));
  return null;
}

function validEmployees(n) {
  return Number.isFinite(n) && n >= 1 && n <= 1000000 ? n : null;
}

/** 資本金の値から円を読む。読めなければ null。例: 「3億5,000万円」「10,000千円」「金500万円」 */
function parseYen(raw) {
  let s = removeDates(normalizeNum(stripTags(String(raw || ''))));
  const re = /(\d+(?:\.\d+)?)\s*(千万|百万|億|万|千)?\s*(円)?/g;
  const unit = { '億': 1e8, '千万': 1e7, '百万': 1e6, '万': 1e4, '千': 1e3 };
  let total = 0, any = false, m;
  while ((m = re.exec(s))) {
    const n = Number(m[1]);
    if (m[2]) { total += n * unit[m[2]]; any = true; }
    else if (m[3]) { total += n; any = true; }
    if (m[3]) break; // 「円」で金額は終わり
  }
  total = Math.round(total);
  return any && total > 0 ? total : null;
}

/* ---------- ページからの抽出 ---------- */
const EMP_LABEL_RE = /従業員|社員数|職員数|スタッフ数|従業者数/;
const CAP_LABEL_RE = /資本金/;
const EMP_TEXT_RE = /(?:従業員数|従業員|社員数|職員数|スタッフ数|従業者数)(?:\([^)]*\)|（[^）]*）)?[\s:：　]*/g;
const CAP_TEXT_RE = /資本金額?(?:\([^)]*\)|（[^）]*）)?[\s:：　]*/g;
const LISTED_RE = /東証|東京証券取引所|証券コード|(?<![非未再])上場(?!企業|会社|メーカー|大手|予定|を目指|準備)/;
const UNLISTED_RE = /非上場|未上場/;

/** table の th/td と dl の dt/dd から [ラベル, 値] の組を集める */
function collectPairs(html) {
  const src = String(html || '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  const pairs = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
  let r;
  while ((r = rowRe.exec(src))) {
    const cells = [];
    const cellRe = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
    let c;
    while ((c = cellRe.exec(r[1]))) cells.push(stripTags(c[2]));
    for (let i = 0; i + 1 < cells.length; i++) pairs.push([cells[i], cells[i + 1]]);
  }
  const dlRe = /<dl\b[^>]*>([\s\S]*?)<\/dl\s*>/gi;
  let d;
  while ((d = dlRe.exec(src))) {
    const itemRe = /<dt\b[^>]*>([\s\S]*?)<\/dt\s*>\s*<dd\b[^>]*>([\s\S]*?)<\/dd\s*>/gi;
    let it;
    while ((it = itemRe.exec(d[1]))) pairs.push([stripTags(it[1]), stripTags(it[2])]);
  }
  return pairs;
}

const shortLabel = (s) => String(s).replace(/\s+/g, '');

/**
 * 会社概要HTMLから { employees, employeesText, capitalYen, capitalText, listed } を取り出す。わからない項目は null。
 * 表(th/td)・定義リスト(dt/dd)を優先し、なければ文章中の「従業員数:25名」の形を探す。
 */
function extractCompanySize(html) {
  const out = { employees: null, employeesText: null, capitalYen: null, capitalText: null, listed: null };
  const pairs = collectPairs(html);

  for (const [label, value] of pairs) {
    const l = shortLabel(label);
    if (l.length > 15 || !value) continue;
    if (out.employees === null && EMP_LABEL_RE.test(l)) {
      const n = parseEmployeeValue(value);
      if (n !== null) { out.employees = n; out.employeesText = value.slice(0, 80); }
    } else if (out.capitalYen === null && CAP_LABEL_RE.test(l)) {
      const y = parseYen(value);
      if (y !== null) { out.capitalYen = y; out.capitalText = value.slice(0, 80); }
    }
  }

  const text = stripTags(html);
  if (out.employees === null) {
    EMP_TEXT_RE.lastIndex = 0;
    let m;
    while ((m = EMP_TEXT_RE.exec(text))) {
      const win = text.slice(m.index + m[0].length, m.index + m[0].length + 50);
      // ラベルの直後が数字・約・区分名のときだけ値として読む(「従業員の皆様」などを拾わない)
      if (!new RegExp('^(?:約|[0-9０-９]|合計|総数|計|単体|当社|グループ|連結|(?:' + CAT + '))').test(win)) continue;
      const n = parseEmployeeValue(cutAtNextLabel(win));
      if (n !== null) { out.employees = n; out.employeesText = cutAtNextLabel(win).trim().slice(0, 80); break; }
    }
  }
  if (out.capitalYen === null) {
    CAP_TEXT_RE.lastIndex = 0;
    let m;
    while ((m = CAP_TEXT_RE.exec(text))) {
      const win = text.slice(m.index + m[0].length, m.index + m[0].length + 30);
      if (!/^(?:金|約|[0-9０-９])/.test(win)) continue;
      const y = parseYen(win);
      if (y !== null) { out.capitalYen = y; out.capitalText = win.trim().slice(0, 40); break; }
    }
  }

  const stripped = text.replace(UNLISTED_RE, ' ');
  if (LISTED_RE.test(stripped)) out.listed = true;
  else if (UNLISTED_RE.test(text)) out.listed = false;
  return out;
}

/** 文章中の値の窓を、次の項目名(資本金・設立など)の手前で切る */
function cutAtNextLabel(win) {
  const i = win.search(/資本金|設立|創業|代表|所在地|事業内容|売上|年商|取引銀行|URL|TEL|電話/);
  return i > 0 ? win.slice(0, i) : win;
}

/* ---------- 規模の判定 ---------- */
function classifySize(info, { maxEmployees = 20, largeCapitalYen = 100000000 } = {}) {
  if (!info) return 'unknown';
  if (Number.isFinite(info.employees)) return info.employees <= maxEmployees ? 'small' : 'large';
  if (info.listed) return 'large';
  if (Number.isFinite(info.capitalYen) && info.capitalYen >= largeCapitalYen) return 'large';
  return 'unknown';
}

/* ---------- サイト単位の調査 ---------- */
const keyOf = (u) => String(u).replace(/#.*$/, '').replace(/\/$/, '');

function mergeInfo(acc, info, url) {
  let hit = false;
  for (const k of ['employees', 'employeesText', 'capitalYen', 'capitalText']) {
    if (acc[k] === null && info[k] !== null) { acc[k] = info[k]; hit = true; }
  }
  if (info.listed === true) acc.listed = true;
  else if (acc.listed === null && info.listed === false) acc.listed = false;
  if (hit && !acc.profileUrl) acc.profileUrl = url;
}

/**
 * 1サイトの規模を調べる。フォーム送信はしない。例外は投げない。
 * opts: { pages: [{url, body}](取得済みページ。再取得を避ける), fetchPage, fetchRobots, maxEmployees, maxFetch }
 * 戻り値: { employees, employeesText, capitalYen, capitalText, listed, sizeClass, profileUrl, note, checkedPages }
 */
async function findCompanySize(websiteUrl, opts = {}) {
  const res = {
    employees: null, employeesText: null, capitalYen: null, capitalText: null, listed: null,
    sizeClass: 'unknown', profileUrl: null, note: '', checkedPages: 0,
  };
  try {
    return await run(websiteUrl, opts, res);
  } catch (e) {
    res.sizeClass = 'unknown';
    res.note = clip('規模の調査に失敗: ' + (e && e.userSafe ? e.message : (e && e.message) || '不明'), 100);
    return res;
  }
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);

async function run(websiteUrl, opts, res) {
  const fetchPage = opts.fetchPage || fetchHomepage;
  const fetchRobots = opts.fetchRobots || ((origin) => require('./safeFetch').fetchHead(origin + '/robots.txt', 16384, 4000));
  const maxFetch = Number.isFinite(opts.maxFetch) ? opts.maxFetch : MAX_PROFILE_FETCH;
  const classify = () => { res.sizeClass = classifySize(res, { maxEmployees: opts.maxEmployees }); };

  const reason = nonOwnReason(websiteUrl, opts);
  if (reason) { res.note = clip(reason, 100); return res; }

  const pages = Array.isArray(opts.pages) ? opts.pages.filter((p) => p && typeof p.body === 'string') : [];
  if (!pages.length) {
    let top;
    try {
      top = await fetchPage(websiteUrl);
    } catch (e) {
      res.note = clip(e && e.userSafe ? e.message : 'トップページの取得に失敗', 100);
      return res;
    }
    if (!top || top.status >= 400 || typeof top.body !== 'string') {
      res.note = `トップページ取得不可(HTTP ${top ? top.status : '?'})`;
      return res;
    }
    const finalReason = nonOwnReason(top.finalUrl || websiteUrl, opts);
    if (finalReason) { res.note = clip(finalReason, 100); return res; }
    pages.push({ url: top.finalUrl || websiteUrl, body: top.body });
  }

  const siteHost = hostOf(pages[0].url) || hostOf(websiteUrl);
  const seen = new Set(pages.map((p) => keyOf(p.url)));
  for (const p of pages) {
    res.checkedPages++;
    mergeInfo(res, extractCompanySize(p.body), p.url);
  }

  if (res.employees === null) {
    const scored = [];
    let idx = 0;
    for (const p of pages) {
      for (const l of extractLinks(p.body, p.url)) {
        if (hostOf(l.url) !== siteHost) continue; // 同じサイトの中だけ
        const k = keyOf(l.url);
        if (seen.has(k)) continue;
        const s = scoreProfileLink(l);
        if (s <= 0) continue;
        seen.add(k);
        scored.push({ ...l, score: s, idx: idx++ });
      }
    }
    scored.sort((a, b) => b.score - a.score || a.idx - b.idx);

    let robotsRules = null;
    let fetched = 0, skipped = 0, tried = 0;
    for (const c of scored) {
      if (fetched >= maxFetch) break;
      if (robotsRules === null) {
        try { robotsRules = parseRobots(await fetchRobots(new URL(pages[0].url).origin)); } catch { robotsRules = []; }
      }
      if (isDisallowed(robotsRules, c.url)) { skipped++; continue; }
      fetched++;
      let page;
      try { page = await fetchPage(c.url); } catch { continue; }
      if (!page || page.status >= 400 || typeof page.body !== 'string') continue;
      tried++;
      res.checkedPages++;
      const url = page.finalUrl || c.url;
      mergeInfo(res, extractCompanySize(page.body), url);
      if (!res.profileUrl && tried === 1) res._firstProfile = url;
      if (res.employees !== null) break;
    }
    if (!res.profileUrl && res._firstProfile) res.profileUrl = res._firstProfile;
    delete res._firstProfile;
    if (res.employees === null) {
      res.note = !scored.length ? '会社概要ページが見つからない'
        : tried ? '従業員数の記載なし' + (skipped ? `(robots除外${skipped}件)` : '')
        : skipped ? `会社概要ページはrobots除外(${skipped}件)` : '会社概要ページを取得できない';
    }
  }

  if (res.employees !== null) res.note = '従業員数を取得';
  classify();
  res.note = clip(res.note, 100);
  return res;
}

module.exports = { scoreProfileLink, extractCompanySize, classifySize, findCompanySize, parseEmployeeValue, parseYen, MAX_PROFILE_FETCH };
