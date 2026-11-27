'use strict';
/**
 * 送信ツール(eigyo-form-sender)の結果CSVを、倉庫の送信履歴(webdock_sends)へ取り込む(PR-4。倉庫から直接送った分)。
 *   node cli/import-send-results.js --since=2026-11-11 [--dir=/opt/eigyo-form-sender/data/results] [--dry-run] [--limit=N]
 *
 *   --since=YYYY-MM-DD  この日(日本時間0時)以降に更新されたファイルだけ読む(必須)
 *   --dir=              結果CSVのフォルダ(既定 /opt/eigyo-form-sender/data/results。rows/<同じ名前>.csv があれば一緒に読む)
 *   --dry-run           倉庫に何も書かず、件数だけ出す(取り込み済みの記録も付けない)
 *   --limit=N           今回読むファイルの上限
 * 先に sql/warehouse_migrate_014.sql を適用しておく(取り込み済みの記録の表。なければ --dry-run 以外は中止)。
 * 読み飛ばすもの: 10分以内に更新されたファイル(書き込み中かもしれない)・取り込み済み(名前+更新時刻+サイズが同じ)。
 * 倉庫の分が0行のファイル(STOC側の送信など)も「取り込み済み」に記録して、次回から読み直さない。
 * ファイルごとの失敗は表示して続け、最後に終了コード1で終わる(その回は記録しないので次回また読む)。
 * 同時に2つ動かないよう、一時フォルダにロックファイルを作る(2時間より古いものは残骸として消す)。
 * 毎時の実行は ops/cron.d/webdock-send-results。接続: WH_DB_HOST(127.0.0.1) WH_DB_PORT WH_DB_USER WH_DB_PASS (.env)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const wh = require('../src/warehouse');
const SR = require('../src/sendResults');

const DEFAULT_DIR = '/opt/eigyo-form-sender/data/results';
const RECENT_MS = 10 * 60 * 1000;
const STALE_LOCK_MS = 2 * 3600 * 1000;
const LOCK_PATH = path.join(os.tmpdir(), 'webdock-import-send-results.lock');

function parseArgs(argv) {
  const o = { since: null, dir: DEFAULT_DIR, dryRun: false, limit: 0 };
  for (const a of argv) {
    let m;
    if (a === '--dry-run') o.dryRun = true;
    else if ((m = /^--since=(.*)$/.exec(a))) o.since = m[1];
    else if ((m = /^--dir=(.*)$/.exec(a))) o.dir = m[1];
    else if ((m = /^--limit=(.*)$/.exec(a))) { o.limit = Number(m[1]); if (!Number.isInteger(o.limit) || o.limit < 1) throw new Error('--limit は1以上の整数にしてください'); }
    else throw new Error('不明なオプション: ' + a);
  }
  if (!o.since || !/^\d{4}-\d{2}-\d{2}$/.test(o.since) || Number.isNaN(Date.parse(o.since + 'T00:00:00+09:00'))) throw new Error('--since=YYYY-MM-DD を指定してください');
  return o;
}

/** [YYYY-MM-DD HH:MM:SS] (日本時間) */
function stamp(d = new Date()) {
  const j = new Date(d.getTime() + 9 * 3600 * 1000).toISOString();
  return `[${j.slice(0, 10)} ${j.slice(11, 19)}]`;
}
const log = (m) => console.log(`${stamp()} ${m}`);

/** ロックを取る。取れなければ false。2時間より古いロックは残骸として消して取り直す */
function acquireLock(lockPath = LOCK_PATH, now = Date.now()) {
  for (let i = 0; i < 2; i++) {
    try { fs.closeSync(fs.openSync(lockPath, 'wx')); return true; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = now - fs.statSync(lockPath).mtimeMs; } catch { continue; }
      if (age < STALE_LOCK_MS) return false;
      try { fs.unlinkSync(lockPath); } catch { /* 取り直しで判定 */ }
    }
  }
  return false;
}
function releaseLock(lockPath = LOCK_PATH) { try { fs.unlinkSync(lockPath); } catch { /* なくてよい */ } }

const isNoTable = (e) => !!e && (e.errno === 1146 || e.code === 'ER_NO_SUCH_TABLE');

/** 対象のファイル一覧(更新が古い順)。10分以内のものは除く */
function listFiles(dir, sinceMs, nowMs) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/\.csv$/i.test(name)) continue;
    const full = path.join(dir, name);
    let s;
    try { s = fs.statSync(full); } catch { continue; }
    if (!s.isFile() || s.mtimeMs < sinceMs) continue;
    if (nowMs - s.mtimeMs < RECENT_MS) continue;
    out.push({ name, full, size: s.size, mtime: new Date(Math.floor(s.mtimeMs / 1000) * 1000) }); // DATETIME は秒まで
  }
  return out.sort((a, b) => a.mtime - b.mtime || (a.name < b.name ? -1 : 1));
}

/** 取り込み本体。pool と opts を受ける(終了コードを返す) */
async function run(pool, opts, { now = Date.now(), out = log } = {}) {
  if (!fs.existsSync(opts.dir)) { out(`フォルダがありません: ${opts.dir}(何もしません)`); return 0; }
  let trackOk = true;
  try { await pool.query(`SELECT 1 FROM ${SR.TRACK} LIMIT 1`); } catch (e) {
    if (!isNoTable(e)) throw e;
    if (!opts.dryRun) { out('取り込み済みの記録の表がありません。先に sql/warehouse_migrate_014.sql を適用してください(mysql --default-character-set=utf8mb4 < sql/warehouse_migrate_014.sql)。'); return 1; }
    trackOk = false;
    out('警告: 取り込み済みの記録の表がありません(--dry-run なので続けます。sql/warehouse_migrate_014.sql を適用してください)');
  }
  const sinceMs = Date.parse(opts.since + 'T00:00:00+09:00');
  let files = listFiles(opts.dir, sinceMs, now);
  let skipped = 0, failedFiles = 0, done = 0;
  const total = { warehouseRows: 0, matched: 0, success: 0, failed: 0, skipped: 0, unchanged: 0, unmatched: 0, refusal: 0 };
  out(`対象ファイル候補: ${files.length}件(${opts.since} 以降${opts.dryRun ? '・--dry-run' : ''})`);
  for (const f of files) {
    if (opts.limit && done >= opts.limit) break;
    try {
      if (trackOk && await SR.isImported(pool, f)) { skipped++; continue; }
      done++;
      const rowsPath = path.join(opts.dir, 'rows', f.name);
      const items = SR.parseSendResults(wh.decodeBuffer(fs.readFileSync(f.full)), fs.existsSync(rowsPath) ? wh.decodeBuffer(fs.readFileSync(rowsPath)) : null);
      const st = await SR.applyResults(pool, items, { fileMtime: f.mtime, fileName: f.name, dryRun: opts.dryRun });
      if (!opts.dryRun) await SR.recordImported(pool, f, st);
      for (const k of Object.keys(total)) total[k] += st[k];
      out(`${f.name}: 行${st.rows} 倉庫${st.warehouseRows} 一致${st.matched} 成功${st.success} 失敗${st.failed} スキップ${st.skipped} 変更なし${st.unchanged} 不一致${st.unmatched} 営業お断り${st.refusal}`);
    } catch (e) {
      failedFiles++;
      out(`${f.name}: 失敗 ${e.message}(記録せず、次回また読みます)`);
    }
  }
  out(`まとめ${opts.dryRun ? '(--dry-run・何も書いていません)' : ''}: 読んだ${done}件 / 取り込み済みで飛ばした${skipped}件 / エラー${failedFiles}件 / 倉庫${total.warehouseRows}行 一致${total.matched} 成功${total.success} 失敗${total.failed} スキップ${total.skipped} 変更なし${total.unchanged} 不一致${total.unmatched} 営業お断り${total.refusal}`);
  return failedFiles ? 1 : 0;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error('エラー: ' + e.message); return 2; }
  try { require('dotenv').config(); } catch { /* なくても動く */ }
  if (!acquireLock()) { log('別の取り込みが動いています(ロック中)。終了します'); return 0; }
  const { createWarehousePool } = require('./find-forms');
  const pool = createWarehousePool();
  try { return await run(pool, opts); } catch (e) { log('エラー: ' + e.message); return 1; } finally { await pool.end(); releaseLock(); }
}

module.exports = { parseArgs, stamp, acquireLock, releaseLock, listFiles, run, LOCK_PATH, DEFAULT_DIR };
if (require.main === module) main().then((c) => process.exit(c));
