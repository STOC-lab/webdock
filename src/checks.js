'use strict';

/**
 * 診断エンジン(11項目)。すべて「外から見えるだけ」の情報で判定する。
 * status: 'ok' | 'warn' | 'bad' | 'unknown'
 */

const dns = require('dns').promises;
const { URL } = require('url');
const PV = require('./phpVersions');


function daysBetween(a, b) {
  return Math.round((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

/* ---- 通信 ---- */

/* ---- 通信 ---- */

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function checkCertExpiry(page) {
  const t = { key: 'cert', title: 'SSL証明書の有効期限' };
  if (!page.finalUrl.startsWith('https:') || !page.tls) {
    return { ...t, status: 'unknown', summary: '確認できませんでした(https で接続できなかったため)', evidence: '' };
  }
  if (!page.tls.validTo) {
    return { ...t, status: 'unknown', summary: '確認できませんでした(証明書の情報を取得できなかったため)', evidence: '' };
  }
  const expire = new Date(page.tls.validTo);
  const left = daysBetween(expire, new Date());
  const date = expire.toISOString().slice(0, 10);
  // 注意: outreach.js が「残りN日」の形でこの evidence を読む。書式を変えないこと
  const ev = `有効期限: ${date}(残り${left}日)`;
  const WARNING = '今このサイトを開くと、ブラウザに「この接続ではプライバシーが保護されません」という警告画面が出て、訪問者はページを見られません。';
  const FIX_BAD = '制作会社に「SSL証明書が無効になっている」と伝え、再発行・自動更新の設定を依頼してください。';
  if (!page.tls.authorized) {
    const expired = left < 0;
    return {
      ...t, status: 'bad',
      summary: expired
        ? `証明書は ${date} に期限が切れています(${-left}日前)`
        : `証明書がブラウザに無効と判定されています(期限は ${date}、検証エラー: ${page.tls.authorizationError || '不明'})`,
      why: WARNING,
      fix: FIX_BAD,
      evidence: `${ev} / 検証エラー: ${page.tls.authorizationError || '不明'}`,
    };
  }
  if (left < 0) return { ...t, status: 'bad', summary: `証明書は ${date} に期限が切れています(${-left}日前)`, why: WARNING, fix: FIX_BAD, evidence: ev };
  if (left < 30) {
    return {
      ...t, status: 'warn',
      summary: `証明書は ${date} に期限が切れます(あと${left}日)`,
      why: `${date} を過ぎると、ブラウザに「この接続ではプライバシーが保護されません」という警告画面が出て、訪問者はページを見られなくなります。`,
      fix: '制作会社に「SSL証明書の自動更新が有効か確認してほしい」と依頼してください。',
      evidence: ev,
    };
  }
  return { ...t, status: 'ok', summary: `証明書は ${date} まで有効です(あと${left}日)`, why: '', fix: '', evidence: ev };
}

function checkHttpsRedirect(page) {
  const t = { key: 'https_redirect', title: 'HTTPSへの自動転送' };
  const probe = page.httpProbe || null;
  const host = hostOf(page.finalUrl);
  // 転送を直接観測した、または http:// への実アクセスで https への転送を確認できた
  if (page.httpToHttps || (probe && probe.result === 'redirects_to_https')) {
    const chain = page.httpToHttps ? page.redirectChain : (probe.chain || []);
    return { ...t, status: 'ok', summary: `http://${host}/ を開くと、https に自動で切り替わります`, why: '', fix: '', evidence: `転送を確認(${chain.map((h) => h.status).filter((x) => x).join('→')})` };
  }
  if (page.finalUrl.startsWith('https:')) {
    if (probe && probe.result === 'serves_http' && probe.status >= 200 && probe.status < 300) {
      // https のサイトで実際に問題がある唯一のケース(http のままページが表示された=2xx のときだけ。403/500 などは中身が出ていないので指摘しない)
      return {
        ...t, status: 'warn',
        summary: `http://${host}/ を開くと https に切り替わらず、そのまま暗号化なしで表示されます`,
        why: '古いリンクやブックマークから来た人は、暗号化されない状態で閲覧・問い合わせすることになります。',
        fix: '制作会社に「http→httpsへの常時リダイレクトを設定してほしい」と依頼してください。',
        evidence: `http://${host}/ が転送されずにHTTP ${probe.status} を返しました`,
      };
    }
    if (probe && probe.result === 'unreachable') {
      return { ...t, status: 'ok', summary: `http://${host}/ には接続できません(https だけで公開されています)`, why: '', fix: '', evidence: `http://${host}/ へ接続できませんでした` };
    }
    // redirects_elsewhere / 調査データなし: 判断できないので指摘にしない
    const reason = !probe ? 'http 側の確認データがないため'
      : probe.result === 'serves_http' ? `http://${host}/ が HTTP ${probe.status} を返し、ページの中身が見られなかったため`
      : `http://${host}/ の転送先が別のサイトだったため`;
    return { ...t, status: 'unknown', summary: `確認できませんでした(${reason})`, evidence: probe ? `http://${host}/ の転送先: ${probe.result}` : 'http側の確認データなし' };
  }
  return {
    ...t, status: 'bad',
    summary: 'このサイトは https に対応していません',
    why: 'Chrome では住所欄に「保護されていない通信」と表示されます。フォームの入力内容も暗号化されずに送られます。',
    fix: '制作会社に「SSL証明書を入れて、サイト全体を https にしてほしい」と依頼してください。',
    evidence: `最終URL: ${page.finalUrl}`,
  };
}

function checkTlsVersion(page) {
  const t = { key: 'tls_version', title: '古い暗号方式(TLS)の利用' };
  if (!page.tls || !page.tls.protocol) {
    return { ...t, status: 'unknown', summary: '確認できませんでした(接続時の暗号方式を取得できなかったため)', evidence: '' };
  }
  const proto = page.tls.protocol; // 'TLSv1.3' など
  const ev = `接続時の暗号方式: ${proto}`;
  if (proto === 'TLSv1.3' || proto === 'TLSv1.2') {
    return { ...t, status: 'ok', summary: `サーバーは ${proto}(新しい暗号方式)で接続しました`, why: '', fix: '', evidence: ev };
  }
  return {
    ...t, status: 'warn',
    summary: `サーバーが ${proto}(古い暗号方式)で接続しました`,
    why: '主要ブラウザは TLS1.0/1.1 を2020年に廃止しており、新しいブラウザでは開けないことがあります。カード業界の基準でも使用禁止です。',
    fix: '制作会社に「TLS1.2以上だけを有効にしてほしい」と依頼してください。',
    evidence: ev,
  };
}

/* ---- 設定(ヘッダー) ---- */

function checkSecurityHeaders(page) {
  const t = { key: 'headers', title: 'セキュリティ用ヘッダー設定' };
  const h = page.headers || {};
  const items = [
    { k: 'strict-transport-security', label: 'HSTS', jp: 'https固定(HSTS)', why: '一度 https で来た人も、次回 http に誘導される余地が残ります。' },
    { k: 'x-frame-options', label: 'クリックジャッキング対策', jp: 'クリックジャッキング対策', why: '他人のサイトに御社のページを透明に重ね、意図しないボタンを押させる手口に使えます。',
      altHas: !!h['content-security-policy'] && /frame-ancestors/i.test(h['content-security-policy'] || '') },
    { k: 'content-security-policy', label: 'CSP', jp: '不正スクリプトの実行制限(CSP)', why: '万一ページに不正なスクリプトが入り込んだとき、ブラウザ側で止める仕組みがありません。' },
    { k: 'x-content-type-options', label: 'MIMEスニッフィング対策', jp: 'MIMEスニッフィング対策', why: 'アップロードされたファイルが、ブラウザでプログラムとして実行される余地があります。' },
  ];
  const missing = [];
  const present = [];
  for (const it of items) {
    if (h[it.k] || it.altHas) present.push(it); else missing.push(it);
  }
  const ev = `設定あり: ${present.map((i) => i.label).join('、') || 'なし'} / 未設定: ${missing.map((i) => i.label).join('、') || 'なし'}`;
  if (missing.length === 0) return { ...t, status: 'ok', summary: `ブラウザへの防御指示 ${items.length}つすべてが設定されています`, why: '', fix: '', evidence: ev };
  const summary = missing.length === items.length
    ? `ブラウザへの防御指示 ${items.length}つがすべて未設定です(${missing.map((i) => i.jp).join('、')})`
    : `ブラウザへの防御指示 ${items.length}つのうち ${missing.length}つが未設定です(未設定: ${missing.map((i) => i.jp).join('、')})`;
  const why = missing.slice(0, 3).map((i) => i.why).join('');
  const names = missing.map((i) => i.label).join('・');
  if (missing.length <= 2) return { ...t, status: 'warn', summary, why, fix: `制作会社に「${names} のレスポンスヘッダーを追加してほしい」と依頼してください。`, evidence: ev };
  return { ...t, status: 'bad', summary, why, fix: `制作会社に「${names} のヘッダーを追加してほしい」と依頼してください。`, evidence: ev };
}

function checkCookies(page) {
  const t = { key: 'cookies', title: 'Cookie(クッキー)の保護設定' };
  const raw = page.headers && page.headers['set-cookie'];
  if (!raw || !raw.length) {
    return { ...t, status: 'ok', summary: 'トップページでは Cookie は発行されていません', why: '', fix: '', evidence: 'Set-Cookieヘッダーなし' };
  }
  const list = Array.isArray(raw) ? raw : [raw];
  const weak = []; // 保護設定が足りない Cookie { name, noSecure, noHttpOnly }
  for (const c of list) {
    const noSecure = !/;\s*secure/i.test(c);
    const noHttpOnly = !/;\s*httponly/i.test(c);
    if (noSecure || noHttpOnly) weak.push({ name: String(c).split(';')[0].split('=')[0].trim() || '(名前なし)', noSecure, noHttpOnly });
  }
  const insecure = weak.length;
  const ev = `Cookie ${list.length}件中、Secure/HttpOnly不足: ${insecure}件`;
  if (insecure === 0) return { ...t, status: 'ok', summary: `Cookie ${list.length}件はすべて Secure・HttpOnly が付いています`, why: '', fix: '', evidence: ev };
  const names = [...new Set(weak.map((w) => w.name))];
  const why = [
    weak.some((w) => w.noSecure) ? '暗号化されていない通信でも送られ、途中で盗み見られる可能性があります。' : '',
    weak.some((w) => w.noHttpOnly) ? 'ページに入り込んだ不正なスクリプトから読み取られる可能性があります。' : '',
  ].join('');
  return {
    ...t, status: 'warn',
    summary: `保護設定のない Cookie が ${insecure}件あります(${names.slice(0, 3).join('、')}${names.length > 3 ? ' など' : ''})`,
    why,
    fix: '制作会社に「CookieにSecureとHttpOnly属性を付けてほしい」と依頼してください。',
    evidence: ev,
  };
}

// 混在コンテンツ: ページが「実際に読み込む」部品だけを数える(リンク <a href> やメタ情報は読み込みではない)
const MIXED_KIND_ORDER = ['form', 'script', 'css', 'embed', 'image', 'media'];
const MIXED_LABEL = { image: '画像', script: 'スクリプト', css: 'CSS', embed: '埋め込み', media: '動画・音声', form: 'フォームの送信先' };

function attrOf(attrs, name) {
  const m = attrs.match(new RegExp(`(?:^|[\\s"'/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'));
  return m ? (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]).trim() : '';
}
function srcsetUrls(v) {
  return String(v || '').split(',').map((c) => c.trim().split(/\s+/)[0]).filter(Boolean);
}
/** 実在しそうな http:// の URL だけ返す(ホスト名にドットが無い http://about 等は実在しないので除外) */
function insecureUrl(u) {
  if (!/^http:\/\//i.test(u)) return null;
  try {
    const p = new URL(u);
    return p.hostname.includes('.') ? u : null;
  } catch { return null; }
}
function linkKind(rel, as) {
  const tokens = rel.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.includes('stylesheet')) return 'css';
  if (tokens.some((x) => /icon$/.test(x))) return 'image';
  if (tokens.includes('modulepreload') || tokens.includes('manifest')) return 'script';
  if (tokens.includes('preload')) {
    const a = as.toLowerCase();
    if (a === 'style') return 'css';
    if (a === 'image') return 'image';
    if (a === 'video' || a === 'audio' || a === 'track') return 'media';
    if (a === 'document' || a === 'iframe' || a === 'embed' || a === 'object') return 'embed';
    return 'script';
  }
  return null; // canonical / alternate / dns-prefetch など(読み込みではない)
}
function findInsecureLoads(html) {
  const body = String(html || '').replace(/<!--[\s\S]*?-->/g, '');
  const found = [];
  const seen = new Set();
  const add = (kind, u) => {
    const url = insecureUrl(u);
    if (!url) return;
    const key = kind + ' ' + url;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ kind, url });
  };
  for (const m of body.matchAll(/<(img|script|iframe|link|video|audio|source|track|embed|object|form)\b([^>]*)>/gi)) {
    const tag = m[1].toLowerCase();
    const a = m[2];
    if (tag === 'img') { add('image', attrOf(a, 'src')); srcsetUrls(attrOf(a, 'srcset')).forEach((u) => add('image', u)); }
    else if (tag === 'source') { add('media', attrOf(a, 'src')); srcsetUrls(attrOf(a, 'srcset')).forEach((u) => add('image', u)); }
    else if (tag === 'script') add('script', attrOf(a, 'src'));
    else if (tag === 'iframe' || tag === 'embed') add('embed', attrOf(a, 'src'));
    else if (tag === 'object') add('embed', attrOf(a, 'data'));
    else if (tag === 'video' || tag === 'audio' || tag === 'track') add('media', attrOf(a, 'src'));
    else if (tag === 'form') add('form', attrOf(a, 'action'));
    else if (tag === 'link') { const k = linkKind(attrOf(a, 'rel'), attrOf(a, 'as')); if (k) add(k, attrOf(a, 'href')); }
  }
  found.sort((x, y) => MIXED_KIND_ORDER.indexOf(x.kind) - MIXED_KIND_ORDER.indexOf(y.kind));
  return found;
}

function checkMixedContent(page) {
  const t = { key: 'mixed', title: '混在コンテンツ(http読み込み)' };
  if (!page.finalUrl.startsWith('https:')) {
    return { ...t, status: 'unknown', summary: '確認できませんでした(このサイトは https ではないため、対象外です)', evidence: '' };
  }
  const found = findInsecureLoads(page.body);
  if (!found.length) return { ...t, status: 'ok', summary: 'http で読み込んでいる部品はありませんでした', why: '', fix: '', evidence: '' };

  const ev = found.slice(0, 5).map((f) => `${MIXED_LABEL[f.kind]}: ${f.url}`).join(' / ') + (found.length > 5 ? ` / ほか ${found.length - 5}件` : '');
  const count = {};
  found.forEach((f) => { count[f.kind] = (count[f.kind] || 0) + 1; });
  const forms = found.filter((f) => f.kind === 'form');
  const loads = found.filter((f) => f.kind !== 'form');
  const hasActive = !!(count.script || count.css || count.embed);

  const parts = [];
  if (forms.length) {
    parts.push(forms.length === 1
      ? `問い合わせフォームの送信先が ${forms[0].url} になっています(暗号化されない送信先)`
      : `フォームの送信先 ${forms.length}件が http:// になっています(例: ${forms[0].url})`);
  }
  if (loads.length) {
    const kinds = MIXED_KIND_ORDER.filter((k) => k !== 'form' && count[k]).map((k) => `${MIXED_LABEL[k]} ${count[k]}件`).join('・');
    parts.push(`${kinds}を http:// で読み込んでいます(例: ${loads[0].url})`);
  }
  const whys = [];
  if (forms.length) whys.push('フォームに入力された氏名・電話番号・相談内容が、暗号化されないまま送られます。同じWi-Fiにいる第三者が読み取れる状態です。');
  if (hasActive) whys.push('ChromeやSafariはこの読み込みを自動で止めるため、その部分が表示されない・動かない状態になっている可能性が高いです。止められない古いブラウザでは、通信途中で中身を書き換えられる恐れがあります。');
  if (!forms.length && !hasActive) whys.push('ブラウザのアドレス欄の鍵マークが外れ、「保護されていない通信」と表示されることがあります。');
  return {
    ...t,
    status: (forms.length || hasActive) ? 'bad' : 'warn',
    summary: parts.join('。ほか、'),
    why: whys.join(''),
    fix: '制作会社に「次のURLを https:// に書き換えてほしい」と依頼してください。',
    evidence: ev,
  };
}

/* ---- ソフト ---- */

function checkCmsExposure(page) {
  const t = { key: 'cms', title: 'CMS(WordPress等)のバージョン露出' };
  const body = page.body || '';
  const h = page.headers || {};
  const found = [];
  const names = []; // summary 用の「ソフト名 版」
  const gen = body.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i);
  if (gen) { found.push(`generatorタグ: ${gen[1]}`); names.push(gen[1]); }
  // WordPress本体のバージョンが分かる wp-includes 配下の ?ver= のみを対象(プラグインのver=は対象外)
  const wpVer = body.match(/wp-includes\/[^"'\s]+\?ver=(\d+\.\d+(?:\.\d+)?)/);
  const isWp = /wp-content|wp-includes/i.test(body);
  if (isWp && wpVer) { found.push(`WordPress関連バージョン: ${wpVer[1]}`); if (!gen) names.push(`WordPress ${wpVer[1]}`); }
  if (h['x-powered-by']) { found.push(`X-Powered-By: ${h['x-powered-by']}`); names.push(String(h['x-powered-by'])); }
  if (h['server'] && /\/\d/.test(h['server'])) { found.push(`Server: ${h['server']}`); names.push(String(h['server'])); }

  if (!found.length) {
    return { ...t, status: 'ok', summary: 'ソフト名や版数は外から見えていません', why: '', fix: '', evidence: isWp ? 'WordPressと推定されるがバージョン露出なし' : '露出なし' };
  }
  return {
    ...t, status: 'warn',
    summary: `ページや通信の応答にソフト名と版が書かれています(${names.slice(0, 2).join('、')}${names.length > 2 ? ' など' : ''})`,
    why: '攻撃者はこの版数から、使える弱点があるかすぐ調べられます。',
    fix: '制作会社に「generatorタグやX-Powered-Byなどのバージョン表示を隠し、本体・プラグインを最新に更新してほしい」と依頼してください。',
    evidence: found.join(' / '),
  };
}

/* ---- PHPの版(X-Powered-By に出ている場合のみ。外から見えるものだけで判定) ---- */

function checkPhpVersion(page) {
  const t = { key: 'php', title: 'PHP(サイトを動かす部品)の版' };
  const h = page.headers || {};
  const raw = h['x-powered-by'];
  const raws = Array.isArray(raw) ? raw.join(', ') : raw;
  const v = PV.parsePhpVersion(raws);
  if (!v) return { ...t, status: 'unknown', summary: 'PHPの版は外部から確認できませんでした', why: '', fix: '', evidence: '' };
  const evidence = `X-Powered-By: ${raws}`;
  const c = PV.classifyPhp(v);
  if (c.kind === 'eol') {
    return {
      ...t, status: 'bad',
      summary: `表示されているPHPの版(${v.text})は公式サポートが終了した版です`,
      why: '10月に公表された深刻な脆弱性(悪用が確認されています)について、この版には公式の修正が提供されていません。提供元が独自に修正を適用している場合もあります。',
      fix: 'サーバーの提供元・制作会社に、PHPのサポート中の版(8.3以降など)への更新を依頼してください。',
      evidence,
    };
  }
  if (c.kind === 'unpatched') {
    return {
      ...t, status: 'bad',
      summary: `表示されているPHPの版(${v.text})は、${PV.DISCLOSED_JA}の修正が入る前の版です`,
      why: '10月に公表された深刻な脆弱性は実際に悪用が確認されています。提供元が修正を取り込んでいて、表示される版は古いままの場合もあります。',
      fix: `サーバーの提供元・制作会社に、PHP ${c.fixed}以降への更新、または修正の適用状況の確認を依頼してください。`,
      evidence,
    };
  }
  return {
    ...t, status: 'ok',
    summary: `表示されているPHPの版(${v.text})は修正済みの版です`,
    why: '', fix: '',
    evidence: `${evidence}(版の表示そのものは「CMSのバージョン露出」の項目で扱います)`,
  };
}

// 既知の脆弱性が修正された最初の版(これ未満を「古い」と判定)と、why に出す CVE と一言説明
const LIB_SAFE = {
  'jQuery': [3, 5, 0],      // CVE-2020-11022/11023 (XSS)
  'jQuery UI': [1, 13, 0],  // CVE-2021-41182 ほか (XSS)
  'Bootstrap': [3, 4, 1],   // CVE-2019-8331 (XSS) ※4系は4.3.1以上
};
const LIB_CVE = {
  'jQuery': { cve: 'CVE-2020-11022/11023', what: '入力欄などを経由して不正なスクリプトが動く' },
  'jQuery UI': { cve: 'CVE-2021-41182 ほか', what: '日付選択などの部品を経由して不正なスクリプトが動く' },
  'Bootstrap': { cve: 'CVE-2019-8331', what: 'ツールチップなどの部品を経由して不正なスクリプトが動く' },
};
function safeVerLabel(name, ver) {
  if (name === 'Bootstrap' && /^4\./.test(ver)) return '4.3.1';
  return LIB_SAFE[name].join('.');
}
function verLess(v, safe) {
  const a = v.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== safe[i]) return (a[i] || 0) < safe[i]; }
  return false;
}
function isOld(name, ver) {
  if (name === 'Bootstrap' && /^4\./.test(ver)) return verLess(ver, [4, 3, 1]);
  if (name === 'Bootstrap' && /^[5-9]\./.test(ver)) return false;
  return verLess(ver, LIB_SAFE[name]);
}
// script src からライブラリ名を判定
function libNameOf(src) {
  const s = src.toLowerCase();
  if (/migrate/.test(s)) return null;
  if (/jquery-?ui|jqueryui/.test(s)) return 'jQuery UI';
  if (/bootstrap[^/]*\.js|\/bootstrap\/|bootstrap@/.test(s)) return 'Bootstrap';
  if (/(^|\/)jquery([-.@][\d.]+)?(\.min|\.slim|\.slim\.min)?\.js|\/jquery\/\d|jquery@\d/.test(s)) return 'jQuery';
  return null;
}
// URL(パス・?ver=)から版数を取り出す
function verFromUrl(src) {
  const path = src.split(/[?#]/)[0];
  const m = path.match(/(?:[\/@-]|jquery|bootstrap|ui)v?(\d+\.\d+(?:\.\d+)?)(?=[\/.-]|$)/i);
  if (m) return m[1];
  const q = src.match(/[?&]ver=(\d+\.\d+(?:\.\d+)?)/);
  return q ? q[1] : null;
}
// ファイル先頭のコメントから版数を読む
function verFromHead(name, text) {
  const re = {
    'jQuery': /jQuery(?: JavaScript Library)? v?(\d+\.\d+\.\d+)/,
    'jQuery UI': /jQuery UI - v?(\d+\.\d+\.\d+)/,
    'Bootstrap': /Bootstrap v?(\d+\.\d+\.\d+)/,
  }[name];
  const m = re && text.match(re);
  return m ? m[1] : null;
}


async function checkOldJsLibs(page) {
  const t = { key: 'js_libs', title: '古いJavaScriptライブラリ' };
  const body = page.body || '';
  const srcs = [...body.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const findings = [];
  const seen = new Set();
  let headReads = 0;
  for (const raw of srcs) {
    const name = libNameOf(raw);
    if (!name || seen.has(name)) continue;
    let abs;
    try { abs = new URL(raw, page.finalUrl).toString(); } catch { continue; }
    let ver = verFromUrl(abs);
    let how = 'URL';
    if (!ver && headReads < 3) {
      headReads++;
      const { fetchHead } = require('./safeFetch');
      const head = await fetchHead(abs);
      ver = verFromHead(name, head);
      how = 'ファイル先頭';
    }
    if (!ver) continue;
    seen.add(name);
    findings.push({ name, ver, old: isOld(name, ver), how, url: abs });
  }
  if (!findings.length) {
    return { ...t, status: 'unknown', summary: '確認できませんでした(jQuery・Bootstrap等の主要ライブラリが見つからない、または版数を特定できなかったため)', evidence: 'ページから読み込まれる主要ライブラリが見つからない、または版数を特定できませんでした' };
  }
  const olds = findings.filter((f) => f.old);
  const ev = findings.map((f) => `${f.name} ${f.ver}${f.old ? '(古い・既知の脆弱性あり)' : ''}`).join(' / ');
  if (!olds.length) return { ...t, status: 'ok', summary: `${findings.map((f) => `${f.name} ${f.ver}`).join('・')} は、既知の弱点が修正された版です`, why: '', fix: '', evidence: ev };
  return {
    ...t, status: 'warn',
    summary: `${olds.map((f) => `${f.name} ${f.ver}`).join('・')} を使っています(${olds[0].url})`,
    why: olds.slice(0, 2).map((f) => `${f.name} ${safeVerLabel(f.name, f.ver)} 未満には公表済みの弱点(${LIB_CVE[f.name].cve}: ${LIB_CVE[f.name].what})があります。`).join(''),
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
  if (list.length === 0) return { ...t, status: 'ok', summary: '外部サービスからプログラムを読み込んでいません', why: '', fix: '', evidence: ev };
  const summary = `${list.length}か所の外部サービスからプログラムを読み込んでいます(例: ${list.slice(0, 3).join('、')})`;
  if (list.length <= 8) return { ...t, status: 'ok', summary, why: '', fix: '', evidence: ev };
  return {
    ...t, status: 'warn',
    summary,
    why: 'このうち1つでも乗っ取られると、御社サイトを見た人の入力内容が抜き取られる経路になります。',
    fix: '制作会社に「不要なタグ(過去の計測・広告タグ等)を整理し、読み込み先を見直してほしい」と依頼してください。',
    evidence: ev,
  };
}

/* ---- メール ---- */

async function checkMailSpoofing(page) {
  const t = { key: 'mail', title: 'メールのなりすまし対策(SPF/DMARC)' };
  let host = '';
  try { host = new URL(page.finalUrl).hostname.replace(/^www\./, ''); } catch {}
  if (!host) return { ...t, status: 'unknown', summary: '確認できませんでした(ドメインを特定できなかったため)', evidence: '' };

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
    return { ...t, status: 'ok', summary: `SPF と DMARC(p=${dmarcPolicy})が登録されています`, why: '', fix: '', evidence: ev };
  }
  if (!spf && !dmarc) {
    return {
      ...t, status: 'bad',
      summary: `「info@${host}」のように御社のドメインを名乗るメールを、誰でも送れる状態です(SPF・DMARC どちらも未登録)`,
      why: '取引先に御社名義で「振込先変更」などの偽メールが届いても、受け取る側のメールソフトは偽物と判定できません。',
      fix: 'ドメイン管理会社に「SPFとDMARCのレコードを設定してほしい」と依頼してください。',
      evidence: ev,
    };
  }
  if (spf && !dmarc) {
    return {
      ...t, status: 'warn',
      summary: 'SPF は登録されていますが、DMARC が未登録です(偽のメールを拒否するよう受信側に伝える設定がありません)',
      why: `「info@${host}」を名乗る偽メールが届いても、受信側は御社が拒否を望んでいるか分からず、そのまま受信箱に入れてしまうことがあります。`,
      fix: 'ドメイン管理会社に「DMARCレコードを追加してほしい」と依頼してください。',
      evidence: ev,
    };
  }
  if (!spf && dmarc) {
    return {
      ...t, status: 'warn',
      summary: 'DMARC は登録されていますが、SPF が未登録です(御社のメールを送ってよいサーバーの一覧がありません)',
      why: '受信側が「このメールは御社のサーバーから送られたか」を確認できないため、偽メールと見分けられず、正規のメールまで迷惑メール扱いされることがあります。',
      fix: 'ドメイン管理会社に「SPFレコードを設定してほしい」と依頼してください。',
      evidence: ev,
    };
  }
  // SPF・DMARC ともにあるが、DMARC が p=none など(拒否・隔離しない)
  return {
    ...t, status: 'warn',
    summary: `DMARC は p=${dmarcPolicy || '不明'} です${dmarcPolicy === 'none' ? '(見張るだけで偽メールを止めない設定)' : '(偽メールを拒否・隔離する設定ではありません)'}`,
    why: '偽メールの送信は記録されるだけで、受け取る側では止まりません。取引先に偽メールが届く状況は変わりません。',
    fix: 'ドメイン管理会社に「DMARCのポリシーをp=quarantineまたはrejectへ強化してほしい」と依頼してください。',
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
    checkPhpVersion(page),
    checkExternalScripts(page),
  ];
  const jsLibs = await checkOldJsLibs(page);
  const mail = await checkMailSpoofing(page);
  sync.splice(8, 0, jsLibs); // 表示順を従来どおりに
  const results = [...sync, mail];

  // 解決方法の区分: site=ホームページのリニューアルで解消 / dns=ドメイン(メール)設定が別途必要
  const REMEDY = {
    cert: 'site', https_redirect: 'site', tls_version: 'site',
    headers: 'site', cookies: 'site', mixed: 'site',
    cms: 'site', php: 'site', js_libs: 'site', ext_scripts: 'site',
    mail: 'dns',
  };
  results.forEach((r) => { r.remedy = REMEDY[r.key] || 'site'; });

  const counts = results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  const { score, grade } = scoreOf(results);
  return { results, counts, score, grade };
}

module.exports = { runChecks, checkPhpVersion, scoreOf };
