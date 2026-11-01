'use strict';
// WEB入れ替え候補まわりのテスト(DB不要・偽のプールを使う)
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);

const SS = require('../cli/score-scan');
const R = require('../src/replaceCandidates');
const IMP = require('../cli/warehouse-import');
const BASE = require('../cli/metrics-baseline');
const ADM = require('../src/adminWarehouse');
const { HEADERS } = require('../cli/warehouse-promote');

// 偽のプール: query(sql, params) を記録し、handlers の最初に合うものが答える
function fakePool(handlers = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      const text = typeof sql === 'string' ? sql : sql.sql;
      calls.push({ sql: text, params });
      for (const [rx, fn] of handlers) if (rx.test(text)) return fn(text, params, calls);
      return [[], []];
    },
  };
}

(async () => {
  // ===== 移行008 =====
  const mig = fs.readFileSync(path.join(__dirname, '..', 'sql', 'warehouse_migrate_008.sql'), 'utf8');
  const lits = [...mig.matchAll(/IF\(COUNT\(\*\) = 0, '((?:[^']|'')*)', 'SELECT 1'\)/g)];
  eq(lits.length, 8, '移行008: PREPARE文字列が8個(列7+索引1)で引用符が崩れていない');
  for (const c of ['wd_score SMALLINT NULL', 'wd_grade CHAR\\(1\\) NULL', 'wd_scanned_at DATETIME NULL', 'blog_latest_at DATETIME NULL', 'blog_posts_90d SMALLINT NULL', 'blog_source VARCHAR\\(20\\) NULL', 'blog_checked_at DATETIME NULL']) {
    ok(new RegExp('ADD COLUMN ' + c + " COMMENT ''[^']+''").test(mig), '移行008: ' + c);
  }
  ok(/ADD KEY idx_pref_wdscore \(prefecture, wd_score\)/.test(mig), '移行008: 索引');
  ok(/CREATE TABLE IF NOT EXISTS stoc_master\.shop_metrics_history/.test(mig) && /KEY idx_shop_captured \(shop_id, captured_at\)/.test(mig), '移行008: 履歴表');
  ok((mig.match(/PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;/g) || []).length === 8, '移行008: 冪等の書き方');

  // ===== 履歴: planHistory =====
  const ex = [
    { id: 1, cid: 'A', fallback_key: null, rating: '4.0', review_count: 10, photo_count: 5, has_hist: 1 },
    { id: 2, cid: 'B', fallback_key: null, rating: '4.5', review_count: 20, photo_count: 8, has_hist: 1 },
    { id: 3, cid: 'C', fallback_key: null, rating: null, review_count: 3, photo_count: null, has_hist: 0 },
    { id: 4, cid: null, fallback_key: 'fk4', rating: '3.0', review_count: 1, photo_count: 1, has_hist: 1 },
  ];
  const recs = [
    { cid: 'A', review_count: 10, photo_count: 5, rating: 4.0 },      // 変化なし → 行なし
    { cid: 'B', review_count: 22, photo_count: 8, rating: 4.5 },      // 口コミ増 → 行
    { cid: 'C', review_count: 3, photo_count: null, rating: null },   // 変化なしだが履歴なし → 初回の行
    { cid: null, fallback_key: 'fk4', review_count: null, photo_count: null, rating: 3.5 }, // 評価だけ変化(他は今の値を引き継ぐ)
    { cid: 'N1', review_count: 7, photo_count: 2, rating: 4.1 },       // 新規
  ];
  const plan = IMP.planHistory(recs, ex);
  eq(plan.rows, [[2, 22, 8, 4.5], [3, 3, null, null], [4, 1, 1, 3.5]], '履歴: 変化した店・初回の店だけ。新しい値(取り込みが空なら今の値)');
  eq(plan.newRecs.map((r) => r.cid), ['N1'], '履歴: 新規店は後でID引き');

  // ===== 履歴: upsertBatch(偽のプール) =====
  const mk = (hist) => fakePool([
    [/FROM stoc_master\.shops WHERE cid IN/, (sql) => (/EXISTS/.test(sql) ? [ex.filter((e) => e.cid)] : [[{ id: 99, cid: 'N1', fallback_key: null }]])],
    [/SELECT COUNT\(\*\) AS n/, () => [[{ n: 3 }]]],
  ]);
  let pool = mk();
  let st = { inserted: 0, updated: 0 };
  await IMP.upsertBatch(pool, recs.filter((r) => r.cid), st, false, false, true);
  const hist = pool.calls.filter((c) => /INSERT INTO stoc_master\.shop_metrics_history/.test(c.sql));
  eq(hist.length, 1, '履歴: 挿入は1回(バッチ)');
  eq(hist[0].params, [2, 22, 8, 4.5, 3, 3, null, null, 99, 7, 2, 4.1], '履歴: 変化2件+新規の基準1件(新しい値)');
  ok(/\(\?,NOW\(\),\?,\?,\?\)/.test(hist[0].sql), '履歴: captured_at は NOW()');
  const iUp = pool.calls.findIndex((c) => /INSERT INTO stoc_master\.shops/.test(c.sql));
  const iHist = pool.calls.findIndex((c) => /shop_metrics_history \(/.test(c.sql));
  ok(iUp >= 0 && iHist > iUp, '履歴は upsert の後(新規店のIDが引ける)');
  eq([st.inserted, st.updated], [1, 3], '履歴あり: 新規/更新の数え方は従来どおり');
  // 履歴の表がないとき
  pool = fakePool([[/SELECT COUNT\(\*\) AS n/, () => [[{ n: 0 }]]]]);
  st = { inserted: 0, updated: 0 };
  await IMP.upsertBatch(pool, recs.filter((r) => r.cid), st, false, false, false);
  ok(!pool.calls.some((c) => /shop_metrics_history/.test(c.sql)), '履歴の表がないときは履歴に触れない');

  // ===== metrics-baseline =====
  ok(/NOT EXISTS \(SELECT 1 FROM stoc_master\.shop_metrics_history h WHERE h\.shop_id = s\.id\)/.test(BASE.baselineSql()) && /s\.id >= \? AND s\.id < \?/.test(BASE.baselineSql()), '基準: 履歴のない店だけ・id範囲で区切る');
  pool = fakePool([
    [/information_schema\.TABLES/, () => [[{ n: 1 }]]],
    [/MIN\(id\)/, () => [[{ lo: 1, hi: 120000 }]]],
    [/INSERT INTO stoc_master\.shop_metrics_history/, () => [{ affectedRows: 10 }]],
  ]);
  const total = await BASE.runBaseline(pool, { chunk: 50000, log: () => {} });
  eq([total, pool.calls.filter((c) => /INSERT INTO/.test(c.sql)).length], [30, 3], '基準: 12万件を5万件ずつ3回に分けて実行');
  let err = null;
  try { await BASE.runBaseline(fakePool([[/information_schema\.TABLES/, () => [[{ n: 0 }]]]]), { log: () => {} }); } catch (e) { err = e; }
  ok(err && /migrate_008/.test(err.message), '基準: 表がなければ案内して中止');

  // ===== score-scan: 引数・対象SQL =====
  eq(SS.parseArgs(['--prefecture', '兵庫県']).rescanDays, 30, 'score-scan: 既定の再調査30日');
  eq(SS.parseArgs(['--prefecture', '兵庫県', '--limit', '10', '--concurrency', '3', '--loop']).concurrency, 3, 'score-scan: 引数');
  ok((() => { try { SS.parseArgs([]); } catch { return true; } return false; })(), 'score-scan: 都道府県なしはエラー');
  ok((() => { try { SS.parseArgs(['--prefecture', 'ほげ']); } catch { return true; } return false; })(), 'score-scan: 不正な県名はエラー');
  ok((() => { try { SS.parseArgs(['--prefecture', '兵庫県', '--dry-run']); } catch { return true; } return false; })(), 'score-scan: dry-run は --out が必要');
  eq(SS.parseArgs(['--sync-stoc-only']).syncStocOnly, true, 'score-scan: --sync-stoc-only は県なしでも可');
  const q = SS.buildTargetQuery({ prefecture: ['兵庫県'], rescanDays: 30, afterId: 5, limit: 500, hasSiteHost: true });
  ok(/s\.prefecture IN \(\?\)/.test(q.sql) && /website_url IS NOT NULL/.test(q.sql) && /size_class IS NULL OR s\.size_class <> 'large'/.test(q.sql), '対象SQL: 県・URLあり・大規模除外(NULL可)');
  ok(/wd_scanned_at IS NULL OR s\.wd_scanned_at < NOW\(\) - INTERVAL \? DAY/.test(q.sql) && /COUNT\(\*\) FROM stoc_master\.shops c WHERE c\.site_host = s\.site_host\) < \?/.test(q.sql), '対象SQL: 再調査日数・チェーン除外');
  eq(q.params, [['兵庫県'], 30, 5, 3, 500], '対象SQL: 引数(チェーンは3店舗以上)');
  ok(!/site_host/.test(SS.buildTargetQuery({ prefecture: ['兵庫県'], rescanDays: 30, limit: 1, hasSiteHost: false }).sql), '対象SQL: site_host 列がなければチェーン句なし');

  // ===== score-scan: 書き込み・エラー・並列処理 =====
  const u1 = SS.buildShopUpdate(7, { ok: true, score: 62, grade: 'C', blog: { latestAt: new Date('2026-10-20'), posts90d: 4, source: 'rss' } });
  eq(u1.params, [62, 'C', new Date('2026-10-20'), 4, 'rss', 7], '書き込み: 点数・ブログ');
  ok(/blog_checked_at = NOW\(\)/.test(u1.sql) && /wd_scanned_at = NOW\(\)/.test(u1.sql), '書き込み: 調べた日時');
  const u2 = SS.buildShopUpdate(8, { ok: false, error: 'x' });
  ok(/wd_score = NULL/.test(u2.sql) && /wd_scanned_at = NOW\(\)/.test(u2.sql) && !/blog_/.test(u2.sql) && u2.params[0] === 8, 'エラー: 点数は空・調べた日時だけ入れる(再試行しない)');
  eq(SS.buildShopUpdate(9, { ok: true, score: null, grade: '—', blog: { external: 'note.com' } }).params, [null, null, null, null, 'external:note.com', 9], '外部ブログ: external:名前 を記録');
  const writes = [], synced = [], prog = [];
  const rows = [{ id: 1, website_url: 'https://a.example', stoc_store_id: 11 }, { id: 2, website_url: 'https://b.example', stoc_store_id: null }, { id: 3, website_url: 'https://c.example', stoc_store_id: 13 }];
  const pr = await SS.processTargets(rows, {
    concurrency: 2,
    scan: async (u) => { if (u.includes('b.')) throw new Error('接続できません'); return { score: 55, grade: 'D', blog: { latestAt: new Date(), posts90d: 5, source: 'atom' } }; },
    write: async (id, res) => writes.push([id, res.ok]),
    syncStoc: async (row) => synced.push(row.id),
    onProgress: (s) => prog.push(s.done),
  });
  eq([pr.stats.ok, pr.stats.error, pr.stats.active, pr.stats.inRange], [2, 1, 2, 2], '処理: 成功・エラー・ブログ活発・40〜75点の数');
  eq(writes.sort().length, 3, '処理: エラーの店も書き込む');
  eq(synced.sort(), [1, 3], '処理: 営業管理には紐付いた店だけ写す');
  // 営業管理に写す値
  const sv = SS.writeValues({ ok: true, score: 62, grade: 'C', blog: { posts90d: 2, source: 'rss', latestAt: new Date('2026-10-01') } });
  eq([sv.wd_score, sv.wd_grade, sv.blog_posts_90d, sv.blog_source], [62, 'C', 2, 'rss'], '写す値');

  // scanSite: ブログ判定の失敗で点数を捨てない・fetch は safeFetch 相当を差し替え
  const fakeSf = {
    fetchHomepage: async (u) => ({ finalUrl: u, status: 200, body: '<html></html>', headers: {} }),
    withHttpProbe: async (p) => p, fetchHead: async () => '',
  };
  const sc = await SS.scanSite('https://z.example/', { safeFetch: fakeSf, runChecks: async () => ({ score: 48, grade: 'D' }), detectBlogActivity: async () => { throw new Error('x'); } });
  eq([sc.score, sc.grade, sc.blog.source], [48, 'D', null], 'scanSite: ブログ判定が失敗しても点数は残る');
  err = null;
  try { await SS.scanSite('https://z.example/', { safeFetch: { ...fakeSf, fetchHomepage: () => new Promise(() => {}) }, runChecks: async () => ({}), timeoutMs: 30 }); } catch (e) { err = e; }
  ok(err && /タイムアウト/.test(err.message), 'scanSite: 時間切れ');

  // ===== 営業管理(STOC)への写し =====
  eq(SS.stocDbName({}), 'stoc_sales', 'STOC DB名: 既定');
  eq(SS.stocDbName({ STOC_DB_NAME: 'stoc_x' }), 'stoc_x', 'STOC DB名: 環境変数');
  ok((() => { try { SS.stocDbName({ STOC_DB_NAME: 'a;b' }); } catch { return true; } return false; })(), 'STOC DB名: 不正は拒否');
  const gh = SS.grantHint('stoc_sales', { WH_DB_USER: 'stoc_wh' });
  ok(gh.includes("GRANT UPDATE (wd_score, wd_grade, wd_scanned_at, blog_latest_at, blog_posts_90d, blog_source) ON stoc_sales.stores TO 'stoc_wh'@'localhost'"), 'GRANT案内の文面');
  let rd = await SS.checkStocReady(fakePool([[/information_schema\.COLUMNS/, () => [[{ c: 'wd_score' }]]]]), 'stoc_sales');
  ok(!rd.ok && rd.reason === 'nocolumns' && /wd_grade/.test(rd.message) && /add_webdock_metrics_to_stores\.sql/.test(rd.message), '列がなければ警告してスキップ');
  const allCols = SS.STOC_COLS.map((c) => ({ c }));
  rd = await SS.checkStocReady(fakePool([[/information_schema\.COLUMNS/, () => [allCols]], [/^UPDATE stoc_sales\.stores/, () => { throw Object.assign(new Error('denied'), { errno: 1142 }); }]]), 'stoc_sales');
  ok(!rd.ok && rd.reason === 'nogrant' && /GRANT UPDATE \(wd_score/.test(rd.message) && /権限/.test(rd.message), '権限がなければ日本語でGRANTを案内');
  const readyPool = fakePool([[/information_schema\.COLUMNS/, () => [allCols]]]);
  rd = await SS.checkStocReady(readyPool, 'stoc_sales');
  ok(rd.ok && readyPool.calls.some((c) => /WHERE id = -1/.test(c.sql)), '権限確認は行に当たらないUPDATE');
  const su = SS.stocUpdate('stoc_sales', 55, { wd_score: 60, wd_grade: 'C', wd_scanned_at: 'T', blog_latest_at: null, blog_posts_90d: 1, blog_source: 'rss' });
  ok(/^UPDATE stoc_sales\.stores SET wd_score = \?.*WHERE id = \?$/.test(su.sql) && su.params[6] === 55, 'STOC更新SQL');
  // sync-stoc-only: 500件ずつ
  const shopsPage = (n, from) => Array.from({ length: n }, (_, i) => ({ id: from + i, stoc_store_id: 1000 + from + i, wd_score: 50, wd_grade: 'D', wd_scanned_at: 'T', blog_latest_at: null, blog_posts_90d: null, blog_source: null }));
  let page = 0;
  const syncPool = fakePool([
    [/FROM stoc_master\.shops WHERE id > \?/, (s, p) => { page++; return [page === 1 ? shopsPage(500, 1) : page === 2 ? shopsPage(20, 501) : []]; }],
  ]);
  const ss = await SS.syncStocOnly(syncPool, { prefecture: ['兵庫県'], db: 'stoc_sales', log: () => {} });
  const sel = syncPool.calls.filter((c) => /FROM stoc_master\.shops WHERE id > \?/.test(c.sql));
  eq([ss.done, sel[0].params, sel[1].params[0]], [520, [0, ['兵庫県'], 500], 500], 'sync-stoc-only: 500件ずつ・県で絞る・続きから');
  eq(syncPool.calls.filter((c) => /^UPDATE stoc_sales\.stores/.test(c.sql)).length, 520, 'sync-stoc-only: 1店ずつ更新');

  // ===== 検索SQLの組み立て =====
  const d = R.parseQuery({}).opts;
  eq([d.pref, d.minScore, d.maxScore, d.useBlog, d.blogPosts, d.blogDays, d.useGmap, d.photo, d.review, d.inc, d.mode, d.excludeChains, d.notInStoc],
    [['兵庫県'], 40, 75, true, 3, 60, true, 100, 30, 3, 'or', true, false], '検索の既定値');
  let b = R.buildSearch(d, { hasHistory: true, hasSiteHost: true });
  const w = b.where.join(' AND ');
  ok(b.where[0] === 's.prefecture IN (?)' && b.where[1] === 's.wd_score BETWEEN ? AND ?', '県が先頭(索引 prefecture, wd_score)');
  ok(/s\.blog_posts_90d >= \? OR s\.blog_latest_at >= NOW\(\) - INTERVAL \? DAY\) OR \(s\.photo_count >= \? OR s\.review_count >= \? OR \(EXISTS/.test(w), '既定: ブログ OR GMAP(口コミ増加つき)');
  ok(/captured_at <= NOW\(\) - INTERVAL 28 DAY/.test(w) && /INTERVAL 30 DAY/.test(w), '口コミ増加: 28日以上の履歴・30日');
  ok(/size_class <> 'large'/.test(w) && /< \?/.test(w), '既定: 大規模・チェーンを除く');
  ok(!/stoc_store_id IS NULL/.test(w), '既定: 営業管理未登録の絞りはなし');
  eq(b.params, [['兵庫県'], 40, 75, 3, 3, 60, 100, 30, 3], '既定の引数の並び');
  // 履歴なし
  b = R.buildSearch(d, { hasHistory: false, hasSiteHost: true });
  ok(!/shop_metrics_history/.test(b.where.join(' ')) && b.incExpr === null, '履歴の表がなければ増加は使わない');
  eq(b.params, [['兵庫県'], 40, 75, 3, 3, 60, 100, 30], '履歴なしの引数');
  // AND
  const andO = R.parseQuery({ q: '1', mode: 'and', use_blog: '1', use_gmap: '1', pref: '兵庫県' }).opts;
  b = R.buildSearch(andO, { hasHistory: false, hasSiteHost: false });
  ok(/\) AND \(s\.photo_count/.test(b.where[b.where.length - 1]) && !/ OR \(s\.photo_count/.test(b.where[b.where.length - 1]), 'AND: ブログ AND GMAP');
  ok(andO.excludeChains === false && !b.where.join(' ').includes("size_class"), 'q=1でチェックなしなら除外オフ');
  // 片方だけ・両方なし・未登録のみ
  const onlyBlog = R.parseQuery({ q: '1', use_blog: '1', not_in_stoc: '1' }).opts;
  b = R.buildSearch(onlyBlog, { hasHistory: true });
  ok(b.where.includes('s.stoc_store_id IS NULL') && !b.where.join(' ').includes('photo_count'), '未登録のみ・ブログだけ');
  b = R.buildSearch(R.parseQuery({ q: '1' }).opts, {});
  eq(b.where.length, 3, '両方OFFなら活発さの条件なし');
  // 検証
  ok(R.parseQuery({ min_score: '80', max_score: '50' }).error, '点数の上下逆はエラー');
  ok(R.parseQuery({ pref: 'ほげ' }).error, '不正な県はエラー');
  ok(R.parseQuery({ photo: 'abc' }).error, '数字でない値はエラー');
  // ページ・シリアライズの往復
  const cs = R.countSql(d, { hasSiteHost: true });
  ok(/^SELECT COUNT\(\*\) AS n FROM stoc_master\.shops s WHERE/.test(cs.sql), '件数SQL');
  const ps = R.pageSql(d, { hasHistory: true, hasSiteHost: true }, 100, 200);
  ok(/review_inc/.test(ps.sql) && /LIMIT \? OFFSET \?$/.test(ps.sql) && ps.params.slice(-2).join() === '100,200', '一覧SQL: 100件ずつ・口コミ増加の列');
  const rt = R.parseQuery(Object.fromEntries(new URLSearchParams(R.toQueryString(andO, { page: 2 })))).opts;
  eq([rt.mode, rt.useBlog, rt.useGmap, rt.excludeChains, rt.page, rt.minScore], ['and', true, true, false, 2, 40], '条件はURLで往復できる');
  const ex1 = R.exportSql(d, { hasSiteHost: true }, 77, 1000, true);
  ok(/s\.id > \?/.test(ex1.sql) && /s\.stoc_store_id IS NULL/.test(ex1.sql) && /ORDER BY s\.id LIMIT \?$/.test(ex1.sql), '書き出しSQL: id順・未登録のみ');

  // ===== CSV =====
  const row = { id: 1, name: '山田,商店', category: 'パン屋 / 洋菓子', category_main: 'パン屋', postal: '670-0001', address: '兵庫県姫路市A町1', address_raw: 'raw', phone: '079-000-0000', rating: '4.2', review_count: 40, gbp_registered: '有', website_url: 'https://y.example', gmap_url: 'https://maps/x', photo_count: 120, wd_score: 58, wd_grade: 'D', blog_latest_at: new Date(2026, 9, 25), blog_posts_90d: 6, blog_source: 'rss', stoc_store_id: null, review_inc: 4 };
  eq(R.listCsvHeader(), '﻿' + R.LIST_HEADERS.join(',') + '\r\n', '一覧CSV: BOM付きヘッダ');
  eq(R.listRow(row), ['山田,商店', 'パン屋', '兵庫県姫路市A町1', 58, 'D', '2026-10-25', 6, 'rss', 120, 40, 4, 'https://y.example', '未登録'], '一覧CSV: 列');
  ok(R.listCsvRow(row).startsWith('"山田,商店",パン屋,'), '一覧CSV: カンマは引用');
  eq(R.listRow({ ...row, review_inc: undefined, stoc_store_id: 5 }).slice(-3), ['', 'https://y.example', '登録あり'], '一覧CSV: 増加なしは空・登録あり');
  eq(HEADERS.length, 11, '取込CSVは11列');

  // ===== 管理画面 =====
  eq(ADM.buildScoreScanArgs({ pref: '兵庫県' }).args, ['cli/score-scan.js', '--prefecture', '兵庫県', '--concurrency', '6', '--rescan-days', '30'], '点数取得の引数');
  eq(ADM.buildScoreScanArgs({ pref: ['兵庫県', '大阪府'], scan_limit: '50', rescan_days: '7' }).args.slice(-4), ['--rescan-days', '7', '--limit', '50'], '点数取得: 上限・再調査');
  ok(ADM.buildScoreScanArgs({}).error && ADM.buildScoreScanArgs({ pref: 'x' }).error && ADM.buildScoreScanArgs({ pref: '兵庫県', scan_limit: '0' }).error, '点数取得: 入力検査');

  const started = [];
  const jobs = { start: (s) => { started.push(s); return { ok: true, id: started.length }; }, get: () => null, list: () => [], running: () => null };
  const calls = { search: [], each: [], mark: [] };
  const store = {
    search: async (o, pg) => { calls.search.push([o, pg]); return { caps: { hasScore: true, hasHistory: true, hasSiteHost: true }, total: 250, rows: [row, { ...row, id: 2, name: '<b>x</b>', stoc_store_id: 9 }] }; },
    each: async (o, cb, opt) => { calls.each.push([o, opt]); await cb([row, { ...row, id: 2, name: '二店目' }]); },
    mark: async (ids) => calls.mark.push(ids),
  };
  const app = express();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-'));
  ADM.registerAdminWarehouse(app, { password: 'correct-horse-battery', allowIps: '203.0.113.10', secret: 's', jobs, uploadDir: tmp, exportDir: tmp, queryStats: async () => ({ total: 0, rows: [], sizeAvailable: true }), replaceStore: store });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = server.address().port;
  const req = (p, o = {}) => fetch(`http://127.0.0.1:${port}${p}`, { redirect: 'manual', ...o, headers: { 'X-Real-IP': '203.0.113.10', ...(o.headers || {}) } });
  const A = '/admin/warehouse';
  const lg = await req(A + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=correct-horse-battery' });
  const cookie = (lg.headers.get('set-cookie') || '').split(';')[0];
  const H = { Cookie: cookie };
  const csrf = ((await (await req(A + '/replace', { headers: H })).text()).match(/name="_csrf" value="([0-9a-f]+)"/) || [])[1];
  ok(csrf, 'CSRFが画面にある');

  let res = await req(A + '/replace', { headers: H });
  let html = await res.text();
  ok(res.status === 200 && html.includes('WEB入れ替え候補') && html.includes('兵庫県全体で数時間かかります。夜に回すのがおすすめです。'), '画面: 注意書き・ナビ');
  eq(calls.search.length, 0, '画面: 初めて開いただけでは検索しない');
  res = await req(A + '/replace?q=1&pref=%E5%85%B5%E5%BA%AB%E7%9C%8C&use_blog=1&use_gmap=1&exclude_chains=1&page=2', { headers: H });
  html = await res.text();
  ok(html.includes('該当 250 件') && html.includes('&lt;b&gt;x&lt;/b&gt;') && !html.includes('<b>x</b>'), '画面: 件数・表(HTMLは無害化)');
  eq([calls.search[0][1], calls.search[0][0].page], [2, 2], '画面: ページ指定');
  ok(html.includes('登録あり') && html.includes('未登録') && /page=1/.test(html) && /page=3/.test(html), '画面: 登録の有無・ページ送り');
  res = await req(A + '/replace?q=1&min_score=90&max_score=10', { headers: H });
  ok((await res.text()).includes('点数の下限は上限以下'), '画面: 入力エラー');

  res = await req(A + '/replace/list.csv?q=1&use_blog=1&pref=%E5%85%B5%E5%BA%AB%E7%9C%8C', { headers: H });
  const buf = Buffer.from(await res.arrayBuffer());
  ok(/charset=UTF-8/i.test(res.headers.get('content-type')) && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, '一覧CSV: UTF-8・BOM');
  ok(buf.toString('utf8').includes('二店目') && buf.toString('utf8').split('\r\n').length === 4, '一覧CSV: 全件');
  eq(calls.each[0][0].useGmap, false, '一覧CSV: 条件(GMAPなし)がURLどおり');

  const form = (extra) => new URLSearchParams({ _csrf: csrf, q: '1', pref: '兵庫県', use_blog: '1', use_gmap: '1', ...extra }).toString();
  res = await req(A + '/replace/promote.csv', { method: 'POST', headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({}) });
  ok(/Shift_JIS/i.test(res.headers.get('content-type')), '取込CSV: Shift_JIS');
  const sj = new TextDecoder('shift_jis').decode(Buffer.from(await res.arrayBuffer()));
  ok(sj.startsWith(HEADERS.join(',')) && sj.includes('パン屋') && sj.split('\r\n').length === 4, '取込CSV: 11列ヘッダ+データ');
  eq([calls.each[1][1], calls.mark.length], [{ onlyNotInStoc: true }, 0], '取込CSV: 未登録の店だけ・既定では出力済みにしない');
  res = await req(A + '/replace/promote.csv', { method: 'POST', headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ mark: '1' }) });
  await res.arrayBuffer();
  eq(calls.mark, [[1, 2]], '取込CSV: チェックしたときだけ出力済みにする');
  res = await req(A + '/replace/promote.csv', { method: 'POST', headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'q=1' });
  eq(res.status, 403, '取込CSV: CSRFなしは拒否');

  res = await req(A + '/replace/scan', { method: 'POST', headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, pref: '兵庫県' }).toString() });
  eq([res.status, started[0] && started[0].args[0]], [303, 'cli/score-scan.js'], '点数取得ジョブを開始');
  res = await req(A + '/replace/scan', { method: 'POST', headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf }).toString() });
  eq(res.status, 400, '県なしは400');
  server.close();

  console.log(`replace: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
