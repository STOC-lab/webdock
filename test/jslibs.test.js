'use strict';
// 古いJavaScriptライブラリの判定(版不明・まとめファイル対応)のテスト(通信は deps.fetchHead で差し替え。DB・実通信なし)
const C = require('../src/checks');
const R = require('../src/reportBuckets');
const { plainFor } = require('../src/plainLanguage');
const { pickFinding, pickFindingB2b } = require('../src/outreach');
const B = require('../cli/batch-scan');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadTemplates } = require('../src/outreach');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);

const page = (scripts) => ({ finalUrl: 'https://www.example.co.jp/', body: '<html><head>' + scripts.map((s) => `<script src="${s}"></script>`).join('') + '</head></html>' });
/** routes: { URL: 本文 }。呼び出しを記録する */
function mkHead(routes) {
  const f = async (url, bytes) => { f.calls.push([url, bytes]); return routes[url] || ''; };
  f.calls = [];
  return f;
}
const run = async (scripts, routes) => { const f = mkHead(routes || {}); const r = await C.checkOldJsLibs(page(scripts), { fetchHead: f }); return { r, f }; };
const U = (p) => 'https://www.example.co.jp' + p;

(async () => {
  // ---- libNameOf / verFromUrl / verFromHead ----
  eq(C.libNameOf('/js/angular.min.js?ver=1.8.2'), 'AngularJS', 'angular.min.js');
  eq(C.libNameOf('https://cdnjs.cloudflare.com/ajax/libs/angularjs/1.8.2/angular.min.js'), 'AngularJS', 'cdnjs angularjs');
  eq(C.libNameOf('https://unpkg.com/vue@2.6.14/dist/vue.js'), 'Vue.js', 'vue@');
  eq(C.libNameOf('/js/vue.min.js'), 'Vue.js', 'vue.min.js');
  eq(C.libNameOf('/js/moment.min.js?ver=2.29.1'), 'moment.js', 'moment.min.js');
  eq(C.libNameOf('/js/moment-with-locales.min.js'), 'moment.js', 'moment-with-locales');
  eq(C.libNameOf('/js/main.js'), null, 'main.js は名前なし');
  eq(C.libNameOf('/js/vuetify.js'), null, 'vuetify は別物');
  eq(C.libNameOf('/js/jquery-migrate.min.js'), null, 'migrate は除外');
  eq(C.libNameOf('/js/jquery.min.js'), 'jQuery', 'jquery(従来)');
  eq(C.verFromUrl('https://x/angular.min.js?ver=1.8.2'), '1.8.2', 'ver= angular');
  eq(C.verFromUrl('https://cdnjs.cloudflare.com/ajax/libs/angularjs/1.8.2/angular.min.js'), '1.8.2', 'パス angularjs/1.8.2/');
  eq(C.verFromUrl('https://unpkg.com/vue@2.6.14/dist/vue.js'), '2.6.14', 'vue@2.6.14');
  eq(C.verFromUrl('https://x/moment.min.js?ver=2.29.1'), '2.29.1', 'moment ver=');
  eq(C.verFromUrl('https://x/jquery-3.6.0.min.js'), '3.6.0', 'jquery-3.6.0(従来)');
  eq(C.verFromHead('AngularJS', '/** @license AngularJS v1.8.2 (c) */'), '1.8.2', 'head angular');
  eq(C.verFromHead('Vue.js', '/*! Vue.js v2.7.16 */'), '2.7.16', 'head vue');
  eq(C.verFromHead('moment.js', '//! moment.js\n//! version : 2.29.4\n//! license : MIT'), '2.29.4', 'head moment');
  eq(C.verFromHead('moment.js', '//! moment.js\n'), null, 'moment 版なし');
  eq(C.verFromHead('jQuery', '/*! jQuery v1.12.4 | (c) */'), '1.12.4', 'head jquery(従来)');

  // ---- isOld ----
  ok(C.isOld('AngularJS', '1.8.2'), 'AngularJS 1.x は常に古い');
  ok(C.isOld('Vue.js', '2.7.16'), 'Vue 2 は古い');
  ok(!C.isOld('Vue.js', '3.4.0'), 'Vue 3 は ok');
  ok(C.isOld('moment.js', '2.29.3'), 'moment 2.29.3 は古い');
  ok(!C.isOld('moment.js', '2.29.4'), 'moment 2.29.4 は ok');
  ok(C.isOld('jQuery', '1.12.4') && !C.isOld('jQuery', '3.5.0'), 'jQuery(従来)');

  // ---- URLから版(追加GETなし) ----
  let { r, f } = await run(['/js/jquery-3.6.0.min.js']);
  eq([r.status, !!r.noScore, f.calls.length], ['ok', false, 0], 'URLから版・ok・通信なし');
  ok(r.summary.includes('jQuery 3.6.0'), 'summary');
  ({ r, f } = await run(['/js/jquery-1.12.4.min.js']));
  eq([r.status, !!r.noScore], ['warn', false], '古い jQuery は warn(採点対象)');
  ok(r.why.includes('CVE-2020-11022'), 'why に CVE(従来文言)');

  // ---- 先頭コメントから版 ----
  ({ r, f } = await run(['/js/jquery.min.js'], { [U('/js/jquery.min.js')]: '/*! jQuery v3.7.1 | (c) OpenJS */' }));
  eq([r.status, !!r.noScore, f.calls.length, f.calls[0][1]], ['ok', false, 1, 4096], '先頭4KBから版');

  // ---- AngularJS / Vue2 / moment ----
  ({ r } = await run(['/js/angular.min.js?ver=1.8.2']));
  eq([r.status, !!r.noScore], ['warn', false], 'AngularJS は warn(採点対象)');
  ok(r.why.includes('サポートが終了しており、今後見つかる弱点も修正されません'), 'AngularJS の why');
  ({ r } = await run(['https://unpkg.com/vue@2.6.14/dist/vue.js']));
  eq([r.status], ['warn'], 'Vue2 warn');
  ({ r } = await run(['https://unpkg.com/vue@3.4.0/dist/vue.global.js']));
  eq([r.status], ['ok'], 'Vue3 ok');
  ({ r } = await run(['/js/moment.min.js?ver=2.29.1']));
  eq([r.status], ['warn'], 'moment 2.29.1 warn');
  ok(r.why.includes('CVE-2022-31129') && r.why.includes('固まる'), 'moment の why');
  ({ r } = await run(['/js/moment.min.js?ver=2.29.4']));
  eq([r.status], ['ok'], 'moment 2.29.4 ok');

  // ---- まとめファイルから複数検出 ----
  const bundle = '/*! jQuery v1.12.4 | x */\n...\n//! moment.js\n//! version : 2.29.1\n...\n/** @license AngularJS v1.8.2 */';
  ({ r, f } = await run(['/wp-content/cache/autoptimize/js/autoptimize_abc.js'], { [U('/wp-content/cache/autoptimize/js/autoptimize_abc.js')]: bundle }));
  eq([r.status, !!r.noScore, f.calls.length, f.calls[0][1]], ['warn', false, 1, 512 * 1024], 'バンドル: 512KB読み・warn');
  ok(['jQuery 1.12.4', 'moment.js 2.29.1', 'AngularJS 1.8.2'].every((x) => r.summary.includes(x)), 'バンドル: 3つ検出');
  // バンドル内に新しい版だけ → ok
  ({ r } = await run(['/js/bundle.js'], { [U('/js/bundle.js')]: '/*! jQuery v3.7.1 */ //! moment.js\n//! version : 2.30.1' }));
  eq([r.status, !!r.noScore], ['ok', false], 'バンドル内が新しい版 → ok');
  // 外部サイトのバンドルは読まない
  ({ f } = await run(['https://cdn.other.com/app.js']));
  eq(f.calls.length, 0, '他サイトの .js は読まない');
  // www 違いは同一サイト
  ({ f } = await run(['https://example.co.jp/app.js']));
  eq(f.calls.length, 1, 'www 違いは同一サイト');

  // ---- 追加GETは合計3回 ----
  const many = ['/a/jquery.min.js', '/a/bootstrap.min.js', '/a/jquery-ui.min.js', '/a/main.js', '/a/app.js', '/a/x.js'];
  ({ r, f } = await run(many));
  eq(f.calls.length, 3, '追加GETは合計3回まで');
  ok(f.calls.every((c) => c[1] === 4096), '優先順: 既知ライブラリ(版不明)が先でバンドルに回らない');
  // 既知1つ + バンドル候補: 既知→バンドル(ファイル名ヒット優先)
  ({ f } = await run(['/a/other.js', '/a/jquery.min.js', '/a/main.js', '/a/app.js', '/a/zzz.js']));
  eq(f.calls.map((c) => c[0].replace(U(''), '')), ['/a/jquery.min.js', '/a/main.js', '/a/app.js'], '既知→バンドルらしい名前→合計3回');
  // 同じURLは二重に読まない
  ({ f } = await run(['/a/main.js', '/a/main.js']));
  eq(f.calls.length, 1, '同じURLは1回');

  // ---- 版不明 → warn + noScore ----
  ({ r } = await run(['/js/jquery.min.js']));
  eq([r.status, r.noScore], ['warn', true], '版不明は warn+noScore');
  eq(r.summary, 'jQuery を使っていますが、版を外から特定できませんでした', '版不明 summary');
  eq(r.why, '古い版には公表済みの弱点があります。版が見えないことは、安全であることを意味しません。', '版不明 why');
  eq(r.fix, '制作会社に、使っているライブラリ(jQuery など)の版を確認し、古ければ更新するよう依頼してください。', '版不明 fix');
  ({ r } = await run(['/js/jquery.min.js', '/js/bootstrap.min.js']));
  eq(r.summary, 'jQuery・Bootstrap を使っていますが、版を外から特定できませんでした', '複数は・でつなぐ');

  // ---- 何もなし → ok + noScore ----
  ({ r } = await run(['/js/site.js'], {}));
  eq([r.status, r.noScore], ['ok', true], '何もなし ok+noScore');
  eq(r.summary, 'jQuery・Bootstrap など、弱点が知られた主要ライブラリの読み込みは見つかりませんでした', 'なし summary');
  eq(r.evidence, '主要ライブラリの読み込みなし', 'なし evidence');
  ({ r } = await run([]));
  eq([r.status, r.noScore], ['ok', true], 'script なし');

  // ---- 混在: 版付き優先 ----
  ({ r } = await run(['/js/jquery-3.6.0.min.js', '/js/bootstrap.min.js']));
  eq([r.status, !!r.noScore], ['ok', false], '版付き ok + 版不明 → ok(採点対象)');
  ok(r.evidence.includes('jQuery 3.6.0') && r.evidence.includes('版を特定できなかったもの: Bootstrap'), 'evidence に版不明を併記');
  ({ r } = await run(['/js/jquery-1.12.4.min.js', '/js/bootstrap.min.js']));
  eq([r.status, !!r.noScore], ['warn', false], '古いもの + 版不明 → warn(採点対象)');
  // 版不明のまま名前だけの jQuery が、バンドル内の版で解決される
  ({ r } = await run(['/js/jquery.min.js', '/js/bundle.js'], { [U('/js/bundle.js')]: '/*! jQuery v1.12.4 */' }));
  eq([r.status, !!r.noScore], ['warn', false], 'バンドルで版が分かれば採点対象');

  // ---- 通信が例外でも落ちない ----
  r = await C.checkOldJsLibs(page(['/js/jquery.min.js']), { fetchHead: async () => { throw new Error('x'); } });
  eq([r.status, r.noScore], ['warn', true], '通信失敗は版不明扱い');

  // ---- scoreOf: noScore 除外・従来の点数は不変 ----
  const base = [{ key: 'cert', status: 'ok' }, { key: 'headers', status: 'ok' }, { key: 'mixed', status: 'bad' }];
  const sBase = C.scoreOf(base).score;
  eq(C.scoreOf([...base, { key: 'js_libs', status: 'warn', noScore: true }]).score, sBase, '版不明は点数に影響しない');
  eq(C.scoreOf([...base, { key: 'js_libs', status: 'ok', noScore: true }]).score, sBase, '見つからない ok も点数に影響しない');
  eq(C.scoreOf([...base, { key: 'js_libs', status: 'unknown' }]).score, sBase, '従来の unknown と同じ点数');
  ok(C.scoreOf([...base, { key: 'js_libs', status: 'ok' }]).score !== sBase, '版付き ok は従来どおり採点');
  ok(C.scoreOf([...base, { key: 'js_libs', status: 'warn' }]).score !== sBase, '古い warn は従来どおり採点');
  // runChecks 経由
  const rc = await C.runChecks({ ...page(['/js/jquery.min.js']), headers: {} }, { fetchPassive: async () => null, fetchHead: mkHead({}) });
  const j = rc.results.find((x) => x.key === 'js_libs');
  eq([j.status, j.noScore], ['warn', true], 'runChecks: deps から fetchHead が渡る');

  // ---- バケット ----
  const hidden = { key: 'js_libs', status: 'warn', noScore: true, title: 't', summary: 's', evidence: '' };
  eq(R.bucketOf(hidden), 'partial', '版不明は partial');
  eq(R.bucketOf({ key: 'js_libs', status: 'warn' }), 'renewal', '従来の warn は renewal');
  eq(R.bucketOf({ key: 'js_libs', status: 'bad' }), 'renewal', '従来の bad は renewal');
  const okNs = { key: 'js_libs', status: 'ok', noScore: true, title: 't', summary: 's', evidence: '' };
  eq(R.groupItems([okNs, hidden]).okItems.length, 1, 'ok+noScore は問題なし項目に入る');
  eq(R.groupItems([okNs, hidden]).partial.length, 1, 'hidden は部分的な修正に入る');

  // ---- plain ----
  const ph = plainFor(hidden);
  ok(ph && ph.analogy.includes('消火器'), 'plain: 版不明用');
  ok(plainFor({ key: 'js_libs', status: 'warn' }).analogy.includes('リコール'), 'plain: 従来');
  eq(plainFor(okNs), null, 'plain: ok は null');

  // ---- outreach: noScore の js_libs を所見に使わない ----
  const mk = (o) => Object.keys({ cert: 1, https_redirect: 1, tls_version: 1, headers: 1, cookies: 1, mixed: 1, cms: 1, js_libs: 1, ext_scripts: 1, mail: 1 })
    .map((k) => ({ key: k, status: (o[k] && o[k].status) || o[k] || 'ok', ...(o[k] && o[k].noScore ? { noScore: true } : {}) }));
  eq(pickFindingB2b(mk({ js_libs: { status: 'warn', noScore: true } })), null, 'B2B: 版不明は使わない');
  eq(pickFindingB2b(mk({ js_libs: { status: 'warn', noScore: true }, cms: 'warn' })), 'cms', 'B2B: 版不明を飛ばして次へ');
  eq(pickFindingB2b(mk({ js_libs: 'warn' })), 'js_libs', 'B2B: 従来の warn は使う');
  eq(pickFinding(mk({ js_libs: { status: 'warn', noScore: true } })), null, 'old_parts: 版不明は使わない');
  eq(pickFinding(mk({ js_libs: 'warn' })), 'old_parts', 'old_parts: 従来');

  // ---- CSV: noScore は「—」 ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jslibs-'));
  try {
    const out = path.join(dir, 'o.csv');
    const ks = ['cert', 'https_redirect', 'tls_version', 'headers', 'cookies', 'mixed', 'cms', 'php', 'js_libs', 'ext_scripts', 'mail'];
    const res = (js) => ks.map((k) => (k === 'js_libs' ? { key: k, ...js } : { key: k, status: 'ok' }));
    const rows = [1, 2, 3].map((n) => ({ store_id: String(n), name: '会社' + n, url: `https://c${n}.jp/`, prefecture: '兵庫県', category: '建設会社' }));
    const sc = { 1: { status: 'warn', noScore: true }, 2: { status: 'ok', noScore: true }, 3: { status: 'warn' } };
    await B.runBatch({
      rows, out, templates: loadTemplates(), templateMode: 'b2b', concurrency: 1, log: () => {},
      scan: async (url) => ({ results: res(sc[url.match(/c(\d)/)[1]]), score: 80, grade: 'B' }),
    });
    const t = B.parseDelimited(fs.readFileSync(out, 'utf8').replace(/^\ufeff/, ''), ',');
    const ij = t[0].indexOf('JSライブラリ');
    const col = (id) => t.find((r) => r[0] === id)[ij];
    eq([col('1'), col('2'), col('3')], ['—', '—', 'C'], 'CSV: noScore の js_libs は「—」、従来の warn は C');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  console.log(`jslibs: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
