'use strict';
/**
 * 一括診断(問い合わせ営業用)
 * node cli/batch-scan.js --in list.tsv --out result.csv [--concurrency 5] [--limit N] [--template west|east|auto] [--resume]
 */
const fs = require('fs');
const path = require('path');
const { JUDGE, pickFinding, shouldSend, regionOf, fillTemplate, loadTemplates } = require('../src/outreach');

const SCAN_TIMEOUT_MS = 45000;

const COLUMNS = ['store_id', '店名', '都道府県', '業種', 'URL', 'ドメイン', '判定', '点数', '証明書', 'https転送', '暗号方式',
  'ヘッダー', 'Cookie', '混在', 'CMS露出', 'JSライブラリ', '外部スクリプト', 'なりすまし対策', '指摘種別', '指摘', '困ること',
  '送信推奨', '本文', 'エラー', '診断日時'];
const ITEM_KEYS = ['cert', 'https_redirect', 'tls_version', 'headers', 'cookies', 'mixed', 'cms', 'js_libs', 'ext_scripts', 'mail'];

const ALIASES = {
  store_id: ['store_id', 'id', '店舗id'],
  name: ['name', '店名', '会社名', 'shop_name'],
  url: ['url', 'website_url', 'ウェブサイト'],
  prefecture: ['prefecture', '都道府県'],
  category: ['category', '業種'],
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
    prefecture: cell(r, 'prefecture'), category: cell(r, 'category'),
  }));
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

async function runBatch({ rows, scan, out, templates, concurrency = 5, templateMode = 'auto', resume = false, isStopped, log }) {
  const say = log || ((m) => process.stderr.write(m + '\n'));
  const jsonl = out + '.jsonl';
  const exists = fs.existsSync(out) && fs.statSync(out).size > 0;
  const done = resume && exists ? readDoneIds(out) : new Set();
  if (resume && exists) {
    if (!fs.existsSync(jsonl)) fs.writeFileSync(jsonl, '');
  } else {
    fs.writeFileSync(out, '﻿' + csvLine(COLUMNS));
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

  async function processRow(row) {
    const rec = { ...row, domain: '', grade: '', score: '', results: null, error: '', findingType: '', 指摘: '', 困ること: '', send: false, body: '' };
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
    rec.scannedAt = jstNow();
    const byKey = {};
    for (const x of rec.results || []) byKey[x.key] = x.status;
    const items = ITEM_KEYS.map((k) => (byKey[k] ? JUDGE[byKey[k]] : ''));
    fs.appendFileSync(out, csvLine([
      row.store_id, row.name, row.prefecture, row.category, row.url, rec.domain, rec.grade, rec.score, ...items,
      rec.findingType, rec['指摘'], rec['困ること'], rec.send ? 'はい' : 'いいえ', rec.body, rec.error, rec.scannedAt,
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
    else if (k === '--resume') a.resume = true;
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.in || !a.out || !['west', 'east', 'auto'].includes(a.template)) {
    console.error('使い方: node cli/batch-scan.js --in list.tsv --out result.csv [--concurrency 5] [--limit N] [--template west|east|auto] [--resume]');
    process.exit(2);
  }
  let rows = parseInput(fs.readFileSync(a.in, 'utf8'));
  if (a.limit > 0) rows = rows.slice(0, a.limit);
  fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true });
  process.on('SIGINT', () => {
    if (stopRequested) process.exit(130);
    stopRequested = true;
    console.error('中断要求を受け付けました。実行中の分が終わり次第終了します(もう一度Ctrl+Cで強制終了)。');
  });
  const stats = await runBatch({
    rows, scan: scanOne, out: a.out, templates: loadTemplates(), concurrency: a.concurrency, templateMode: a.template, resume: a.resume,
  });
  console.error(`完了: ${stats.done}件処理 / 送信推奨 ${stats.send}件 / エラー ${stats.errors}件 / 再開でスキップ ${stats.skipped}件`);
}

module.exports = { runBatch, parseInput, parseDelimited, csvField, csvLine, scanOne, COLUMNS };

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
