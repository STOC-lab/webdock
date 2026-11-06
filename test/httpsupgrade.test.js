'use strict';
// http:// 入力 → https への昇格(withHttpProbe)のテスト。ネットワーク不要(fetchHomepage はモック)
const { withHttpProbe } = require('../src/safeFetch');
const { runChecks } = require('../src/checks');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}

const tls = { authorized: true, protocol: 'TLSv1.3', validTo: new Date(Date.now() + 200 * 864e5).toUTCString(), validFrom: new Date().toUTCString(), subjectCN: 'decollte.jp' };
const httpPage = (status = 200) => ({ finalUrl: 'http://decollte.jp/a?b=1', status, headers: {}, body: '<html></html>', tls: null, redirectChain: [{ url: 'http://decollte.jp/a?b=1', status }], httpToHttps: false });
const httpsPage = (o = {}) => ({ finalUrl: 'https://decollte.jp/a?b=1', status: 200, headers: {}, body: '<html></html>', tls, redirectChain: [{ url: 'https://decollte.jp/a?b=1', status: 200 }], httpToHttps: false, ...o });
const mk = (fn) => { const calls = []; return { calls, deps: { fetchHomepage: async (u) => { calls.push(u); return fn(u); } } }; };
const httpsCheck = async (page) => (await runChecks(page, {})).results.find((c) => c.key === 'https_redirect');
const noProbe = async () => { throw new Error('probe は呼ばれないはず'); };

(async () => {
  // http 200 + https 200
  let m = mk(() => httpsPage());
  let r = await withHttpProbe(httpPage(), noProbe, m.deps);
  eq(m.calls, ['https://decollte.jp/a?b=1'], '同じパス+クエリで https を取得');
  eq(r.finalUrl, 'https://decollte.jp/a?b=1', 'https の page を返す');
  eq(r.httpProbe, { result: 'serves_http', status: 200, chain: [{ url: 'http://decollte.jp/a?b=1', status: 200 }] }, 'httpProbe');
  eq(r.upgradedFromHttp, true, 'upgradedFromHttp');
  eq(r.originalHttpUrl, 'http://decollte.jp/a?b=1', 'originalHttpUrl');
  let c = await httpsCheck(r);
  eq(c.status, 'warn', 'warn');
  eq(c.evidence.includes('入力された http:// のURLでは転送されず'), true, 'evidence');

  // http 200 + https 例外
  m = mk(() => { throw new Error('証明書が無効です'); });
  let p = httpPage();
  r = await withHttpProbe(p, noProbe, m.deps);
  eq(r === p && r.finalUrl.startsWith('http:'), true, '元の http page');
  eq(r.httpsUpgradeError, '証明書が無効です', 'httpsUpgradeError');
  c = await httpsCheck(r);
  eq(c.status, 'bad', 'bad');
  eq(c.evidence.includes('https:// でも接続を試しましたが表示できませんでした(証明書が無効です)'), true, '試行した旨');

  // https 404
  m = mk(() => httpsPage({ status: 404 }));
  r = await withHttpProbe(httpPage(), noProbe, m.deps);
  eq(r.finalUrl.startsWith('http:'), true, '404 は失敗');
  eq((await httpsCheck(r)).status, 'bad', '404 は bad');

  // 別サイトへ転送
  m = mk(() => httpsPage({ finalUrl: 'https://other.example.com/' }));
  r = await withHttpProbe(httpPage(), noProbe, m.deps);
  eq(r.finalUrl.startsWith('http:'), true, '別サイトは失敗');
  eq(r.httpsUpgradeError, '別のサイトへ転送されました', '理由');

  // https が http に落ちる
  m = mk(() => httpPage());
  r = await withHttpProbe(httpPage(), noProbe, m.deps);
  eq(r.finalUrl.startsWith('http:'), true, 'https 到達不可は失敗');

  // www 差は同一扱い
  m = mk(() => httpsPage({ finalUrl: 'https://www.decollte.jp/a?b=1' }));
  r = await withHttpProbe(httpPage(), noProbe, m.deps);
  eq(r.upgradedFromHttp, true, 'www 差は成功');

  // 元が https
  m = mk(() => httpsPage());
  let probed = 0;
  const hp = httpsPage();
  r = await withHttpProbe(hp, async (h) => { probed++; return { result: 'unreachable', status: 0, chain: [] }; }, m.deps);
  eq(m.calls.length, 0, 'fetchHomepage は呼ばない');
  eq(probed, 1, 'probe を呼ぶ');
  eq(r.httpProbe.result, 'unreachable', 'httpProbe 設定');
  eq(r.upgradedFromHttp, undefined, '昇格フラグなし');

  // http 403 + https 200 → unknown
  m = mk(() => httpsPage());
  r = await withHttpProbe(httpPage(403), noProbe, m.deps);
  eq(r.upgradedFromHttp, true, '403 でも昇格');
  eq((await httpsCheck(r)).status, 'unknown', '403 は unknown');

  // runChecks 全体
  let res = await runChecks(await withHttpProbe(httpPage(), noProbe, mk(() => httpsPage()).deps), {});
  eq(Array.isArray(res.results), true, 'runChecks(昇格)');
  res = await runChecks(await withHttpProbe(httpPage(), noProbe, mk(() => { throw new Error('x'); }).deps), {});
  eq(Array.isArray(res.results), true, 'runChecks(失敗)');

  console.log(`httpsupgrade: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
