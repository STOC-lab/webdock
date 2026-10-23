'use strict';

/**
 * 診断エンジン(10項目)。すべて「外から見えるだけ」の情報で判定する。
 * status: 'ok' | 'warn' | 'bad' | 'unknown'
 */

const dns = require('dns').promises;
const { URL } = require('url');

// 既知の古いJavaScriptライブラリ(ファイル名からバージョンを拾える範囲)
const OLD_LIB_RULES = [
  { name: 'jQuery', re: /jquery[-.]?(\d+)\.(\d+)(?:\.(\d+))?(?:\.min)?\.js/i, safeMajorMinor: [3, 5] },
];

function daysBetween(a, b) {
  return Math.round((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

/* ---- 通信 ---- */

function checkCertExpiry(page) {
  const t = { key: 'cert', title: 'SSL証明書の有効期限' };
  if (!page.finalUrl.startsWith('https:') || !page.tls) {
    return { ...t, status: 'unknown', summary: 'HTTPSでの確認ができませんでした', evidence: '' };
  }
  if (!page.tls.validTo) {
    return { ...t, status: 'unknown', summary: '証明書情報を取得できませんでした', evidence: '' };
  }
  const expire = new Date(page.tls.validTo);
  const left = daysBetween(expire, new Date());
  const ev = `有効期限: ${expire.toISOString().slice(0, 10)}(残り${left}日)`;
  if (!page.tls.authorized) {
    return {
      ...t, status: 'bad',
      summary: '証明書に問題があります(期限切れ・不一致など)',
      why: 'ブラウザに「保護されていない通信」「危険なサイト」と警告が出て、訪問者が離れてしまいます。',
      fix: '制作会社に「SSL証明書が無効になっている」と伝え、再発行・自動更新の設定を依頼してください。',
      evidence: `${ev} / 検証エラー: ${page.tls.authorizationError || '不明'}`,
    };
  }
  if (left < 0) return { ...t, status: 'bad', summary: '証明書が期限切れです', why: 'サイトに安全警告が表示され、信用を大きく損ないます。', fix: '証明書を至急再発行し、自動更新を設定してください。', evidence: ev };
  if (left < 30) return { ...t, status: 'warn', summary: `まもなく期限切れ(残り${left}日)`, why: '更新を忘れると、ある日突然サイトに警告が出ます。', fix: '自動更新が有効か制作会社に確認してください。', evidence: ev };
  return { ...t, status: 'ok', summary: `有効(残り${left}日)`, why: '', fix: '', evidence: ev };
}

function checkHttpsRedirect(page) {
  const t = { key: 'https_redirect', title: 'HTTPSへの自動転送' };
  if (page.httpToHttps) {
    return { ...t, status: 'ok', summary: 'http→httpsへ自動転送されています', why: '', fix: '', evidence: `転送を確認(${page.redirectChain.map((h) => h.status).join('→')})` };
  }
  if (page.finalUrl.startsWith('https:')) {
    return {
      ...t, status: 'warn',
      summary: 'httpでアクセスした際の自動転送が確認できませんでした',
      why: '「http://」で来た訪問者が暗号化されないまま閲覧し、情報が盗み見られる恐れがあります。',
      fix: '制作会社に「http→httpsへの常時リダイレクトを設定してほしい」と依頼してください。',
      evidence: '最終URLはhttpsだが、自動転送は未確認',
    };
  }
  return {
    ...t, status: 'bad',
    summary: 'サイトがHTTPSになっていません',
    why: '通信が暗号化されず、問い合わせ内容やパスワードが第三者に見られる危険があります。',
    fix: 'SSL証明書を導入し、サイト全体をhttps化するよう依頼してください。',
    evidence: `最終URL: ${page.finalUrl}`,
  };
}

function checkTlsVersion(page) {
  const t = { key: 'tls_version', title: '古い暗号方式(TLS)の利用' };
  if (!page.tls || !page.tls.protocol) {
    return { ...t, status: 'unknown', summary: '暗号方式を取得できませんでした', evidence: '' };
  }
  const proto = page.tls.protocol; // 'TLSv1.3' など
  const ev = `接続時の暗号方式: ${proto}`;
  if (proto === 'TLSv1.3' || proto === 'TLSv1.2') {
    return { ...t, status: 'ok', summary: `新しい暗号方式(${proto})です`, why: '', fix: '', evidence: ev };
  }
  return {
    ...t, status: 'warn',
    summary: `古い暗号方式(${proto})が使われています`,
    why: '古い暗号方式は解読される恐れがあり、クレジットカード業界の基準でも利用が禁止されています。',
    fix: 'サーバー側でTLS1.2以上のみを有効にするよう依頼してください。',
    evidence: ev,
  };
}

/* ---- 設定(ヘッダー) ---- */

function checkSecurityHeaders(page) {
  const t = { key: 'headers', title: 'セキュリティ用ヘッダー設定' };
  const h = page.headers || {};
  const items = [
    { k: 'content-security-policy', label: 'CSP' },
    { k: 'x-frame-options', label: 'クリックジャッキング対策', altHas: !!h['content-security-policy'] && /frame-ancestors/i.test(h['content-security-policy'] || '') },
    { k: 'strict-transport-security', label: 'HSTS' },
    { k: 'x-content-type-options', label: 'MIMEスニッフィング対策' },
  ];
  const missing = [];
  const present = [];
  for (const it of items) {
    if (h[it.k] || it.altHas) present.push(it.label);
    else missing.push(it.label);
  }
  const ev = `設定あり: ${present.join('、') || 'なし'} / 未設定: ${missing.join('、') || 'なし'}`;
  if (missing.length === 0) return { ...t, status: 'ok', summary: '主要な防御ヘッダーが設定されています', why: '', fix: '', evidence: ev };
  if (missing.length <= 2) return { ...t, status: 'warn', summary: `防御ヘッダーが一部未設定(${missing.length}件)`, why: 'なりすまし表示や盗み見など、既知の攻撃を防ぐ「基本の戸締まり」が一部開いています。', fix: `制作会社に「${missing.join('・')} のレスポンスヘッダーを追加してほしい」と依頼してください。`, evidence: ev };
  return { ...t, status: 'bad', summary: `防御ヘッダーがほとんど未設定(${missing.length}件)`, why: 'サイトの基本的な戸締まりがされておらず、既知の攻撃を受けやすい状態です。', fix: `制作会社に「${missing.join('・')} のヘッダーを追加してほしい」と依頼してください。`, evidence: ev };
}

function checkCookies(page) {
  const t = { key: 'cookies', title: 'Cookie(クッキー)の保護設定' };
  const raw = page.headers && page.headers['set-cookie'];
  if (!raw || !raw.length) {
    return { ...t, status: 'ok', summary: 'トップページでCookieは発行されていません', why: '', fix: '', evidence: 'Set-Cookieヘッダーなし' };
  }
  const list = Array.isArray(raw) ? raw : [raw];
  let insecure = 0;
  for (const c of list) {
    const secure = /;\s*secure/i.test(c);
    const httpOnly = /;\s*httponly/i.test(c);
    if (!secure || !httpOnly) insecure++;
  }
  const ev = `Cookie ${list.length}件中、Secure/HttpOnly不足: ${insecure}件`;
  if (insecure === 0) return { ...t, status: 'ok', summary: 'Cookieは適切に保護されています', why: '', fix: '', evidence: ev };
  return {
    ...t, status: 'warn',
    summary: `保護設定が不足したCookieがあります(${insecure}件)`,
    why: 'ログイン情報などが盗み見られ、なりすましに悪用される恐れがあります。',
    fix: '制作会社に「CookieにSecureとHttpOnly属性を付けてほしい」と依頼してください。',
    evidence: ev,
  };
}

function checkMixedContent(page) {
  const t = { key: 'mixed', title: '混在コンテンツ(http読み込み)' };
  if (!page.finalUrl.startsWith('https:')) {
    return { ...t, status: 'unknown', summary: 'HTTPSサイトではないため対象外', evidence: '' };
  }
  const body = page.body || '';
  const m = body.match(/(?:src|href)\s*=\s*["']http:\/\/[^"']+/gi) || [];
  const count = m.length;
  const urls = [...new Set(m.map((s) => s.replace(/^(?:src|href)\s*=\s*["']/i, '')))];
  const shown = urls.slice(0, 5).join(' / ');
  const ev = `本文中の http:// リソース参照: ${count}件` + (count ? `(${shown}${urls.length > 5 ? ' ほか' : ''})` : '');
  if (count === 0) return { ...t, status: 'ok', summary: '暗号化されない読み込みは見つかりませんでした', why: '', fix: '', evidence: ev };
  if (count <= 3) return { ...t, status: 'warn', summary: `暗号化されない読み込みが一部あります(${count}件)`, why: '一部の画像やスクリプトがhttpのままで、「保護されていない通信」警告の原因になります。', fix: '制作会社にhttp://の読み込みをhttps://へ直すよう依頼してください。', evidence: ev };
  return { ...t, status: 'bad', summary: `暗号化されない読み込みが多数あります(${count}件)`, why: 'ページ内に暗号化されない読み込みが多く、安全警告や改ざんのリスクがあります。', fix: 'すべての読み込みをhttps://へ統一するよう依頼してください。', evidence: ev };
}

/* ---- ソフト ---- */

function checkCmsExposure(page) {
  const t = { key: 'cms', title: 'CMS(WordPress等)のバージョン露出' };
  const body = page.body || '';
  const h = page.headers || {};
  const found = [];
  const gen = body.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i);
  if (gen) found.push(`generatorタグ: ${gen[1]}`);
  // WordPress本体のバージョンが分かる wp-includes 配下の ?ver= のみを対象(プラグインのver=は対象外)
  const wpVer = body.match(/wp-includes\/[^"'\s]+\?ver=(\d+\.\d+(?:\.\d+)?)/);
  const isWp = /wp-content|wp-includes/i.test(body);
  if (isWp && wpVer) found.push(`WordPress関連バージョン: ${wpVer[1]}`);
  if (h['x-powered-by']) found.push(`X-Powered-By: ${h['x-powered-by']}`);
  if (h['server'] && /\/\d/.test(h['server'])) found.push(`Server: ${h['server']}`);

  if (!found.length) {
    return { ...t, status: 'ok', summary: 'バージョン情報の目立った露出はありませんでした', why: '', fix: '', evidence: isWp ? 'WordPressと推定されるがバージョン露出なし' : '露出なし' };
  }
  return {
    ...t, status: 'warn',
    summary: '使用ソフトのバージョンが外部に見えています',
    why: '攻撃者は公開されたバージョンから既知の弱点を調べます。古いまま放置すると狙われやすくなります。',
    fix: '制作会社に「generatorタグやX-Powered-Byなどのバージョン表示を隠し、本体・プラグインを最新に更新してほしい」と依頼してください。',
    evidence: found.join(' / '),
  };
}

function checkOldJsLibs(page) {
  const t = { key: 'js_libs', title: '古いJavaScriptライブラリ' };
  const body = page.body || '';
  const findings = [];
  for (const rule of OLD_LIB_RULES) {
    const m = body.match(rule.re);
    if (m) {
      const major = Number(m[1]);
      const minor = Number(m[2] || 0);
      const [sMaj, sMin] = rule.safeMajorMinor;
      const old = major < sMaj || (major === sMaj && minor < sMin);
      findings.push({ name: rule.name, ver: `${m[1]}.${m[2] || 0}${m[3] ? '.' + m[3] : ''}`, old });
    }
  }
  if (!findings.length) {
    return { ...t, status: 'unknown', summary: 'バージョン付きの既知ライブラリは検出されませんでした', evidence: 'ファイル名からの判定のため、未検出でも使用していないとは限りません' };
  }
  const olds = findings.filter((f) => f.old);
  const ev = findings.map((f) => `${f.name} ${f.ver}${f.old ? '(古い)' : ''}`).join(' / ');
  if (!olds.length) return { ...t, status: 'ok', summary: '検出したライブラリは新しいバージョンでした', why: '', fix: '', evidence: ev };
  return {
    ...t, status: 'warn',
    summary: `古いライブラリが使われています(${olds.map((f) => f.name).join('・')})`,
    why: '古いライブラリには公表済みの弱点があり、サイト改ざんや情報盗難に悪用されることがあります。',
    fix: `制作会社に「${olds.map((f) => f.name).join('・')} を最新版へ更新してほしい」と依頼してください。`,
    evidence: ev,
  };
}

function checkExternalScripts(page) {
  const t = { key: 'ext_scripts', title: '外部スクリプトの数と送信先' };
  const body = page.body || '';
  let selfHost = '';
  try { selfHost = new URL(page.finalUrl).hostname.replace(/^www\./, ''); } catch {}
  const srcs = [...body.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const hosts = new Set();
  for (const s of srcs) {
    try {
      const h = new URL(s, page.finalUrl).hostname.replace(/^www\./, '');
      if (h && h !== selfHost) hosts.add(h);
    } catch {}
  }
  const list = [...hosts];
  const ev = `外部スクリプト読込元: ${list.length}ドメイン${list.length ? '(' + list.slice(0, 8).join('、') + (list.length > 8 ? ' ほか' : '') + ')' : ''}`;
  if (list.length === 0) return { ...t, status: 'ok', summary: '外部スクリプトの読み込みはありませんでした', why: '', fix: '', evidence: ev };
  if (list.length <= 8) return { ...t, status: 'ok', summary: `外部スクリプトは${list.length}ドメイン`, why: '', fix: '', evidence: ev };
  return {
    ...t, status: 'warn',
    summary: `外部スクリプトの読込先が多い(${list.length}ドメイン)`,
    why: '外部から読み込むスクリプトが多いほど、どこか1つが乗っ取られた時に自社サイト経由で情報が盗まれる経路が増えます。',
    fix: '不要なタグ(過去の計測・広告タグ等)を整理し、読み込み先を見直すよう依頼してください。',
    evidence: ev,
  };
}

/* ---- メール ---- */

async function checkMailSpoofing(page) {
  const t = { key: 'mail', title: 'メールのなりすまし対策(SPF/DMARC)' };
  let host = '';
  try { host = new URL(page.finalUrl).hostname.replace(/^www\./, ''); } catch {}
  if (!host) return { ...t, status: 'unknown', summary: 'ドメインを特定できませんでした', evidence: '' };

  let spf = false, dmarc = false, dmarcPolicy = '';
  try {
    const txt = await dns.resolveTxt(host);
    spf = txt.some((r) => r.join('').toLowerCase().startsWith('v=spf1'));
  } catch {}
  try {
    const d = await dns.resolveTxt(`_dmarc.${host}`);
    const rec = d.map((r) => r.join('')).find((s) => s.toLowerCase().startsWith('v=dmarc1'));
    if (rec) {
      dmarc = true;
      const pm = rec.match(/p=([a-z]+)/i);
      dmarcPolicy = pm ? pm[1].toLowerCase() : '';
    }
  } catch {}

  const ev = `SPF: ${spf ? 'あり' : 'なし'} / DMARC: ${dmarc ? 'あり(p=' + (dmarcPolicy || '不明') + ')' : 'なし'}`;
  if (spf && dmarc && (dmarcPolicy === 'reject' || dmarcPolicy === 'quarantine')) {
    return { ...t, status: 'ok', summary: 'なりすましメール対策が設定されています', why: '', fix: '', evidence: ev };
  }
  if (!spf && !dmarc) {
    return {
      ...t, status: 'bad',
      summary: 'なりすまし対策(SPF・DMARC)が未設定です',
      why: '御社ドメインを名乗る偽メールを他人が自由に送れる状態です。取引先への詐欺メールに悪用される恐れがあります。',
      fix: 'ドメイン管理会社に「SPFとDMARCのレコードを設定してほしい」と依頼してください。',
      evidence: ev,
    };
  }
  return {
    ...t, status: 'warn',
    summary: 'なりすまし対策が一部のみです',
    why: '対策が不完全で、なりすましメールを十分にブロックできません。',
    fix: dmarc ? 'DMARCのポリシーをp=quarantineまたはrejectへ強化するよう依頼してください。' : 'DMARCレコードを追加するよう依頼してください。',
    evidence: ev,
  };
}

/* ---- 集計 ---- */

function scoreOf(results) {
  // ok=10, warn=5, bad=0, unknown=除外
  const scored = results.filter((r) => r.status !== 'unknown');
  if (!scored.length) return { score: null, grade: '—' };
  const sum = scored.reduce((a, r) => a + (r.status === 'ok' ? 10 : r.status === 'warn' ? 5 : 0), 0);
  const score = Math.round((sum / (scored.length * 10)) * 100);
  let grade = 'E';
  if (score >= 90) grade = 'A';
  else if (score >= 75) grade = 'B';
  else if (score >= 60) grade = 'C';
  else if (score >= 40) grade = 'D';
  return { score, grade };
}

async function runChecks(page) {
  const sync = [
    checkCertExpiry(page),
    checkHttpsRedirect(page),
    checkTlsVersion(page),
    checkSecurityHeaders(page),
    checkCookies(page),
    checkMixedContent(page),
    checkCmsExposure(page),
    checkOldJsLibs(page),
    checkExternalScripts(page),
  ];
  const mail = await checkMailSpoofing(page);
  const results = [...sync, mail];

  // 解決方法の区分: site=ホームページのリニューアルで解消 / dns=ドメイン(メール)設定が別途必要
  const REMEDY = {
    cert: 'site', https_redirect: 'site', tls_version: 'site',
    headers: 'site', cookies: 'site', mixed: 'site',
    cms: 'site', js_libs: 'site', ext_scripts: 'site',
    mail: 'dns',
  };
  results.forEach((r) => { r.remedy = REMEDY[r.key] || 'site'; });

  const counts = results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  const { score, grade } = scoreOf(results);
  return { results, counts, score, grade };
}

module.exports = { runChecks };
