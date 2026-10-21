'use strict';
const assert = require('assert');
const { isBlockedIp } = require('../src/safeFetch');
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
