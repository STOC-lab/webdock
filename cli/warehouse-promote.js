'use strict';

/**
 * 倉庫 → 営業アプリ取り込み用CSV(Shift_JIS・カンマ区切り・11列)を作る
 *   node cli/warehouse-promote.js --out data/promote_20261024.csv --prefecture 東京都,神奈川県
 *        [--category 美容院,ネイル] [--has-website] [--include-closed] [--form-found] [--limit 5000] [--mark]
 * 対象: stoc_store_id IS NULL(営業アプリに未登録)かつ promoted_at IS NULL(未出力)
 */

const fs = require('fs');
const path = require('path');
const wh = require('../src/warehouse');
const { makePool } = require('./warehouse-import');

const HEADERS = ['屋号', '業種', '郵便番号', '住所', '電話番号', '評価', '口コミ数', 'Googleマイビジネス登録有無', '登録URL', 'GMAP', '写真枚数'];

function parseArgs(argv) {
  const o = { out: null, prefecture: [], category: [], hasWebsite: false, excludeClosed: true, formFound: false, limit: 5000, mark: false };
  const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--prefecture') o.prefecture = list(argv[++i]);
    else if (a === '--category') o.category = list(argv[++i]);
    else if (a === '--has-website') o.hasWebsite = true;
    else if (a === '--exclude-closed') o.excludeClosed = true;
    else if (a === '--include-closed') o.excludeClosed = false;
    else if (a === '--form-found') o.formFound = true;
    else if (a === '--limit') o.limit = Math.floor(Number(argv[++i]));
    else if (a === '--mark') o.mark = true;
    else throw new Error('不明なオプション: ' + a);
  }
  if (!o.out) throw new Error('--out <出力CSV> を指定してください');
  if (!Number.isFinite(o.limit) || o.limit < 1) throw new Error('--limit の値が不正です');
  return o;
}

function buildQuery(o) {
  const where = ['stoc_store_id IS NULL', 'promoted_at IS NULL'];
  const params = [];
  if (o.prefecture.length) { where.push('prefecture IN (?)'); params.push(o.prefecture); }
  if (o.category.length) {
    where.push('(' + o.category.map(() => 'category LIKE ?').join(' OR ') + ')');
    for (const c of o.category) params.push('%' + c.replace(/[\\%_]/g, '\\$&') + '%');
  }
  if (o.hasWebsite) where.push("website_url IS NOT NULL AND website_url <> ''");
  if (o.excludeClosed) where.push("(business_status IS NULL OR (business_status NOT LIKE '%閉業%' AND business_status NOT LIKE '%閉店%'))");
  if (o.formFound) where.push("form_status = 'url_found'");
  const sql = `SELECT id, name, category, postal, address_raw, phone, rating, review_count, gbp_registered, website_url, gmap_url, photo_count
FROM stoc_master.shops WHERE ${where.join(' AND ')}
ORDER BY review_count IS NULL, review_count DESC, id
LIMIT ?`;
  params.push(o.limit);
  return { sql, params };
}

function csvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const csvLine = (vals) => vals.map(csvField).join(',') + '\r\n';

function rowToCsv(r) {
  return csvLine([r.name, r.category, r.postal, r.address_raw, r.phone,
    r.rating === null ? '' : Number(r.rating).toFixed(1), r.review_count, r.gbp_registered, r.website_url, r.gmap_url, r.photo_count]);
}

async function main() {
  try { require('dotenv').config(); } catch { /* なくても動く */ }
  const o = parseArgs(process.argv.slice(2));
  const pool = makePool();
  try {
    const { sql, params } = buildQuery(o);
    const [rows] = await pool.query(sql, params);
    let text = csvLine(HEADERS);
    for (const r of rows) text += rowToCsv(r);
    fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
    fs.writeFileSync(o.out, wh.encodeShiftJis(text));
    if (o.mark && rows.length) {
      const ids = rows.map((r) => r.id);
      for (let i = 0; i < ids.length; i += 1000) {
        await pool.query('UPDATE stoc_master.shops SET promoted_at = NOW() WHERE id IN (?)', [ids.slice(i, i + 1000)]);
      }
    }
    console.log(`${rows.length}件を書き出しました -> ${o.out}${o.mark ? '(出力済みとして記録)' : ''}`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('エラー: ' + e.message); process.exit(1); });
}

module.exports = { parseArgs, buildQuery, rowToCsv, HEADERS };
