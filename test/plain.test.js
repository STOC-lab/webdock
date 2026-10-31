'use strict';
// やさしい説明(src/plainLanguage.js)と、各画面への表示のテスト。DB・外部通信なし
const path = require('path');
const ejs = require('ejs');
const { PLAIN, plainFor } = require('../src/plainLanguage');
const R = require('../src/reportBuckets');

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  x ' + msg); } };
const V = (f) => path.join(__dirname, '..', 'views', f);

const keys = ['cert', 'https_redirect', 'tls_version', 'headers', 'cookies', 'mixed', 'cms', 'php', 'js_libs', 'ext_scripts', 'mail'];
keys.forEach((k) => {
  ['warn', 'bad'].forEach((s) => {
    const p = plainFor({ key: k, status: s });
    ok(p && p.analogy && p.scenario, `${k} ${s}: 文面あり`);
  });
  ok(plainFor({ key: k, status: 'ok' }) === null, `${k} ok: null`);
  ok(plainFor({ key: k, status: 'unknown' }) === null, `${k} unknown: null`);
});
ok(plainFor({ key: 'https_redirect', status: 'bad' }) === PLAIN.no_https, 'https_redirect bad は no_https');
ok(plainFor({ key: 'https_redirect', status: 'warn' }) === PLAIN.https_redirect, 'https_redirect warn');
ok(plainFor({ key: 'php', status: 'ok' }) === null, 'php ok: null');
ok(plainFor({ key: 'nokey', status: 'bad' }) === null && plainFor(null) === null, '未登録key・null');

const items = [
  { key: 'cert', title: 'SSL証明書の有効期限', status: 'bad', summary: 'S1', why: 'WHY1', fix: 'F1', remedy: 'site' },
  { key: 'mail', title: 'メール', status: 'ok', summary: 'S2', why: '', fix: '', remedy: 'dns' },
];
const MARK = 'たとえるなら';
const base = { plainFor, SERVICE_NAME: 'WEBドック', OPERATOR_NAME: '株式会社エストック' };
const render = (f, d) => ejs.renderFile(V(f), { ...base, ...d });
const NOTE = '専門用語を使わず、身近なものにたとえて説明しています。';

(async () => {
  const scan = { id: 1, grade: 'D', result: { results: items, counts: { bad: 1, warn: 0, ok: 1, unknown: 0 } }, url: 'https://example.co.jp/' };
  const bad = await render('partials/item.ejs', { item: items[0] });
  const good = await render('partials/item.ejs', { item: items[1] });
  ok(bad.includes(MARK) && bad.includes('このままにしておくと') && bad.includes(PLAIN.cert.analogy), '項目(bad): たとえ・シナリオ');
  ok(!bad.includes('WHY1') && bad.includes('直し方'), '項目(bad): whyの代わりにscenario、fixは残る');
  ok(!good.includes(MARK), '項目(ok): たとえなし');

  try {
    const k = await render('karte.ejs', { scan, company: null, companyInfo: null });
    ok(k.includes(MARK) && k.includes(NOTE), 'karte: たとえ+注記');
  } catch (e) { fail++; console.log('  x karte render', e.message); }

  const g = R.groupItems(items);
  const rep = await render('report.ejs', { scan: { results: items }, company: 'X', input: 'https://example.co.jp/', g, BUCKETS: R.BUCKETS, BUCKET_ORDER: R.BUCKET_ORDER, statusLabel: R.statusLabel,
    sender: { company: 'a', name: 'b', tel: 'c', mail: 'd' }, surname: 'b', dateJa: '2026年10月31日', siteRequest: '', dnsRequest: '' });
  ok(rep.includes(MARK) && rep.includes(NOTE) && rep.includes(PLAIN.cert.scenario), 'report: たとえ+注記');
  const rep2 = await render('report.ejs', { scan: { results: [items[1]] }, company: 'X', input: 'u', g: R.groupItems([items[1]]), BUCKETS: R.BUCKETS, BUCKET_ORDER: R.BUCKET_ORDER, statusLabel: R.statusLabel,
    sender: { company: 'a', name: 'b', tel: 'c', mail: 'd' }, surname: 'b', dateJa: 'd', siteRequest: '', dnsRequest: '' });
  ok(!rep2.includes(MARK), 'report(okのみ): たとえなし');

  // 個人ページ
  const pageItems = [items[0], { key: 'headers', title: 'ヘッダー', status: 'warn', summary: 'OTHER', why: '', fix: '' }, items[1]];
  const mk = (variant) => render('page/show.ejs', {
    pageTitle: 't', company: 'C', domain: 'd', dateJa: 'x', sentence: '文', variant, main: pageItems[0], others: [pageItems[1]], okCount: 1, hasItems: true,
    optedOut: false, requested: false, token: 'tok', nonce: 'n', error: '', reqToken: 'r', viewToken: 'v', form: {}, errors: {}, sender: {},
  });
  const full = await mk('full'), titles = await mk('titles');
  ok(full.includes(PLAIN.cert.analogy) && full.includes(PLAIN.cert.scenario) && full.includes(PLAIN.headers.analogy), 'page full: 主+他にたとえ');
  ok(titles.includes(PLAIN.cert.analogy) && !titles.includes(PLAIN.headers.analogy) && !titles.includes('OTHER'), 'page titles: 主のみたとえ、他は題名だけ');

  console.log(`plain.test: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(e); process.exit(1); });
