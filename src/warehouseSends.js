'use strict';
/**
 * 倉庫から直接送る(営業管理に入れない)ための、倉庫側の送信履歴(stoc_master.webdock_sends / webdock_send_batches)。
 * 表は sql/warehouse_migrate_010.sql。営業管理(stoc_sales)へは書き込まない。読むだけ(SELECT)。
 *
 *  - バッチコード: whd_YYYYMMDD_HHmmss_xxxx(STOCの sender_… と頭が違うので、STOCの結果の戻しや送信済みの判定と混ざらない)
 *  - 送信履歴で外す日数の既定は 60日。送信結果の取り込み(PR-4)ができるまでは pending も「送信済み」に数える(取り込み前に重ねて送らない)
 *  - 直接送信の対象外の県(兵庫・岡山・徳島・香川・愛媛・高知)は営業管理経由に限る
 * プールは引数で受ける(テストでは偽物を渡す)。
 */
const crypto = require('crypto');
const S = require('./stocBatch');

const SENDS = 'stoc_master.webdock_sends';
const BATCHES = 'stoc_master.webdock_send_batches';
const PAGES = 'stoc_master.webdock_pages';
const SHOPS = 'stoc_master.shops';

/** 直接送信の対象外(営業管理経由に限定する県) */
const DIRECT_EXCLUDED_PREFECTURES = ['兵庫県', '岡山県', '徳島県', '香川県', '愛媛県', '高知県'];
/** 倉庫の送信履歴で外す日数の既定 */
const DEFAULT_MIN_DAYS_WH = 60;
/** 「送信済み」に数える状態。failed・skipped は数えない(失敗した店は次回また送ってよい。PR-4 で営業お断りが理由の失敗だけ別に除外する予定) */
const COUNTED_SEND_STATUS = ['pending', 'success'];
const MAX_DAYS = 3650;

const WH_BATCH_CODE_RE = /^whd_\d{8}_\d{6}_[0-9a-f]{4}$/;
const BATCH_INSERT_CHUNK = 500;

const isNoTable = (e) => !!e && (e.errno === 1146 || e.code === 'ER_NO_SUCH_TABLE');

/** 対象外の県が含まれていれば、そのメッセージ。なければ null */
function directPrefectureError(prefs) {
  const list = (Array.isArray(prefs) ? prefs : String(prefs || '').split(',')).map((p) => String(p).trim()).filter(Boolean);
  const ng = DIRECT_EXCLUDED_PREFECTURES.filter((p) => list.includes(p));
  if (!ng.length) return null;
  return `「倉庫から直接」では ${DIRECT_EXCLUDED_PREFECTURES.join('・')} は送れません(営業管理経由に限ります)。含まれている県: ${ng.join('・')}`;
}

/** 日数の検査。整数の 0〜3650 でなければ例外 */
function assertDays(days) {
  if (!Number.isInteger(days) || days < 0 || days > MAX_DAYS) throw new Error(`日数は0以上${MAX_DAYS}以下の整数にしてください: ${days}`);
  return days;
}

/** whd_YYYYMMDD_HHmmss_xxxx。日時と xxxx(16進4桁)の作り方は STOCの sender_ と同じ(頭だけ違う) */
function newBatchCode(now = new Date(), rand) {
  return 'whd_' + S.newBatchCode(now, rand).slice('sender_'.length);
}

/**
 * 送信先URLの正規化: スキーム・ホストは小文字、既定のポート・「#」以降・パス末尾の「/」は落とす(パスの大文字小文字と「?」以降は残す)。
 * URLとして読めなければ前後の空白だけ取る。結果CSV(PR-4)も同じ関数で「バッチコード + 送信先URL」を照合する。
 */
function normalizeFormUrl(url) {
  const s = String(url === undefined || url === null ? '' : url).trim();
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch { return s; }
}
/** 正規化した送信先URLのSHA1(16進40文字) */
const formUrlKey = (url) => crypto.createHash('sha1').update(normalizeFormUrl(url), 'utf8').digest('hex');

/* ---------- 読み出し ---------- */

function readError(what, e, strictNote) {
  return Object.assign(new Error(`${what}を読めませんでした(${e.message})。${strictNote}`), { stocCheck: true });
}
const MIGRATE_NOTE = '先に sql/warehouse_migrate_010.sql を適用してください(mysql < sql/warehouse_migrate_010.sql)。\n二重送信を防ぐため処理を中止しました。';

async function readIds(pool, sql, params, col, { what, tolerateMissing, warn }) {
  let rows;
  try { [rows] = await pool.query(sql, params); } catch (e) {
    if (isNoTable(e) && tolerateMissing) {
      (warn || ((m) => console.error(m)))(`警告: ${what}を読めない(表がない)ため、この除外はスキップします。sql/warehouse_migrate_010.sql を適用してください。`);
      return new Set();
    }
    throw readError(what, e, isNoTable(e) ? MIGRATE_NOTE : '二重送信を防ぐため処理を中止しました。');
  }
  return new Set(rows.map((r) => Number(r[col])).filter((n) => n > 0));
}

/**
 * 倉庫の送信履歴で、N日以内に送った(pending・success)店の倉庫の店ID(shops.id)の集合。直接送信で使う。読めなければ例外。
 */
async function loadWarehouseResendShopSet(pool, days) {
  assertDays(days);
  return readIds(pool,
    `SELECT DISTINCT shop_id FROM ${SENDS} WHERE send_status IN (${COUNTED_SEND_STATUS.map((s) => `'${s}'`).join(',')}) AND created_at >= NOW() - INTERVAL ? DAY`,
    [days], 'shop_id', { what: '倉庫の送信履歴(webdock_sends)', tolerateMissing: false });
}

/** 倉庫の専用ページで「今後の案内は不要」と申し出た店の倉庫の店ID(shop_id)の集合。期間は問わない。直接送信で使う。読めなければ例外 */
async function loadOptOutShopSet(pool) {
  return readIds(pool, `SELECT DISTINCT shop_id FROM ${PAGES} WHERE opt_out_at IS NOT NULL AND shop_id IS NOT NULL`,
    [], 'shop_id', { what: '配信停止の記録(webdock_pages)', tolerateMissing: false });
}

/**
 * 倉庫の店の情報を、営業管理の店(STOC stores)と同じ形にそろえて引く。S.ratingInfo / S.contactPhone をそのまま使うため。
 * 戻り: Map(倉庫の店ID数値 → { name, phone, address, gbp_rating, gbp_review_count, website_url })
 */
async function fetchWarehouseShops(pool, ids) {
  const map = new Map();
  const uniq = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  for (let i = 0; i < uniq.length; i += 1000) {
    const [rows] = await pool.query(`SELECT id, name, phone, address_raw, rating, review_count, website_url FROM ${SHOPS} WHERE id IN (?)`, [uniq.slice(i, i + 1000)]);
    for (const r of rows) {
      map.set(Number(r.id), {
        name: r.name, phone: r.phone, address: r.address_raw, gbp_rating: r.rating, gbp_review_count: r.review_count, website_url: r.website_url,
      });
    }
  }
  return map;
}

/* ---------- 書き込み(倉庫だけ) ---------- */

/**
 * 1バッチを倉庫の送信履歴に書く(1トランザクション。失敗は ROLLBACK)。
 * opts: { code, fileName?, items:[{ shopId, key, sentence, pageToken, formUrl, matchedStocStoreId }], filter(object), outDir }
 * webdock_send_batches に1行、webdock_sends に1店1行(send_status は pending)。営業管理(stoc_sales)には何も書かない。
 */
async function createBatch(pool, opts) {
  const items = opts.items;
  if (!items.length) throw new Error('登録する店舗がありません');
  if (items.length > S.BATCH_MAX) throw new Error(`1バッチは${S.BATCH_MAX}件までです`);
  if (!WH_BATCH_CODE_RE.test(String(opts.code))) throw new Error(`倉庫から直接のバッチコードの形式が不正です: ${opts.code}`);
  const clip = (s, n) => [...String(s === undefined || s === null ? '' : s)].slice(0, n).join('');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`INSERT INTO ${BATCHES} (batch_code, item_count, filter_json, out_dir) VALUES (?,?,?,?)`,
      [opts.code, items.length, JSON.stringify({ for_sender: true, source: 'webdock_direct', ...opts.filter }), opts.outDir ? clip(opts.outDir, 100) : null]);
    for (let i = 0; i < items.length; i += BATCH_INSERT_CHUNK) {
      const values = items.slice(i, i + BATCH_INSERT_CHUNK).map((it) => [
        it.shopId, opts.code, it.key || null, it.sentence || null, it.pageToken || null, clip(it.formUrl, 1000), formUrlKey(it.formUrl),
        it.matchedStocStoreId || null,
      ]);
      await conn.query(`INSERT INTO ${SENDS} (shop_id,batch_code,finding_key,finding_sentence,page_token,form_url,form_url_key,matched_stoc_store_id) VALUES ?`, [values]);
    }
    await conn.commit();
    return { code: opts.code, count: items.length };
  } catch (e) {
    try { await conn.rollback(); } catch { /* 元のエラーを優先 */ }
    if (S.isPermissionError(e)) throw Object.assign(new Error(accessMessage(e.message)), { stocCheck: true });
    if (isNoTable(e)) throw Object.assign(new Error(`倉庫の送信履歴の表を使えません(${e.message})。\n${MIGRATE_NOTE}`), { stocCheck: true });
    throw e;
  } finally {
    if (conn.release) conn.release();
  }
}

/* ---------- 権限の事前確認 ---------- */

function grantStatements(env = process.env) {
  const user = env.WH_DB_USER || 'stoc_wh';
  const host = env.WH_DB_HOST;
  const h = !host || host === '127.0.0.1' || host === '::1' ? 'localhost' : host;
  const to = `'${user}'@'${h}'`;
  return [
    `GRANT SELECT, INSERT, UPDATE ON ${SENDS} TO ${to};`,
    `GRANT SELECT, INSERT, UPDATE ON ${BATCHES} TO ${to};`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${PAGES} TO ${to};`,
    `GRANT SELECT ON ${SHOPS} TO ${to};`,
  ];
}
function accessMessage(cause, env = process.env) {
  return `倉庫の送信履歴への書き込み・読み取りに必要な権限が、倉庫DBユーザーにありません(${cause})。\n`
    + '送信履歴に残らないまま送ってしまわないよう、処理を中止しました。root で次を実行してください:\n' + grantStatements(env).join('\n');
}

/**
 * 倉庫から直接送る前の確認(診断を始める前に呼ぶ)。何も書かずに、0行を対象にした文で権限だけ検査する。
 *  - 営業管理(stoc_sales): 読み取り(SELECT)だけ。stores・sales_logs・inquiry_export_items/batches
 *  - 倉庫: webdock_sends・webdock_send_batches への書き込み、専用ページ(webdock_pages)への書き込み。dryRun=true(倉庫に何も書かない試し)なら読み取りだけ
 * 足りなければ例外(stocCheck: true)。
 */
async function checkDirectAccess(pool, { env = process.env, dryRun = false, checkPages } = {}) {
  const db = S.stocDbName(env);
  const probes = [
    `SELECT id, name, status FROM ${db}.stores WHERE 1 = 0`,
    `SELECT store_id FROM ${db}.sales_logs WHERE 1 = 0`,
    `SELECT store_id FROM ${db}.inquiry_export_items WHERE 1 = 0`,
    `SELECT id FROM ${db}.inquiry_export_batches WHERE 1 = 0`,
    `SELECT id, stoc_store_id FROM ${SHOPS} WHERE 1 = 0`,
    `SELECT shop_id, send_status, created_at FROM ${SENDS} WHERE 1 = 0`,
    `SELECT shop_id, opt_out_at FROM ${PAGES} WHERE 1 = 0`,
  ];
  if (!dryRun) {
    probes.push(
      `INSERT INTO ${BATCHES} (batch_code, item_count) SELECT 'probe', 0 FROM DUAL WHERE 1 = 0`,
      `INSERT INTO ${SENDS} (shop_id, batch_code, form_url, form_url_key) SELECT 0, 'probe', 'probe', 'probe' FROM DUAL WHERE 1 = 0`,
    );
  }
  for (const sql of probes) {
    try { await pool.query(sql); } catch (e) {
      if (S.isPermissionError(e)) throw Object.assign(new Error(accessMessage(e.message, env)), { stocCheck: true });
      if (isNoTable(e)) throw Object.assign(new Error(`倉庫から直接送るための表を使えません(${e.message})。\n先に sql/warehouse_migrate_010.sql を適用してください(mysql < sql/warehouse_migrate_010.sql)。`), { stocCheck: true });
      throw Object.assign(new Error(`倉庫から直接送るための確認に失敗しました: ${e.message}\n(${sql.slice(0, 80)}…)`), { stocCheck: true });
    }
  }
  // 専用ページ(倉庫側だけ。営業管理への書き込み権限は要らない)
  if (!dryRun && checkPages) await checkPages(pool);
}

module.exports = {
  SENDS, BATCHES, DIRECT_EXCLUDED_PREFECTURES, DEFAULT_MIN_DAYS_WH, COUNTED_SEND_STATUS, WH_BATCH_CODE_RE,
  directPrefectureError, assertDays, newBatchCode, normalizeFormUrl, formUrlKey,
  loadWarehouseResendShopSet, loadOptOutShopSet, fetchWarehouseShops,
  createBatch, grantStatements, checkDirectAccess,
};
