'use strict';
// 診断前の除外(送信済み・チェーン・除外ドメイン)、site_host の移行SQL・バックフィル・取り込みのテスト。DB不要(偽の接続)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { siteHostOf } = require('../src/siteHost');
const EX = require('../src/exclusions');
const { selectForScan } = require('../cli/batch-scan');
const { backfill, parseArgs } = require('../cli/warehouse-sitehost');
const { upsertSql } = require('../cli/warehouse-import');
const O = require('../src/outreachSingle');
const { loadTemplates } = require('../src/outreach');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);

(async () => {
  // ホスト名の取り出し
  eq(siteHostOf('https://www.Example.CO.jp/path?q=1'), 'example.co.jp', 'www除去・小文字');
  eq(siteHostOf('example.jp'), 'example.jp', 'スキームなし');
  eq(siteHostOf('http://shop.autozam.jp:8080/'), 'shop.autozam.jp', 'サブドメイン・ポートは落とす');
  eq(siteHostOf('//www.a.jp'), 'a.jp', '先頭//');
  eq([siteHostOf(''), siteHostOf(null), siteHostOf('http://'), siteHostOf('ht tp://x')], [null, null, null, null], '取り出せないものはnull');
  eq(siteHostOf('https://' + 'a'.repeat(260) + '.jp'), null, '255文字超はnull');

  // 除外ドメイン一覧
  const list = EX.parseExcludeDomains('﻿# コメント\nAutozam.JP # 理由\n\n  https://www.bunsen-kk.co.jp/  \nautozam.jp\nwww.dup.jp\n#x.jp\n');
  eq(list, ['autozam.jp', 'bunsen-kk.co.jp', 'dup.jp'], '一覧の解析(コメント・BOM・URL・重複)');
  ok(EX.matchesExcludeList('autozam.jp', list) && EX.matchesExcludeList('shop.autozam.jp', list) && EX.matchesExcludeList('www.autozam.jp', list), '完全一致・サブドメイン・www');
  ok(!EX.matchesExcludeList('notautozam.jp', list) && !EX.matchesExcludeList('autozam.jp.evil.com', list) && !EX.matchesExcludeList('', list), '部分一致はしない');
  const real = EX.loadExcludeDomains();
  ok(real.includes('autozam.jp') && real.includes('bunsen-kk.co.jp'), '同梱の一覧に autozam.jp / bunsen-kk.co.jp');
  eq(EX.loadExcludeDomains('/nonexistent/x.txt'), [], 'ファイルなしは空');

  // 診断前の除外(順序・件数・limit)
  const rows = [
    { store_id: '1', url: 'https://sent.jp', stocStoreId: '100' },
    { store_id: '2', url: 'https://www.autozam.jp/', stocStoreId: '101' },
    { store_id: '3', url: 'https://chain.jp', stocStoreId: '102' },
    { store_id: '4', url: 'https://ok1.jp', stocStoreId: '103' },
    { store_id: '5', url: 'https://ok2.jp', stocStoreId: '' },
    { store_id: '6', url: 'https://shop.bunsen-kk.co.jp', stocStoreId: '100' },
    { store_id: '7', url: 'https://ok3.jp', stocStoreId: '104' },
  ];
  const ctx = { resendSet: new Set([100]), excludeList: list, chainHosts: new Set(['chain.jp']) };
  const r = EX.applyPreScanExclusions(rows, ctx);
  eq(r.rows.map((x) => x.store_id), ['4', '5', '7'], '残る行');
  eq(r.counts, { 'WEBドック送信済み・送信予定': 2, '除外ドメイン指定': 1, 'チェーン・共通ドメイン': 1 }, '理由ごとの件数(送信済みが優先)');
  const lim = selectForScan(rows, ctx, 2);
  eq(lim.rows.map((x) => x.store_id), ['4', '5'], '除外のあとに limit');
  eq(selectForScan(rows, {}, 0).rows.length, 7, 'ctx なしは何も外さない');

  // 送信済みの店を読むSQL
  const q = EX.resendQuery('stoc_sales');
  ok(q.includes("JSON_UNQUOTE(JSON_EXTRACT(b.filter_json, '$.source')) = 'webdock_b2b'") && !/send_status/.test(q) && q.includes('JOIN stoc_sales.inquiry_export_batches b ON b.id = i.batch_id'), '送信済み: source=webdock_b2b の全明細(send_status 不問)');
  ok(q.includes('AND (i.approach_label IS NULL OR i.approach_label <> ?)') && EX.MEO_WRONG_LABEL === 'MEO文面で送信(誤)', '誤MEO文面のラベルの明細は除外しない(条件)');
  let rp = null;
  await EX.loadResendSet({ query: async (sql, params) => { rp = { sql, params }; return [[]]; } }, 'stoc_sales');
  eq(rp.params, ['MEO文面で送信(誤)'], 'ラベルをパラメータで渡す');
  const set = await EX.loadResendSet({ query: async () => [[{ store_id: 5 }, { store_id: '7' }, { store_id: null }, { store_id: 5 }]] }, 'stoc_sales');
  eq([...set].sort(), [5, 7], '送信済みの集合');
  let err = null;
  try { await EX.loadResendSet({ query: async () => { throw new Error('denied'); } }, 'stoc_sales'); } catch (e) { err = e; }
  ok(err && err.stocCheck && err.message.includes('中止'), '読めなければ中止(スキップしない)');

  // チェーン判定の問い合わせ
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('GROUP BY')) return [[{ h: 'chain.jp', n: 5 }]];
      return [[]];
    },
  };
  const warns = [];
  const c = await EX.loadChainHosts(pool, ['chain.jp', 'a.jp', null, 'a.jp'], { columnExists: async () => true, warn: (m) => warns.push(m) });
  eq([...c.hosts], ['chain.jp'], 'チェーンのホスト');
  ok(c.available && !c.unfilled && warns.length === 0, '警告なし');
  const g = calls.find((x) => x.sql.includes('GROUP BY'));
  ok(g.sql.includes('HAVING COUNT(*) >= ?') && g.sql.includes('site_host IN (?)') && g.params[1] === 3 && JSON.stringify(g.params[0]) === JSON.stringify(['chain.jp', 'a.jp']), 'HAVING >= 3 / 候補ホストだけ / 重複・nullなし');
  ok(EX.CHAIN_MIN === 3, '閾値は3');
  // 1000件ずつ
  calls.length = 0;
  await EX.loadChainHosts(pool, Array.from({ length: 2500 }, (_, i) => `h${i}.jp`), { columnExists: async () => true, warn: () => {} });
  eq(calls.filter((x) => x.sql.includes('GROUP BY')).map((x) => x.params[0].length), [1000, 1000, 500], '1000件ずつ');
  // 列なし → 警告してスキップ
  const w2 = [];
  const noCol = await EX.loadChainHosts({ query: async () => { throw new Error('呼ばれない'); } }, ['x.jp'], { columnExists: async () => false, warn: (m) => w2.push(m) });
  ok(!noCol.available && noCol.hosts.size === 0 && w2.length === 1 && w2[0].includes('warehouse_migrate_005.sql'), '列なし: 警告して除外をスキップ(失敗しない)');
  // 未バックフィルの警告
  const w3 = [];
  const un = await EX.loadChainHosts({ query: async (sql) => (sql.includes('GROUP BY') ? [[]] : [[{ x: 1 }]]) }, ['x.jp'], { columnExists: async () => true, warn: (m) => w3.push(m) });
  ok(un.unfilled && w3.length === 1 && w3[0].includes('warehouse-sitehost.js'), '未バックフィルの警告');

  // 移行SQL 005
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'warehouse_migrate_005.sql'), 'utf8');
  ok(sql.includes('site_host VARCHAR(255) NULL') && sql.includes('information_schema.COLUMNS') && sql.includes('information_schema.STATISTICS') && sql.includes('idx_site_host'), '005: 列と索引を冪等に追加');
  eq((sql.match(/PREPARE st FROM @s/g) || []).length, 2, '005: PREPARE は2回');
  // SET @s = (SELECT IF(COUNT(*) = 0, '<DDL>', 'SELECT 1') ... の文字列リテラルを、'' を倍加として読んで取り出す
  const lits = [];
  for (const m of sql.matchAll(/IF\(COUNT\(\*\) = 0, ((?:'(?:[^']|'')*'))\s*,\s*('SELECT 1')\)/g)) lits.push(m[1]);
  eq(lits.length, 2, '005: DDL文字列リテラルを2つ読める');
  ok(lits.every((l) => !/[^']'[^']/.test(l.slice(1, -1).replace(/''/g, ''))), '005: リテラル内の引用符は倍加(001-004と同じ)');
  ok(!/;\s*$/m.test(lits.join('\n')), '005: リテラル内に ; なし');
  // 003 と同じ検査(ENUM('..') を含むものは '' で倍加されている)
  const s3 = fs.readFileSync(path.join(__dirname, '..', 'sql', 'warehouse_migrate_003.sql'), 'utf8');
  ok(s3.includes("ENUM(''small'',''large'',''unknown'')"), '003: 倍加の書式(005の検査の基準)');

  // バックフィル(偽プール)
  const table = [
    { id: 1, website_url: 'https://www.A.jp/x', site_host: null },
    { id: 2, website_url: 'b.jp', site_host: null },
    { id: 3, website_url: 'http://', site_host: null },
    { id: 4, website_url: 'https://done.jp', site_host: 'done.jp' },
    { id: 5, website_url: 'https://c.jp', site_host: null },
    { id: 6, website_url: '', site_host: null },
  ];
  const updates = [];
  const bpool = (hasCol) => ({
    query: async (sql, p) => {
      if (sql.includes('information_schema.COLUMNS')) return [[{ n: hasCol ? 1 : 0 }]];
      if (sql.startsWith('SELECT id, website_url')) {
        const re = sql.includes('site_host IS NULL');
        const rs = table.filter((t) => t.id > p[0] && t.website_url && (!re || t.site_host === null)).slice(0, p[1]);
        return [rs.map((t) => ({ id: t.id, website_url: t.website_url }))];
      }
      if (sql.startsWith('UPDATE')) {
        const n = (p.length) / 3; // id,host の組 n個 + id n個
        for (let i = 0; i < n; i++) { const t = table.find((x) => x.id === p[i * 2]); t.site_host = p[i * 2 + 1]; updates.push([p[i * 2], p[i * 2 + 1]]); }
        return [{ affectedRows: n }];
      }
      throw new Error('想定外: ' + sql);
    },
  });
  const st = await backfill(bpool(true), { chunk: 2, log: () => {} });
  eq(table.map((t) => t.site_host), ['a.jp', 'b.jp', '', 'done.jp', 'c.jp', null], 'バックフィル: www除去・小文字・不正は空文字・URLなし行は触らない・処理済みはそのまま');
  eq(st, { scanned: 4, updated: 4, empty: 1 }, 'バックフィル: 件数(chunk=2で複数回)');
  const again = await backfill(bpool(true), { chunk: 2, log: () => {} });
  eq(again.scanned, 0, '再実行は何もしない');
  table[3].site_host = 'old';
  const re = await backfill(bpool(true), { chunk: 10, recompute: true, log: () => {} });
  eq([re.scanned, table[3].site_host], [5, 'done.jp'], '--recompute: 全行計算し直す');
  const before = updates.length;
  table[0].site_host = null;
  const dry = await backfill(bpool(true), { chunk: 10, dryRun: true, log: () => {} });
  ok(dry.updated === 0 && updates.length === before && table[0].site_host === null, '--dry-run: 書かない');
  let e5 = null;
  try { await backfill(bpool(false), { log: () => {} }); } catch (e) { e5 = e; }
  ok(e5 && e5.message.includes('warehouse_migrate_005.sql'), 'バックフィル: 列なしは案内つきで中止');
  eq(parseArgs(['--chunk', '500', '--recompute']), { chunk: 500, recompute: true, dryRun: false }, '引数');

  // 取り込みSQL
  const u0 = upsertSql(2, true);
  ok(!u0.includes('site_host'), '取り込み: 列なしなら従来のSQL');
  const u1 = upsertSql(2, true, true);
  ok(u1.includes(',site_host,first_seen_at') && (u1.match(/\(\?(,\?)*,NOW\(\),NOW\(\)\)/g) || []).every((x) => (x.match(/\?/g) || []).length === 22), '取り込み: site_host を列に追加(行ごとに22個)');
  ok(u1.indexOf('site_host = IF(website_url IS NULL') > 0 && u1.indexOf('site_host = IF(website_url IS NULL') < u1.indexOf('website_url = IF('), '取り込み: site_host の更新は website_url の更新より前');

  // まとめ.txt に診断前の除外が出る
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'excl-'));
  try {
    const T = loadTemplates();
    const res = await O.buildSingleFiles({
      rows: [], outDir: dir, templates: T, dryRun: true, now: new Date(),
      preExcluded: { 'WEBドック送信済み・送信予定': 12, 'チェーン・共通ドメイン': 3, '除外ドメイン指定': 0 },
      stoc: { fetchStores: async () => new Map(), register: async () => ({}) },
    });
    const txt = fs.readFileSync(path.join(dir, 'まとめ.txt'), 'utf8');
    ok(txt.includes('診断前に除外した会社') && txt.includes('・WEBドック送信済み・送信予定: 12社') && txt.includes('・チェーン・共通ドメイン: 3社') && !txt.includes('除外ドメイン指定: 0'), 'まとめ.txt: 診断前の除外(0件は出さない)');
    eq(JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')).preExcluded['WEBドック送信済み・送信予定'], 12, 'result.json にも出す');
    const txt2 = (await O.buildSingleFiles({ rows: [], outDir: dir, templates: T, dryRun: true, stoc: { fetchStores: async () => new Map() } }), fs.readFileSync(path.join(dir, 'まとめ.txt'), 'utf8'));
    ok(txt2.includes('診断前に除外した会社') && txt2.includes('(なし)'), 'まとめ.txt: 除外なしでも壊れない');
    void res;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  console.log(`exclude: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
