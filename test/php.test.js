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
  eq(php(null).summary, 'PHPで動いている形跡は見つかりませんでした', 'unknown summary');
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
  eq(G.GROUP_ORDER.slice(0, 4), ['php_info', 'php_eol', 'php_unpatched', 'no_https'], 'GROUP_ORDER: phpが先頭');
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

  // ---- 取得元の強化(Server / wp-login.php / index.php / phpinfo)。通信は fetchPassive を差し替える ----
  const mkFetch = (routes) => {
    const calls = [];
    const fn = async (url, budget) => { calls.push(new URL(url).pathname); const r = routes[new URL(url).pathname]; return r === undefined ? null : r; };
    fn.calls = calls;
    return fn;
  };
  const top = (o) => ({ ...base, headers: {}, body: '<html></html>', ...o });
  const deep = (page, routes) => { const f = mkFetch(routes || {}); return checkPhpVersionDeep(page, { fetchPassive: f }).then((r) => ({ r, calls: f.calls })); };
  const { checkPhpVersionDeep } = require('../src/checks');
  const PI_HTML = '<html><head><title>phpinfo()</title></head><body><h1 class="p">PHP Version 7.4.33</h1></body></html>';

  // b. Server ヘッダ(追加通信なし)
  let d = await deep(top({ headers: { server: 'Apache/2.4.57 PHP/8.0.30' } }));
  eq([d.r.status, d.calls.length], ['bad', 0], 'Server ヘッダの版: 追加GETなし');
  eq(d.r.evidence, 'Server: Apache/2.4.57 PHP/8.0.30', 'Server ヘッダ evidence');
  // a が b より優先、トップで取れたら追加GETゼロ
  d = await deep(top({ headers: { 'x-powered-by': 'PHP/8.3.36', server: 'Apache PHP/5.6.1' } }), { '/phpinfo.php': { status: 200, headers: {}, body: PI_HTML } });
  eq([d.r.status, d.calls.length, d.r.evidence.startsWith('X-Powered-By: PHP/8.3.36')], ['ok', 0, true], 'トップで取れたら追加GETゼロ・phpinfoも見ない');
  // c. wp-login.php(WordPress らしい本文)
  d = await deep(top({ body: '<link href="/wp-content/themes/a.css">' }), { '/wp-login.php': { status: 200, headers: { 'x-powered-by': 'PHP/7.4.33' }, body: '' } });
  eq([d.r.status, d.calls], ['bad', ['/wp-login.php']], 'wp-login.php 経由・1回で打ち切り');
  eq(d.r.evidence, 'X-Powered-By: PHP/7.4.33(/wp-login.php の応答)', 'wp-login.php evidence');
  // c. index.php(WordPress でない)
  d = await deep(top(), { '/index.php': { status: 200, headers: { server: 'nginx PHP/8.4.27' }, body: '' } });
  eq([d.r.status, d.calls], ['ok', ['/index.php']], 'index.php 経由');
  ok(d.r.evidence.startsWith('Server: nginx PHP/8.4.27(/index.php の応答)'), 'index.php evidence');
  // d. phpinfo 検出
  d = await deep(top(), { '/index.php': { status: 404, headers: {}, body: '' }, '/phpinfo.php': { status: 200, headers: {}, body: PI_HTML } });
  eq([d.r.status, d.r.phpinfo, d.calls], ['bad', true, ['/index.php', '/phpinfo.php']], 'phpinfo 検出・打ち切り(/info.php は見ない)');
  eq(d.r.evidence, '/phpinfo.php が公開されており PHP Version 7.4.33', 'phpinfo evidence');
  eq(d.r.summary, 'サーバーの設定確認ページ(phpinfo)が誰でも見られる状態です(PHP 7.4.33)', 'phpinfo summary');
  ok(d.r.why.startsWith('サーバーの内部情報(版・設定・フォルダ構成など)がすべて公開されており、攻撃の下調べに使われます。') && d.r.why.includes('公式の修正が提供されていません'), 'phpinfo why: eol の説明が続く');
  eq(d.r.fix, '制作会社・サーバー会社に、/phpinfo.php(または /info.php)の削除と、PHPの版の確認・更新を依頼してください。', 'phpinfo fix');
  // /info.php 経由 + 最新版でも bad
  d = await deep(top(), { '/info.php': { status: 200, headers: {}, body: PI_HTML.replace('7.4.33', '8.5.12') } });
  eq([d.r.status, d.r.phpinfo, d.calls], ['bad', true, ['/index.php', '/phpinfo.php', '/info.php']], '/info.php で検出(追加GETは最大3回)');
  ok(!d.r.why.includes('公式の修正'), '修正済み版なら版の説明は付かない');
  // 両方必須・404は検出しない
  d = await deep(top(), { '/phpinfo.php': { status: 200, headers: {}, body: '<title>phpinfo()</title>' }, '/info.php': { status: 200, headers: {}, body: '<h1>PHP Version 7.4.33</h1>' } });
  eq([d.r.phpinfo, d.r.status, d.calls.length], [undefined, 'unknown', 3], 'phpinfo() だけ/PHP Version だけでは検出しない');
  d = await deep(top(), { '/phpinfo.php': { status: 404, headers: {}, body: PI_HTML }, '/info.php': { status: 403, headers: {}, body: PI_HTML } });
  eq([d.r.phpinfo, d.r.status], [undefined, 'unknown'], '200以外では検出しない');
  // 追加GETは3回を超えない(予算を使い切る fetcher)
  let n = 0;
  const greedy = async (u, budget) => { n++; return null; };
  await checkPhpVersionDeep(top(), { fetchPassive: greedy });
  ok(n <= 3, '追加GETの回数 ' + n);
  // 通信が例外でも落ちない
  d = await checkPhpVersionDeep(top(), { fetchPassive: async () => { throw new Error('x'); } });
  eq(d.status, 'unknown', '通信失敗は unknown');
  // 版非公開 + 手がかり
  d = await deep(top({ body: '<link href="/wp-content/a.css">' }));
  eq([d.r.status, d.r.noScore, d.r.evidence], ['warn', true, 'WordPress'], '手がかり(WordPress) -> warn noScore');
  eq(d.r.summary, 'このサイトはPHPで動いていますが、版は外から見えないよう隠されています(これ自体は正しい設定です)', 'hidden summary');
  eq(d.r.fix, '制作会社またはサーバー会社に、PHPの版と修正の適用状況を確認してください。', 'hidden fix');
  d = await deep(top({ headers: { 'set-cookie': ['PHPSESSID=abc; path=/'] } }));
  eq([d.r.status, d.r.evidence], ['warn', 'PHPSESSID'], 'PHPSESSID');
  d = await deep(top({ headers: { 'x-powered-by': 'PHP' } }));
  eq(d.r.status, 'warn', 'X-Powered-By: PHP(版なし)');
  d = await deep(top({ body: '<a href="/contact.php">a</a>' }));
  eq([d.r.status, d.r.evidence], ['warn', '.phpのページへのリンク'], '.php リンク');
  d = await deep(top({ body: '<a href="https://other.example.com/x.php">a</a><a href="/x.html">b</a>' }));
  eq(d.r.status, 'unknown', '他サイトの.phpリンクは手がかりにしない');
  d = await deep(top(), { '/index.php': { status: 200, headers: { 'set-cookie': 'PHPSESSID=zz' }, body: '' } });
  eq([d.r.status, d.r.noScore, d.r.evidence], ['warn', true, 'PHPSESSID'], 'c の応答の PHPSESSID');
  d = await deep(top());
  eq([d.r.status, d.r.noScore], ['unknown', undefined], '手がかりなし -> unknown');

  // ---- scoreOf: noScore は除外・既存の点数は不変 ----
  const A = [{ key: 'a', status: 'ok' }, { key: 'b', status: 'warn' }, { key: 'c', status: 'bad' }];
  const before = scoreOf(A);
  eq(scoreOf([...A, { key: 'php', status: 'warn', noScore: true }]), before, 'noScore は点数に影響しない');
  eq([scoreOf([{ key: 'a', status: 'ok' }, { key: 'php', status: 'warn' }]).score, scoreOf([{ key: 'a', status: 'ok' }, { key: 'php', status: 'warn', noScore: true }]).score], [75, 100], 'noScore なしの warn は従来どおり5点・noScore は除外');
  eq(before.score, 50, '既存ケース: ok+warn+bad = 50点');
  eq(scoreOf([{ key: 'php', status: 'warn', noScore: true }]).score, null, 'noScore だけなら点数なし');
  eq(scoreOf([...A, { key: 'php', status: 'bad', phpinfo: true }]).score, Math.round((15 / 40) * 100), 'phpinfo の bad は採点対象');

  // ---- バケット ----
  eq(R.bucketOf({ key: 'php', status: 'warn', noScore: true }), 'partial', '版非公開 -> partial');
  eq(R.bucketOf({ key: 'php', status: 'warn' }), 'urgent', '従来の php warn は urgent のまま');
  eq(R.bucketOf({ key: 'php', status: 'bad', phpinfo: true }), 'urgent', 'phpinfo -> urgent');
  eq(R.statusLabel('warn'), '要確認', '表示語');

  // ---- やさしい説明 ----
  const PL = require('../src/plainLanguage');
  const pli = PL.plainFor({ key: 'php', status: 'bad', phpinfo: true });
  ok(pli && pli.analogy.includes('金庫の場所と鍵の型番') && pli.scenario, 'plain: phpinfo');
  const plh = PL.plainFor({ key: 'php', status: 'warn', noScore: true });
  ok(plh && plh.analogy && plh.scenario && plh !== PL.plainFor({ key: 'php', status: 'bad' }), 'plain: 版非公開');

  // ---- outreach の所見 ----
  const piRes = mk({ php: 'bad', https_redirect: 'bad' }); piRes.find((x) => x.key === 'php').phpinfo = true;
  eq(pickFindingB2b(piRes), 'php_info', 'phpinfo -> php_info(最優先)');
  eq(pickFindingB2b(mk({ php: 'warn' }, {})), null, '版非公開(warn)は所見に使わない');
  const hid = mk({ php: 'warn', mixed: 'bad' }); hid.find((x) => x.key === 'php').noScore = true;
  eq(pickFindingB2b(hid), 'mixed', '版非公開は飛ばして次の所見');
  ok(T.findingsB2b.php_info && T.findingsB2b.php_info['指摘'] && T.findingsB2b.php_info['困ること'] && T.findingsB2b.php_info['一文'], 'findings-b2b: php_info');
  eq(G.groupKeyOfFinding('php_info'), 'php_info', 'groupKey php_info');
  eq(G.batchCode('php_info', new Date('2026-10-29T00:00:00Z')), 'WD-PHP-INFO-20261029', 'バッチコード php_info');
  ok(!/\{[^}]*\}/.test(G.renderGroupBodies(T, 'php_info', new Date('2026-10-29T00:00:00Z')).body), 'php_info グループ本文: 展開済み');
  eq(require('../src/pageRoutes').FINDING_TO_CHECK.php_info, 'php', 'FINDING_TO_CHECK php_info');
  // evidence から版が読める(CSVの PHP版 列用)
  eq(PV.parsePhpVersion('/phpinfo.php が公開されており PHP Version 7.4.33').text, '7.4.33', 'phpinfo evidence から版');
  // 専用ページ用の要約にフラグが残る
  const sf2 = P.summarizeFindings([{ key: 'php', status: 'warn', noScore: true, title: 't', summary: 's', remedy: 'site' }]);
  eq(sf2[0].noScore, true, 'summarizeFindings: noScore');

  // ---- runChecks 経由(通信は差し替え) ----
  const rc = await runChecks({ ...base, headers: {}, body: '<link href="/wp-content/a.css">' }, { fetchPassive: mkFetch({}) });
  const rcPhp = rc.results.find((x) => x.key === 'php');
  eq([rcPhp.status, rcPhp.noScore], ['warn', true], 'runChecks: 版非公開');
  const rcNone = await runChecks({ ...base, headers: {} }, { fetchPassive: mkFetch({}) });
  eq(rc.score, rcNone.score, 'runChecks: 版非公開は点数に影響しない');


  console.log(`php: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
