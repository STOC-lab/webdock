'use strict';

/**
 * 倉庫(stoc_master.shops)への取り込み
 *   node cli/warehouse-import.js --root <folder> [--dry-run] [--batch 1000] [--pattern "gmp_*.csv"]
 *   --pattern: ファイル名(フォルダ名は含まない)に対するワイルドカード(* と ?、大文字小文字無視)。
 *              リスツール整形後のファイル(nagasaki.csv 等)を除き、収集ツールの元ファイルだけ取り込むために使う。
 *   元ファイルはUTF-8(BOM有無どちらも可)。Shift_JISも自動判定。
 *   node cli/warehouse-import.js --link-only [--carry-forms]
 *   --carry-forms: リンク後、倉庫で見つけたフォームURL(とメール/Instagram)を営業アプリの
 *                  contact_channel_candidates / store_contact_channels へ引き継ぐ(通常の取り込みの最後にも実行)
 * 接続: WH_DB_HOST(127.0.0.1) WH_DB_PORT WH_DB_USER WH_DB_PASS (.env)
 */

const fs = require('fs');
const path = require('path');
const wh = require('../src/warehouse');
const { siteHostOf } = require('../src/siteHost');

const BIG_FILE = 200 * 1024 * 1024;
const CHUNK = 64 * 1024 * 1024;
const LINK_CHUNK = 50000;

function parseArgs(argv) {
  const o = { root: null, dryRun: false, batch: 1000, linkOnly: false, pattern: null, carryForms: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') o.root = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--link-only') o.linkOnly = true;
    else if (a === '--carry-forms') o.carryForms = true;
    else if (a === '--pattern') o.pattern = argv[++i];
    else if (a === '--batch') o.batch = Math.floor(Number(argv[++i]));
    else throw new Error('不明なオプション: ' + a);
  }
  if (o.pattern !== null && !o.pattern) throw new Error('--pattern の値が空です');
  if (!o.linkOnly && !o.root) throw new Error('--root <フォルダ> を指定してください');
  if (!Number.isFinite(o.batch) || o.batch < 1) throw new Error('--batch の値が不正です');
  return o;
}

function globToRegExp(glob) {
  const re = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + re + '$', 'i');
}

function* walk(dir, pattern) {
  const rx = pattern ? globToRegExp(pattern) : null;
  const ents = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, pattern);
    else if (/\.(csv|tsv|txt)$/i.test(e.name) && (!rx || rx.test(e.name))) yield full;
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
  let map = null, delim = null, hasBs = false;
  let batch = [];
  for (const text of readBlocks(file)) {
    let rows;
    if (!map) {
      const firstLine = text.split(/\r?\n/, 1)[0];
      delim = wh.detectDelimiter(firstLine);
      rows = wh.parseDelimited(text, delim);
      if (!rows.length) continue;
      map = wh.mapHeader(rows.shift());
      hasBs = map.business_status !== undefined;
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
      if (batch.length >= batchSize) { await onBatch(batch, hasBs); batch = []; }
    }
  }
  if (batch.length) await onBatch(batch, hasBs);
}

const COLS = ['cid', 'fallback_key', 'name', 'category', 'category_main', 'postal', 'address_raw', 'address', 'prefecture', 'phone', 'rating', 'review_count', 'gbp_registered', 'business_status', 'website_url', 'gmap_url', 'photo_count', 'place_id', 'lat', 'lng', 'source_file'];
const clip = (v, n) => (typeof v === 'string' && v.length > n ? v.slice(0, n) : v);
const LIMITS = { cid: 20, name: 255, category: 500, category_main: 100, business_status: 50, postal: 10, address_raw: 500, address: 500, prefecture: 10, phone: 30, gbp_registered: 10, website_url: 1000, gmap_url: 1000, place_id: 100, source_file: 300 };
const fillIfEmpty = (c) => `${c} = IF(${c} IS NULL OR ${c} = '', VALUES(${c}), ${c})`;
const newer = (c) => `${c} = COALESCE(VALUES(${c}), ${c})`;

/** hasSiteHost=true(sql/warehouse_migrate_005.sql 適用済み)なら site_host 列も入れる */
function upsertSql(n, hasBs, hasSiteHost = false) {
  const cols = hasSiteHost ? [...COLS, 'site_host'] : COLS;
  const ph = '(' + cols.map(() => '?').join(',') + ',NOW(),NOW())';
  // site_host は website_url と一緒に動かす: 既存の website_url が空のときだけ新しい値を入れる(この代入は website_url の更新より前に書くこと)
  const siteHost = hasSiteHost ? "site_host = IF(website_url IS NULL OR website_url = '', VALUES(site_host), site_host),\n  " : '';
  return `INSERT INTO stoc_master.shops (${cols.join(',')},first_seen_at,last_seen_at) VALUES ${Array(n).fill(ph).join(',')}
ON DUPLICATE KEY UPDATE last_seen_at = NOW(),
  ${siteHost}  ${newer('rating')}, ${newer('review_count')}, ${newer('photo_count')}, ${newer('lat')}, ${newer('lng')},
  ${hasBs ? 'business_status = VALUES(business_status)' : 'business_status = business_status'},
  ${['website_url', 'phone', 'category', 'category_main', 'postal', 'address_raw', 'address', 'prefecture', 'place_id', 'gmap_url', 'gbp_registered'].map(fillIfEmpty).join(',\n  ')}`;
}

async function upsertBatch(pool, recs, stats, hasBs, hasSiteHost = false) {
  const params = [];
  for (const r of recs) {
    for (const c of COLS) params.push(LIMITS[c] ? clip(r[c], LIMITS[c]) : r[c]);
    if (hasSiteHost) params.push(siteHostOf(clip(r.website_url, LIMITS.website_url)) || (r.website_url ? '' : null));
  }
  // 既存件数を事前に数えて新規/更新を判定(affectedRowsは同一秒の再実行で0になり、DB間差もあるため)
  const cids = [...new Set(recs.filter((r) => r.cid).map((r) => r.cid))];
  const fbs = [...new Set(recs.filter((r) => !r.cid).map((r) => r.fallback_key))];
  let existing = 0;
  if (cids.length) { const [[x]] = await pool.query('SELECT COUNT(*) AS n FROM stoc_master.shops WHERE cid IN (?)', [cids]); existing += Number(x.n); }
  if (fbs.length) { const [[x]] = await pool.query('SELECT COUNT(*) AS n FROM stoc_master.shops WHERE fallback_key IN (?)', [fbs]); existing += Number(x.n); }
  await pool.query(upsertSql(recs.length, hasBs, hasSiteHost), params);
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
  // 営業管理(stoc_sales)と倉庫(stoc_master)で照合順序が違うと「Illegal mix of collations」になるため、
  // 営業管理側の stores.cid の照合順序に倉庫側をそろえて比較する(営業管理側の索引がそのまま使える)。
  const [[col]] = await pool.query(
    "SELECT COLLATION_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='stoc_sales' AND TABLE_NAME='stores' AND COLUMN_NAME='cid'");
  const coll = col && /^[A-Za-z0-9_]+$/.test(col.c || '') ? col.c : null;
  const wcid = coll ? `w.cid COLLATE ${coll}` : 'w.cid';
  const [[r]] = await pool.query('SELECT MIN(id) AS lo, MAX(id) AS hi FROM stoc_master.shops WHERE cid IS NOT NULL');
  if (r.lo === null) return 0;
  let linked = 0;
  for (let lo = Number(r.lo); lo <= Number(r.hi); lo += LINK_CHUNK) {
    const [res] = await pool.query(
      `UPDATE stoc_master.shops w JOIN stoc_sales.stores s ON s.cid = ${wcid}
       SET w.stoc_store_id = s.id
       WHERE w.id >= ? AND w.id < ? AND w.cid IS NOT NULL AND (w.stoc_store_id IS NULL OR w.stoc_store_id <> s.id)`,
      [lo, lo + LINK_CHUNK]);
    linked += res.affectedRows;
  }
  log(`リンク完了: ${linked}件を営業アプリの店舗に紐付けました`);
  return linked;
}

const GRANT_HINT = `  GRANT SELECT, INSERT, UPDATE ON stoc_sales.store_contact_channels TO 'stoc_wh'@'localhost';
  GRANT SELECT, INSERT, UPDATE ON stoc_sales.contact_channel_candidates TO 'stoc_wh'@'localhost';`;

/**
 * 倉庫でフォームが見つかった店舗のうち、営業アプリに紐付いたもの(stoc_store_id あり)について、
 * フォームURL・メールを contact_channel_candidates へ、状態を store_contact_channels へ書く。
 * sent / confirmed / failed などの状態は上書きしない。何度実行しても結果は同じ。
 * 値(文字列)をDBをまたいでコピーするだけで、照合順序をそろえる必要のある比較は行わない
 * (列同士の比較が必要になる場合は linkStep と同様に COLLATE でそろえること)。
 */
async function carryFormsStep(pool, log = console.error) {
  const tot = { urls: 0, emails: 0, channels: 0 };
  const T = 'stoc_sales.store_contact_channels.'; // 倉庫側にも同名の列(instagram_url)があるので修飾が必要
  try {
    const [[r]] = await pool.query("SELECT MIN(id) AS lo, MAX(id) AS hi FROM stoc_master.shops WHERE stoc_store_id IS NOT NULL AND form_status = 'url_found'");
    if (r.lo === null) { log('引き継ぎ: 対象(フォームあり・営業アプリ紐付け済み)の店舗はありません'); return tot; }
    const base = "stoc_store_id IS NOT NULL AND form_status = 'url_found' AND id >= ? AND id < ?";
    for (let lo = Number(r.lo); lo <= Number(r.hi); lo += LINK_CHUNK) {
      const range = [lo, lo + LINK_CHUNK];
      const [a] = await pool.query(
        `INSERT IGNORE INTO stoc_sales.contact_channel_candidates (store_id, channel_type, value, source)
         SELECT stoc_store_id, 'inquiry_url', form_url, 'finder' FROM stoc_master.shops WHERE ${base} AND form_url IS NOT NULL AND form_url <> ''`, range);
      const [b] = await pool.query(
        `INSERT IGNORE INTO stoc_sales.contact_channel_candidates (store_id, channel_type, value, source)
         SELECT stoc_store_id, 'email', email, 'finder' FROM stoc_master.shops WHERE ${base} AND email IS NOT NULL AND email <> ''`, range);
      const [c] = await pool.query(
        `INSERT INTO stoc_sales.store_contact_channels
           (store_id, inquiry_status, inquiry_last_checked_at, email_status, email_last_checked_at, instagram_url, instagram_status)
         SELECT stoc_store_id, 'url_found', COALESCE(form_checked_at, NOW()),
                IF(email IS NOT NULL AND email <> '', 'found', 'unknown'),
                IF(email IS NOT NULL AND email <> '', COALESCE(form_checked_at, NOW()), NULL),
                IF(instagram_url IS NOT NULL AND instagram_url <> '', instagram_url, NULL),
                IF(instagram_url IS NOT NULL AND instagram_url <> '', 'found', 'unknown')
         FROM stoc_master.shops WHERE ${base} AND form_url IS NOT NULL AND form_url <> ''
         ON DUPLICATE KEY UPDATE
           ${T}inquiry_status = IF(${T}inquiry_status IS NULL OR ${T}inquiry_status IN ('unknown','no_form'), 'url_found', ${T}inquiry_status),
           ${T}inquiry_last_checked_at = GREATEST(COALESCE(${T}inquiry_last_checked_at, '1970-01-01'), VALUES(inquiry_last_checked_at)),
           ${T}email_last_checked_at = IF(VALUES(email_status) = 'found' AND (${T}email_status IS NULL OR ${T}email_status = 'unknown'), VALUES(email_last_checked_at), ${T}email_last_checked_at),
           ${T}email_status = IF(VALUES(email_status) = 'found' AND (${T}email_status IS NULL OR ${T}email_status = 'unknown'), 'found', ${T}email_status),
           ${T}instagram_status = IF(VALUES(instagram_url) IS NOT NULL AND (${T}instagram_url IS NULL OR ${T}instagram_url = '') AND (${T}instagram_status IS NULL OR ${T}instagram_status = 'unknown'), 'found', ${T}instagram_status),
           ${T}instagram_url = IF(VALUES(instagram_url) IS NOT NULL AND (${T}instagram_url IS NULL OR ${T}instagram_url = ''), VALUES(instagram_url), ${T}instagram_url)`, range);
      tot.urls += a.affectedRows; tot.emails += b.affectedRows; tot.channels += c.affectedRows;
    }
  } catch (e) {
    if (e && [1044, 1142, 1143, 1227].includes(e.errno)) {
      log('エラー: 営業アプリのテーブルへ書き込む権限がありません。root で次を実行してから、もう一度実行してください。\n' + GRANT_HINT + "\n  FLUSH PRIVILEGES;");
      return null;
    }
    throw e;
  }
  log(`引き継ぎ完了: 候補を追加(問い合わせURL ${tot.urls}件 / メール ${tot.emails}件)、連絡先の状態を更新(${tot.channels}件)`);
  return tot;
}

async function main() {
  try { require('dotenv').config(); } catch { /* なくても動く */ }
  const o = parseArgs(process.argv.slice(2));
  if (o.linkOnly) {
    const pool = makePool();
    try {
      await linkStep(pool);
      if (o.carryForms) await carryFormsStep(pool);
    } finally { await pool.end(); }
    return;
  }
  const root = path.resolve(o.root);
  const files = [...walk(root, o.pattern)];
  console.error(`対象ファイル ${files.length}件 (${root})${o.dryRun ? ' [dry-run]' : ''}`);
  const pool = o.dryRun ? null : makePool();
  const total = { files: 0, rows: 0, inserted: 0, updated: 0, skipped: 0 };
  const errors = [];
  let runId = null;
  const hasSiteHost = pool ? await wh.columnExists(pool, 'shops', 'site_host') : false;
  if (pool && !hasSiteHost) console.error('警告: shops.site_host 列がないため、サイトのホスト名は記録しません(sql/warehouse_migrate_005.sql を適用すると記録されます)。');
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
        await processFile(file, root, o.batch, async (recs, hasBs) => {
          for (const r of recs) if (r.cid) withCid.n++;
          if (pool) await upsertBatch(pool, recs, st, hasBs, hasSiteHost);
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
    if (pool) {
      await linkStep(pool);
      if (o.carryForms) await carryFormsStep(pool);
    }
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

module.exports = { parseArgs, walk, globToRegExp, processFile, upsertSql, linkStep, carryFormsStep, makePool };
