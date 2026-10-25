'use strict';
/**
 * 一括診断(問い合わせ営業用)
 * node cli/batch-scan.js --in list.tsv --out result.csv [--group-out dir(b2bのみ。--outは省略可)] [--concurrency 5] [--limit N] [--template west|east|auto|b2b] [--resume]
 * 入力は TSV/CSV(UTF-8 または Shift_JIS。warehouse-promote の11列CSVもそのまま使える)。
 * グループ本文の差し込みタグ: --merge-tags '{"会社名":"%company%","ドメイン":"%domain%"}' (省略時は outreach-config.json の「差し込みタグ」)
 * 倉庫から直接: node cli/batch-scan.js --source warehouse --prefecture 兵庫県 --main-category 製造,建設 [--exclude-large|--small-only]
 *              [--form-found] --template b2b --out result.csv   (WH_DB_* が必要)
 * B2B(建設・製造向け): --template b2b [--subject 1|2|3] [--max-chars N]
 */
const fs = require('fs');
const path = require('path');
const { JUDGE, pickFinding, shouldSend, regionOf, fillTemplate, loadTemplates, buildB2bMessage } = require('../src/outreach');
const wh = require('../src/warehouse');
const { writeGroupFiles } = require('../src/outreachGroups');

const SCAN_TIMEOUT_MS = 45000;

const COLUMNS = ['store_id', '店名', '都道府県', '業種', 'URL', 'ドメイン', '判定', '点数', '証明書', 'https転送', '暗号方式',
  'ヘッダー', 'Cookie', '混在', 'CMS露出', 'JSライブラリ', '外部スクリプト', 'なりすまし対策', '指摘種別', '指摘', '困ること',
  '送信推奨', '本文', 'エラー', '診断日時'];
// B2Bモードだけ末尾に足す列
const B2B_COLUMNS = ['業種区分', '件名', '本文文字数', '短縮本文', '使用本文', '問い合わせURL', '画像認証', '営業お断り'];
const ITEM_KEYS = ['cert', 'https_redirect', 'tls_version', 'headers', 'cookies', 'mixed', 'cms', 'js_libs', 'ext_scripts', 'mail'];

const ALIASES = {
  store_id: ['store_id', 'id', '店舗id'],
  name: ['name', '店名', '会社名', 'shop_name', '屋号'],
  url: ['url', 'website_url', 'ウェブサイト', '登録url'],
  prefecture: ['prefecture', '都道府県'],
  category: ['category', '業種'],
  address: ['address', '住所'], // 都道府県の列がないとき、先頭の都道府県名から補う
};

/* ---------- CSV/TSV ---------- */

function parseDelimited(text, delim) {
  const rows = [];
  let row = [], field = '', inQ = false, i = 0;
  const s = String(text).replace(/^﻿/, '');
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { inQ = true; i++; continue; }
    if (c === delim) { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = ''; i++; continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function parseInput(text) {
  const s = String(text).replace(/^﻿/, '');
  const firstLine = s.split(/\r?\n/, 1)[0] || '';
  const delim = firstLine.includes('\t') ? '\t' : ',';
  const table = parseDelimited(s, delim);
  if (!table.length) return [];
  const header = table[0].map((h) => h.trim().toLowerCase());
  const idx = {};
  for (const [canon, names] of Object.entries(ALIASES)) {
    idx[canon] = header.findIndex((h) => names.includes(h));
  }
  const cell = (r, k) => {
    if (idx[k] < 0) return '';
    const v = (r[idx[k]] || '').trim();
    return v === 'NULL' ? '' : v;
  };
  return table.slice(1).map((r) => ({
    store_id: cell(r, 'store_id'), name: cell(r, 'name'), url: cell(r, 'url'),
    prefecture: cell(r, 'prefecture') || wh.prefectureOf(cell(r, 'address')) || '', category: cell(r, 'category'),
  }));
}

/** 入力ファイルの中身(Buffer)を読む。UTF-8でなければ Shift_JIS として読む */
function parseInputBuffer(buf) {
  return parseInput(wh.decodeBuffer(buf));
}

/* ---------- 倉庫から読む ---------- */

function likeEsc(c) { return '%' + String(c).replace(/[\\%_]/g, '\\$&') + '%'; }

/** --source warehouse の検索SQL。noSalesCol=true なら form_no_sales 列も読み、営業お断りの店を外す */
function buildWarehouseQuery(a, { noSalesCol } = {}) {
  const where = ["website_url IS NOT NULL AND website_url <> ''",
    "(business_status IS NULL OR (business_status NOT LIKE '%閉業%' AND business_status NOT LIKE '%閉店%'))"];
  const params = [];
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
  const prefs = list(a.prefecture);
  if (prefs.length) { where.push('prefecture IN (?)'); params.push(prefs); }
  const cats = list(a.mainCategory);
  if (cats.length) {
    where.push('(' + cats.map(() => 'category_main LIKE ?').join(' OR ') + ')');
    for (const c of cats) params.push(likeEsc(c));
  }
  if (a.smallOnly) where.push("size_class = 'small'");
  else if (a.excludeLarge) where.push("(size_class IS NULL OR size_class <> 'large')");
  if (a.formFound) where.push("form_status = 'url_found'");
  // 送信用の文面を作るので、フォームがある店は「営業お断りの記載なし」と確認済み(=0)のものだけにする。
  // 未確認(NULL: 取得失敗・robots除外など)は送らない。find-forms --no-sales-only で確認できる。
  if (noSalesCol) where.push(a.formFound ? 'form_no_sales = 0' : '(form_no_sales IS NULL OR form_no_sales = 0)');
  let sql = `SELECT id AS store_id, name, website_url AS url, prefecture, category_main AS category, form_url, form_captcha${noSalesCol ? ', form_no_sales' : ''}
FROM stoc_master.shops WHERE ${where.join(' AND ')}
ORDER BY review_count IS NULL, review_count DESC, id`;
  if (a.limit > 0) { sql += '\nLIMIT ?'; params.push(a.limit); }
  return { sql, params };
}

async function loadWarehouseRows(a) {
  try { require('dotenv').config(); } catch { /* なくても動く */ }
  const { createWarehousePool } = require('./find-forms');
  const pool = createWarehousePool();
  try {
    const noSalesCol = await wh.columnExists(pool, 'shops', 'form_no_sales');
    if (!noSalesCol) console.error('警告: shops.form_no_sales 列がないため「営業お断り」の除外ができません。先に sql/warehouse_migrate_004.sql を適用してください。');
    const q = buildWarehouseQuery(a, { noSalesCol });
    const [rows] = await pool.query(q.sql, q.params);
    return rows.map((r) => ({
      store_id: String(r.store_id), name: r.name || '', url: r.url || '', prefecture: r.prefecture || '', category: r.category || '',
      formUrl: r.form_url || '', captcha: r.form_captcha === null || r.form_captcha === undefined ? '' : (Number(r.form_captcha) ? 'あり' : 'なし'),
      noSales: Number(r.form_no_sales) === 1 ? 'あり' : '',
    }));
  } finally { await pool.end(); }
}

function csvField(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvLine(values) { return values.map(csvField).join(',') + '\r\n'; }

/* ---------- 診断 ---------- */

async function scanOne(url) {
  const { fetchHomepage } = require('../src/safeFetch');
  const { runChecks } = require('../src/checks');
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(Object.assign(new Error('タイムアウトしました。'), { userSafe: true })), SCAN_TIMEOUT_MS);
  });
  try {
    return await Promise.race([(async () => runChecks(await fetchHomepage(url)))(), timeout]);
  } finally { clearTimeout(timer); }
}

function domainOf(url) {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}

function jstNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function readDoneIds(file) {
  if (!fs.existsSync(file)) return new Set();
  const table = parseDelimited(fs.readFileSync(file, 'utf8'), ',');
  if (!table.length) return new Set();
  const i = table[0].indexOf('store_id');
  const set = new Set();
  if (i >= 0) for (const r of table.slice(1)) if (r[i]) set.add(r[i]);
  return set;
}

/* ---------- バッチ本体 ---------- */

let stopRequested = false;

async function runBatch({ rows, scan, out, templates, concurrency = 5, templateMode = 'auto', resume = false, isStopped, log, subject, maxChars = 0 }) {
  const b2b = templateMode === 'b2b';
  const columns = b2b ? [...COLUMNS, ...B2B_COLUMNS] : COLUMNS;
  const say = log || ((m) => process.stderr.write(m + '\n'));
  const jsonl = out + '.jsonl';
  const exists = fs.existsSync(out) && fs.statSync(out).size > 0;
  const done = resume && exists ? readDoneIds(out) : new Set();
  if (resume && exists) {
    if (!fs.existsSync(jsonl)) fs.writeFileSync(jsonl, '');
  } else {
    fs.writeFileSync(out, '﻿' + csvLine(columns));
    fs.writeFileSync(jsonl, '');
  }
  const todo = rows.filter((r) => !(r.store_id && done.has(r.store_id)));
  const total = todo.length;
  const cache = new Map(); // domain -> Promise<{scanResult}|{error}>
  const stats = { total, done: 0, send: 0, errors: 0, skipped: rows.length - total };
  const started = Date.now();
  let next = 0;

  async function check(url) {
    try { return { res: await scan(url) }; }
    catch (e) { return { error: e && e.userSafe ? e.message : '診断できませんでした' }; }
  }

  const seqOf = new Map(todo.map((r, i) => [r, i]));

  async function processRow(row) {
    const rec = { ...row, domain: '', grade: '', score: '', results: null, error: '', findingType: '', 指摘: '', 困ること: '', send: false, body: '', b2b: null, reason: '' };
    let url = row.url;
    if (!url) rec.error = 'URLなし';
    else {
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
      try { rec.domain = domainOf(url); } catch (_) { rec.error = 'URLが不正です'; }
    }
    if (!rec.error) {
      if (!cache.has(rec.domain)) cache.set(rec.domain, check(url));
      const r = await cache.get(rec.domain);
      if (r.error) rec.error = r.error;
      else {
        const { results, grade, score } = r.res;
        rec.results = results; rec.grade = grade; rec.score = score;
        if (b2b) {
          // 件名の巡回は store_id(数字なら)、なければ処理順。どちらでも同じ入力なら同じ結果
          const idNum = /^\d+$/.test(String(row.store_id || '')) ? Number(row.store_id) : seqOf.get(row);
          rec.b2b = buildB2bMessage(templates, {
            name: row.name, category: row.category, domain: rec.domain, results, scannedAt: new Date(), seq: idNum, subjectNo: subject, maxChars,
          });
          rec.findingType = rec.b2b.findingType; rec['指摘'] = rec.b2b.指摘; rec['困ること'] = rec.b2b.困ること;
          rec.send = rec.b2b.send; rec.reason = rec.b2b.reason; rec.body = rec.b2b.body;
        } else {
        rec.findingType = pickFinding(results) || '';
        rec.send = shouldSend(grade, rec.findingType);
        const f = (templates.findings || {})[rec.findingType];
        if (f) { rec['指摘'] = f['指摘']; rec['困ること'] = f['困ること']; }
        if (rec.send) {
          const region = templateMode === 'west' || templateMode === 'east' ? templateMode : regionOf(row.prefecture);
          rec.body = fillTemplate(templates[region], {
            ...(templates.config || {}), 会社名: row.name, ドメイン: rec.domain, 指摘: rec['指摘'], 困ること: rec['困ること'],
          });
        }
        }
      }
    }
    rec.scannedAt = jstNow();
    const byKey = {};
    for (const x of rec.results || []) byKey[x.key] = x.status;
    const items = ITEM_KEYS.map((k) => (byKey[k] ? JUDGE[byKey[k]] : ''));
    let sendCell = rec.send ? 'はい' : 'いいえ';
    let extra = [];
    if (b2b) {
      if (!rec.send) sendCell = '送らない' + (rec.error ? ':診断できず' : rec.reason ? ':' + rec.reason : '');
      const m = rec.b2b;
      extra = [m ? m.industry : '', m ? m.subject : '', m ? m.length : '', m ? m.shortBody : '', m ? m.use : '',
        row.formUrl || '', row.captcha || '', row.noSales || ''];
    }
    fs.appendFileSync(out, csvLine([
      row.store_id, row.name, row.prefecture, row.category, row.url, rec.domain, rec.grade, rec.score, ...items,
      rec.findingType, rec['指摘'], rec['困ること'], sendCell, rec.body, rec.error, rec.scannedAt, ...extra,
    ]));
    fs.appendFileSync(jsonl, JSON.stringify({
      store_id: row.store_id, name: row.name, prefecture: row.prefecture, category: row.category, url: row.url, domain: rec.domain,
      grade: rec.grade, score: rec.score, findingType: rec.findingType, send: rec.send, error: rec.error, scannedAt: rec.scannedAt,
      results: rec.results,
    }) + '\n');
    stats.done++;
    if (rec.send) stats.send++;
    if (rec.error) stats.errors++;
    if (stats.done % 20 === 0) {
      const mins = Math.ceil(((Date.now() - started) / stats.done) * (total - stats.done) / 60000);
      say(`[${stats.done}/${total}] 送信推奨 ${stats.send}件 / エラー ${stats.errors}件 / 残り約${mins}分`);
    }
  }

  async function worker() {
    while (next < todo.length && !stopRequested && !(isStopped && isStopped())) {
      await processRow(todo[next++]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return stats;
}

/* ---------- CLI ---------- */

function parseArgs(argv) {
  const a = { concurrency: 5, template: 'auto', resume: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--in') a.in = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--concurrency') a.concurrency = parseInt(argv[++i], 10) || 5;
    else if (k === '--limit') a.limit = parseInt(argv[++i], 10);
    else if (k === '--template') a.template = argv[++i];
    else if (k === '--group-out') a.groupOut = argv[++i];
    else if (k === '--merge-tags') a.mergeTags = argv[++i];
    else if (k === '--resume') a.resume = true;
    else if (k === '--source') a.source = argv[++i];
    else if (k === '--prefecture') a.prefecture = argv[++i];
    else if (k === '--main-category') a.mainCategory = argv[++i];
    else if (k === '--exclude-large') a.excludeLarge = true;
    else if (k === '--small-only') a.smallOnly = true;
    else if (k === '--form-found') a.formFound = true;
    else if (k === '--subject') a.subject = parseInt(argv[++i], 10);
    else if (k === '--max-chars') a.maxChars = parseInt(argv[++i], 10) || 0;
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const fromWh = a.source === 'warehouse';
  // --group-out(b2bのみ)があれば --out は省略可。省略時は <group-out>/scan_all.csv に全件の診断結果を書く
  if (a.groupOut && !a.out && a.template === 'b2b') a.out = path.join(a.groupOut, 'scan_all.csv');
  if ((!a.in && !fromWh) || !a.out || (a.groupOut && a.template !== 'b2b') || !['west', 'east', 'auto', 'b2b'].includes(a.template) || (a.source && !fromWh)
    || (a.subject !== undefined && !(a.subject >= 1 && a.subject <= 3))) {
    console.error('使い方: node cli/batch-scan.js (--in list.tsv | --source warehouse --prefecture 兵庫県 [--main-category 製造,建設] [--exclude-large|--small-only] [--form-found])\n'
      + '        --out result.csv [--group-out dir(b2bのみ。--outは省略可)] [--concurrency 5] [--limit N] [--template west|east|auto|b2b] [--subject 1-3] [--max-chars N] [--resume]');
    process.exit(2);
  }
  let mergeTags;
  if (a.mergeTags !== undefined) {
    try {
      mergeTags = JSON.parse(a.mergeTags);
      if (!mergeTags || typeof mergeTags !== 'object' || Array.isArray(mergeTags) || !Object.values(mergeTags).every((v) => typeof v === 'string')) throw new Error('形式不正');
    } catch {
      console.error('--merge-tags は {"会社名":"%company%","ドメイン":"%domain%"} のようなJSONで指定してください。');
      process.exit(2);
    }
  }
  let rows;
  if (fromWh) rows = await loadWarehouseRows(a);
  else {
    rows = parseInputBuffer(fs.readFileSync(a.in));
    if (a.limit > 0) rows = rows.slice(0, a.limit);
  }
  fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true });
  process.on('SIGINT', () => {
    if (stopRequested) process.exit(130);
    stopRequested = true;
    console.error('中断要求を受け付けました。実行中の分が終わり次第終了します(もう一度Ctrl+Cで強制終了)。');
  });
  const stats = await runBatch({
    rows, scan: scanOne, out: a.out, templates: loadTemplates(), concurrency: a.concurrency, templateMode: a.template, resume: a.resume,
    subject: a.subject, maxChars: a.maxChars,
  });
  if (a.groupOut) {
    // 再開(--resume)分も含めて、出力CSV全体からグループを作る
    const table = parseDelimited(fs.readFileSync(a.out, 'utf8'), ',');
    const head = table[0] || [];
    const recs = table.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] || ''])));
    const g = writeGroupFiles(a.groupOut, recs, loadTemplates(), new Date(), mergeTags);
    console.error(`グループ出力: ${a.groupOut} に ${g.files.length}ファイル(グループ ${g.summary.length}個 / 送らない ${g.excludedTotal}社)。まとめ.txt を確認してください。`);
  }
  console.error(`完了: ${stats.done}件処理 / 送信推奨 ${stats.send}件 / エラー ${stats.errors}件 / 再開でスキップ ${stats.skipped}件`);
}

module.exports = { runBatch, parseInput, parseInputBuffer, buildWarehouseQuery, parseArgs, main, B2B_COLUMNS, parseDelimited, csvField, csvLine, scanOne, COLUMNS };

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
