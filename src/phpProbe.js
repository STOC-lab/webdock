'use strict';
/**
 * PHPの版の取得元を順に試す(受動的な範囲のみ)。
 *   a. トップの X-Powered-By
 *   b. トップの Server ヘッダ内の PHP/x.y.z(追加通信なし)
 *   c. PHPが動的に返すページ1つの X-Powered-By / Server(WordPressらしければ /wp-login.php、そうでなければ /index.php)
 *   d. /phpinfo.php → /info.php(200 かつ本文に phpinfo() と PHP Version x.y.z があるときだけ「phpinfo公開」)
 * 見つかった時点で終了する。追加の通信は1サイト最大3回(転送先への通信も1回と数える)。
 * 行わないこと: POST・ログイン・攻撃文字列・エラー誘発・総当たり。追加GETの転送は同一サイト内のみ。
 * 通信は deps.fetchPassive(url, budget) で差し替えられる(テスト用)。
 */
const PV = require('./phpVersions');
const { URL } = require('url');

const MAX_EXTRA_GETS = 3;
const WP_RE = /wp-content|wp-includes/i;

const headerText = (v) => (Array.isArray(v) ? v.join(', ') : (v === undefined || v === null ? '' : String(v)));

/** ヘッダから版を探す(a → b の順)。戻り: { version, label } | null。label は evidence 用(例「X-Powered-By: PHP/7.4.33」) */
function versionFromHeaders(headers) {
  const h = headers || {};
  for (const [name, label] of [['x-powered-by', 'X-Powered-By'], ['server', 'Server']]) {
    const raw = headerText(h[name]);
    const version = PV.parsePhpVersion(raw);
    if (version) return { version, label: `${label}: ${raw}` };
  }
  return null;
}

/** PHPで動いている手がかり(版なし)。戻り: ['WordPress', 'PHPSESSID', ...] */
function phpHints(res, opts) {
  const hints = [];
  if (!res) return hints;
  const h = res.headers || {};
  const body = res.body || '';
  if (!(opts && opts.skipBody)) {
    if (WP_RE.test(body)) hints.push('WordPress');
  }
  if (/PHPSESSID/i.test(headerText(h['set-cookie']))) hints.push('PHPSESSID');
  if (/PHP/i.test(headerText(h['x-powered-by']))) hints.push('X-Powered-By: PHP(版なし)');
  if (!(opts && opts.skipBody) && hasSamePhpLink(body, res.finalUrl)) hints.push('.phpのページへのリンク');
  return hints;
}

/** 本文の href / action に、同一サイトの「.php」で終わるURLがあるか */
function hasSamePhpLink(body, baseUrl) {
  let base;
  try { base = new URL(baseUrl); } catch { return false; }
  const strip = (x) => String(x).toLowerCase().replace(/^www\./, '');
  const re = /\b(?:href|action)\s*=\s*["']([^"'\s]+)["']/gi;
  let m, n = 0;
  while ((m = re.exec(body)) && n++ < 500) {
    try {
      const u = new URL(m[1], base);
      if (/^https?:$/.test(u.protocol) && strip(u.hostname) === strip(base.hostname) && /\.php$/i.test(u.pathname)) return true;
    } catch { /* 読めないリンクは無視 */ }
  }
  return false;
}

/** phpinfo ページか(200 かつ phpinfo() と PHP Version x.y.z の両方を含む)。戻り: 版の文字列 | null */
function phpinfoVersion(res) {
  if (!res || res.status !== 200) return null;
  const body = res.body || '';
  if (!/phpinfo\(\)/i.test(body)) return null;
  const m = body.match(/PHP Version\s*(?:=>\s*)?(?:<[^>]*>\s*)*(\d+\.\d+\.\d+)/i);
  return m ? m[1] : null;
}

/** トップページだけで分かること(通信なし)。戻り: { found, hints } */
function fromPage(page) {
  const p = page || {};
  const found = versionFromHeaders(p.headers);
  return { found, hints: found ? [] : phpHints({ headers: p.headers, body: p.body, finalUrl: p.finalUrl }) };
}

/**
 * 版が取れるまで追加の確認をする(c → d)。例外は投げない。
 * 戻り: { found: {version,label}|null, phpinfo: {path, version}|null, hints: [...], gets: 追加通信の回数 }
 */
async function probe(page, deps) {
  const d = deps || {};
  const p = page || {};
  const first = fromPage(p);
  if (first.found) return { found: { ...first.found, via: '' }, phpinfo: null, hints: [], gets: 0 };
  const fetchFn = d.fetchPassive || require('./safeFetch').fetchPassive;
  const budget = { left: MAX_EXTRA_GETS };
  let gets = 0;
  const get = async (path) => {
    if (budget.left <= 0) return null;
    budget.left -= 1; gets += 1;
    let origin;
    try { origin = new URL(p.finalUrl).origin; } catch { return null; }
    try { return await fetchFn(origin + path, budget); } catch { return null; }
  };
  const hints = [...first.hints];
  const addHints = (hs) => hs.forEach((x) => { if (!hints.includes(x)) hints.push(x); });

  // c. PHPが動的に返すページ1つ
  const dynPath = WP_RE.test(p.body || '') ? '/wp-login.php' : '/index.php';
  const dyn = await get(dynPath);
  if (dyn) {
    const f = versionFromHeaders(dyn.headers);
    if (f) return { found: { ...f, via: `(${dynPath} の応答)` }, phpinfo: null, hints, gets };
    addHints(phpHints(dyn, { skipBody: true }));
  }
  // d. phpinfo が公開されていないか(この順、ヒットしたら打ち切り)
  for (const path of ['/phpinfo.php', '/info.php']) {
    const r = await get(path);
    const v = phpinfoVersion(r);
    if (v) return { found: null, phpinfo: { path, version: v }, hints, gets };
  }
  return { found: null, phpinfo: null, hints, gets };
}

module.exports = { MAX_EXTRA_GETS, versionFromHeaders, phpHints, hasSamePhpLink, phpinfoVersion, fromPage, probe };
