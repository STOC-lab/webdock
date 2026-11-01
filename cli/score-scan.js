'use strict';

/**
 * 倉庫のURLあり店舗を診断して点数(wd_score)とブログ更新(blog_*)を記録する。「WEB入れ替え候補」の元データ作り。
 *   node cli/score-scan.js --prefecture 兵庫県 [--limit N] [--concurrency 6] [--rescan-days 30] [--loop]
 *                          [--dry-run --out x.csv]
 *   node cli/score-scan.js --sync-stoc-only [--prefecture 兵庫県]   (倉庫の記録済みの値を営業管理 stores へ写すだけ)
 * 先に sql/warehouse_migrate_008.sql を適用してください。
 * 対象: URLあり・閉業でない・大規模(size_class='large')でない・チェーン(同じホスト名が3店舗以上)でない・除外ドメインでない店で、
 *       wd_scanned_at が空、または --rescan-days 日より前。エラーの店も wd_scanned_at だけ入れる(wd_score は空)ので、rescan-days の間は再試行しない。
 * 取得は公開ページへのGETのみ(トップ+ブログ判定の追加最大3回+robots.txt)。1サイト60秒まで。
 * 営業管理(STOC_DB_NAME、既定 stoc_sales)の stores に wd_score 等の列があり、店が stoc_store_id で紐付いていれば、同じ値を写す。
 */

const fs = require('fs');
const path = require('path');
const wh = require('../src/warehouse');
const { PREFECTURES } = require('../src/regions');
const { CHAIN_MIN, loadChainHosts, loadExcludeDomains, applyPreScanExclusions } = require('../src/exclusions');
const { detectBlogActivity, blogSourceValue } = require('../src/blogActivity');
const { makePool } = require('./warehouse-import');

const SITE_TIMEOUT_MS = 60000;
const LOOP_BATCH = 500;
const LOOP_SLEEP_MS = 30 * 60 * 1000;
const SYNC_BATCH = 500;
const STOC_COLS = ['wd_score', 'wd_grade', 'wd_scanned_at', 'blog_latest_at', 'blog_posts_90d', 'blog_source'];

function parseArgs(argv) {
  const o = { prefecture: [], limit: 0, concurrency: 6, rescanDays: 30, loop: false, dryRun: false, out: null, syncStocOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--prefecture') o.prefecture = String(next() || '').split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--limit') o.limit = Number(next());
    else if (a === '--concurrency') o.concurrency = Number(next());
    else if (a === '--rescan-days') o.rescanDays = Number(next());
    else if (a === '--loop') o.loop = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--out') o.out = next();
    else if (a === '--sync-stoc-only') o.syncStocOnly = true;
    else throw new Error('不明なオプション: ' + a);
  }
  if (o.prefecture.some((p) => !PREFECTURES.includes(p))) throw new Error('--prefecture の都道府県名が正しくありません');
  if (!o.syncStocOnly && !o.prefecture.length) throw new Error('--prefecture を指定してください(例: --prefecture 兵庫県)');
  if (!Number.isFinite(o.limit) || o.limit < 0) throw new Error('--limit の値が不正です');
  for (const k of ['concurrency', 'rescanDays']) {
    if (!Number.isFinite(o[k]) || o[k] < 1) throw new Error(`--${k === 'rescanDays' ? 'rescan-days' : k} の値が不正です`);
    o[k] = Math.floor(o[k]);
  }
  if (o.dryRun && !o.out) throw new Error('--dry-run には --out <CSV> が必要です');
  o.limit = Math.floor(o.limit);
  return o;
}

/** 対象を読むSQL。都道府県 → 索引(prefecture, …)。チェーン判定は site_host の索引で数える */
function buildTargetQuery({ prefecture, rescanDays, afterId = 0, limit, hasSiteHost = true }) {
  const params = [prefecture];
  let sql = `SELECT s.id, s.name, s.website_url, s.stoc_store_id
FROM stoc_master.shops s
WHERE s.prefecture IN (?) AND s.website_url IS NOT NULL AND s.website_url <> ''
  AND (s.business_status IS NULL OR (s.business_status NOT LIKE '%閉業%' AND s.business_status NOT LIKE '%閉店%'))
  AND (s.size_class IS NULL OR s.size_class <> 'large')
  AND (s.wd_scanned_at IS NULL OR s.wd_scanned_at < NOW() - INTERVAL ? DAY)
  AND s.id > ?`;
  params.push(rescanDays, afterId);
  if (hasSiteHost) {
    sql += `
  AND (s.site_host IS NULL OR (SELECT COUNT(*) FROM stoc_master.shops c WHERE c.site_host = s.site_host) < ?)`;
    params.push(CHAIN_MIN);
  }
  sql += '\nORDER BY s.id\nLIMIT ?';
  params.push(limit);
  return { sql, params };
}

/* ---------- 1サイトの診断 ---------- */

/** 診断(batch-scan の scanOne と同じ fetchHomepage + withHttpProbe + runChecks)に、ブログ判定を足す。全体で60秒 */
async function scanSite(url, deps = {}) {
  const sf = deps.safeFetch || require('../src/safeFetch');
  const runChecks = deps.runChecks || require('../src/checks').runChecks;
  const detect = deps.detectBlogActivity || detectBlogActivity;
  const deadline = Date.now() + (deps.timeoutMs || SITE_TIMEOUT_MS);
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('タイムアウトしました')), deps.timeoutMs || SITE_TIMEOUT_MS); });
  try {
    return await Promise.race([(async () => {
      const page = await sf.withHttpProbe(await sf.fetchHomepage(url));
      const r = await runChecks(page);
      let blog = { latestAt: null, posts90d: null, source: null, external: null };
      try {
        const fetchFn = async (u) => { if (Date.now() > deadline) throw new Error('時間切れ'); return sf.fetchHomepage(u); };
        const fetchRobots = deps.fetchRobots || ((origin) => sf.fetchHead(origin + '/robots.txt', 16384, 4000));
        blog = await detect({ finalUrl: page.finalUrl, body: page.body }, fetchFn, { fetchRobots });
      } catch { /* ブログ判定の失敗で点数は捨てない */ }
      return { score: r.score, grade: r.grade, blog };
    })(), timeout]);
  } finally { clearTimeout(timer); }
}

/** 結果 → 倉庫の更新(SQLと引数)。ok=false(エラー)は点数を空にして wd_scanned_at だけ入れる */
function buildShopUpdate(id, res) {
  if (!res.ok) {
    return { sql: 'UPDATE stoc_master.shops SET wd_score = NULL, wd_grade = NULL, wd_scanned_at = NOW() WHERE id = ?', params: [id] };
  }
  const b = res.blog || {};
  return {
    sql: 'UPDATE stoc_master.shops SET wd_score = ?, wd_grade = ?, wd_scanned_at = NOW(), blog_latest_at = ?, blog_posts_90d = ?, blog_source = ?, blog_checked_at = NOW() WHERE id = ?',
    params: [res.score ?? null, res.score === null || res.score === undefined ? null : String(res.grade).slice(0, 1), b.latestAt || null, b.posts90d ?? null, blogSourceValue(b), id],
  };
}

/* ---------- 営業管理(STOC)への写し ---------- */

function stocDbName(env = process.env) {
  const n = env.STOC_DB_NAME || 'stoc_sales';
  if (!/^[A-Za-z0-9_]+$/.test(n)) throw new Error('STOC_DB_NAME が不正です: ' + n);
  return n;
}

function grantHint(db, env = process.env) {
  const user = env.WH_DB_USER || '<WH_DB_USER>';
  return `  GRANT UPDATE (${STOC_COLS.join(', ')}) ON ${db}.stores TO '${user}'@'localhost';\n  FLUSH PRIVILEGES;`;
}

/**
 * 営業管理側の準備を確かめる。戻り: { ok:true } / { ok:false, reason:'nocolumns'|'nogrant'|'noaccess', message }
 * 列は information_schema で、書き込み権限は「どの行にも当たらない UPDATE」で確かめる(データは変わらない)。
 */
async function checkStocReady(pool, db) {
  try {
    const [r] = await pool.query(
      'SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME IN (?)', [db, 'stores', STOC_COLS]);
    const have = new Set(r.map((x) => x.c));
    const missing = STOC_COLS.filter((c) => !have.has(c));
    if (missing.length) {
      return { ok: false, reason: 'nocolumns', message: `営業管理 ${db}.stores に列がありません(${missing.join(', ')})。営業管理側の database/migrations/add_webdock_metrics_to_stores.sql を適用してください。営業管理への写しはスキップします。` };
    }
  } catch (e) {
    return { ok: false, reason: 'noaccess', message: `営業管理 ${db}.stores の列を確認できませんでした(${e.message})。営業管理への写しはスキップします。` };
  }
  try {
    await pool.query(`UPDATE ${db}.stores SET wd_score = wd_score WHERE id = -1`);
  } catch (e) {
    if (e && [1044, 1142, 1143, 1227].includes(e.errno)) {
      return { ok: false, reason: 'nogrant', message: `エラー: 営業管理 ${db}.stores の点数の列を更新する権限がありません。root で次を実行してから、もう一度実行してください。\n${grantHint(db)}` };
    }
    return { ok: false, reason: 'noaccess', message: `営業管理 ${db}.stores を確認できませんでした(${e.message})。営業管理への写しはスキップします。` };
  }
  return { ok: true };
}

function stocUpdate(db, stocStoreId, v) {
  return {
    sql: `UPDATE ${db}.stores SET wd_score = ?, wd_grade = ?, wd_scanned_at = ?, blog_latest_at = ?, blog_posts_90d = ?, blog_source = ? WHERE id = ?`,
    params: [v.wd_score ?? null, v.wd_grade ?? null, v.wd_scanned_at || null, v.blog_latest_at || null, v.blog_posts_90d ?? null, v.blog_source ?? null, stocStoreId],
  };
}

/** 倉庫の記録済みの値を、紐付いた営業管理の店へ500件ずつ写す */
async function syncStocOnly(pool, { prefecture = [], db, log = console.error, shouldStop = () => false }) {
  const st = { done: 0 };
  let after = 0;
  for (;;) {
    if (shouldStop()) break;
    const params = [];
    let sql = 'SELECT id, stoc_store_id, wd_score, wd_grade, wd_scanned_at, blog_latest_at, blog_posts_90d, blog_source FROM stoc_master.shops WHERE id > ? AND stoc_store_id IS NOT NULL AND wd_scanned_at IS NOT NULL';
    params.push(after);
    if (prefecture.length) { sql += ' AND prefecture IN (?)'; params.push(prefecture); }
    sql += ' ORDER BY id LIMIT ?';
    params.push(SYNC_BATCH);
    const [rows] = await pool.query(sql, params);
    if (!rows.length) break;
    for (const r of rows) {
      const u = stocUpdate(db, r.stoc_store_id, r);
      await pool.query(u.sql, u.params);
    }
    st.done += rows.length;
    after = rows[rows.length - 1].id;
    log(`[営業管理へ写し] ${st.done}件`);
  }
  log(`営業管理へ写し完了: ${st.done}件`);
  return st;
}

/**
 * 倉庫に点数があり、営業管理側がまだ古い(または空の)店だけを、1本の UPDATE ... JOIN で写す。
 * 常駐(--loop)中に「営業管理とつなぐ」で紐付いた店を自動で拾うために使う。戻り: 更新した件数(affectedRows)
 * db は stocDbName() で検証済みの値を渡すこと(SQL に直接埋め込むため)。
 */
async function syncStocPending(pool, { prefecture = [], db, log = console.error }) {
  if (!/^[A-Za-z0-9_]+$/.test(String(db))) throw new Error('営業管理のDB名が不正です: ' + db);
  const params = [];
  let sql = `UPDATE ${db}.stores st JOIN stoc_master.shops s ON s.stoc_store_id = st.id`
    + ' SET st.wd_score = s.wd_score, st.wd_grade = s.wd_grade, st.wd_scanned_at = s.wd_scanned_at,'
    + ' st.blog_latest_at = s.blog_latest_at, st.blog_posts_90d = s.blog_posts_90d, st.blog_source = s.blog_source'
    + ' WHERE s.wd_scanned_at IS NOT NULL AND (st.wd_scanned_at IS NULL OR st.wd_scanned_at <> s.wd_scanned_at)';
  if (prefecture.length) { sql += ' AND s.prefecture IN (?)'; params.push(prefecture); }
  const [res] = await pool.query(sql, params);
  const n = (res && res.affectedRows) || 0;
  if (n > 0) log(`[営業管理へ自動写し] ${n}件`);
  return n;
}

/* ---------- 処理本体 ---------- */

/**
 * rows を concurrency 並列で処理する。
 * deps: { scan(url), write(id, result), syncStoc?(row, result), shouldStop, onProgress(stats) }
 */
async function processTargets(rows, deps) {
  const st = { total: rows.length, done: 0, ok: 0, error: 0, active: 0, inRange: 0 };
  const results = [];
  let idx = 0;
  const worker = async () => {
    for (;;) {
      if (deps.shouldStop && deps.shouldStop()) return;
      const i = idx++;
      if (i >= rows.length) return;
      const row = rows[i];
      let res;
      try {
        const r = await deps.scan(row.website_url);
        res = { ok: true, score: r.score, grade: r.grade, blog: r.blog };
        st.ok++;
        const b = r.blog || {};
        const recent = (b.posts90d >= 3) || (b.latestAt && Date.now() - +new Date(b.latestAt) <= 60 * 86400000);
        if (recent) st.active++;
        if (r.score !== null && r.score >= 40 && r.score <= 75) st.inRange++;
      } catch (e) {
        res = { ok: false, error: e && e.message };
        st.error++;
      }
      try {
        await deps.write(row.id, res);
        if (deps.syncStoc && row.stoc_store_id) await deps.syncStoc(row, res);
      } catch (e) {
        console.error(`  書き込みエラー id=${row.id}: ${e.message}`);
      }
      results.push({ row, res });
      st.done++;
      if (deps.onProgress) deps.onProgress(st);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, deps.concurrency || 1) }, worker));
  return { stats: st, results };
}

const csvField = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const CSV_COLUMNS = ['id', '店名', 'URL', '点数', '判定', 'ブログ最新日', '90日件数', '取得元', 'エラー'];
function csvRow(row, res) {
  const b = res.blog || {};
  return [row.id, row.name, row.website_url, res.ok ? res.score : '', res.ok ? res.grade : '', b.latestAt ? new Date(b.latestAt).toISOString().slice(0, 10) : '', b.posts90d ?? '', res.ok ? blogSourceValue(b) || '' : '', res.ok ? '' : res.error || ''].map(csvField).join(',') + '\r\n';
}

async function fetchTargets(pool, opts, afterId, limit, hasSiteHost, excludeList) {
  const q = buildTargetQuery({ prefecture: opts.prefecture, rescanDays: opts.rescanDays, afterId, limit, hasSiteHost });
  const [raw] = await pool.query(q.sql, q.params);
  if (!raw.length) return { rows: [], lastId: afterId, excluded: 0 };
  const lastId = raw[raw.length - 1].id;
  const { siteHostOf } = require('../src/siteHost');
  const hosts = raw.map((r) => siteHostOf(r.website_url)).filter(Boolean);
  const chain = hasSiteHost ? await loadChainHosts(pool, hosts, { columnExists: wh.columnExists, warn: () => {} }) : { hosts: new Set() };
  const { rows } = applyPreScanExclusions(raw.map((r) => ({ ...r, url: r.website_url })), { excludeList, chainHosts: chain.hosts });
  return { rows, lastId, excluded: raw.length - rows.length };
}

async function main() {
  try { require('dotenv').config(); } catch { /* なくても動く */ }
  const o = parseArgs(process.argv.slice(2));
  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.error('\n停止要求を受け付けました。処理中のサイトが終わり次第終了します(もう一度押すと強制終了)。');
  });
  const pool = makePool();
  try {
    const db = stocDbName();
    if (o.syncStocOnly) {
      const ready = await checkStocReady(pool, db);
      if (!ready.ok) { console.error(ready.message); process.exitCode = 1; return; }
      await syncStocOnly(pool, { prefecture: o.prefecture, db, shouldStop: () => stopping });
      return;
    }
    if (!(await wh.columnExists(pool, 'shops', 'wd_score'))) {
      throw new Error('shops.wd_score 列がありません。先に sql/warehouse_migrate_008.sql を適用してください。');
    }
    const hasSiteHost = await wh.columnExists(pool, 'shops', 'site_host');
    if (!hasSiteHost) console.error('警告: shops.site_host 列がないためチェーン判定ができません(sql/warehouse_migrate_005.sql と node cli/warehouse-sitehost.js を実行してください)。');
    const excludeList = loadExcludeDomains();

    // 営業管理への写し(列がなければ1回だけ警告してスキップ。権限がなければここで止める)
    let syncStoc = null;
    let stocReady = false;
    if (!o.dryRun) {
      const ready = await checkStocReady(pool, db);
      if (ready.ok) {
        stocReady = true;
        syncStoc = async (row, res) => { const u = stocUpdate(db, row.stoc_store_id, writeValues(res)); await pool.query(u.sql, u.params); };
      } else if (ready.reason === 'nogrant') {
        console.error(ready.message); process.exitCode = 1; return;
      } else console.error('警告: ' + ready.message);
    }

    let csv = null;
    if (o.dryRun) {
      fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
      csv = '﻿' + CSV_COLUMNS.map(csvField).join(',') + '\r\n';
    }
    const write = async (id, res) => { if (!o.dryRun) { const u = buildShopUpdate(id, res); await pool.query(u.sql, u.params); } };
    const total = { done: 0, ok: 0, error: 0 };
    const runOnce = async (limit) => {
      let after = 0, got = 0, round = { done: 0, ok: 0, error: 0 };
      const loopBatch = o.loop && !o.dryRun;
      while (!stopping) {
        const want = loopBatch ? LOOP_BATCH : (o.limit ? Math.min(LOOP_BATCH, o.limit - got) : LOOP_BATCH);
        if (want <= 0) break;
        const t = await fetchTargets(pool, o, after, want, hasSiteHost, excludeList);
        const lastWasFull = t.lastId !== after;
        if (!lastWasFull) break;
        after = t.lastId;
        got += t.rows.length;
        if (t.excluded) console.error(`チェーン・除外ドメインで除外: ${t.excluded}件`);
        let lastPrinted = 0;
        const { stats, results } = await processTargets(t.rows, {
          concurrency: o.concurrency, scan: (u) => scanSite(u), write, syncStoc, shouldStop: () => stopping,
          onProgress: (s) => {
            if ((s.done % 50 === 0 || s.done === s.total) && s.done !== lastPrinted) {
              lastPrinted = s.done;
              console.error(`[${s.done}/${s.total}] 成功 ${s.ok}件 / 40〜75点 ${s.inRange}件 / ブログ活発 ${s.active}件 / エラー ${s.error}件`);
            }
          },
        });
        if (csv !== null) for (const { row, res } of results) csv += csvRow(row, res);
        round.done += stats.done; round.ok += stats.ok; round.error += stats.error;
        if (!loopBatch && o.limit && got >= o.limit) break;
      }
      for (const k of ['done', 'ok', 'error']) total[k] += round[k];
      return round;
    };
    // 常駐中の自動写し(失敗してもプロセスは落とさない)
    const autoSync = async () => {
      if (!stocReady) return;
      try { await syncStocPending(pool, { prefecture: o.prefecture, db }); }
      catch (e) { console.error('警告: 営業管理への自動写しに失敗: ' + e.message); }
    };
    if (o.loop && !o.dryRun) {
      while (!stopping) {
        const r = await runOnce();
        if (!r.done) {
          await autoSync();
          console.error(`対象なし。30分待機します (${new Date().toLocaleString('ja-JP')})`);
          for (let t = 0; t < LOOP_SLEEP_MS && !stopping; t += 1000) await new Promise((res) => setTimeout(res, 1000));
        } else {
          console.error(`周回完了: ${r.done}件 (成功${r.ok} / エラー${r.error})`);
          await autoSync();
        }
      }
    } else {
      if (o.loop && o.dryRun) console.error('--dry-run のため --loop は無視します');
      await runOnce();
      console.error(`完了: ${total.done}件 (成功${total.ok} / エラー${total.error})${o.dryRun ? ` -> ${o.out}` : ''}`);
      if (csv !== null) fs.writeFileSync(o.out, csv);
    }
  } finally { await pool.end(); }
}

/** 診断結果 → 営業管理に写す値(倉庫に書くのと同じ内容。エラーは点数なし) */
function writeValues(res) {
  const u = buildShopUpdate(0, res);
  if (!res.ok) return { wd_score: null, wd_grade: null, wd_scanned_at: new Date(), blog_latest_at: null, blog_posts_90d: null, blog_source: null };
  const b = res.blog || {};
  return { wd_score: res.score ?? null, wd_grade: u.params[1], wd_scanned_at: new Date(), blog_latest_at: b.latestAt || null, blog_posts_90d: b.posts90d ?? null, blog_source: blogSourceValue(b) };
}

if (require.main === module) {
  main().catch((e) => { console.error('エラー: ' + e.message); process.exit(1); });
}

module.exports = {
  parseArgs, buildTargetQuery, scanSite, buildShopUpdate, processTargets, fetchTargets, csvRow, CSV_COLUMNS, STOC_COLS,
  stocDbName, grantHint, checkStocReady, stocUpdate, syncStocOnly, syncStocPending, writeValues, SITE_TIMEOUT_MS,
};
