'use strict';

/**
 * 問い合わせフォーム事前調査(フォーム探し)
 *
 *   node cli/find-forms.js --dry-run --limit 50 --out data/forms-sample.csv   (DB書き込みなし・CSVのみ)
 *   node cli/find-forms.js --limit 2000                                       (DBへ書き込み)
 *   node cli/find-forms.js --loop                                             (500件ずつ処理し続ける)
 *
 * オプション: --concurrency 5  --prefecture 兵庫県  --recheck-days 90  --error-retry-days 7
 * フォームの送信は一切しない(ページを見るだけ)。
 */

const fs = require('fs');
const path = require('path');
const { findContact, hostOf } = require('../src/formFinder');

const SITE_TIMEOUT_MS = 60000;
const LOOP_BATCH = 500;
const LOOP_SLEEP_MS = 30 * 60 * 1000;

/* ---------- 引数 ---------- */
function parseArgs(argv) {
  const o = { dryRun: false, limit: 100, out: 'data/forms-result.csv', loop: false, concurrency: 5, prefecture: null, recheckDays: 90, errorRetryDays: 7, limitGiven: false };
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
    else throw new Error('不明なオプション: ' + a);
  }
  for (const k of ['limit', 'concurrency', 'recheckDays', 'errorRetryDays']) {
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

function csvRow(store, r) {
  const res = r.status === 'url_found' ? 'フォームあり' : r.status === 'no_form' ? 'フォームなし' : 'エラー';
  const kind = r.status !== 'url_found' ? '' : r.kind === 'external' ? '外部サービス' : '自社';
  return csvLine([
    store.id, store.name, store.prefecture, store.website_url, res, r.inquiryUrl || '', kind,
    r.status === 'url_found' ? (r.hasCaptcha ? 'あり' : 'なし') : '',
    (r.emails || []).join(' '), r.instagram || '', r.note || '',
  ]);
}

function makeCsvWriter(file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, '﻿' + csvLine(CSV_COLUMNS));
  return async (store, result) => { fs.appendFileSync(file, csvRow(store, result)); };
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
async function processStores({ stores, finder, writer, concurrency = 5, shouldStop = () => false, onProgress = () => {}, siteTimeoutMs = SITE_TIMEOUT_MS }) {
  const groups = new Map();
  const order = [];
  for (const s of stores) {
    const url = normalizeUrl(s.website_url);
    const host = hostOf(url) || '__invalid__:' + s.id;
    if (!groups.has(host)) { groups.set(host, { url, stores: [] }); order.push(host); }
    groups.get(host).stores.push(s);
  }

  const stats = { total: stores.length, done: 0, found: 0, none: 0, error: 0 };
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
        else stats.error++;
        onProgress({ ...stats });
      }
    }
  }

  const n = Math.max(1, Math.min(concurrency, order.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  return stats;
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

async function fetchTargets(pool, opts, limit) {
  const { sql, params } = buildTargetQuery({ ...opts, limit });
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

  return async function write(store, r) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const emails = (r.emails || []).slice(0, 3).filter((e) => e.length <= 1000);
      await conn.execute(UPSERT, [
        store.id,
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

  const pool = createPool();
  const writer = opts.dryRun ? makeCsvWriter(opts.out) : makeDbWriter(pool);
  const finder = (url) => findContact(url);
  let lastPrinted = 0;
  const makeProgress = (offset) => (s) => {
    const done = s.done;
    if (done % 50 === 0 || done === s.total) {
      if (done === lastPrinted) return;
      lastPrinted = done;
      console.error(`[${done}/${s.total}] フォームあり ${s.found}件 / なし ${s.none}件 / エラー ${s.error}件`);
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
        const st = await processStores({ stores: rows, finder, writer, concurrency: opts.concurrency, shouldStop, onProgress: makeProgress(0) });
        console.error(`バッチ完了: ${st.done}件 (あり${st.found} / なし${st.none} / エラー${st.error})`);
      }
    } else {
      if (opts.loop && opts.dryRun) console.error('--dry-run のため --loop は無視します');
      const rows = await fetchTargets(pool, opts, opts.limit);
      console.error(`対象 ${rows.length}件${opts.dryRun ? ` -> ${opts.out}` : ''}`);
      const st = await processStores({ stores: rows, finder, writer, concurrency: opts.concurrency, shouldStop, onProgress: makeProgress(0) });
      console.error(`完了: ${st.done}/${st.total}件 (あり${st.found} / なし${st.none} / エラー${st.error})`);
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('エラー: ' + e.message); process.exit(1); });
}

module.exports = { processStores, parseArgs, buildTargetQuery, csvField, csvLine, csvRow, CSV_COLUMNS, normalizeUrl };
