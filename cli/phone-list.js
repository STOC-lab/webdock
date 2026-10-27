'use strict';
/**
 * 電話営業リスト
 * 倉庫(stoc_master.shops)のURLあり店舗 → WEBドック診断で点数 → 点数が範囲内のサイトだけ「ブログ/お知らせ/新着情報/NEWS」の最終更新日を調べる
 * → 直近N日以内に更新があった会社を、電話営業用のCSVに出す。
 *
 * node cli/phone-list.js --prefecture 兵庫県[,大阪府] [--main-category 製造,建設] [--exclude-large|--small-only]
 *      [--min-score 50] [--max-score 70] [--days 7] [--limit 3000] [--concurrency 5]
 *      --out exports/phone_list_YYYYMMDD-HHmmss.csv [--resume]
 * (WH_DB_* が必要。診断の記録は <out>.jsonl に追記され、--resume で続きから再開できます)
 */
const fs = require('fs');
const path = require('path');
const { PREFECTURES } = require('../src/regions');
const EX = require('../src/exclusions');
const { loadWarehouseRows, selectForScan, scanOne, csvLine } = require('./batch-scan');
const { detectLatestPost, toJstDate, daysAgo } = require('../src/freshness');

const COLUMNS = ['会社名', '電話番号', '住所', '都道府県', '業種', 'URL', '点数', '評価', '主な指摘', '最終更新日', '何日前', '更新の根拠', '記事URL', '記事タイトル', 'store_id', '診断日時'];
const SOURCE_LABEL = { rss: 'RSS', wordpress: 'WordPress投稿', news_page: 'お知らせページ', top_page: 'トップページ', sitemap: 'サイトマップ' };
const USAGE = '使い方: node cli/phone-list.js --prefecture 兵庫県[,大阪府] [--main-category 製造,建設] [--exclude-large|--small-only]\n'
  + '        [--min-score 50] [--max-score 70] [--days 7] [--limit 3000] [--concurrency 5] --out exports/phone_list_YYYYMMDD-HHmmss.csv [--resume]';

/* ---------- 引数 ---------- */

/** 引数を読む。不正なら { error } を含めて返す(終了はしない。main が使い方を出して止める) */
function parseArgs(argv) {
  const a = { minScore: 50, maxScore: 70, days: 7, limit: 3000, concurrency: 5, resume: false, excludeLarge: false, smallOnly: false };
  const intOpt = (name, v, min, max) => {
    if (v === undefined || !/^\d+$/.test(String(v).trim())) return `${name} は整数で指定してください。`;
    const n = Number(v);
    if (n < min || n > max) return `${name} は ${min}〜${max} の範囲で指定してください。`;
    return n;
  };
  const fail = (m) => ({ ...a, error: m });
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const takeNum = (prop, min, max) => {
      const r = intOpt(k, argv[++i], min, max);
      if (typeof r === 'string') return r;
      a[prop] = r; return null;
    };
    let err = null;
    if (k === '--prefecture') a.prefecture = argv[++i];
    else if (k === '--main-category') a.mainCategory = argv[++i];
    else if (k === '--exclude-large') a.excludeLarge = true;
    else if (k === '--small-only') a.smallOnly = true;
    else if (k === '--min-score') err = takeNum('minScore', 0, 100);
    else if (k === '--max-score') err = takeNum('maxScore', 0, 100);
    else if (k === '--days') err = takeNum('days', 1, 365);
    else if (k === '--limit') err = takeNum('limit', 1, 1000000);
    else if (k === '--concurrency') err = takeNum('concurrency', 1, 20);
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--resume') a.resume = true;
    else return fail(`知らない指定です: ${k}`);
    if (err) return fail(err);
  }
  const prefs = String(a.prefecture || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!prefs.length) return fail('--prefecture は必須です(例: 兵庫県)。');
  if (prefs.some((p) => !PREFECTURES.includes(p))) return fail('都道府県の指定が正しくありません。');
  a.prefecture = prefs.join(',');
  if (a.mainCategory !== undefined && !String(a.mainCategory).trim()) a.mainCategory = undefined;
  if (a.minScore > a.maxScore) return fail('--min-score は --max-score 以下にしてください。');
  if (a.excludeLarge && a.smallOnly) return fail('--exclude-large と --small-only は同時に指定できません。');
  if (!a.out) return fail('--out は必須です。');
  return a;
}

/* ---------- 下ごしらえ ---------- */

const digitsOf = (s) => String(s || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\D/g, '');

/** 電話番号が空の行を除き、同じ電話番号(数字だけ)は最初の1件だけ残し、最後に limit。戻り: { rows, noPhone, dup } */
function preparePhoneRows(rows, limit = 0) {
  const seen = new Set();
  const out = [];
  let noPhone = 0, dup = 0;
  for (const r of rows) {
    const d = digitsOf(r.phone);
    if (!d) { noPhone++; continue; }
    if (seen.has(d)) { dup++; continue; }
    seen.add(d);
    out.push(r);
  }
  return { rows: limit > 0 ? out.slice(0, limit) : out, noPhone, dup };
}

/** 主な指摘: 悪い(bad)を先、次に注意(warn)の項目名を最大2つ「・」でつなぐ */
function mainFindings(results) {
  const list = Array.isArray(results) ? results : [];
  const pick = (st) => list.filter((x) => x && x.status === st && x.title).map((x) => x.title);
  return [...pick('bad'), ...pick('warn')].slice(0, 2).join('・');
}

function domainOf(url) {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}

function jstNow(now = new Date()) {
  const t = new Date(now.getTime() + 9 * 3600e3).toISOString();
  return `${t.slice(0, 10)} ${t.slice(11, 16)}`;
}

function readRecords(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line); if (j && typeof j === 'object') out.push(j); } catch { /* 壊れた行は読み飛ばす */ }
  }
  return out;
}

/** 記録(jsonl)の該当行だけを、最終更新日の新しい順に並べてCSVにする。戻り: 該当件数 */
function writeCsv(out, records) {
  const hits = records.filter((r) => r.hit);
  hits.sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : (Number(a.score) || 0) - (Number(b.score) || 0)));
  let text = '﻿' + csvLine(COLUMNS);
  for (const r of hits) {
    text += csvLine([r.name, r.phone, r.address || '', r.prefecture || '', r.category || '', r.url, r.score, r.grade, r.findings || '',
      r.latest, r.daysAgo, SOURCE_LABEL[r.source] || '', r.postUrl || '', r.postTitle || '', r.store_id, r.scannedAt]);
  }
  fs.writeFileSync(out, text);
  return hits.length;
}

/* ---------- 本体 ---------- */

let stopRequested = false;

/**
 * rows: 倉庫から選んだ行(電話番号の除外・重複除去・limit はここで行う)
 * scan(url) → {results, grade, score} / detect(url, {now}) → detectLatestPost の戻り値。テストでは偽物を渡す
 */
async function runPhoneList({ rows, scan = scanOne, detect = detectLatestPost, out, minScore = 50, maxScore = 70, days = 7, limit = 0,
  concurrency = 5, resume = false, isStopped, log, now = () => new Date() }) {
  const say = log || ((m) => process.stderr.write(m + '\n'));
  const prep = preparePhoneRows(rows, limit);
  say(`電話番号が空の店を除外: ${prep.noPhone}件 / 同じ電話番号の重複を除外: ${prep.dup}件 → 診断対象 ${prep.rows.length}社`);
  const jsonl = out + '.jsonl';
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  let done = new Set();
  if (resume && fs.existsSync(jsonl)) {
    done = new Set(readRecords(jsonl).map((r) => String(r.store_id)).filter((x) => x && x !== 'undefined' && x !== ''));
  } else {
    fs.writeFileSync(jsonl, '');
  }
  const todo = prep.rows.filter((r) => !(r.store_id && done.has(String(r.store_id))));
  const total = todo.length;
  const stats = { total, done: 0, inRange: 0, hits: 0, unknown: 0, errors: 0, skipped: prep.rows.length - total };
  const scanCache = new Map();   // ドメイン -> Promise<{res}|{error}>
  const detectCache = new Map(); // ドメイン -> Promise<detect結果|null>
  const started = Date.now();
  let next = 0;

  async function check(url) {
    try { return { res: await scan(url) }; } catch (e) { return { error: e && e.userSafe ? e.message : '診断できませんでした' }; }
  }

  async function processRow(row) {
    const rec = {
      store_id: row.store_id, name: row.name, phone: row.phone, address: row.address || '', prefecture: row.prefecture || '', category: row.category || '',
      url: row.url, domain: '', score: null, grade: '', findings: '', inRange: false, hit: false, latest: '', daysAgo: null, source: '', postUrl: '', postTitle: '',
      note: '', error: '', scannedAt: '',
    };
    let url = row.url;
    if (!url) rec.error = 'URLなし';
    else {
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
      try { rec.domain = domainOf(url); } catch { rec.error = 'URLが不正です'; }
    }
    if (!rec.error) {
      if (!scanCache.has(rec.domain)) scanCache.set(rec.domain, check(url));
      const r = await scanCache.get(rec.domain);
      if (r.error) rec.error = r.error;
      else {
        rec.score = typeof r.res.score === 'number' ? r.res.score : null;
        rec.grade = r.res.grade || '';
        rec.findings = mainFindings(r.res.results);
        rec.inRange = rec.score !== null && rec.score >= minScore && rec.score <= maxScore;
      }
    }
    if (rec.inRange) {
      // 範囲内のサイトだけ更新日を調べる
      if (!detectCache.has(rec.domain)) detectCache.set(rec.domain, Promise.resolve().then(() => detect(url, { now: now() })).catch(() => null));
      const d = await detectCache.get(rec.domain);
      if (!d) rec.note = '更新日を調べられませんでした';
      else {
        rec.note = d.note || '';
        if (d.date) {
          rec.latest = toJstDate(d.date);
          rec.daysAgo = Math.max(0, daysAgo(d.date, now()));
          rec.source = d.source || '';
          rec.postUrl = d.url || '';
          rec.postTitle = d.title || '';
          rec.hit = daysAgo(d.date, now()) <= days;
        }
      }
    }
    rec.scannedAt = jstNow(now());
    fs.appendFileSync(jsonl, JSON.stringify(rec) + '\n');
    stats.done++;
    if (rec.error) stats.errors++;
    if (rec.inRange) { stats.inRange++; if (!rec.latest) stats.unknown++; }
    if (rec.hit) stats.hits++;
    if (stats.done % 20 === 0) {
      const mins = Math.ceil(((Date.now() - started) / stats.done) * (total - stats.done) / 60000);
      say(`[${stats.done}/${total}] 範囲内 ${stats.inRange}件 / 該当 ${stats.hits}件 / エラー ${stats.errors}件 / 残り約${mins}分`);
    }
  }

  async function worker() {
    while (next < todo.length && !stopRequested && !(isStopped && isStopped())) {
      await processRow(todo[next++]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  // 再開分も含めて、記録全体からCSVを作る
  const all = readRecords(jsonl);
  const hitCount = writeCsv(out, all);
  const unknownAll = all.filter((r) => r.inRange && !r.latest).length;
  const scannedAll = all.filter((r) => !r.error).length;
  const inRangeAll = all.filter((r) => r.inRange).length;
  say(`完了: 診断 ${scannedAll}件 / ${minScore}〜${maxScore}点 ${inRangeAll}件 / ${days}日以内に更新 ${hitCount}件 → ${out}`);
  say(`更新日が分からなかった: ${unknownAll}件 / エラー: ${all.filter((r) => r.error).length}件 / 再開でスキップ ${stats.skipped}件`);
  return { ...stats, scannedAll, inRangeAll, hitCount, unknownAll, csv: out };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.error) {
    console.error('エラー: ' + a.error + '\n' + USAGE);
    process.exit(2);
  }
  const loaded = await loadWarehouseRows(a);
  const ctx = { excludeList: EX.loadExcludeDomains(), chainHosts: loaded.chain.hosts };
  const sel = selectForScan(loaded.rows, ctx, 0); // 件数の上限は、電話番号の整理のあとにかける
  const pre = { ...sel.counts };
  if (loaded.claimExcluded) pre[EX.REASON.claim] = loaded.claimExcluded;
  console.error('診断前に除外: ' + (Object.entries(pre).map(([k, n]) => `${k} ${n}`).join(' / ') || 'なし') + ` → 候補 ${sel.rows.length}社`);
  process.on('SIGINT', () => {
    if (stopRequested) process.exit(130);
    stopRequested = true;
    console.error('中断要求を受け付けました。実行中の分が終わり次第終了します(もう一度Ctrl+Cで強制終了)。--resume で続きから再開できます。');
  });
  await runPhoneList({
    rows: sel.rows, out: a.out, minScore: a.minScore, maxScore: a.maxScore, days: a.days, limit: a.limit, concurrency: a.concurrency, resume: a.resume,
  });
}

module.exports = { parseArgs, main, runPhoneList, preparePhoneRows, mainFindings, COLUMNS };

if (require.main === module) main().catch((e) => { console.error(e && (e.claimCheck || e.stocCheck || e.pageCheck) ? 'エラー: ' + e.message : e); process.exit(1); });
