'use strict';
/**
 * 倉庫 stoc_master.shops.site_host(サイトのホスト名。www.なし小文字)を website_url から埋める。
 *   node cli/warehouse-sitehost.js [--chunk 10000] [--recompute] [--dry-run]
 * 先に sql/warehouse_migrate_005.sql を適用しておく。既定は site_host が NULL の行だけを id 順に処理(途中で止めても再実行で続きから)。
 * URLからホスト名を取り出せない行は空文字を入れて「処理済み」にする。--recompute は値のある行も含めて全行を計算し直す。
 * 接続: WH_DB_HOST(127.0.0.1) WH_DB_PORT WH_DB_USER WH_DB_PASS (.env)
 */
const { siteHostOf } = require('../src/siteHost');
const wh = require('../src/warehouse');

function parseArgs(argv) {
  const o = { chunk: 10000, recompute: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--chunk') o.chunk = Math.floor(Number(argv[++i]));
    else if (a === '--recompute') o.recompute = true;
    else if (a === '--dry-run') o.dryRun = true;
    else throw new Error('不明なオプション: ' + a);
  }
  if (!Number.isFinite(o.chunk) || o.chunk < 1) throw new Error('--chunk の値が不正です');
  return o;
}

/** 戻り: { scanned, updated, empty }。pool は mysql2 の query を持つもの */
async function backfill(pool, { chunk = 10000, recompute = false, dryRun = false, log = (m) => console.error(m) } = {}) {
  if (!(await wh.columnExists(pool, 'shops', 'site_host'))) {
    throw new Error('shops.site_host 列がありません。先に sql/warehouse_migrate_005.sql を適用してください。');
  }
  const st = { scanned: 0, updated: 0, empty: 0 };
  let last = 0;
  for (;;) {
    const [rows] = await pool.query(
      `SELECT id, website_url FROM stoc_master.shops WHERE id > ? AND website_url IS NOT NULL AND website_url <> ''${recompute ? '' : ' AND site_host IS NULL'} ORDER BY id LIMIT ?`,
      [last, chunk]);
    if (!rows.length) break;
    last = Number(rows[rows.length - 1].id);
    const hosts = rows.map((r) => [Number(r.id), siteHostOf(r.website_url) || '']);
    st.scanned += rows.length;
    st.empty += hosts.filter((h) => h[1] === '').length;
    if (!dryRun) {
      const params = [];
      for (const [id, h] of hosts) params.push(id, h);
      for (const [id] of hosts) params.push(id);
      const [res] = await pool.query(
        `UPDATE stoc_master.shops SET site_host = CASE id ${hosts.map(() => 'WHEN ? THEN ?').join(' ')} ELSE site_host END WHERE id IN (${hosts.map(() => '?').join(',')})`, params);
      st.updated += Number(res && res.affectedRows) || 0;
    }
    log(`処理 ${st.scanned}件 (id ${last} まで) 更新 ${st.updated}件 取り出せず ${st.empty}件${dryRun ? ' [dry-run]' : ''}`);
  }
  return st;
}

async function main() {
  try { require('dotenv').config(); } catch { /* なくても動く */ }
  const o = parseArgs(process.argv.slice(2));
  const { makePool } = require('./warehouse-import');
  const pool = makePool();
  try {
    const st = await backfill(pool, o);
    console.error(`完了: ${st.scanned}件処理 / 更新 ${st.updated}件 / ホスト名を取り出せず ${st.empty}件`);
  } finally { await pool.end(); }
}

module.exports = { parseArgs, backfill };

if (require.main === module) main().catch((e) => { console.error('エラー: ' + e.message); process.exit(1); });
