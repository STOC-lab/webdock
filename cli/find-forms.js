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
 *   dry-run のCSVには --with-size のとき 従業員数・資本金・上場・規模・会社概要URL の列が付く
 * フォームの送信は一切しない(ページを見るだけ)。
 */

const fs = require('fs');
const path = require('path');
const { findContact, hostOf } = require('../src/formFinder');
const { findCompanySize } = require('../src/companyProfile');
const { fetchHomepage } = require('../src/safeFetch');

const SITE_TIMEOUT_MS = 60000;
const LOOP_BATCH = 500;
const LOOP_SLEEP_MS = 30 * 60 * 1000;

/* ---------- 引数 ---------- */
function parseArgs(argv) {
  const o = { dryRun: false, limit: 100, out: 'data/forms-result.csv', loop: false, concurrency: 5, prefecture: null, recheckDays: 90, errorRetryDays: 7, limitGiven: false, source: 'stores', retryNeedsBrowser: false, category: [], withSize: false, sizeOnly: false, maxEmployees: 20 };
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
    else if (a === '--max-employees') o.maxEmployees = Number(next());
    else throw new Error('不明なオプション: ' + a);
  }
  if (o.source !== 'stores' && o.source !== 'warehouse') throw new Error('--source は stores か warehouse を指定してください');
  if ((o.withSize || o.sizeOnly || o.category.length) && o.source !== 'warehouse') {
    throw new Error('--with-size / --size-only / --category は --source warehouse のときだけ使えます');
  }
  for (const k of ['limit', 'concurrency', 'recheckDays', 'errorRetryDays', 'maxEmployees']) {
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
async function processStores({ stores, finder, writer, concurrency = 5, shouldStop = () => false, onProgress = () => {}, siteTimeoutMs = SITE_TIMEOUT_MS, sizeOnlyStats = false }) {
  const groups = new Map();
  const order = [];
  for (const s of stores) {
    const url = normalizeUrl(s.website_url);
    const host = hostOf(url) || '__invalid__:' + s.id;
    if (!groups.has(host)) { groups.set(host, { url, stores: [] }); order.push(host); }
    groups.get(host).stores.push(s);
  }

  const stats = { total: stores.length, done: 0, found: 0, none: 0, unknown: 0, error: 0 };
  const sizeCounts = { small: 0, large: 0, sizeUnknown: 0 };
  let idx = 0;

  async function worker() {
    while (!shouldStop()) {
      const i = idx++;
      if (i >= order.length) return;
      const g = groups.get(order[i]);
      let result;
      try {
        if (!hostOf(g.url)) throw Object.assign(new Error('URLが不正です'), { userSafe: true });
        result = await withTimeout(Promise.resolve(finder(g.url)), siteTimeoutMs);
      } catch (e) {
        result = { status: 'error', inquiryUrl: null, hasCaptcha: false, kind: 'none', emails: [], instagram: null, checkedPages: 0, note: e && e.userSafe ? e.message : '調査に失敗しました' };
      }
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

/**
 * 倉庫の調査対象。(prefecture, form_status) 索引で都道府県の範囲に絞ってから並べ替える。
 * 調査すると form_status / form_checked_at が変わって対象から外れるので、ループしても同じ行を繰り返さない。
 * needs_browser は retryNeedsBrowser のときだけ再試行する。
 */
function buildWarehouseTargetQuery({ recheckDays, errorRetryDays, prefecture, limit, retryNeedsBrowser, category }) {
  const params = [];
  const prefs = String(prefecture || '').split(',').map((x) => x.trim()).filter(Boolean);
  let sql = `
SELECT id, name, website_url, prefecture, review_count
FROM stoc_master.shops
WHERE website_url IS NOT NULL AND website_url <> ''`;
  if (prefs.length) { sql += '\n  AND prefecture IN (?)'; params.push(prefs); }
  sql += categoryClause(category, params);
  sql += `
  AND (
    (form_status = 'unknown' AND form_checked_at IS NULL)
    OR (form_status IN (${retryNeedsBrowser ? "'error','needs_browser'" : "'error'"}) AND form_checked_at < NOW() - INTERVAL ? DAY)
    OR (form_status = 'no_form' AND form_checked_at < NOW() - INTERVAL ? DAY)
  )
ORDER BY review_count IS NULL, review_count DESC, id
LIMIT ?`;
  params.push(errorRetryDays, recheckDays, limit);
  return { sql, params };
}

/**
 * --size-only の調査対象: ホームページがあり、規模を未調査(size_checked_at が空)の店舗。
 * 調査すると size_checked_at が入って対象から外れるので、ループしても同じ行を繰り返さない。
 */
function buildWarehouseSizeTargetQuery({ prefecture, category, limit }) {
  const params = [];
  const prefs = String(prefecture || '').split(',').map((x) => x.trim()).filter(Boolean);
  let sql = `
SELECT id, name, website_url, prefecture, review_count
FROM stoc_master.shops
WHERE website_url IS NOT NULL AND website_url <> ''
  AND size_checked_at IS NULL`;
  if (prefs.length) { sql += '\n  AND prefecture IN (?)'; params.push(prefs); }
  sql += categoryClause(category, params);
  sql += '\nORDER BY review_count IS NULL, review_count DESC, id\nLIMIT ?';
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
  const SQL = `
UPDATE stoc_master.shops SET
  form_status = ?, form_url = ?, form_kind = ?, form_captcha = ?, form_note = ?, form_checked_at = NOW(),
  email = IF((email IS NULL OR email = '') AND ? IS NOT NULL, ?, email),
  instagram_url = IF((instagram_url IS NULL OR instagram_url = '') AND ? IS NOT NULL, ?, instagram_url)
WHERE id = ?`;
  return async function write(shop, r) {
    const u = resultToShopUpdate(r);
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
function makeFinder({ withSize = false, sizeOnly = false, maxEmployees = 20, fetchPage = fetchHomepage, fetchRobots, maxRecordBytes = 3000000 } = {}) {
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

async function fetchTargets(pool, opts, limit) {
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
  const shouldStop = () => stopping;

  const wh = opts.source === 'warehouse';
  const pool = wh ? createWarehousePool() : createPool();
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
        const rows = (await fetchTargets(pool, opts, LOOP_BATCH)).filter((r) => !seen.has(r.id));
        if (!rows.length) {
          console.error(`対象なし。30分待機します (${new Date().toLocaleString('ja-JP')})`);
          for (let t = 0; t < LOOP_SLEEP_MS && !stopping; t += 1000) await new Promise((r) => setTimeout(r, 1000));
          seen.clear();
          continue;
        }
        rows.forEach((r) => seen.add(r.id));
        lastPrinted = 0;
        const st = await processStores({ stores: rows, finder, writer, concurrency: opts.concurrency, shouldStop, onProgress: makeProgress(0), sizeOnlyStats: opts.sizeOnly });
        if (opts.sizeOnly) console.error(`バッチ完了: ${st.done}件 (小規模${st.small} / 大規模${st.large} / 不明${st.sizeUnknown} / エラー${st.error})`);
        else console.error(`バッチ完了: ${st.done}件 (あり${st.found} / なし${st.none} / 要確認${st.unknown} / エラー${st.error})`);
      }
    } else {
      if (opts.loop && opts.dryRun) console.error('--dry-run のため --loop は無視します');
      const rows = await fetchTargets(pool, opts, opts.limit);
      console.error(`対象 ${rows.length}件${opts.dryRun ? ` -> ${opts.out}` : ''}`);
      const st = await processStores({ stores: rows, finder, writer, concurrency: opts.concurrency, shouldStop, onProgress: makeProgress(0), sizeOnlyStats: opts.sizeOnly });
      if (opts.sizeOnly) console.error(`完了: ${st.done}/${st.total}件 (小規模${st.small} / 大規模${st.large} / 不明${st.sizeUnknown} / エラー${st.error})`);
      else console.error(`完了: ${st.done}/${st.total}件 (あり${st.found} / なし${st.none} / 要確認${st.unknown} / エラー${st.error})`);
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('エラー: ' + e.message); process.exit(1); });
}

module.exports = { buildWarehouseTargetQuery, resultToShopUpdate, makeWarehouseWriter, createWarehousePool, makeDbWriter, fetchTargets, createPool, processStores, parseArgs, buildTargetQuery, csvField, csvLine, csvRow, CSV_COLUMNS, normalizeUrl,
  buildWarehouseSizeTargetQuery, sizeToShopUpdate, makeWarehouseSizeWriter, makeFinder, SIZE_CSV_COLUMNS, SIZE_ONLY_CSV_COLUMNS };
