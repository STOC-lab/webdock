'use strict';

/**
 * 問い合わせフォーム事前調査(フォーム探し)
 *
 *   node cli/find-forms.js --dry-run --limit 50 --out data/forms-sample.csv   (DB書き込みなし・CSVのみ)
 *   node cli/find-forms.js --limit 2000                                       (DBへ書き込み)
 *   node cli/find-forms.js --loop                                             (500件ずつ処理し続ける)
 *
 * オプション: --concurrency 5  --prefecture 兵庫県  --recheck-days 90  --error-retry-days 7
 * 倉庫モード: node cli/find-forms.js --source warehouse --prefecture 大阪府 [--loop] [--retry-needs-browser]
 *            (stoc_master.shops を対象にし、結果は shops の form_* 列へ書く。接続は WH_DB_* )
 * 会社規模(倉庫モードのみ。先に sql/warehouse_migrate_003.sql を適用):
 *   --category 製造,建設,工事   業種(category)にどれかを含む店舗だけ(カンマ区切り・OR)
 *   --with-size                 フォーム探しと同時に会社概要から従業員数・資本金・上場を読み、size_* 列へ書く
 *                               (フォーム探しで取得済みのページを使い回し、追加取得は1サイト最大2ページ)
 *   --size-only                 規模だけ調べる(size_checked_at が空の店舗が対象。form_* 列は触らない)
 *   --max-employees 20          この人数以下を small、超えると large とする(既定20)
 *   --no-sales-only             form_status='url_found' で form_no_sales が未判定(NULL)の既存フォームだけ、フォームのページを取得して
 *                               「営業お断り」の記載を調べ form_no_sales(0/1)へ書く(sql/warehouse_migrate_004.sql が必要。他の列は触らない。
 *                               取得失敗・robots除外はNULLのまま。--size-only / --with-size とは併用不可。--loop / --limit / --dry-run / --concurrency 可)
 * 夜間モード(倉庫のみ): --night   夜間の時間帯(倉庫の管理画面で設定。既定22時〜6時)にだけ動き、統合済みの店(stoc_sales.stores.merged_into)を除き、
 *                               同じホストへは他のプロセスと合わせて10秒以上あけ、7日以内に調べた結果は使い回す。一時的なエラーは2回まで再試行、
 *                               404はサイトのトップで再試行。--category / --with-size / --size-only / --no-sales-only が無いときは、
 *                               電話番号あり・業種ルール(rules/問い合わせ営業.json)を通る店を、口コミの多い順に調べる。
 *   --order id|reviews          夜間の取り出し順。既定 id(ID の大きい順=新しく取り込んだ店から。主キーで読むので軽い)。reviews は口コミ数の多い順(重い。従来の動き)
 *   --ignore-window             (試験用)時間帯と開始日時の制限を外す
 *   --permanent-retry-days 90   403・ドメインなし等の再試行の間隔(倉庫モード。既定90)
 *   dry-run のCSVには --with-size のとき 従業員数・資本金・上場・規模・会社概要URL の列が付く
 * フォームの送信は一切しない(ページを見るだけ)。
 */

const fs = require('fs');
const path = require('path');
const { findContact, hostOf, detectNoSales, NOTE_NO_SALES, parseRobots, isDisallowed } = require('../src/formFinder');
const { findCompanySize } = require('../src/companyProfile');
const { fetchHomepage, fetchHead } = require('../src/safeFetch');
const night = require('../src/nightGuard');

const SITE_TIMEOUT_MS = 60000;
const LOOP_BATCH = 500;
const LOOP_SLEEP_MS = 30 * 60 * 1000;

/* ---------- 引数 ---------- */
function parseArgs(argv) {
  const o = { dryRun: false, limit: 100, out: 'data/forms-result.csv', loop: false, concurrency: 5, prefecture: null, recheckDays: 90, errorRetryDays: 7, limitGiven: false, source: 'stores', retryNeedsBrowser: false, category: [], withSize: false, sizeOnly: false, noSalesOnly: false, maxEmployees: 30, night: false, ignoreWindow: false, permanentRetryDays: 90, order: 'id' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--loop') o.loop = true;
    else if (a === '--limit') { o.limit = Number(next()); o.limitGiven = true; }
    else if (a === '--out') o.out = next();
    else if (a === '--concurrency') o.concurrency = Number(next());
    else if (a === '--prefecture') o.prefecture = next();
    else if (a === '--recheck-days') o.recheckDays = Number(next());
    else if (a === '--error-retry-days') o.errorRetryDays = Number(next());
    else if (a === '--source') o.source = next();
    else if (a === '--retry-needs-browser') o.retryNeedsBrowser = true;
    else if (a === '--category') o.category = String(next() || '').split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--with-size') o.withSize = true;
    else if (a === '--size-only') o.sizeOnly = true;
    else if (a === '--no-sales-only') o.noSalesOnly = true;
    else if (a === '--max-employees') o.maxEmployees = Number(next());
    else if (a === '--night') o.night = true;
    else if (a === '--ignore-window') o.ignoreWindow = true;
    else if (a === '--permanent-retry-days') o.permanentRetryDays = Number(next());
    else if (a === '--order') o.order = next();
    else throw new Error('不明なオプション: ' + a);
  }
  if (o.source !== 'stores' && o.source !== 'warehouse') throw new Error('--source は stores か warehouse を指定してください');
  if ((o.withSize || o.sizeOnly || o.category.length) && o.source !== 'warehouse') {
    throw new Error('--with-size / --size-only / --category は --source warehouse のときだけ使えます');
  }
  if ((o.night || o.ignoreWindow) && o.source !== 'warehouse') throw new Error('--night / --ignore-window は --source warehouse のときだけ使えます');
  if (o.order !== 'id' && o.order !== 'reviews') throw new Error('--order は id か reviews を指定してください');
  if (o.ignoreWindow && !o.night) throw new Error('--ignore-window は --night と一緒に指定してください');
  if (o.noSalesOnly) {
    if (o.source !== 'warehouse') throw new Error('--no-sales-only は --source warehouse のときだけ使えます');
    if (o.sizeOnly || o.withSize) throw new Error('--no-sales-only は --size-only / --with-size と同時に使えません');
  }
  for (const k of ['limit', 'concurrency', 'recheckDays', 'errorRetryDays', 'maxEmployees', 'permanentRetryDays']) {
    if (!Number.isFinite(o[k]) || o[k] < 1) throw new Error(`--${k} の値が不正です`);
    o[k] = Math.floor(o[k]);
  }
  return o;
}

/* ---------- CSV ---------- */
function csvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const csvLine = (vals) => vals.map(csvField).join(',') + '\r\n';
const CSV_COLUMNS = ['store_id', '店名', '都道府県', 'URL', '結果', '問い合わせURL', '種類', '画像認証', 'メール', 'Instagram', '備考'];
const SIZE_CSV_COLUMNS = ['従業員数', '資本金', '上場', '規模', '会社概要URL'];
// --size-only 用(フォームの列は出さない)
const SIZE_ONLY_CSV_COLUMNS = ['store_id', '店名', '都道府県', 'URL', ...SIZE_CSV_COLUMNS, '備考'];

const SIZE_LABEL = { small: '小規模', large: '大規模', unknown: '不明' };

function sizeCells(size) {
  const z = size || {};
  return [
    z.employees === null || z.employees === undefined ? '' : z.employees,
    z.capitalYen === null || z.capitalYen === undefined ? '' : z.capitalYen,
    z.listed === true ? 'あり' : z.listed === false ? '非上場' : '',
    z.sizeClass ? SIZE_LABEL[z.sizeClass] || '' : '',
    z.profileUrl || '',
  ];
}

function csvRow(store, r, mode = {}) {
  if (mode.sizeOnly) {
    const z = r.size || {};
    return csvLine([store.id, store.name, store.prefecture, store.website_url, ...sizeCells(z), z.note || r.note || '']);
  }
  const res = r.status === 'url_found' ? 'フォームあり' : r.status === 'no_form' ? 'フォームなし' : r.status === 'unknown' ? '要確認' : 'エラー';
  const kind = r.status !== 'url_found' ? '' : r.kind === 'external' ? '外部サービス' : '自社';
  return csvLine([
    store.id, store.name, store.prefecture, store.website_url, res, r.inquiryUrl || '', kind,
    r.status === 'url_found' ? (r.hasCaptcha ? 'あり' : 'なし') : '',
    (r.emails || []).join(' '), r.instagram || '', r.note || '',
    ...(mode.withSize ? sizeCells(r.size) : []),
  ]);
}

function makeCsvWriter(file, mode = {}) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const cols = mode.sizeOnly ? SIZE_ONLY_CSV_COLUMNS : mode.withSize ? [...CSV_COLUMNS, ...SIZE_CSV_COLUMNS] : CSV_COLUMNS;
  fs.writeFileSync(file, '﻿' + csvLine(cols));
  return async (store, result) => { fs.appendFileSync(file, csvRow(store, result, mode)); };
}

/* ---------- 処理本体 ---------- */
function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'http://' + s;
}

function withTimeout(p, ms) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(Object.assign(new Error('サイト全体の制限時間(60秒)を超えました'), { userSafe: true })), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/**
 * stores: [{id,name,website_url,prefecture,...}]
 * finder(url) -> 結果, writer(store, result) -> Promise
 * 同一ホストの店舗は1回だけ調べて全店舗に反映する。
 */
async function processStores({ stores, finder, writer, concurrency = 5, shouldStop = () => false, onProgress = () => {}, siteTimeoutMs = SITE_TIMEOUT_MS, sizeOnlyStats = false, gate = null, needSize = false }) {
  const groups = new Map();
  const order = [];
  for (const s of stores) {
    const url = normalizeUrl(s.website_url);
    const host = hostOf(url) || '__invalid__:' + s.id;
    if (!groups.has(host)) { groups.set(host, { url, stores: [] }); order.push(host); }
    groups.get(host).stores.push(s);
  }

  const stats = { total: stores.length, done: 0, found: 0, none: 0, unknown: 0, error: 0, deferred: 0, retried: 0, reused: 0 };
  const sizeCounts = { small: 0, large: 0, sizeUnknown: 0 };
  let idx = 0;

  async function worker() {
    while (!shouldStop()) {
      const i = idx++;
      if (i >= order.length) return;
      const g = groups.get(order[i]);
      let result;
      const errorResult = (e) => ({ status: 'error', inquiryUrl: null, hasCaptcha: false, kind: 'none', emails: [], instagram: null, checkedPages: 0, note: e && e.userSafe ? e.message : '調査に失敗しました' });
      const visitOnce = async (u) => {
        try {
          if (!hostOf(u)) throw Object.assign(new Error('URLが不正です'), { userSafe: true });
          return await withTimeout(Promise.resolve(finder(u)), siteTimeoutMs);
        } catch (e) { return errorResult(e); }
      };
      if (gate && hostOf(g.url)) {
        try { result = await gate.run(hostOf(g.url), visitOnce, g.url, { needSize }); }
        catch (e) { result = errorResult(e); }
      } else {
        result = await visitOnce(g.url);
      }
      if (result.deferred) { // 順番待ちが長すぎた: 何も書かない(未調査のまま残り、次の周回で調べる)
        stats.deferred += g.stores.length;
        stats.done += g.stores.length;
        onProgress({ ...stats, ...(sizeOnlyStats ? sizeCounts : {}) });
        continue;
      }
      if (result.retries || result.rootRetried) stats.retried++;
      if (result.reused) stats.reused++;
      for (const s of g.stores) {
        let r = result;
        try {
          await writer(s, r);
        } catch (e) {
          console.error(`書き込み失敗 store_id=${s.id}: ${e.message}`);
          r = { ...result, status: 'error', note: '書き込み失敗: ' + e.message };
        }
        stats.done++;
        if (r.status === 'url_found') stats.found++;
        else if (r.status === 'no_form') stats.none++;
        else if (r.status === 'unknown') stats.unknown++;
        else if (r.status === 'size') {
          // --size-only: 規模の判定結果を数える
          if (r.size && r.size.sizeClass === 'small') sizeCounts.small++;
          else if (r.size && r.size.sizeClass === 'large') sizeCounts.large++;
          else sizeCounts.sizeUnknown++;
        } else stats.error++;
        onProgress({ ...stats, ...(sizeOnlyStats ? sizeCounts : {}) });
      }
    }
  }

  const n = Math.max(1, Math.min(concurrency, order.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  return sizeOnlyStats ? { ...stats, ...sizeCounts } : stats;
}

/* ---------- DB ---------- */
function loadEnv() {
  try { require('dotenv').config(); } catch { /* dotenvなしでも動く */ }
}

function createPool() {
  const mysql = require('mysql2/promise');
  return mysql.createPool({
    host: process.env.FINDER_DB_HOST || '127.0.0.1',
    port: Number(process.env.FINDER_DB_PORT || 3306),
    user: process.env.FINDER_DB_USER,
    password: process.env.FINDER_DB_PASS,
    database: process.env.FINDER_DB_NAME || 'stoc_sales',
    charset: 'utf8mb4',
    connectionLimit: 3,
  });
}

function buildTargetQuery({ recheckDays, errorRetryDays, prefecture, limit }) {
  const params = [];
  let sql = `
SELECT s.id, s.name, s.website_url, s.prefecture, s.score
FROM stores s
LEFT JOIN store_contact_channels c ON c.store_id = s.id
WHERE s.website_url IS NOT NULL AND s.website_url <> ''
  AND s.merged_into IS NULL
  AND (s.status IS NULL OR s.status NOT IN ('失注','契約'))
  AND (c.manual_inquiry_url IS NULL OR c.manual_inquiry_url = '')
  AND (c.confirmed_inquiry_url IS NULL OR c.confirmed_inquiry_url = '')
  AND (c.inquiry_status IS NULL OR c.inquiry_status NOT IN ('sent','confirmed','failed'))
  AND (
    c.store_id IS NULL
    OR (c.inquiry_status = 'unknown' AND (c.inquiry_last_checked_at IS NULL OR c.inquiry_last_checked_at < NOW() - INTERVAL ? DAY))
    OR (c.inquiry_status = 'no_form' AND (c.inquiry_last_checked_at IS NULL OR c.inquiry_last_checked_at < NOW() - INTERVAL ? DAY))
  )`;
  params.push(errorRetryDays, recheckDays);
  if (prefecture) { sql += '\n  AND s.prefecture = ?'; params.push(prefecture); }
  sql += '\nORDER BY s.score DESC, s.id\nLIMIT ?';
  params.push(limit);
  return { sql, params };
}

/* ---------- 倉庫モード(stoc_master.shops) ---------- */
function createWarehousePool() {
  const mysql = require('mysql2/promise');
  return mysql.createPool({
    host: process.env.WH_DB_HOST || '127.0.0.1',
    port: Number(process.env.WH_DB_PORT || 3306),
    user: process.env.WH_DB_USER,
    password: process.env.WH_DB_PASS,
    charset: 'utf8mb4',
    connectionLimit: 3,
  });
}

/** 業種(category)の絞り込み。カンマ区切りのどれかを含む行(OR)。LIKEのワイルドカードはエスケープする */
function categoryClause(category, params) {
  const cats = (Array.isArray(category) ? category : String(category || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
  if (!cats.length) return '';
  for (const c of cats) params.push('%' + c.replace(/[\\%_]/g, '\\$&') + '%');
  // 主業種(category_main)だけで絞る。category には副業種も並ぶため、飲食店などが「加工」「製造」で混ざる
  return '\n  AND (' + cats.map(() => 'category_main LIKE ?').join(' OR ') + ')';
}

/** 統合済みの店(営業管理側で merged_into が入っている)を外す。営業管理に紐付いていない店(stoc_store_id が空)は残す */
const MERGED_CLAUSE = '\n  AND (stoc_store_id IS NULL OR NOT EXISTS (SELECT 1 FROM stoc_sales.stores st WHERE st.id = stoc_master.shops.stoc_store_id AND st.merged_into IS NOT NULL))';
// 業種ルール(rules/問い合わせ営業.json)の判定に必要な列(warehouse-promote と同じ)
const PRIORITY_COLUMNS = 'id, form_status, name, category, category_main, postal, address_raw, phone, rating, review_count, gbp_registered, website_url, gmap_url, photo_count, site_host, prefecture';

/**
 * 倉庫の調査対象。(prefecture, form_status) 索引で都道府県の範囲に絞ってから並べ替える。
 * 調査すると form_status / form_checked_at が変わって対象から外れるので、ループしても同じ行を繰り返さない。
 * needs_browser は retryNeedsBrowser のときだけ再試行する。
 * エラーの再試行: 一時的なもの等は errorRetryDays 日後、403・ドメインなし等(永続的)は permanentRetryDays(既定90)日後。
 * night: 統合済みの店を外す。priority: 電話番号ありだけにし、既定は ID の大きい順(id < cursor.id)。order: 'reviews' のときだけ口コミ数の多い順に (review_count, id) で位置(cursor)を進める。
 */
function buildWarehouseTargetQuery({ recheckDays, errorRetryDays, permanentRetryDays = 90, prefecture, limit, retryNeedsBrowser, category, night: isNight = false, priority = false, cursor = null, order = 'id' }) {
  const params = [];
  const prefs = String(prefecture || '').split(',').map((x) => x.trim()).filter(Boolean);
  let sql = `
SELECT ${priority ? PRIORITY_COLUMNS : 'id, name, website_url, prefecture, review_count'}
FROM stoc_master.shops
WHERE website_url IS NOT NULL AND website_url <> ''`;
  if (prefs.length) { sql += '\n  AND prefecture IN (?)'; params.push(prefs); }
  sql += categoryClause(category, params);
  sql += `
  AND (
    (form_status = 'unknown' AND form_checked_at IS NULL)
    OR (form_status IN (${retryNeedsBrowser ? "'error','needs_browser'" : "'error'"}) AND form_checked_at < NOW() - INTERVAL ? DAY AND NOT ${night.PERMANENT_NOTE_SQL})
    OR (form_status = 'error' AND ${night.PERMANENT_NOTE_SQL} AND form_checked_at < NOW() - INTERVAL ? DAY)
    OR (form_status = 'no_form' AND form_checked_at < NOW() - INTERVAL ? DAY)
  )`;
  params.push(errorRetryDays, permanentRetryDays, recheckDays);
  if (isNight) sql += MERGED_CLAUSE;
  if (priority) {
    sql += "\n  AND phone IS NOT NULL AND phone REGEXP '[0-9]'";
    if (order === 'reviews') {
      if (cursor) { sql += '\n  AND (COALESCE(review_count, -1) < ? OR (COALESCE(review_count, -1) = ? AND id > ?))'; params.push(cursor.rc, cursor.rc, cursor.id); }
      sql += '\nORDER BY COALESCE(review_count, -1) DESC, id\nLIMIT ?';
    } else {
      // ID の大きい順: 主キーで続きから読める(全件読み・filesort なし)
      if (cursor) { sql += '\n  AND id < ?'; params.push(cursor.id); }
      sql += '\nORDER BY id DESC\nLIMIT ?';
    }
  } else {
    sql += '\nORDER BY review_count IS NULL, review_count DESC, id\nLIMIT ?';
  }
  params.push(limit);
  return { sql, params };
}

/**
 * --size-only の調査対象: ホームページがあり、規模を未調査(size_checked_at が空)の店舗。
 * 調査すると size_checked_at が入って対象から外れるので、ループしても同じ行を繰り返さない。
 */
function buildWarehouseSizeTargetQuery({ prefecture, category, limit, night: isNight = false }) {
  const params = [];
  const prefs = String(prefecture || '').split(',').map((x) => x.trim()).filter(Boolean);
  let sql = `
SELECT id, name, website_url, prefecture, review_count
FROM stoc_master.shops
WHERE website_url IS NOT NULL AND website_url <> ''
  AND size_checked_at IS NULL`;
  if (prefs.length) { sql += '\n  AND prefecture IN (?)'; params.push(prefs); }
  sql += categoryClause(category, params);
  if (isNight) sql += MERGED_CLAUSE;
  sql += '\nORDER BY review_count IS NULL, review_count DESC, id\nLIMIT ?';
  params.push(limit);
  return { sql, params };
}

/**
 * --no-sales-only の調査対象: フォームURLがあるのに「営業お断り」を未判定(form_no_sales IS NULL)の店舗。
 * 取得に失敗した行はNULLのまま残るので、id > afterId で前へ進めて同じ行を繰り返さない(呼び出し側で afterId を更新する)。
 */
function buildWarehouseNoSalesTargetQuery({ prefecture, category, limit, afterId = 0, night: isNight = false }) {
  const params = [];
  const prefs = String(prefecture || '').split(',').map((x) => x.trim()).filter(Boolean);
  let sql = `
SELECT id, name, prefecture, form_url, form_note
FROM stoc_master.shops
WHERE form_status = 'url_found'
  AND form_url IS NOT NULL AND form_url <> ''
  AND form_no_sales IS NULL
  AND id > ?`;
  params.push(afterId);
  if (prefs.length) { sql += '\n  AND prefecture IN (?)'; params.push(prefs); }
  sql += categoryClause(category, params);
  if (isNight) sql += MERGED_CLAUSE;
  sql += '\nORDER BY id\nLIMIT ?';
  params.push(limit);
  return { sql, params };
}

const clipStr = (v, n) => (typeof v === 'string' && v.length > n ? v.slice(0, n) : v);

/** finderの結果 -> shops の更新値。finderの 'unknown'(JS生成サイト等)は 'needs_browser' として記録する。 */
function resultToShopUpdate(r) {
  const found = r.status === 'url_found' && r.inquiryUrl && r.inquiryUrl.length <= 1000;
  const status = found ? 'url_found' : r.status === 'no_form' ? 'no_form' : r.status === 'unknown' ? 'needs_browser'
    : 'error';
  const email = (r.emails || []).find((e) => e && e.length <= 255) || null;
  const note = r.status === 'url_found' && !found ? 'フォームURLが長すぎます' : r.note;
  return {
    form_status: status,
    form_url: found ? r.inquiryUrl : null,
    form_kind: found ? clipStr(r.kind === 'external' ? 'external' : 'onsite', 20) : null,
    form_captcha: found ? (r.hasCaptcha ? 1 : 0) : null,
    form_note: note ? clipStr(String(note), 100) : null,
    email,
    instagram_url: r.instagram && r.instagram.length <= 500 ? r.instagram : null,
  };
}

function makeWarehouseWriter(pool) {
  // form_no_sales 列(migrate_004)があれば「営業お断り」の印も書く。なければ警告を1回出して従来どおり
  let hasNoSales = null;
  const SQL_NS = `
UPDATE stoc_master.shops SET
  form_status = ?, form_url = ?, form_kind = ?, form_captcha = ?, form_no_sales = ?, form_note = ?, form_checked_at = NOW(),
  email = IF((email IS NULL OR email = '') AND ? IS NOT NULL, ?, email),
  instagram_url = IF((instagram_url IS NULL OR instagram_url = '') AND ? IS NOT NULL, ?, instagram_url)
WHERE id = ?`;
  const SQL = `
UPDATE stoc_master.shops SET
  form_status = ?, form_url = ?, form_kind = ?, form_captcha = ?, form_note = ?, form_checked_at = NOW(),
  email = IF((email IS NULL OR email = '') AND ? IS NOT NULL, ?, email),
  instagram_url = IF((instagram_url IS NULL OR instagram_url = '') AND ? IS NOT NULL, ?, instagram_url)
WHERE id = ?`;
  return async function write(shop, r) {
    const u = resultToShopUpdate(r);
    if (hasNoSales === null) {
      hasNoSales = await require('../src/warehouse').columnExists(pool, 'shops', 'form_no_sales');
      if (!hasNoSales) console.error('警告: shops.form_no_sales 列がありません。「営業お断り」の印は記録されません(sql/warehouse_migrate_004.sql を適用してください)。');
    }
    if (hasNoSales) {
      // フォームが見つかった店だけ 0/1。見つからなかった店は NULL
      const ns = u.form_status === 'url_found' ? (r.noSales ? 1 : 0) : null;
      await pool.execute(SQL_NS, [u.form_status, u.form_url, u.form_kind, u.form_captcha, ns, u.form_note,
        u.email, u.email, u.instagram_url, u.instagram_url, shop.id]);
      return;
    }
    await pool.execute(SQL, [u.form_status, u.form_url, u.form_kind, u.form_captcha, u.form_note,
      u.email, u.email, u.instagram_url, u.instagram_url, shop.id]);
  };
}

/** 規模の調査結果 -> shops の更新値 */
function sizeToShopUpdate(z) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  return {
    employees: num(z.employees) !== null && z.employees <= 2147483647 ? z.employees : null,
    capital_yen: num(z.capitalYen),
    listed: z.listed === true ? 1 : z.listed === false ? 0 : null,
    size_class: ['small', 'large', 'unknown'].includes(z.sizeClass) ? z.sizeClass : 'unknown',
    size_note: z.note ? clipStr(String(z.note), 100) : null,
    profile_url: z.profileUrl && z.profileUrl.length <= 1000 ? z.profileUrl : null,
  };
}

/** 規模の列だけを書く(form_* 列は触らない) */
function makeWarehouseSizeWriter(pool) {
  const SQL = `
UPDATE stoc_master.shops SET
  employees = ?, capital_yen = ?, listed = ?, size_class = ?, size_note = ?, profile_url = ?, size_checked_at = NOW()
WHERE id = ?`;
  return async function writeSize(shop, z) {
    const u = sizeToShopUpdate(z);
    await pool.execute(SQL, [u.employees, u.capital_yen, u.listed, u.size_class, u.size_note, u.profile_url, shop.id]);
  };
}

/**
 * 1サイトの調査関数を作る。
 * --with-size: フォーム探しで取得したページを記録して、会社概要の読み取りに使い回す(追加取得は最大2ページ)。
 * --size-only: 規模だけ調べる(トップ+会社概要候補)。結果の status は 'size'。
 */
function makeFinder({ withSize = false, sizeOnly = false, maxEmployees = 30, fetchPage = fetchHomepage, fetchRobots, maxRecordBytes = 3000000 } = {}) {
  const robotsOpt = fetchRobots ? { fetchRobots } : {};
  if (sizeOnly) {
    return async (url) => {
      const size = await findCompanySize(url, { fetchPage, maxEmployees, ...robotsOpt });
      return { status: 'size', size, note: size.note };
    };
  }
  if (!withSize) return (url) => findContact(url, { fetchPage, ...robotsOpt });
  return async (url) => {
    const pages = [];
    let bytes = 0;
    const recorder = async (u, ...rest) => {
      const r = await fetchPage(u, ...rest);
      if (r && r.status < 400 && typeof r.body === 'string' && bytes + r.body.length <= maxRecordBytes) {
        pages.push({ url: r.finalUrl || u, body: r.body });
        bytes += r.body.length;
      }
      return r;
    };
    const result = await findContact(url, { fetchPage: recorder, ...robotsOpt });
    if (!pages.length && result.status === 'error') {
      // トップページが取れなかったサイトは、規模の調査でも再取得しない
      result.size = { employees: null, employeesText: null, capitalYen: null, capitalText: null, listed: null, sizeClass: 'unknown', profileUrl: null, note: result.note || 'トップページ取得不可', checkedPages: 0 };
    } else {
      result.size = await findCompanySize(url, { pages, fetchPage, maxEmployees, ...robotsOpt });
    }
    return result;
  };
}

/** form_note に「営業お断りの記載あり」を足す(100文字に収める。重複は足さない) */
function appendNoSalesNote(note) {
  const cur = String(note || '');
  if (cur.includes(NOTE_NO_SALES)) return clipStr(cur, 100);
  if (!cur) return NOTE_NO_SALES;
  return clipStr(cur, Math.max(0, 100 - NOTE_NO_SALES.length - 1)) + '/' + NOTE_NO_SALES;
}

async function defaultFetchRobotsForNoSales(origin) {
  return fetchHead(origin + '/robots.txt', 16384, 4000);
}

/**
 * --no-sales-only の1店舗分: form_url のページだけを取得して「営業お断り」を判定する。
 * 戻り値: { ok:true, noSales:boolean } / { ok:false, note }(失敗・robots除外。DBは更新しない)
 */
async function checkNoSalesRow(shop, { fetchPage = fetchHomepage, fetchRobots = defaultFetchRobotsForNoSales } = {}) {
  const url = normalizeUrl(shop.form_url);
  let origin;
  try { origin = new URL(url).origin; } catch { return { ok: false, note: 'フォームURLが不正です' }; }
  let rules = [];
  try { rules = parseRobots(await fetchRobots(origin)); } catch { rules = []; }
  if (isDisallowed(rules, url)) return { ok: false, note: 'robots.txtで除外' };
  let page;
  try { page = await fetchPage(url); } catch (e) { return { ok: false, note: e && e.userSafe ? e.message : '取得に失敗しました' }; }
  if (!page || page.status >= 400 || typeof page.body !== 'string') return { ok: false, note: '取得に失敗しました' + (page && page.status ? `(HTTP ${page.status})` : '') };
  return { ok: true, noSales: detectNoSales(page.body) };
}

/** form_no_sales だけを書く(他の列は触らない)。お断りありなら form_note へ追記 */
function makeNoSalesWriter(pool) {
  const SQL = 'UPDATE stoc_master.shops SET form_no_sales = ?, form_note = ? WHERE id = ? AND form_no_sales IS NULL';
  const SQL_PLAIN = 'UPDATE stoc_master.shops SET form_no_sales = ? WHERE id = ? AND form_no_sales IS NULL';
  return async function writeNoSales(shop, noSales) {
    if (noSales) await pool.execute(SQL, [1, appendNoSalesNote(shop.form_note), shop.id]);
    else await pool.execute(SQL_PLAIN, [0, shop.id]);
  };
}

const NO_SALES_CSV_COLUMNS = ['store_id', '店名', '都道府県', '問い合わせURL', '営業お断り', '備考'];
function noSalesCsvRow(shop, r) {
  return csvLine([shop.id, shop.name, shop.prefecture, shop.form_url, r.ok ? (r.noSales ? 'あり' : 'なし') : '', r.ok ? (r.noSales ? NOTE_NO_SALES : '') : r.note || '']);
}
function makeNoSalesCsvWriter(file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, '﻿' + csvLine(NO_SALES_CSV_COLUMNS));
  return async (shop, r) => { if (r) fs.appendFileSync(file, noSalesCsvRow(shop, r)); };
}

/**
 * rows を concurrency 並列で調べる。check(shop) -> 結果、writer(shop, 結果) -> Promise(失敗は数えて続行)。
 * 戻り値: { total, done, noSales, clean, skipped, error }  skipped=取得失敗/robots除外(NULLのまま)
 */
async function processNoSales({ rows, check, writer, concurrency = 5, shouldStop = () => false, onProgress = () => {}, siteTimeoutMs = SITE_TIMEOUT_MS }) {
  const stats = { total: rows.length, done: 0, noSales: 0, clean: 0, skipped: 0, error: 0 };
  let idx = 0;
  async function worker() {
    while (!shouldStop()) {
      const i = idx++;
      if (i >= rows.length) return;
      const shop = rows[i];
      let r;
      try { r = await withTimeout(Promise.resolve(check(shop)), siteTimeoutMs); }
      catch (e) { r = { ok: false, note: e && e.userSafe ? e.message : '調査に失敗しました' }; }
      try {
        await writer(shop, r);
        if (!r.ok) stats.skipped++;
        else if (r.noSales) stats.noSales++;
        else stats.clean++;
      } catch (e) {
        console.error(`書き込み失敗 store_id=${shop.id}: ${e.message}`);
        stats.error++;
      }
      stats.done++;
      onProgress({ ...stats });
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, rows.length || 1)) }, worker));
  return stats;
}

/** 夜間モードの優先順位(電話番号あり → 業種ルール通過 → 口コミ数の多い順)を使うか。業種指定・規模・お断り判定の専用モードでは使わない */
const wantsPriority = (o) => !!(o.night && o.source === 'warehouse' && !(o.category || []).length && !o.withSize && !o.sizeOnly && !o.noSalesOnly);

let ruleCheckCache;
function getRuleCheck() {
  if (ruleCheckCache === undefined) {
    const P = require('./warehouse-promote');
    const rules = P.loadRules(undefined);
    if (!rules) console.error('警告: 業種ルール(rules/問い合わせ営業.json)が見つかりません。ルールでの絞り込みなしで進めます。');
    ruleCheckCache = { isNoPhone: P.isNoPhone, check: rules ? require('../src/rules').compileRules(rules) : null };
  }
  return ruleCheckCache;
}

/**
 * 優先順位つきの対象を limit 件。ルールを通らない店は読み飛ばし、state.cursor で前へ進める
 * (既定の ID 大きい順は { id }、--order reviews は { rc, id })。
 * 1回の取り出しで実行したクエリ回数と各所要ミリ秒を、時刻つきの1行でログに出す(opts.log で差し替え可)。
 */
async function fetchPrioritized(pool, opts, limit, state) {
  const { isNoPhone, check } = getRuleCheck();
  const byReviews = opts.order === 'reviews';
  const PAGE = Math.max(1000, limit * 2);
  const out = [];
  const timings = [];
  try {
    while (out.length < limit) {
      const { sql, params } = buildWarehouseTargetQuery({ ...opts, order: byReviews ? 'reviews' : 'id', limit: PAGE, priority: true, cursor: state.cursor });
      const t0 = Date.now();
      let rows;
      try { [rows] = await pool.query(sql, params); } finally { timings.push(Date.now() - t0); }
      for (const r of rows) {
        state.cursor = byReviews
          ? { rc: r.review_count === null || r.review_count === undefined ? -1 : Number(r.review_count), id: r.id }
          : { id: r.id };
        if (isNoPhone(r.phone)) continue;
        if (check && check(r)) continue;
        out.push(r);
        if (out.length >= limit) break;
      }
      if (rows.length < PAGE) break;
    }
  } finally {
    (opts.log || console.error)(`[${new Date().toISOString()}] 夜間の対象取り出し: order=${byReviews ? 'reviews' : 'id'} クエリ${timings.length}回 (${timings.map((t) => t + 'ms').join(', ')}) 合計${timings.reduce((a, b) => a + b, 0)}ms 取得${out.length}/${limit}件`);
  }
  return out;
}

async function fetchTargets(pool, opts, limit) {
  if (opts.source === 'warehouse' && opts.noSalesOnly) {
    const { sql, params } = buildWarehouseNoSalesTargetQuery({ ...opts, limit });
    const [rows] = await pool.query(sql, params);
    return rows;
  }
  if (wantsPriority(opts)) return fetchPrioritized(pool, opts, limit, opts._cursorState || (opts._cursorState = { cursor: null }));
  const build = opts.source === 'warehouse' ? (opts.sizeOnly ? buildWarehouseSizeTargetQuery : buildWarehouseTargetQuery) : buildTargetQuery;
  const { sql, params } = build({ ...opts, limit });
  // LIMIT のプレースホルダは query() で埋め込む(execute だと型で失敗する環境があるため)
  const [rows] = await pool.query(sql, params);
  return rows;
}

function makeDbWriter(pool) {
  const UPSERT = `
INSERT INTO store_contact_channels
  (store_id, inquiry_status, inquiry_last_checked_at, email_status, email_last_checked_at, instagram_url, instagram_status)
VALUES (?, ?, NOW(), ?, IF(? = 'found', NOW(), NULL), ?, ?)
ON DUPLICATE KEY UPDATE
  inquiry_status = IF(VALUES(inquiry_status) <> 'unknown' AND (inquiry_status IS NULL OR inquiry_status IN ('unknown','url_found','no_form')), VALUES(inquiry_status), inquiry_status),
  inquiry_last_checked_at = NOW(),
  email_last_checked_at = IF(VALUES(email_status) = 'found' AND (email_status IS NULL OR email_status = 'unknown'), NOW(), email_last_checked_at),
  email_status = IF(VALUES(email_status) = 'found' AND (email_status IS NULL OR email_status = 'unknown'), 'found', email_status),
  instagram_status = IF(VALUES(instagram_url) IS NOT NULL AND (instagram_url IS NULL OR instagram_url = '') AND (instagram_status IS NULL OR instagram_status = 'unknown'), 'found', instagram_status),
  instagram_url = IF(VALUES(instagram_url) IS NOT NULL AND (instagram_url IS NULL OR instagram_url = ''), VALUES(instagram_url), instagram_url)`;

  async function writeOnce(store, r) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const emails = (r.emails || []).slice(0, 3).filter((e) => e.length <= 1000);
      await conn.execute(UPSERT, [
        store.id,
        // unknown(要ブラウザ確認)とerrorは inquiry_status を変えず、確認日時だけ更新する(UPSERT側で保証)
        r.status === 'url_found' ? 'url_found' : r.status === 'no_form' ? 'no_form' : 'unknown',
        emails.length ? 'found' : 'unknown',
        emails.length ? 'found' : 'unknown',
        r.instagram || null,
        r.instagram ? 'found' : 'unknown',
      ]);
      if (r.status === 'url_found' && r.inquiryUrl && r.inquiryUrl.length <= 1000) {
        await conn.execute(
          `UPDATE contact_channel_candidates SET is_active = 0
           WHERE store_id = ? AND channel_type = 'inquiry_url' AND source = 'finder' AND value <> ?`,
          [store.id, r.inquiryUrl]);
        await conn.execute(
          `INSERT IGNORE INTO contact_channel_candidates (store_id, channel_type, value, source) VALUES (?, 'inquiry_url', ?, 'finder')`,
          [store.id, r.inquiryUrl]);
        // 以前finderが記録して無効化したURLが再び見つかった場合は有効に戻す(他ソースの行は触らない)
        await conn.execute(
          `UPDATE contact_channel_candidates SET is_active = 1
           WHERE store_id = ? AND channel_type = 'inquiry_url' AND source = 'finder' AND value = ? AND is_active = 0`,
          [store.id, r.inquiryUrl]);
      }
      for (const e of emails) {
        await conn.execute(
          `INSERT IGNORE INTO contact_channel_candidates (store_id, channel_type, value, source) VALUES (?, 'email', ?, 'finder')`,
          [store.id, e]);
      }
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch { /* 無視 */ }
      throw e;
    } finally {
      conn.release();
    }
  }

  // 並列実行時にInnoDBがデッドロック(1213)/ロック待ち超過(1205)でトランザクションを中止することがあるため、短く待って再試行する
  return async function write(store, r) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await writeOnce(store, r);
      } catch (e) {
        const retriable = e && (e.errno === 1213 || e.errno === 1205);
        if (!retriable || attempt >= 4) throw e;
        await new Promise((res) => setTimeout(res, 50 * attempt + Math.floor(Math.random() * 100)));
      }
    }
  };
}

/** --no-sales-only の本体。id > afterId で前へ進め、取得失敗で NULL のまま残った行を同じ周回で繰り返さない */
async function runNoSalesOnly(opts, pool, shouldStop, isStopping, nightCtx = null) {
  if (!(await require('../src/warehouse').columnExists(pool, 'shops', 'form_no_sales'))) {
    throw new Error('shops.form_no_sales 列がありません。先に `mysql < sql/warehouse_migrate_004.sql` を実行してください。');
  }
  // 夜間モード: 同じホストを他のプロセスと同時に訪問しない・10秒以上あける
  const check = nightCtx
    ? (shop) => {
        const host = hostOf(normalizeUrl(shop.form_url));
        return host ? nightCtx.gate.exclusive(host, () => checkNoSalesRow(shop)) : checkNoSalesRow(shop);
      }
    : (shop) => checkNoSalesRow(shop);
  const writer = opts.dryRun
    ? makeNoSalesCsvWriter(opts.out)
    : (() => { const w = makeNoSalesWriter(pool); return async (shop, r) => { if (r.ok) await w(shop, r.noSales); }; })();
  const onProgress = (s) => {
    if (s.done % 50 === 0 || s.done === s.total) console.error(`[${s.done}/${s.total}] お断りあり ${s.noSales}件 / なし ${s.clean}件 / 取得不可 ${s.skipped}件 / エラー ${s.error}件`);
  };
  const summary = (label, st) => console.error(`${label}: ${st.done}/${st.total}件 (お断りあり${st.noSales} / なし${st.clean} / 取得不可${st.skipped} / エラー${st.error})`);
  const loop = opts.loop && !opts.dryRun;
  if (opts.loop && opts.dryRun) console.error('--dry-run のため --loop は無視します');
  let afterId = 0;
  do {
    if (nightCtx && !(await waitForWindow(nightCtx, isStopping, loop))) return;
    const rows = await fetchTargets(pool, { ...opts, afterId }, loop ? LOOP_BATCH : opts.limit);
    if (!rows.length) {
      if (!loop) { console.error('対象なし'); return; }
      console.error(`対象なし。30分待機します (${new Date().toLocaleString('ja-JP')})`);
      for (let t = 0; t < LOOP_SLEEP_MS && !isStopping(); t += 1000) await new Promise((r) => setTimeout(r, 1000));
      afterId = 0; // 取得不可で残った行を次の周回でやり直す
      continue;
    }
    afterId = rows[rows.length - 1].id;
    if (!loop) console.error(`対象 ${rows.length}件${opts.dryRun ? ` -> ${opts.out}` : ''}`);
    const st = await processNoSales({ rows, check, writer, concurrency: opts.concurrency, shouldStop, onProgress });
    summary(loop ? 'バッチ完了' : '完了', st);
  } while (loop && !isStopping());
}

/* ---------- 夜間モード ---------- */
const sleepInterruptible = async (ms, isStopping) => { for (let t = 0; t < ms && !isStopping(); t += 1000) await new Promise((r) => setTimeout(r, 1000)); };

async function makeNightContext(opts, pool) {
  const reader = night.createScheduleReader({
    store: night.makeSettingsStore(pool),
    onError: (e) => console.error('夜間の時間帯の設定を読めませんでした(前の値を使います): ' + e.message),
  });
  await reader.refresh();
  reader.start();
  const gapSec = Number(process.env.FORM_HOST_GAP_SEC || 10);
  const gate = night.createHostGate({
    store: night.makeDbHostStore(pool),
    gapMs: (Number.isFinite(gapSec) && gapSec >= 1 ? gapSec : 10) * 1000,
    log: (m) => console.error(m),
  });
  const s = reader.current();
  console.error(`夜間モード: ${s.start}時〜${s.end}時${s.enabled ? '' : '(停止中)'}${s.from ? ` / ${s.from} から` : ''} (設定元: ${s.source})${opts.ignoreWindow ? ' / 時間帯の制限なし(--ignore-window)' : ''}`);
  return { reader, gate, ignoreWindow: opts.ignoreWindow };
}

/** 時間帯の中になるまで待つ。戻り値 false = 停止要求。loop でなく時間帯外なら即 false */
async function waitForWindow(ctx, isStopping, loop) {
  if (ctx.ignoreWindow) return true;
  let told = false;
  for (;;) {
    await ctx.reader.get();
    if (ctx.reader.isOpenNow()) return true;
    if (!loop) { console.error('夜間の時間帯の外です。何もしません(試験なら --ignore-window)。'); return false; }
    if (isStopping()) return false;
    if (!told) { const s = ctx.reader.current(); console.error(`時間帯の外です(${s.start}時〜${s.end}時${s.enabled ? '' : '・停止中'}${s.from ? ` / ${s.from} から` : ''})。開くまで待機します (${new Date().toLocaleString('ja-JP')})`); told = true; }
    await sleepInterruptible(60000, isStopping);
    if (isStopping()) return false;
  }
}

/* ---------- main ---------- */
async function main() {
  loadEnv();
  const opts = parseArgs(process.argv.slice(2));
  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.error('\n停止要求を受け付けました。処理中のサイトが終わり次第終了します(もう一度押すと強制終了)。');
  });
  const wh = opts.source === 'warehouse';
  const pool = wh ? createWarehousePool() : createPool();
  const nightCtx = opts.night ? await makeNightContext(opts, pool) : null;
  // 夜間モードは時間帯が閉じたら新しいサイトに着手しない(処理中のサイトは終わらせる)
  const shouldStop = nightCtx && !nightCtx.ignoreWindow ? () => stopping || !nightCtx.reader.isOpenNow() : () => stopping;
  if (opts.noSalesOnly) {
    try { await runNoSalesOnly(opts, pool, () => shouldStop(), () => stopping, nightCtx); } finally { if (nightCtx) nightCtx.reader.stop(); await pool.end(); }
    return;
  }
  const csvMode = { withSize: opts.withSize, sizeOnly: opts.sizeOnly };
  let writer;
  if (opts.dryRun) writer = makeCsvWriter(opts.out, csvMode);
  else if (opts.sizeOnly) { const w = makeWarehouseSizeWriter(pool); writer = async (shop, r) => { if (r.size) await w(shop, r.size); }; }
  else if (wh) {
    const wf = makeWarehouseWriter(pool);
    const ws = makeWarehouseSizeWriter(pool);
    writer = async (shop, r) => { await wf(shop, r); if (opts.withSize && r.size) await ws(shop, r.size); };
  } else writer = makeDbWriter(pool);
  const finder = makeFinder({ withSize: opts.withSize, sizeOnly: opts.sizeOnly, maxEmployees: opts.maxEmployees });
  let lastPrinted = 0;
  const makeProgress = (offset) => (s) => {
    const done = s.done;
    if (done % 50 === 0 || done === s.total) {
      if (done === lastPrinted) return;
      lastPrinted = done;
      if (opts.sizeOnly) { console.error(`[${done}/${s.total}] 小規模 ${s.small}件 / 大規模 ${s.large}件 / 不明 ${s.sizeUnknown}件 / エラー ${s.error}件`); return; }
      console.error(`[${done}/${s.total}] フォームあり ${s.found}件 / なし ${s.none}件 / 要確認 ${s.unknown}件 / エラー ${s.error}件`);
    }
  };

  try {
    if (opts.loop && !opts.dryRun) {
      const seen = new Set();
      while (!stopping) {
        if (nightCtx && !(await waitForWindow(nightCtx, () => stopping, true))) break;
        const rows = (await fetchTargets(pool, opts, LOOP_BATCH)).filter((r) => !seen.has(r.id));
        if (!rows.length) {
          console.error(`対象なし。30分待機します (${new Date().toLocaleString('ja-JP')})`);
          await sleepInterruptible(LOOP_SLEEP_MS, () => stopping);
          seen.clear();
          opts._cursorState = null;
          continue;
        }
        rows.forEach((r) => seen.add(r.id));
        lastPrinted = 0;
        const st = await processStores({ stores: rows, finder, writer, concurrency: opts.concurrency, shouldStop, onProgress: makeProgress(0), sizeOnlyStats: opts.sizeOnly, gate: nightCtx && nightCtx.gate, needSize: opts.withSize || opts.sizeOnly });
        if (nightCtx && !nightCtx.ignoreWindow && !nightCtx.reader.isOpenNow()) { seen.clear(); opts._cursorState = null; } // 途中で時間帯が閉じた: 次の夜に先頭からやり直す
        if (opts.sizeOnly) console.error(`バッチ完了: ${st.done}件 (小規模${st.small} / 大規模${st.large} / 不明${st.sizeUnknown} / エラー${st.error})`);
        else console.error(`バッチ完了: ${st.done}件 (あり${st.found} / なし${st.none} / 要確認${st.unknown} / エラー${st.error})${nightCtx ? ` 再試行${st.retried} / 使い回し${st.reused} / 見送り${st.deferred}` : ''}`);
      }
    } else {
      if (opts.loop && opts.dryRun) console.error('--dry-run のため --loop は無視します');
      if (nightCtx && !(await waitForWindow(nightCtx, () => stopping, false))) return;
      const rows = await fetchTargets(pool, opts, opts.limit);
      console.error(`対象 ${rows.length}件${opts.dryRun ? ` -> ${opts.out}` : ''}`);
      const st = await processStores({ stores: rows, finder, writer, concurrency: opts.concurrency, shouldStop, onProgress: makeProgress(0), sizeOnlyStats: opts.sizeOnly, gate: nightCtx && nightCtx.gate, needSize: opts.withSize || opts.sizeOnly });
      if (opts.sizeOnly) console.error(`完了: ${st.done}/${st.total}件 (小規模${st.small} / 大規模${st.large} / 不明${st.sizeUnknown} / エラー${st.error})`);
      else console.error(`完了: ${st.done}/${st.total}件 (あり${st.found} / なし${st.none} / 要確認${st.unknown} / エラー${st.error})${nightCtx ? ` 再試行${st.retried} / 使い回し${st.reused} / 見送り${st.deferred}` : ''}`);
    }
  } finally {
    if (nightCtx) nightCtx.reader.stop();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('エラー: ' + e.message); process.exit(1); });
}

module.exports = { wantsPriority, fetchPrioritized, MERGED_CLAUSE, buildWarehouseTargetQuery, resultToShopUpdate, makeWarehouseWriter, createWarehousePool, makeDbWriter, fetchTargets, createPool, processStores, parseArgs, buildTargetQuery, csvField, csvLine, csvRow, CSV_COLUMNS, normalizeUrl,
  buildWarehouseSizeTargetQuery, sizeToShopUpdate, makeWarehouseSizeWriter, makeFinder, SIZE_CSV_COLUMNS, SIZE_ONLY_CSV_COLUMNS,
  buildWarehouseNoSalesTargetQuery, appendNoSalesNote, checkNoSalesRow, makeNoSalesWriter, processNoSales, noSalesCsvRow, NO_SALES_CSV_COLUMNS };
