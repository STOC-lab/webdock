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
  c = await redirOf({ httpProbe: { result: 'unreachable', error: 'x' } });
  ok(c.status==='ok' && c.summary==='httpでの接続は受け付けていません(問題ありません)', 'redirect: unreachable -> ok');
  c = await redirOf({ httpProbe: { result: 'redirects_elsewhere', chain: [] } });
  ok(c.status==='unknown' && c.summary==='自動転送を確認できませんでした', 'redirect: redirects_elsewhere -> unknown');
  c = await redirOf({});
  ok(c.status==='unknown', 'redirect: https開始で調査データなし -> unknown(旧: warn)');
  c = await redirOf({ finalUrl: 'http://a.example.jp/' });
  ok(c.status==='bad', 'redirect: httpのまま -> bad');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
