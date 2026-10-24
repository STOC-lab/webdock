'use strict';

/**
 * 倉庫(stoc_master.shops)への取り込み
 *   node cli/warehouse-import.js --root <folder> [--dry-run] [--batch 1000]
 *   node cli/warehouse-import.js --link-only
 * 接続: WH_DB_HOST(127.0.0.1) WH_DB_PORT WH_DB_USER WH_DB_PASS (.env)
 */

const fs = require('fs');
const path = require('path');
const wh = require('../src/warehouse');

const BIG_FILE = 200 * 1024 * 1024;
const CHUNK = 64 * 1024 * 1024;
const LINK_CHUNK = 50000;

function parseArgs(argv) {
  const o = { root: null, dryRun: false, batch: 1000, linkOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') o.root = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--link-only') o.linkOnly = true;
    else if (a === '--batch') o.batch = Math.floor(Number(argv[++i]));
    else throw new Error('不明なオプション: ' + a);
  }
  if (!o.linkOnly && !o.root) throw new Error('--root <フォルダ> を指定してください');
  if (!Number.isFinite(o.batch) || o.batch < 1) throw new Error('--batch の値が不正です');
  return o;
}

function* walk(dir) {
  const ents = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (/\.(csv|tsv|txt)$/i.test(e.name)) yield full;
  }
}

/** ファイルを読み、行(セル配列)のブロックを順に返す。大きいファイルは改行位置で分割して読む。 */
function* readBlocks(file) {
  const size = fs.statSync(file).size;
  if (size <= BIG_FILE) { yield wh.decodeBuffer(fs.readFileSync(file)); return; }
  const fd = fs.openSync(file, 'r');
  try {
    let pos = 0;
    let carry = Buffer.alloc(0);
    let decoder = null;
    let first = true;
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      pos += n;
      let data = Buffer.concat([carry, buf.subarray(0, n)]);
      let cut = pos >= size ? data.length : data.lastIndexOf(0x0a) + 1; // 0x0aはSJISの2バイト目にもUTF-8にも現れない
      if (cut <= 0) { carry = data; continue; }
      carry = data.subarray(cut);
      data = data.subarray(0, cut);
      if (first) {
        if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) data = data.subarray(3);
        try { new TextDecoder('utf-8', { fatal: true }).decode(data); decoder = new TextDecoder('utf-8'); } catch { decoder = new TextDecoder('shift_jis'); }
        first = false;
      }
      yield decoder.decode(data);
    }
  } finally { fs.closeSync(fd); }
}

/** 1ファイルを処理し、レコードを onBatch(records) に渡す。 */
async function processFile(file, root, batchSize, onBatch, stats) {
  const rel = path.relative(root, file);
  const folder = path.basename(path.dirname(file));
  let map = null, delim = null;
  let batch = [];
  for (const text of readBlocks(file)) {
    let rows;
    if (!map) {
      const firstLine = text.split(/\r?\n/, 1)[0];
      delim = wh.detectDelimiter(firstLine);
      rows = wh.parseDelimited(text, delim);
      if (!rows.length) continue;
      map = wh.mapHeader(rows.shift());
      if (map.name === undefined) throw new Error('ヘッダに「屋号」列がありません');
    } else {
      rows = wh.parseDelimited(text, delim);
    }
    for (const cells of rows) {
      stats.rows++;
      const rec = wh.toRecord(cells, map, rel, folder);
      if (!rec.name) { stats.skipped++; continue; }
      if (rec.name.length > 255) rec.name = rec.name.slice(0, 255);
      rec.fallback_key = rec.cid ? null : wh.fallbackKey(rec);
      batch.push(rec);
      if (batch.length >= batchSize) { await onBatch(batch); batch = []; }
    }
  }
  if (batch.length) await onBatch(batch);
}

const COLS = ['cid', 'fallback_key', 'name', 'category', 'postal', 'address_raw', 'address', 'prefecture', 'phone', 'rating', 'review_count', 'gbp_registered', 'website_url', 'gmap_url', 'photo_count', 'place_id', 'lat', 'lng', 'source_file'];
const clip = (v, n) => (typeof v === 'string' && v.length > n ? v.slice(0, n) : v);
const LIMITS = { cid: 20, name: 255, category: 100, postal: 10, address_raw: 500, address: 500, prefecture: 10, phone: 30, gbp_registered: 10, website_url: 1000, gmap_url: 1000, place_id: 100, source_file: 300 };
const fillIfEmpty = (c) => `${c} = IF(${c} IS NULL OR ${c} = '', VALUES(${c}), ${c})`;
const newer = (c) => `${c} = COALESCE(VALUES(${c}), ${c})`;

function upsertSql(n) {
  const ph = '(' + COLS.map(() => '?').join(',') + ',NOW(),NOW())';
  return `INSERT INTO stoc_master.shops (${COLS.join(',')},first_seen_at,last_seen_at) VALUES ${Array(n).fill(ph).join(',')}
ON DUPLICATE KEY UPDATE last_seen_at = NOW(),
  ${newer('rating')}, ${newer('review_count')}, ${newer('photo_count')}, ${newer('lat')}, ${newer('lng')},
  ${['website_url', 'phone', 'category', 'postal', 'address_raw', 'address', 'prefecture', 'place_id', 'gmap_url', 'gbp_registered'].map(fillIfEmpty).join(',\n  ')}`;
}

async function upsertBatch(pool, recs, stats) {
  const params = [];
  for (const r of recs) for (const c of COLS) params.push(LIMITS[c] ? clip(r[c], LIMITS[c]) : r[c]);
  // 既存件数を事前に数えて新規/更新を判定(affectedRowsは同一秒の再実行で0になり、DB間差もあるため)
  const cids = [...new Set(recs.filter((r) => r.cid).map((r) => r.cid))];
  const fbs = [...new Set(recs.filter((r) => !r.cid).map((r) => r.fallback_key))];
  let existing = 0;
  if (cids.length) { const [[x]] = await pool.query('SELECT COUNT(*) AS n FROM stoc_master.shops WHERE cid IN (?)', [cids]); existing += Number(x.n); }
  if (fbs.length) { const [[x]] = await pool.query('SELECT COUNT(*) AS n FROM stoc_master.shops WHERE fallback_key IN (?)', [fbs]); existing += Number(x.n); }
  await pool.query(upsertSql(recs.length), params);
  const inserted = cids.length + fbs.length - existing;
  stats.inserted += inserted;
  stats.updated += recs.length - inserted;
}

function makePool() {
  const mysql = require('mysql2/promise');
  return mysql.createPool({
    host: process.env.WH_DB_HOST || '127.0.0.1',
    port: Number(process.env.WH_DB_PORT || 3306),
    user: process.env.WH_DB_USER,
    password: process.env.WH_DB_PASS,
    charset: 'utf8mb4',
    connectionLimit: 2,
    flags: ['-FOUND_ROWS'],
  });
}

async function linkStep(pool, log = console.error) {
  try {
    await pool.query('SELECT 1 FROM stoc_sales.stores LIMIT 1');
  } catch (e) {
    log('警告: stoc_sales.stores にアクセスできないためリンク処理をスキップします: ' + e.message);
    return null;
  }
  const [[r]] = await pool.query('SELECT MIN(id) AS lo, MAX(id) AS hi FROM stoc_master.shops WHERE cid IS NOT NULL');
  if (r.lo === null) return 0;
  let linked = 0;
  for (let lo = Number(r.lo); lo <= Number(r.hi); lo += LINK_CHUNK) {
    const [res] = await pool.query(
      `UPDATE stoc_master.shops w JOIN stoc_sales.stores s ON s.cid = w.cid
       SET w.stoc_store_id = s.id
       WHERE w.id >= ? AND w.id < ? AND w.cid IS NOT NULL AND (w.stoc_store_id IS NULL OR w.stoc_store_id <> s.id)`,
      [lo, lo + LINK_CHUNK]);
    linked += res.affectedRows;
  }
  log(`リンク完了: ${linked}件を営業アプリの店舗に紐付けました`);
  return linked;
}

async function main() {
  try { require('dotenv').config(); } catch { /* なくても動く */ }
  const o = parseArgs(process.argv.slice(2));
  if (o.linkOnly) {
    const pool = makePool();
    try { await linkStep(pool); } finally { await pool.end(); }
    return;
  }
  const root = path.resolve(o.root);
  const files = [...walk(root)];
  console.error(`対象ファイル ${files.length}件 (${root})${o.dryRun ? ' [dry-run]' : ''}`);
  const pool = o.dryRun ? null : makePool();
  const total = { files: 0, rows: 0, inserted: 0, updated: 0, skipped: 0 };
  const errors = [];
  let runId = null;
  const started = new Date();
  if (pool) {
    const [r] = await pool.query('INSERT INTO stoc_master.import_runs (started_at, root_path) VALUES (NOW(), ?)', [root.slice(0, 500)]);
    runId = r.insertId;
  }
  try {
    for (const file of files) {
      const st = { rows: 0, inserted: 0, updated: 0, skipped: 0 };
      const withCid = { n: 0 };
      try {
        await processFile(file, root, o.batch, async (recs) => {
          for (const r of recs) if (r.cid) withCid.n++;
          if (pool) await upsertBatch(pool, recs, st);
        }, st);
      } catch (e) {
        errors.push(`${path.relative(root, file)}: ${e.message}`);
        console.error(`  エラー ${path.relative(root, file)}: ${e.message}`);
      }
      total.files++;
      for (const k of ['rows', 'inserted', 'updated', 'skipped']) total[k] += st[k];
      console.error(`[${total.files}/${files.length}] ${path.relative(root, file)} 読込${st.rows} CIDあり${withCid.n} 新規${st.inserted} 更新${st.updated} スキップ${st.skipped}`);
    }
    console.error(`合計: ファイル${total.files} 読込${total.rows} 新規${total.inserted} 更新${total.updated} スキップ${total.skipped} エラー${errors.length}`);
    if (pool) await linkStep(pool);
  } finally {
    if (pool) {
      await pool.query(
        'UPDATE stoc_master.import_runs SET finished_at = NOW(), files = ?, rows_read = ?, inserted = ?, updated = ?, skipped = ?, errors = ? WHERE id = ?',
        [total.files, total.rows, total.inserted, total.updated, total.skipped, errors.length ? errors.join('\n').slice(0, 60000) : null, runId]);
      await pool.end();
    }
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('エラー: ' + e.message); process.exit(1); });
}

module.exports = { parseArgs, walk, processFile, upsertSql, linkStep, makePool };
