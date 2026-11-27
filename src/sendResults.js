'use strict';
/**
 * 送信ツール(eigyo-form-sender)の結果CSVを、倉庫の送信履歴(stoc_master.webdock_sends)へ取り込む(PR-4。倉庫から直接送った分)。
 *
 * 入力(送信ツールが1ジョブごとに書く):
 *   results/<jobid>.csv       UTF-8 BOM。ヘッダ 送信先URL,結果,トップページURL,問い合わせページURL,備考。結果 = 成功/失敗/スキップ
 *   results/rows/<jobid>.csv  ヘッダなし。送信リストの行(0列=送信先URL、どこかの列にバッチコードと専用ページのURL)。なくてもよい
 *
 * 照合のルール:
 *   - バッチコード・専用ページのトークンは、rows ファイルの行を「正規化した送信先URLのSHA1(formUrlKey)」で結果行に結びつけて得る(同じキーが複数行なら最初の空でない値)。
 *   - バッチコードが whd_ で始まるものだけが倉庫の分。sender_ / exp_ は営業管理(STOC)が自分で取り込むので無視する。
 *   - バッチコードがない行(rows ファイルがない・その行にコードがない)は「代替の照合」: webdock_sends のうち
 *     created_at <= 結果ファイルの更新時刻 の行(send_status は問わない)から、form_url_key が同じ最新の行(created_at, id の新しい順)のバッチを選び、
 *     そのバッチの同じキーの全行(同じフォームURLの店が1バッチに複数ありうる)に当てる。当たらなければ無視(STOCの分かもしれない)。
 *     pending を条件にしないので、書き直したファイルの再処理も同じ行に当たる(success は後退せず、同じ結果は変更なしになる)。
 * 更新のルール:
 *   - success は後退させない。pending/failed/skipped → success はよい。pending → failed/skipped はよい。failed ↔ skipped は後のファイルが勝つ。
 *   - send_result = 備考(なければ「成功」)を100文字まで。sent_at = ファイルの更新時刻(success/failed のとき)。
 *   - 営業お断りが理由の失敗は shops.form_no_sales=1 にする(倉庫の抽出 warehouseWhere が外すので、その店には二度と送らない)。
 *   - 失敗・スキップは「送信済み」に数えないので(COUNTED_SEND_STATUS)、取り込み後は失敗した店がまた送れるようになる。
 * 営業管理(stoc_sales)には何も書かない。プールは引数で受ける(テストでは偽物を渡す)。
 */
const wh = require('./warehouse');
const WS = require('./warehouseSends');

const SENDS = WS.SENDS;
const BATCHES = WS.BATCHES;
const SHOPS = 'stoc_master.shops';
const TRACK = 'stoc_master.webdock_send_result_files';

const BATCH_RE = /^(whd|sender|exp)_\d{8}_\d{6}_[0-9a-f]+$/i;
const TOKEN_RE = /\/r\/([A-Za-z0-9]{10})(?:[/?#]|$)/;
const REFUSAL_RE = /営業|セールス|勧誘|売り込み|お断り/;
const RESULT_MAP = { 成功: 'success', 失敗: 'failed', スキップ: 'skipped' };
const IN_CHUNK = 500;
const RESULT_MAX = 100;

const clip = (s, n) => [...String(s === undefined || s === null ? '' : s)].slice(0, n).join('');
const stripBom = (t) => String(t || '').replace(/^﻿/, '');

/** 結果CSVの本文 → [{ formUrl, result, note }]。結果が 成功/失敗/スキップ 以外の行は捨てる */
function parseResultText(text) {
  const rows = wh.parseDelimited(stripBom(text), ',');
  if (!rows.length) return [];
  const head = rows[0].map((c) => c.trim());
  const idx = (name, def) => { const i = head.indexOf(name); return i >= 0 ? i : def; };
  const hasHeader = head.includes('送信先URL') || head.includes('結果');
  const cUrl = idx('送信先URL', 0), cRes = idx('結果', 1), cNote = idx('備考', 4);
  const out = [];
  for (const r of hasHeader ? rows.slice(1) : rows) {
    const result = RESULT_MAP[String(r[cRes] || '').trim()];
    const formUrl = String(r[cUrl] || '').trim();
    if (!result || !formUrl) continue;
    out.push({ formUrl, result, note: String(r[cNote] || '').trim() });
  }
  return out;
}

/** rows ファイルの本文 → Map(formUrlKey → { batchCode, pageToken })。バッチコード・トークンは列の位置ではなく中身で探す */
function parseRowsText(text) {
  const map = new Map();
  for (const r of wh.parseDelimited(stripBom(text), ',')) {
    const url = String(r[0] || '').trim();
    if (!url) continue;
    let batchCode = null, pageToken = null;
    for (const cell of r) {
      const c = String(cell || '').trim();
      if (!batchCode && BATCH_RE.test(c)) batchCode = c.toLowerCase();
      if (!pageToken && /webdock/i.test(c)) { const m = TOKEN_RE.exec(c); if (m) pageToken = m[1]; } // WEBドックのURLのセルだけ
    }
    const key = WS.formUrlKey(url);
    const cur = map.get(key) || { batchCode: null, pageToken: null };
    map.set(key, { batchCode: cur.batchCode || batchCode, pageToken: cur.pageToken || pageToken });
  }
  return map;
}

/** 結果CSV(+ rows CSV。なければ null)の本文 → [{ formUrl, key, result, note, batchCode|null, pageToken|null }] */
function parseSendResults(resultText, rowsText) {
  const joined = rowsText ? parseRowsText(rowsText) : new Map();
  return parseResultText(resultText).map((r) => {
    const key = WS.formUrlKey(r.formUrl);
    const j = joined.get(key) || {};
    return { formUrl: r.formUrl, key, result: r.result, note: r.note, batchCode: j.batchCode || null, pageToken: j.pageToken || null };
  });
}

/** 今の状態 → 新しい結果に変えるか。success は後退させない。failed ↔ skipped は後のファイルが勝つ */
function shouldUpdate(cur, next, curResult, nextResult) {
  if (cur === 'success') return false;
  if (next === 'success') return true;
  if (cur === 'pending') return true;
  return cur !== next || (curResult || '') !== (nextResult || '');
}

const chunks = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

/**
 * 結果を倉庫の送信履歴へ反映する。
 * opts: { fileMtime(Date), fileName, dryRun, track: { name, mtime, size } }
 *   track があり dryRun でなければ、取り込み済みの記録を同じトランザクションの commit の直前に書く(更新と記録が一緒に成功/失敗する)
 * 戻り: { rows, warehouseRows, matched, success, failed, skipped, unchanged, unmatched, refusal }
 *   rows=結果の行数 / warehouseRows=倉庫の分(whd_ のコードの行 + 代替の照合で当たった行) / matched=送信履歴に当たった行
 *   success・failed・skipped=実際に更新した行 / unchanged=当たったが変えなかった行 / unmatched=whd_ のコードなのに送信履歴にない行 / refusal=営業お断りで form_no_sales にした店
 */
async function applyResults(pool, items, { fileMtime, fileName, dryRun = false, track = null } = {}) {
  const st = { rows: items.length, warehouseRows: 0, matched: 0, success: 0, failed: 0, skipped: 0, unchanged: 0, unmatched: 0, refusal: 0 };
  const mtime = fileMtime instanceof Date ? fileMtime : new Date(fileMtime);
  const cols = 'id, shop_id, batch_code, form_url_key, send_status, send_result';

  // 倉庫の分だけ(sender_ / exp_ は無視)
  const coded = [], plain = [];
  for (const it of items) {
    if (it.batchCode && !/^whd_/i.test(it.batchCode)) continue;
    (it.batchCode ? coded : plain).push(it);
  }

  // 読み出し(書き込み用の接続を使う場合は同じ接続・同じトランザクションで読む)
  const conn = dryRun ? null : await pool.getConnection();
  const q = conn || pool;
  try {
    if (conn) await conn.beginTransaction();
    const byBatchKey = new Map(); // `${batch}\t${key}` → [row]
    const codes = new Map();
    for (const it of coded) {
      const c = it.batchCode.toLowerCase();
      if (!codes.has(c)) codes.set(c, new Set());
      codes.get(c).add(it.key);
    }
    for (const [code, keySet] of codes) {
      for (const part of chunks([...keySet], IN_CHUNK)) {
        const [rows] = await q.query(`SELECT ${cols} FROM ${SENDS} WHERE batch_code = ? AND form_url_key IN (?)`, [code, part]);
        for (const r of rows) {
          const k = `${r.batch_code}\t${r.form_url_key}`;
          if (!byBatchKey.has(k)) byBatchKey.set(k, []);
          byBatchKey.get(k).push(r);
        }
      }
    }
    const byKeyFallback = new Map(); // key → 最新の行のバッチにある、同じキーの全行
    const plainKeys = [...new Set(plain.map((it) => it.key))];
    for (const part of chunks(plainKeys, IN_CHUNK)) {
      const [rows] = await q.query(
        `SELECT ${cols} FROM ${SENDS} WHERE form_url_key IN (?) AND created_at <= ? ORDER BY created_at DESC, id DESC`, [part, mtime]);
      const newestBatch = new Map(); // key → 最新の行のバッチコード(先頭 = 最新)
      for (const r of rows) if (!newestBatch.has(r.form_url_key)) newestBatch.set(r.form_url_key, r.batch_code);
      for (const r of rows) {
        if (r.batch_code !== newestBatch.get(r.form_url_key)) continue;
        if (!byKeyFallback.has(r.form_url_key)) byKeyFallback.set(r.form_url_key, []);
        byKeyFallback.get(r.form_url_key).push(r);
      }
    }

    // 判定(同じ行に複数の結果が来たら、順に当てる)
    const state = new Map(); // id → { status, result }
    const cur = (r) => state.get(r.id) || { status: r.send_status, result: r.send_result };
    const planned = new Map(); // status → (result → Set(id)) 備考にタブが入っても区切りに依らない
    const touchedBatches = new Set();
    const refusalShops = new Set();
    const process1 = (it, rows, isFallback) => {
      if (!rows.length) { if (!isFallback) { st.warehouseRows++; st.unmatched++; } return; }
      st.warehouseRows++; st.matched++;
      const result = clip(it.note || '成功', RESULT_MAX);
      let changed = false;
      for (const r of rows) {
        touchedBatches.add(r.batch_code);
        const c = cur(r);
        if (!shouldUpdate(c.status, it.result, c.result, result)) continue;
        state.set(r.id, { status: it.result, result });
        if (!planned.has(it.result)) planned.set(it.result, new Map());
        const byResult = planned.get(it.result);
        if (!byResult.has(result)) byResult.set(result, new Set());
        byResult.get(result).add(r.id);
        changed = true;
        if (it.result === 'failed' && REFUSAL_RE.test(it.note || '') && r.shop_id) refusalShops.add(r.shop_id);
      }
      if (changed) st[it.result]++; else st.unchanged++;
    };
    for (const it of coded) process1(it, byBatchKey.get(`${it.batchCode.toLowerCase()}\t${it.key}`) || [], false);
    for (const it of plain) process1(it, byKeyFallback.get(it.key) || [], true);
    st.refusal = refusalShops.size;

    if (!dryRun) {
      for (const [status, byResult] of planned) for (const [result, idSet] of byResult) {
        // 同じ id が後から別の結果に変わっていたら、最後の結果だけを書く
        const ids = [...idSet].filter((id) => state.get(id).status === status && state.get(id).result === result);
        for (const part of chunks(ids, IN_CHUNK)) {
          if (status === 'skipped') {
            await conn.query(`UPDATE ${SENDS} SET send_status = ?, send_result = ? WHERE id IN (?) AND send_status <> 'success'`, [status, result, part]);
          } else if (status === 'failed') {
            await conn.query(`UPDATE ${SENDS} SET send_status = ?, send_result = ?, sent_at = ? WHERE id IN (?) AND send_status <> 'success'`, [status, result, mtime, part]);
          } else {
            await conn.query(`UPDATE ${SENDS} SET send_status = ?, send_result = ?, sent_at = ? WHERE id IN (?)`, [status, result, mtime, part]);
          }
        }
      }
      if (refusalShops.size && await wh.columnExists(pool, 'shops', 'form_no_sales')) {
        for (const part of chunks([...refusalShops], IN_CHUNK)) await conn.query(`UPDATE ${SHOPS} SET form_no_sales = 1 WHERE id IN (?)`, [part]);
      }
      for (const part of chunks([...touchedBatches], IN_CHUNK)) {
        await conn.query(`UPDATE ${BATCHES} SET result_imported_at = NOW(), result_file = ? WHERE batch_code IN (?)`, [clip(fileName, 255), part]);
      }
      if (track) await insertTrack(conn, track, st); // 更新と同じトランザクション(commit の直前)
      await conn.commit();
    }
  } catch (e) {
    if (conn) { try { await conn.rollback(); } catch { /* 元のエラーを優先 */ } }
    throw e;
  } finally {
    if (conn && conn.release) conn.release();
  }
  return st;
}

/* ---------- 取り込み済みの記録(sql/warehouse_migrate_014.sql) ---------- */

/** 同じ(名前・更新時刻・サイズ)を取り込み済みか。表がなければ例外(errno 1146) */
async function isImported(pool, { name, mtime, size }) {
  const [r] = await pool.query(`SELECT id FROM ${TRACK} WHERE file_name = ? AND file_mtime = ? AND file_size = ? LIMIT 1`, [name, mtime, size]);
  return r.length > 0;
}

/** 取り込んだ結果を記録する(二重に呼んでも IGNORE で安全)。applyResults が同じ接続のトランザクション内で呼ぶ */
async function insertTrack(q, { name, mtime, size }, st) {
  await q.query(
    `INSERT IGNORE INTO ${TRACK} (file_name, file_mtime, file_size, warehouse_rows, matched, success, failed, skipped, unmatched) VALUES (?,?,?,?,?,?,?,?,?)`,
    [clip(name, 255), mtime, size, st.warehouseRows, st.matched, st.success, st.failed, st.skipped, st.unmatched]);
}

module.exports = {
  TRACK, BATCH_RE, TOKEN_RE, REFUSAL_RE,
  parseResultText, parseRowsText, parseSendResults, shouldUpdate, applyResults, isImported,
};
