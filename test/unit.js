'use strict';
const assert = require('assert');
const { isBlockedIp, probeHttpRedirect, withHttpProbe, sameSiteHost } = require('../src/safeFetch');
const { runChecks } = require('../src/checks');

let pass = 0, fail = 0;
function ok(cond, msg){ if(cond){pass++;} else {fail++; console.log('  ✗ '+msg);} }

// ---- SSRF: ブロックすべきIP ----
const blocked = ['127.0.0.1','0.0.0.0','10.0.0.5','192.168.1.1','172.16.5.5','172.31.255.255',
  '169.254.169.254','100.64.0.1','198.18.0.1','203.0.113.5','224.0.0.1','::1','fe80::1','fc00::1','::ffff:127.0.0.1','::ffff:10.0.0.1'];
blocked.forEach(ip => ok(isBlockedIp(ip)===true, 'should block '+ip));

// ---- SSRF: 許可すべきグローバルIP ----
const allowed = ['8.8.8.8','1.1.1.1','162.43.32.37','93.184.216.34','2001:4860:4860::8888'];
allowed.forEach(ip => ok(isBlockedIp(ip)===false, 'should allow '+ip));

(async () => {
  // ---- 良いサイトのモック ----
  const goodPage = {
    finalUrl:'https://good.example.co.jp/', httpToHttps:true,
    redirectChain:[{url:'http://good.example.co.jp/',status:301},{url:'https://good.example.co.jp/',status:200}],
    status:200,
    tls:{authorized:true, protocol:'TLSv1.3', validTo:new Date(Date.now()+200*864e5).toUTCString(), validFrom:new Date().toUTCString(), subjectCN:'good.example.co.jp'},
    headers:{
      'content-security-policy':"default-src 'self'", 'x-frame-options':'DENY',
      'strict-transport-security':'max-age=63072000','x-content-type-options':'nosniff',
      'set-cookie':['sid=abc; Secure; HttpOnly; Path=/'],
    },
    body:'<html><head><meta charset="utf-8"></head><body><script src="/js/app.js"></script><img src="https://good.example.co.jp/a.png"></body></html>',
  };
  const good = await runChecks(goodPage);
  console.log('GOOD grade=%s score=%s counts=%j', good.grade, good.score, good.counts);
  ok(good.results.length===10, 'good: 10 items');
  ok(good.grade==='A'||good.grade==='B', 'good: high grade (got '+good.grade+')');

  // ---- 悪いサイトのモック ----
  const badPage = {
    finalUrl:'https://bad.example.co.jp/', httpToHttps:false,
    redirectChain:[{url:'https://bad.example.co.jp/',status:200}],
    status:200,
    tls:{authorized:false, authorizationError:'CERT_HAS_EXPIRED', protocol:'TLSv1', validTo:new Date(Date.now()-5*864e5).toUTCString(), validFrom:new Date(Date.now()-400*864e5).toUTCString(), subjectCN:'bad'},
    headers:{
      'x-powered-by':'PHP/5.6.1','server':'Apache/2.2.15',
      'set-cookie':['sid=abc; Path=/'],
    },
    body:'<html><head><meta name="generator" content="WordPress 4.8.1"></head><body>'+
         '<script src="https://a.com/x.js"></script><script src="/jquery-1.7.2.min.js"></script>'+
         '<img src="http://bad.example.co.jp/a.png"><script src="http://x.com/t.js"></script><link href="http://y.com/s.css">'+
         '<script src="https://b.com/1.js"></script><script src="https://c.com/2.js"></script><script src="https://d.com/3.js"></script>'+
         '<script src="https://e.com/4.js"></script><script src="https://f.com/5.js"></script><script src="https://g.com/6.js"></script>'+
         '<script src="https://h.com/7.js"></script><script src="https://i.com/8.js"></script></body></html>',
  };
  const bad = await runChecks(badPage);
  console.log('BAD  grade=%s score=%s counts=%j', bad.grade, bad.score, bad.counts);
  ok(bad.grade==='E'||bad.grade==='D', 'bad: low grade (got '+bad.grade+')');
  const byKey = Object.fromEntries(bad.results.map(r=>[r.key,r.status]));
  ok(byKey.cert==='bad', 'bad: cert expired -> bad');
  ok(byKey.https_redirect!=='ok', 'bad: no https redirect check');
  ok(byKey.tls_version==='warn', 'bad: old TLS -> warn');
  ok(byKey.mixed==='bad'||byKey.mixed==='warn', 'bad: mixed content flagged');
  ok(byKey.js_libs==='warn', 'bad: old jquery -> warn');
  ok(byKey.cms==='warn', 'bad: cms exposure -> warn');
  ok(byKey.ext_scripts==='warn', 'bad: many ext scripts -> warn');

  // ---- http→https 転送調査(probeHttpRedirect)。fakeHop で通信を差し替える ----
  const mkDeps = (script) => {
    // script: { 'http://host/': {status, location} | Error }
    const seen = [];
    return { seen, resolve: async () => '93.184.216.34', fetchOneHop: async (u) => {
      seen.push(u.toString());
      const r = script[u.toString()];
      if (!r) throw new Error('no route');
      if (r instanceof Error) throw r;
      return { status: r.status, location: r.location || null, headers: {}, body: '' };
    } };
  };
  const probe = (host, script) => probeHttpRedirect(host, mkDeps(script));
  let r;
  r = await probe('example.co.jp', { 'http://example.co.jp/': { status: 301, location: 'https://example.co.jp/' } });
  ok(r.result==='redirects_to_https', 'probe: 同一ホストhttps転送');
  r = await probe('example.co.jp', { 'http://example.co.jp/': { status: 301, location: 'https://www.example.co.jp/' } });
  ok(r.result==='redirects_to_https', 'probe: apex→www のhttps転送');
  r = await probe('www.example.co.jp', { 'http://www.example.co.jp/': { status: 302, location: 'https://example.co.jp/' } });
  ok(r.result==='redirects_to_https', 'probe: www→apex のhttps転送');
  r = await probe('example.co.jp', { 'http://example.co.jp/': { status: 301, location: 'http://www.example.co.jp/' }, 'http://www.example.co.jp/': { status: 301, location: 'https://www.example.co.jp/' } });
  ok(r.result==='redirects_to_https', 'probe: http→http(www)→https の2段転送');
  r = await probe('example.co.jp', { 'http://example.co.jp/': { status: 200 } });
  ok(r.result==='serves_http' && r.status===200, 'probe: 200 は serves_http');
  r = await probe('example.co.jp', { 'http://example.co.jp/': { status: 403 } });
  ok(r.result==='serves_http' && r.status===403, 'probe: 403 も serves_http');
  r = await probe('example.co.jp', { 'http://example.co.jp/': { status: 500 } });
  ok(r.result==='serves_http' && r.status===500, 'probe: 500 も serves_http');
  r = await probe('example.co.jp', { 'http://example.co.jp/': { status: 301, location: 'https://other.example.com/' } });
  ok(r.result==='redirects_elsewhere', 'probe: 別ドメインのhttpsは redirects_elsewhere');
  r = await probe('example.co.jp', { 'http://example.co.jp/': { status: 301, location: 'http://other.example.com/' } });
  ok(r.result==='redirects_elsewhere', 'probe: 別ドメインのhttpは redirects_elsewhere');
  r = await probe('example.co.jp', { 'http://example.co.jp/': { status: 301, location: 'https://notexample.co.jp/' } });
  ok(r.result==='redirects_elsewhere', 'probe: 似ているだけのホストは別扱い');
  r = await probe('example.co.jp', { 'http://example.co.jp/': new Error('ECONNREFUSED') });
  ok(r.result==='unreachable' && r.error, 'probe: 接続拒否は unreachable');
  r = await probe('example.co.jp', {});
  ok(r.result==='unreachable', 'probe: 失敗は unreachable');
  r = await probeHttpRedirect('example.co.jp', { resolve: async () => { throw new Error('この宛先は診断できません。'); }, fetchOneHop: async () => { throw new Error('呼ばれない'); } });
  ok(r.result==='unreachable', 'probe: 名前解決で拒否されたら unreachable(接続しない)');
  r = await probeHttpRedirect('127.0.0.1');
  ok(r.result==='unreachable', 'probe: IP直書きは拒否');
  { // 転送ループは MAX_REDIRECTS で打ち切り
    const d = mkDeps({ 'http://example.co.jp/': { status: 302, location: 'http://example.co.jp/' } });
    r = await probeHttpRedirect('example.co.jp', d);
    ok(r.result==='redirects_elsewhere' && d.seen.length<=6, 'probe: ループは打ち切り');
  }
  { // 転送先も毎回再検査(解決でブロックされたら止まる)
    let n = 0;
    r = await probeHttpRedirect('example.co.jp', { resolve: async (h) => { if (++n > 1) throw new Error('blocked'); return '93.184.216.34'; },
      fetchOneHop: async () => ({ status: 302, location: 'http://www.example.co.jp/', headers: {}, body: '' }) });
    ok(r.result==='redirects_elsewhere', 'probe: 2ホップ目の検査失敗');
  }
  ok(sameSiteHost('Example.co.jp','www.example.co.jp') && !sameSiteHost('a.jp','b.jp'), 'sameSiteHost');

  // ---- withHttpProbe: 調査が必要なときだけ呼ぶ ----
  { let called = 0; const fake = async (h) => { called++; return { result: 'serves_http', status: 200, chain: [], host: h }; };
    let pg = await withHttpProbe({ finalUrl: 'https://a.jp/', httpToHttps: false }, fake);
    ok(called===1 && pg.httpProbe.host==='a.jp', 'withHttpProbe: https開始なら調査');
    pg = await withHttpProbe({ finalUrl: 'https://a.jp/', httpToHttps: true }, fake);
    ok(called===1 && !pg.httpProbe, 'withHttpProbe: 転送観測済みなら調査しない');
    pg = await withHttpProbe({ finalUrl: 'http://a.jp/', httpToHttps: false }, fake);
    ok(called===1 && !pg.httpProbe, 'withHttpProbe: httpのままなら調査しない');
    pg = await withHttpProbe({ finalUrl: 'https://a.jp/', httpToHttps: false }, async () => { throw new Error('x'); });
    ok(!pg.httpProbe, 'withHttpProbe: 失敗しても例外にしない');
  }

  // ---- checkHttpsRedirect の各ケース(runChecks 経由) ----
  const redirOf = async (o) => (await runChecks({ finalUrl: 'https://a.example.jp/', httpToHttps: false, redirectChain: [{ url: 'https://a.example.jp/', status: 200 }],
    tls: null, headers: {}, body: '<html></html>', ...o })).results.find((x) => x.key === 'https_redirect');
  let c = await redirOf({ httpToHttps: true, redirectChain: [{ status: 301 }, { status: 200 }] });
  ok(c.status==='ok', 'redirect: httpToHttps true -> ok');
  c = await redirOf({ httpProbe: { result: 'redirects_to_https', chain: [{ status: 301 }, { status: null }] } });
  ok(c.status==='ok', 'redirect: probe redirects_to_https -> ok');
  c = await redirOf({ httpProbe: { result: 'serves_http', status: 200, chain: [] } });
  ok(c.status==='warn' && c.evidence==='http://a.example.jp/ が転送されずにHTTP 200 を返しました', 'redirect: serves_http -> warn + 証拠');
  c = await redirOf({ httpProbe: { result: 'serves_http', status: 403, chain: [] } });
  ok(c.status==='unknown', 'redirect: serves_http 403 は中身が出ていないので指摘しない(unknown)');
  c = await redirOf({ httpProbe: { result: 'unreachable', error: 'x' } });
  ok(c.status==='ok' && c.summary==='http://a.example.jp/ には接続できません(https だけで公開されています)', 'redirect: unreachable -> ok');
  c = await redirOf({ httpProbe: { result: 'redirects_elsewhere', chain: [] } });
  ok(c.status==='unknown' && c.summary==='確認できませんでした(http://a.example.jp/ の転送先が別のサイトだったため)', 'redirect: redirects_elsewhere -> unknown');
  c = await redirOf({});
  ok(c.status==='unknown', 'redirect: https開始で調査データなし -> unknown(旧: warn)');
  c = await redirOf({ finalUrl: 'http://a.example.jp/' });
  ok(c.status==='bad', 'redirect: httpのまま -> bad');


  // ---- 混在コンテンツ: ページが実際に読み込む http:// だけを数える ----
  const mixedOf = async (html, o) => (await runChecks({ finalUrl: 'https://a.example.jp/', httpToHttps: true, redirectChain: [], tls: null, headers: {}, body: html, ...o })).results.find((x) => x.key === 'mixed');
  let mx = await mixedOf('<a href="http://about">詳しく見る</a>');
  ok(mx.status==='ok' && mx.summary==='http で読み込んでいる部品はありませんでした', 'mixed: ドット無しホストのリンク(http://about)は0件');
  mx = await mixedOf('<a href="http://other.jp/">外部</a>');
  ok(mx.status==='ok', 'mixed: ただのリンクは0件');
  mx = await mixedOf('<img src="http://x.jp/a.jpg">');
  ok(mx.status==='warn' && mx.evidence==='画像: http://x.jp/a.jpg' && /鍵マーク/.test(mx.why) && /画像 1件/.test(mx.summary), 'mixed: img は warn');
  mx = await mixedOf('<script src="http://x.jp/a.js"></script>');
  ok(mx.status==='bad' && /自動で止める/.test(mx.why) && mx.summary==='スクリプト 1件を http:// で読み込んでいます(例: http://x.jp/a.js)', 'mixed: script は bad');
  mx = await mixedOf('<form action="http://x.jp/send" method="post"></form>');
  ok(mx.status==='bad' && mx.summary==='問い合わせフォームの送信先が http://x.jp/send になっています(暗号化されない送信先)' && /同じWi-Fi/.test(mx.why), 'mixed: form は bad');
  mx = await mixedOf('<link rel="stylesheet" href="http://x.jp/a.css">');
  ok(mx.status==='bad' && /^CSS: /.test(mx.evidence), 'mixed: stylesheet は bad');
  mx = await mixedOf('<link rel="canonical" href="http://x.jp/"><link rel="alternate" href="http://x.jp/en/"><meta property="og:image" content="http://x.jp/a.png">');
  ok(mx.status==='ok', 'mixed: canonical/alternate/meta は0件');
  mx = await mixedOf('<!-- <script src="http://x.jp/a.js"></script><img src="http://x.jp/b.png"> --><p>http://x.jp/c.png</p>');
  ok(mx.status==='ok', 'mixed: コメント内・本文中のURLは0件');
  mx = await mixedOf('<img src="/a.png" srcset="http://x.jp/a.png 1x, https://x.jp/b.png 2x"><picture><source srcset="http://x.jp/c.webp"></picture>');
  ok(mx.status==='warn' && /画像 2件/.test(mx.summary), 'mixed: srcset の http は数える');
  mx = await mixedOf('<img src="http://localhost/a.png"><script src="http://intranet/a.js"></script>');
  ok(mx.status==='ok', 'mixed: ドット無しホストは0件');
  mx = await mixedOf('<img src="http://x.jp/a.jpg">', { finalUrl: 'http://a.example.jp/' });
  ok(mx.status==='unknown', 'mixed: https でないページは unknown');
  mx = await mixedOf('<form action="http://x.jp/s"></form><script src="http://x.jp/1.js"></script><img src="http://x.jp/1.png"><img src="http://x.jp/2.png"><iframe src="http://x.jp/f"></iframe><video src="http://x.jp/v.mp4"></video><link rel="icon" href="http://x.jp/f.ico">');
  ok(mx.status==='bad' && mx.evidence.split(' / ').length===6 && mx.evidence.startsWith('フォームの送信先: http://x.jp/s / スクリプト: http://x.jp/1.js'), 'mixed: evidence は種類: URL を / 区切り');
  mx = await mixedOf(Array.from({ length: 7 }, (_, i) => `<img src="http://x.jp/${i}.png">`).join(''));
  ok(mx.evidence.endsWith(' / ほか 2件') && mx.evidence.split(' / ').length===6, 'mixed: 5件超は「ほか N件」');
  mx = await mixedOf('<script src="http://x.jp/a.js"></script><script src="http://x.jp/a.js"></script><img src="http://x.jp/a.png">');
  ok(/スクリプト 1件・画像 1件/.test(mx.summary), 'mixed: 同じURLは重複して数えない・summary は件数と種類');

  // ---- 文言: 事実+実際に起きること ----
  const itemOf = async (key, o) => (await runChecks({ finalUrl: 'https://a.example.jp/', httpToHttps: true, redirectChain: [], tls: null, headers: {}, body: '<html></html>', ...o })).results.find((x) => x.key === key);
  c = await itemOf('cert', { tls: { authorized: true, protocol: 'TLSv1.3', validTo: new Date(Date.now() + 125.4 * 864e5).toUTCString() } });
  ok(c.status==='ok' && /^証明書は \d{4}-\d{2}-\d{2} まで有効です\(あと125日\)$/.test(c.summary) && /残り125日/.test(c.evidence), 'cert: ok の文言と「残りN日」の維持');
  c = await itemOf('cert', { tls: { authorized: false, authorizationError: 'CERT_HAS_EXPIRED', protocol: 'TLSv1.3', validTo: new Date(Date.now() - 5 * 864e5).toUTCString() } });
  ok(c.status==='bad' && /5日前/.test(c.summary) && /プライバシーが保護されません/.test(c.why) && /残り-5日/.test(c.evidence), 'cert: 期限切れの文言');
  c = await itemOf('tls_version', { tls: { protocol: 'TLSv1', authorized: true, validTo: new Date().toUTCString() } });
  ok(c.summary==='サーバーが TLSv1(古い暗号方式)で接続しました' && /2020年に廃止/.test(c.why), 'tls: 文言');
  c = await itemOf('headers', { headers: { 'x-content-type-options': 'nosniff' } });
  ok(c.status==='bad' && c.summary==='ブラウザへの防御指示 4つのうち 3つが未設定です(未設定: https固定(HSTS)、クリックジャッキング対策、不正スクリプトの実行制限(CSP))' && c.why.split('。').length===4, 'headers: 未設定を列挙・whyは最大3文');
  c = await itemOf('cookies', { headers: { 'set-cookie': ['PHPSESSID=abc; path=/', 'a=1; Secure', 'b=2; HttpOnly; Secure'] } });
  ok(c.status==='warn' && c.summary==='保護設定のない Cookie が 2件あります(PHPSESSID、a)' && /暗号化されていない通信/.test(c.why) && /不正なスクリプト/.test(c.why), 'cookies: 名前と不足属性');
  c = await itemOf('cookies', { headers: { 'set-cookie': ['a=1; Secure'] } });
  ok(!/暗号化されていない通信/.test(c.why) && /不正なスクリプト/.test(c.why), 'cookies: 欠けている属性(HttpOnlyのみ)の文だけ出す');
  c = await itemOf('cms', { body: '<meta name="generator" content="WordPress 6.2.2">' });
  ok(c.status==='warn' && /WordPress 6\.2\.2/.test(c.summary) && /版数から/.test(c.why), 'cms: 文言');
  c = await itemOf('ext_scripts', { body: Array.from({ length: 9 }, (_, i) => `<script src="https://s${i}.com/a.js"></script>`).join('') });
  ok(c.status==='warn' && c.summary==='9か所の外部サービスからプログラムを読み込んでいます(例: s0.com、s1.com、s2.com)', 'ext_scripts: 文言');
  c = await itemOf('js_libs', { body: '<script src="/js/jquery-1.7.2.min.js"></script>' });
  ok(c.status==='warn' && c.summary==='jQuery 1.7.2 を使っています(https://a.example.jp/js/jquery-1.7.2.min.js)' && /CVE-2020-11022\/11023/.test(c.why) && /3\.5\.0 未満/.test(c.why), 'js_libs: 版・URL・CVE');
  c = await itemOf('https_redirect', { httpToHttps: false, httpProbe: { result: 'serves_http', status: 200, chain: [] } });
  ok(c.summary==='http://a.example.jp/ を開くと https に切り替わらず、そのまま暗号化なしで表示されます' && /古いリンクやブックマーク/.test(c.why), 'https_redirect: warn 文言');
  c = await itemOf('https_redirect', { httpToHttps: false, finalUrl: 'http://a.example.jp/' });
  ok(c.summary==='このサイトは https に対応していません' && /保護されていない通信/.test(c.why), 'https_redirect: bad 文言');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
