'use strict';
// PHPの版の診断(passive。X-Powered-By のみ)・判定・文面・レポート区分・CSV列のテスト(DB・通信なし)
const fs = require('fs');
const os = require('os');
const path = require('path');
const PV = require('../src/phpVersions');
const { checkPhpVersion, scoreOf, runChecks } = require('../src/checks');
const { pickFindingB2b, buildB2bMessage, loadTemplates } = require('../src/outreach');
const R = require('../src/reportBuckets');
const G = require('../src/outreachGroups');
const O = require('../src/outreachSingle');
const B = require('../cli/batch-scan');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);
const php = (v) => checkPhpVersion({ headers: v === null ? {} : { 'x-powered-by': v } });

(async () => {
  // ---- 版の読み取り ----
  eq(PV.parsePhpVersion('PHP/8.1.27').text, '8.1.27', '基本');
  eq(PV.parsePhpVersion('PHP/7.4.33-nmm1').text, '7.4.33', '接尾辞(-nmm1)');
  eq(PV.parsePhpVersion('PHP/8.2.12-1ubuntu1.3').text, '8.2.12', '接尾辞(ubuntu)');
  eq(PV.parsePhpVersion('php/8.3.36').text, '8.3.36', '小文字');
  eq(PV.parsePhpVersion('PHP/5.6.40').major, 5, '5系');
  eq(PV.parsePhpVersion('Express, PHP/8.0.30, ASP.NET').text, '8.0.30', '複数の値の中');
  eq(PV.parsePhpVersion('PHP/8.1'), null, 'パッチなしは読めない');
  eq(PV.parsePhpVersion('PHP'), null, '版なし');
  eq(PV.parsePhpVersion('Express'), null, 'PHP以外');
  eq(PV.parsePhpVersion(undefined), null, 'undefined');
  eq(PV.parsePhpVersion(''), null, '空');

  // ---- 分類 ----
  const cases = [
    ['5.6.40', 'bad'], ['7.4.33', 'bad'], ['8.0.30', 'bad'], ['8.1.27', 'bad'],
    ['8.2.34', 'bad'], ['8.2.35', 'ok'], ['8.3.35', 'bad'], ['8.3.36', 'ok'],
    ['8.4.26', 'bad'], ['8.4.27', 'ok'], ['8.5.11', 'bad'], ['8.5.12', 'ok'], ['8.6.0', 'ok'], ['9.0.1', 'ok'],
  ];
  for (const [v, st] of cases) eq(php('PHP/' + v).status, st, 'status ' + v);
  eq(php('PHP/8.4.27-1~deb13').status, 'ok', '接尾辞つきでも判定');
  eq(php('PHP/5.6.40').summary, '表示されているPHPの版(5.6.40)は公式サポートが終了した版です', 'eol summary');
  ok(php('PHP/7.4.33-nmm1').why.includes('提供元が独自に修正を適用している場合もあります'), 'eol why: 提供元の独自修正');
  eq(php('PHP/8.1.27').fix, 'サーバーの提供元・制作会社に、PHPのサポート中の版(8.3以降など)への更新を依頼してください。', 'eol fix');
  eq(php('PHP/8.2.34').summary, '表示されているPHPの版(8.2.34)は、2026年10月21日の修正が入る前の版です', 'unpatched summary');
  ok(php('PHP/8.2.34').why.includes('悪用') && php('PHP/8.2.34').why.includes('取り込んで'), 'unpatched why: 悪用・バックポート');
  ok(php('PHP/8.2.34').fix.includes('8.2.35以降への更新、または修正の適用状況の確認を依頼してください。'), 'unpatched fix: 修正版');
  ok(php('PHP/8.3.35').fix.includes('8.3.36以降'), 'unpatched fix 8.3');
  eq(php('PHP/8.2.34').evidence, 'X-Powered-By: PHP/8.2.34', 'evidence');
  eq(php('PHP/8.3.36').summary, '表示されているPHPの版(8.3.36)は修正済みの版です', 'ok summary');
  ok(php('PHP/8.3.36').evidence.includes('CMSのバージョン露出'), 'ok evidence: 露出は別項目');
  eq(php(null).status, 'unknown', '未表示 -> unknown');
  eq(php(null).summary, 'PHPの版は外部から確認できませんでした', 'unknown summary');
  eq(php('Express').status, 'unknown', 'PHP以外 -> unknown');
  eq(php(['PHP/8.1.27']).status, 'bad', '配列ヘッダー');
  eq(php(null).key, 'php', 'key');
  eq(php(null).title, 'PHP(サイトを動かす部品)の版', 'title');

  // ---- runChecks への組み込みとスコア ----
  const base = { finalUrl: 'https://a.example.jp/', httpToHttps: true, redirectChain: [], tls: null, body: '<html></html>' };
  const r1 = await runChecks({ ...base, headers: {} });
  const r2 = await runChecks({ ...base, headers: { 'x-powered-by': 'PHP/7.4.33' } });
  const keys = r1.results.map((x) => x.key);
  eq(keys, ['cert', 'https_redirect', 'tls_version', 'headers', 'cookies', 'mixed', 'cms', 'php', 'js_libs', 'ext_scripts', 'mail'], '項目の並び(phpはcmsの次)');
  eq(r1.results.find((x) => x.key === 'php').remedy, 'site', 'remedy site');
  const mkr = (st) => [{ key: 'a', status: 'ok' }, { key: 'b', status: 'warn' }, { key: 'php', status: st }];
  eq(scoreOf(mkr('unknown')), scoreOf([{ key: 'a', status: 'ok' }, { key: 'b', status: 'warn' }]), 'unknown はスコアに影響しない');
  ok(scoreOf(mkr('bad')).score < scoreOf(mkr('unknown')).score, 'bad は点数を下げる(certと同じ重み)');
  eq(scoreOf(mkr('bad')).score, scoreOf([{ key: 'a', status: 'ok' }, { key: 'b', status: 'warn' }, { key: 'cert', status: 'bad' }]).score, 'php bad = cert bad');
  ok(r2.score <= r1.score || r1.score === null, 'PHP bad のサイトは点数が下がる/同じ');

  // ---- B2B 優先順位 ----
  const KEYS = ['cert', 'https_redirect', 'tls_version', 'headers', 'cookies', 'mixed', 'cms', 'php', 'js_libs', 'ext_scripts', 'mail'];
  const mk = (o, ev) => KEYS.map((k) => ({ key: k, status: (o && o[k]) || 'ok', evidence: (ev && ev[k]) || '' }));
  eq(pickFindingB2b(mk({ php: 'bad' }, { php: 'X-Powered-By: PHP/7.4.33' })), 'php_eol', 'EOL -> php_eol');
  eq(pickFindingB2b(mk({ php: 'bad' }, { php: 'X-Powered-By: PHP/8.2.34' })), 'php_unpatched', '修正前 -> php_unpatched');
  eq(pickFindingB2b(mk({ php: 'bad', https_redirect: 'bad' }, { php: 'X-Powered-By: PHP/8.1.1' })), 'php_eol', 'php が no_https より先');
  eq(pickFindingB2b(mk({ php: 'bad', mixed: 'bad' }, { php: 'X-Powered-By: PHP/8.4.1' })), 'php_unpatched', 'php が mixed より先');
  eq(pickFindingB2b(mk({ php: 'ok', https_redirect: 'bad' })), 'no_https', 'php ok は影響なし');
  eq(pickFindingB2b(mk({ php: 'unknown', mixed: 'bad' })), 'mixed', 'php unknown は飛ばす');
  eq(pickFindingB2b(mk({ php: 'unknown' })), null, 'php unknown だけ -> なし');
  eq(pickFindingB2b(mk({ php: 'bad' })), null, 'evidence が読めない bad は使わない');

  // ---- 文面 ----
  const T = loadTemplates();
  for (const k of ['php_eol', 'php_unpatched']) {
    ok(T.findingsB2b[k] && T.findingsB2b[k]['指摘'] && T.findingsB2b[k]['困ること'] && T.findingsB2b[k]['一文'].includes('{ver}'), 'findings-b2b: ' + k);
  }
  const bm = buildB2bMessage(T, { name: 'A社', category: '建設会社', domain: 'a.jp', results: mk({ php: 'bad' }, { php: 'X-Powered-By: PHP/8.0.30' }), scannedAt: new Date('2026-10-29T00:00:00Z'), seq: 1 });
  eq([bm.findingType, bm.send, bm.phpVersion], ['php_eol', true, '8.0.30'], 'buildB2bMessage: php_eol・版');
  ok(bm.body.includes('公式サポートの終了した版である状態を確認しました') && bm.body.includes('公式の修正が提供されていない版であるため'), '旧方式本文: 文として通る');
  const bm2 = buildB2bMessage(T, { name: 'A社', category: '建設会社', domain: 'a.jp', results: mk({ php: 'bad' }, { php: 'X-Powered-By: PHP/8.2.34' }), scannedAt: new Date('2026-10-29T00:00:00Z'), seq: 1 });
  ok(bm2.body.includes('修正が入る前の版である状態を確認しました') && bm2.body.includes('未適用であれば悪用される余地があるため'), 'unpatched 本文: 文として通る');
  const g = G.renderGroupBodies(T, 'php_unpatched', new Date('2026-10-29T00:00:00Z'));
  ok(!/\{[^}]*\}/.test(g.body) && g.body.includes('修正が入る前の版である状態を確認しました'), 'グループ本文: 展開済み');
  eq(G.batchCode('php_eol', new Date('2026-10-29T00:00:00Z')), 'WD-PHP-EOL-20261029', 'バッチコード php_eol');
  eq(G.batchCode('php_unpatched', new Date('2026-10-29T00:00:00Z')), 'WD-PHP-UNPATCHED-20261029', 'バッチコード php_unpatched');
  eq(G.groupKeyOfFinding('php_eol'), 'php_eol', 'groupKey');
  eq(G.GROUP_ORDER.slice(0, 3), ['php_eol', 'php_unpatched', 'no_https'], 'GROUP_ORDER: phpが先頭');
  ok(G.GROUP_LABEL.php_eol && G.GROUP_LABEL.php_unpatched, 'GROUP_LABEL');
  const rowsG = [{ store_id: '1', 店名: 'A', URL: 'https://a.jp/', 問い合わせURL: 'https://a.jp/c', 画像認証: '', 指摘種別: 'php_eol', 送信推奨: 'はい' }];
  eq(G.groupRows(rowsG).groups.map((x) => x.key), ['php_eol'], 'groupRows: php_eol');

  // 単一本文: {ver} に版が入る
  const rec = (n, key, ver, o) => ({ store_id: String(n), stoc_store_id: String(n), 店名: '会社' + n, URL: `https://www.c${n}.jp/`, 業種: '建設会社', 業種区分: '建設', 問い合わせURL: `https://www.c${n}.jp/contact`, 画像認証: 'なし', 営業お断り: 'なし', 指摘種別: key, 送信推奨: 'はい', 'PHP版': ver, ...o });
  const pc = O.pickCandidates([rec(1, 'php_eol', '5.6.40'), rec(2, 'php_unpatched', '8.2.34'), rec(3, 'php_eol', '')]);
  eq(pc.candidates.map((c) => c.key), ['php_eol', 'php_unpatched', 'php_eol'], '単一: 候補');
  const store = (id) => ({ id, name: '会社' + id, address: '', status: '' });
  const sm = new Map([1, 2, 3].map((i) => [i, store(i)]));
  const ex = {};
  const items = O.buildItems(pc.candidates, sm, T, ex);
  eq(items.length, 2, '単一: 版不明の行は除外');
  eq(ex['PHPの版が不明'], 1, '単一: 除外理由');
  ok(items[0].sentence.includes('PHP(サイトを動かす部品)の版が5.6.40で、公式サポートが終了した版でした。') && !items[0].sentence.includes('{ver}'), '単一: php_eol 一文に版');
  ok(items[1].sentence.includes('版が8.2.34で、10月21日に公開された深刻な脆弱性の修正が入る前の版でした。提供元が独自に修正している場合もある'), '単一: php_unpatched 一文に版・注意書き');
  const items2 = O.buildItems(pc.candidates, sm, T, {}, { withPage: true });
  ok(items2[0].sentence.startsWith('御社サイト(c1.jp)を確認したところ、'), '専用ページ版: 先頭にドメイン');
  // 文字数(URL版の最長)
  const bodyUrl = O.renderBody(T, { withPage: true });
  const PC = require('../src/pageCore');
  const lens = items2.map((it) => [...bodyUrl.replace('[company]', '株式会社サンプル製作所').replace('[param1]', PC.pageUrl('AbCdEfGh12')).replace('[param2]', '取引先様・調達ご担当者様・求職者様').replace('[name]', it.sentence)].length);
  ok(Math.max(...lens) <= 540, 'URL版の本文長 ' + lens.join('/'));
  const bl = O.bodyLengths(bodyUrl, items2, { withPage: true });
  ok(bl.longest <= 540, 'bodyLengths longest ' + bl.longest);

  // ---- レポート ----
  eq(R.bucketOf({ key: 'php', status: 'bad' }), 'urgent', 'php bad -> すぐにご確認');
  eq(R.bucketOf({ key: 'php', status: 'unknown' }), null, 'php unknown -> 区分なし');
  eq(R.bucketOf({ key: 'php', status: 'ok' }), null, 'php ok -> 区分なし');
  const gi = R.groupItems([php('PHP/7.4.33'), php(null), php('PHP/8.5.12')]);
  eq([gi.urgent.length, gi.okItems.length], [1, 1], 'groupItems');
  eq(R.fixToRequest(php('PHP/8.1.27').fix), 'サーバーの提供元・制作会社に、PHPのサポート中の版(8.3以降など)への更新をお願いいたします。', 'fixToRequest eol');
  ok(R.fixToRequest(php('PHP/8.2.34').fix).endsWith('の確認をお願いいたします。'), 'fixToRequest unpatched');
  const req = R.buildRequestText([php('PHP/8.2.34')], 'site', '');
  ok(req.includes('1. PHP(サイトを動かす部品)の版') && req.includes('確認した箇所: X-Powered-By: PHP/8.2.34') && req.includes('ご依頼: '), '依頼文');
  const P = require('../src/pages');
  const sf = P.summarizeFindings(r2.results.filter((x) => x.key === 'php'));
  eq([sf[0].key, sf[0].status, sf[0].remedy], ['php', 'bad', 'site'], '専用ページ findings_json に php');

  // ---- CSV 列(末尾に追加) ----
  eq(B.PHP_COLUMNS, ['PHP', 'PHP版'], 'PHP列');
  eq(B.COLUMNS.length, 25, '既存の列は不変(25)');
  eq(B.COLUMNS[B.COLUMNS.length - 1], '診断日時', '既存の最終列は不変');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-'));
  try {
    const out = path.join(dir, 'o.csv');
    const rows = [{ store_id: '1', name: 'A', url: 'https://a.jp/', prefecture: '兵庫県', category: '建設会社' }, { store_id: '2', name: 'B', url: 'https://b.jp/', prefecture: '兵庫県', category: '建設会社' }];
    await B.runBatch({
      rows, out, templates: T, templateMode: 'b2b', concurrency: 1, log: () => {},
      scan: async (url) => (url.includes('a.jp')
        ? { results: mk({ php: 'bad' }, { php: 'X-Powered-By: PHP/7.4.33-nmm1' }), score: 50, grade: 'D' }
        : { results: mk({ php: 'unknown' }), score: 90, grade: 'A' }),
    });
    const t = B.parseDelimited(fs.readFileSync(out, 'utf8').replace(/^﻿/, ''), ',');
    const h = t[0];
    eq(h.slice(-2), ['PHP', 'PHP版'], 'CSV: 末尾が PHP,PHP版');
    const ia = t.find((r) => r[0] === '1'), ib = t.find((r) => r[0] === '2');
    eq([ia[h.length - 2], ia[h.length - 1]], ['D', '7.4.33'], 'CSV: php bad の行');
    eq([ib[h.length - 2], ib[h.length - 1]], ['—', ''], 'CSV: php unknown の行');
    eq(ia[h.indexOf('指摘種別')], 'php_eol', 'CSV: 指摘種別');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  console.log(`php: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
