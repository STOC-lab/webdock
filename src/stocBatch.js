'use strict';
/**
 * STOC営業管理(stoc_sales)へ「送信用バッチ」を登録する。
 * 送信ツールは CSV の7列目(STOCバッチコード)と1列目(送信先URL)で結果をSTOCへ戻す。
 * STOC側(InquiryFollowupController::receiveResult)は inquiry_export_batches.batch_code と inquiry_export_items.website_url で探すので、
 * STOC営業管理の「問い合わせ営業用CSV」書き出し(InquiryExportController::exportForSender)と同じ形でバッチと明細を登録する。
 * DB接続は倉庫と同じ WH_DB_* の資格情報。接続の差し替えができるよう、プールは引数で受ける(テストでは偽物を渡す)。
 */

const BATCH_MAX = 5000;     // 1バッチの上限(STOCの書き出しと同じ)
const INSERT_CHUNK = 500;   // 明細INSERT・stores更新の1回あたり件数

/** 営業管理のDB名(STOC_DB_NAME で変更可。既定 stoc_sales) */
function stocDbName(env = process.env) {
  const n = env.STOC_DB_NAME || 'stoc_sales';
  if (!/^[A-Za-z0-9_]+$/.test(n)) throw new Error('STOC_DB_NAME が不正です: ' + n);
  return n;
}

function createStocPool(env = process.env) {
  const mysql = require('mysql2/promise');
  return mysql.createPool({
    host: env.WH_DB_HOST || '127.0.0.1',
    port: Number(env.WH_DB_PORT || 3306),
    user: env.WH_DB_USER,
    password: env.WH_DB_PASS,
    charset: 'utf8mb4',
    connectionLimit: 2,
  });
}

/* ---------- STOCと同じ整形 ---------- */

/** PHPの真偽(文字列の "0" と "" と 0 と null が偽。"0.0" は真) */
function phpTruthy(v) {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === 'number') return v !== 0;
  const s = String(v);
  return s !== '' && s !== '0';
}

/** 評価・口コミ列。STOCの $ratingInfo と同じ: trim(('評価'.rating) . ('(口コミ'.count.'件)')) */
function ratingInfo(store) {
  const s = store || {};
  return ((phpTruthy(s.gbp_rating) ? '評価' + String(s.gbp_rating) : '')
    + (phpTruthy(s.gbp_review_count) ? '(口コミ' + String(s.gbp_review_count) + '件)' : '')).trim();
}

/** 電話番号。STOCの contactPhone と同じ順: phone → phone_mobile → phone_free(各trimして最初の非空) */
function contactPhone(store) {
  const s = store || {};
  for (const f of ['phone', 'phone_mobile', 'phone_free']) {
    const v = String(s[f] === null || s[f] === undefined ? '' : s[f]).trim();
    if (v !== '') return v;
  }
  return '';
}

/** 明細の phone 列(varchar(20))用。CSVの電話番号は加工しない */
function historyPhone(p) { return [...String(p === null || p === undefined ? '' : p).trim()].slice(0, 20).join(''); }

/** 日本時間の YYYYMMDD_HHmmss */
function jstStamp(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}_${p.hour}${p.minute}${p.second}`;
}

/** STOCと同じ書式: sender_YYYYmmdd_His_xxxx (xxxx は16進4桁。PHPの substr(uniqid(), -4) 相当) */
function newBatchCode(now = new Date(), rand = () => Math.floor(Math.random() * 0x10000)) {
  return 'sender_' + jstStamp(now) + '_' + rand().toString(16).padStart(4, '0').slice(-4);
}
const BATCH_CODE_RE = /^sender_\d{8}_\d{6}_[0-9a-f]{4}$/;

function splitBatches(list, size = BATCH_MAX) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/* ---------- 権限 ---------- */

function grantStatements(env = process.env, db = stocDbName(env)) {
  const user = env.WH_DB_USER || 'stoc_wh';
  const host = env.WH_DB_HOST;
  const h = !host || host === '127.0.0.1' || host === '::1' ? 'localhost' : host;
  return [
    `GRANT SELECT, INSERT ON ${db}.inquiry_export_batches TO '${user}'@'${h}';`,
    `GRANT SELECT, INSERT ON ${db}.inquiry_export_items TO '${user}'@'${h}';`,
    `GRANT SELECT ON ${db}.stores TO '${user}'@'${h}';`,
    `GRANT UPDATE (exported_at, export_count) ON ${db}.stores TO '${user}'@'${h}';`,
  ];
}

function isPermissionError(e) {
  return !!e && (['ER_TABLEACCESS_DENIED_ERROR', 'ER_COLUMNACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR'].includes(e.code)
    || [1142, 1143, 1044].includes(e.errno));
}

function permissionMessage(cause, env = process.env, db = stocDbName(env)) {
  return `送信結果をSTOC営業管理へ戻すため、${db} にバッチを登録する必要がありますが、倉庫DBユーザーに権限がありません(${cause})。\n`
    + 'バッチ未登録のまま送ると結果が失われるため、処理を中止しました。root で次を実行してください:\n'
    + grantStatements(env, db).join('\n');
}

/**
 * 登録に必要な権限を、実際には何も書かずに確認する(0行を対象にした文は権限だけ検査される)。
 * 診断(数時間かかる)を始める前に呼ぶ。権限がなければ例外(stocCheck: true)。
 * readOnly=true(--dry-run-stoc)なら stores の読み取りだけ確認する。
 */
async function checkStocAccess(pool, { env = process.env, readOnly = false } = {}) {
  const db = stocDbName(env);
  const probes = [`SELECT id, name FROM ${db}.stores WHERE 1 = 0`];
  if (!readOnly) {
    probes.push(
      `INSERT INTO ${db}.inquiry_export_batches (batch_code, system_id) SELECT 'probe', 1 FROM DUAL WHERE 1 = 0`,
      `INSERT INTO ${db}.inquiry_export_items (batch_id) SELECT 0 FROM DUAL WHERE 1 = 0`,
      `UPDATE ${db}.stores SET exported_at = exported_at, export_count = export_count WHERE 1 = 0`,
    );
  }
  for (const sql of probes) {
    try { await pool.query(sql); } catch (e) {
      if (isPermissionError(e)) throw Object.assign(new Error(permissionMessage(e.message, env, db)), { stocCheck: true });
      throw Object.assign(new Error(`STOC営業管理(${db})の確認に失敗しました: ${e.message}`), { stocCheck: true });
    }
  }
}

/* ---------- 読み出し ---------- */

const STORE_COLUMNS = 'id, name, status, phone, phone_mobile, phone_free, address, prefecture, category, website_url, gbp_url, gbp_rating, gbp_review_count, score';

/** STOC店舗を id で引く。戻り: Map(id数値 → 行) */
async function fetchStocStores(pool, ids, env = process.env) {
  const db = stocDbName(env);
  const map = new Map();
  const uniq = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  for (let i = 0; i < uniq.length; i += 1000) {
    const [rows] = await pool.query(`SELECT ${STORE_COLUMNS} FROM ${db}.stores WHERE id IN (?)`, [uniq.slice(i, i + 1000)]);
    for (const r of rows) map.set(Number(r.id), r);
  }
  return map;
}

/* ---------- 登録(1バッチ=1トランザクション) ---------- */

const ITEM_COLUMNS = 'batch_id,store_id,shop_name,phone,address,prefecture,category,website_url,inquiry_url,gbp_url,report_url,score,approach_label,first_talk,send_status';

/**
 * 1バッチを登録する。
 * opts: { code, fileName, items:[{ stocId, store(STOC店舗行), formUrl, key, sentence }], memo, filter(object), userId, env }
 * 順序: BEGIN → inquiry_export_batches → inquiry_export_items(500件ずつ) → stores.exported_at/export_count(500件ずつ) → COMMIT。失敗は ROLLBACK。
 */
async function registerBatch(pool, opts) {
  const env = opts.env || process.env;
  const db = stocDbName(env);
  const items = opts.items;
  // 送信ツールは結果を返すとき、website_url として送信先URL(CSVの1列目=フォームURL)を送ってくる(2026-10-26 実送信で確認)。
  // STOC側は batch_code と item.website_url で照合するため、既定でフォームURLを入れる。店舗サイトURLに戻すときだけ STOC_ITEM_WEBSITE_URL=site。
  const formAsSite = env.STOC_ITEM_WEBSITE_URL !== 'site';
  if (!items.length) throw new Error('登録する店舗がありません');
  if (items.length > BATCH_MAX) throw new Error(`1バッチは${BATCH_MAX}件までです`);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const filter = JSON.stringify({ for_sender: true, source: 'webdock_b2b', ...opts.filter });
    const [ins] = await conn.query(
      `INSERT INTO ${db}.inquiry_export_batches (batch_code,system_id,export_format,total_count,status,filter_json,exported_file,exported_by,exported_at,memo) VALUES (?,1,'csv',?,'exported',?,?,?,NOW(),?)`,
      [opts.code, items.length, filter, opts.fileName, opts.userId === undefined ? null : opts.userId, opts.memo],
    );
    const batchId = Number(ins.insertId);
    if (!batchId) throw new Error('バッチIDを取得できませんでした');
    for (let i = 0; i < items.length; i += INSERT_CHUNK) {
      const values = items.slice(i, i + INSERT_CHUNK).map((it) => {
        const s = it.store;
        return [batchId, it.stocId, s.name, historyPhone(contactPhone(s)), s.address === undefined ? null : s.address, s.prefecture === undefined ? null : s.prefecture,
          s.category === undefined ? null : s.category, formAsSite ? (it.formUrl || '') : (s.website_url || it.websiteUrl || ''), it.formUrl || null, s.gbp_url === undefined ? null : s.gbp_url,
          '', s.score === undefined ? null : s.score, 'WEBドック:' + it.key, [...String(it.sentence || '')].slice(0, 200).join(''), 'pending'];
      });
      await conn.query(`INSERT INTO ${db}.inquiry_export_items (${ITEM_COLUMNS}) VALUES ?`, [values]);
    }
    const ids = items.map((it) => it.stocId);
    for (let i = 0; i < ids.length; i += INSERT_CHUNK) {
      await conn.query(`UPDATE ${db}.stores SET exported_at = NOW(), export_count = export_count + 1 WHERE id IN (?)`, [ids.slice(i, i + INSERT_CHUNK)]);
    }
    await conn.commit();
    return { code: opts.code, batchId, count: items.length };
  } catch (e) {
    try { await conn.rollback(); } catch { /* 元のエラーを優先 */ }
    if (isPermissionError(e)) throw Object.assign(new Error(permissionMessage(e.message, env, db)), { stocCheck: true });
    throw e;
  } finally {
    if (conn.release) conn.release();
  }
}

module.exports = {
  BATCH_MAX, BATCH_CODE_RE, stocDbName, createStocPool, phpTruthy, ratingInfo, contactPhone, historyPhone, newBatchCode, splitBatches,
  grantStatements, isPermissionError, permissionMessage, checkStocAccess, fetchStocStores, registerBatch,
};
