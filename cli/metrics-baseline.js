'use strict';

/**
 * 口コミ数・写真数・評価の履歴に「最初の1行」を入れる(1回だけ実行。何度実行しても履歴のない店にだけ足す)
 *   node cli/metrics-baseline.js [--chunk 50000]
 * 先に sql/warehouse_migrate_008.sql を適用してください。
 */

const wh = require('../src/warehouse');
const { makePool } = require('./warehouse-import');

function baselineSql() {
  return `INSERT INTO stoc_master.shop_metrics_history (shop_id, captured_at, review_count, photo_count, rating)
SELECT s.id, NOW(), s.review_count, s.photo_count, s.rating FROM stoc_master.shops s
WHERE s.id >= ? AND s.id < ? AND (s.review_count IS NOT NULL OR s.photo_count IS NOT NULL OR s.rating IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM stoc_master.shop_metrics_history h WHERE h.shop_id = s.id)`;
}

async function runBaseline(pool, { chunk = 50000, log = console.error } = {}) {
  if (!(await wh.tableExists(pool, 'shop_metrics_history'))) {
    throw new Error('shop_metrics_history 表がありません。先に sql/warehouse_migrate_008.sql を適用してください。');
  }
  const [[r]] = await pool.query('SELECT MIN(id) AS lo, MAX(id) AS hi FROM stoc_master.shops');
  if (r.lo === null) { log('店舗がありません'); return 0; }
  let total = 0;
  for (let lo = Number(r.lo); lo <= Number(r.hi); lo += chunk) {
    const [res] = await pool.query(baselineSql(), [lo, lo + chunk]);
    total += res.affectedRows;
    log(`id ${lo}〜${lo + chunk - 1}: ${res.affectedRows}件 (累計 ${total}件)`);
  }
  log(`完了: ${total}件の基準行を追加しました`);
  return total;
}

async function main() {
  try { require('dotenv').config(); } catch { /* なくても動く */ }
  let chunk = 50000;
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--chunk') chunk = Math.max(1000, Math.floor(Number(a[++i])) || 50000);
    else throw new Error('不明なオプション: ' + a[i]);
  }
  const pool = makePool();
  try { await runBaseline(pool, { chunk }); } finally { await pool.end(); }
}

if (require.main === module) main().catch((e) => { console.error('エラー: ' + e.message); process.exit(1); });

module.exports = { baselineSql, runBaseline };
