'use strict';
/**
 * 最終更新日の判定(src/freshness.js の detectLatestPost)の途中経過を見る調査ツール。
 * 「日付が見つからない」が多い・直近の更新が不自然に多い、といった原因を本番VPSで確かめる用。
 * 対象サイトへは通常の診断と同じ safeFetch 経由で取得する(フォーム送信などはしない)。
 *
 *   node cli/fresh-debug.js URL [URL...]
 *   node cli/fresh-debug.js --jsonl <file> --unknown [--limit 15]     範囲内なのに更新日が無かったサイト
 *   node cli/fresh-debug.js --jsonl <file> --hits [--days 90] [--limit 15]   範囲内で days 日以内のサイト(誤検知の確認)
 * 並列は2まで。最後に集計を出す。
 */
const fs = require('fs');
const { detectLatestPost, toJstDate } = require('../src/freshness');

const CONCURRENCY = 2;
const MAX_LINES = 40;
const USAGE = '使い方: node cli/fresh-debug.js URL [URL...]\n'
  + '        node cli/fresh-debug.js --jsonl <file> --unknown [--limit 15]\n'
  + '        node cli/fresh-debug.js --jsonl <file> --hits [--days 90] [--limit 15]';

function parseArgs(argv) {
  const a = { urls: [], jsonl: '', unknown: false, hits: false, days: 90, limit: 15 };
  const num = (name, v, min, max) => {
    if (v === undefined || !/^\d+$/.test(String(v))) return `${name} は整数で指定してください。`;
    const n = Number(v);
    return n < min || n > max ? `${name} は ${min}〜${max} の範囲で指定してください。` : n;
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--jsonl') a.jsonl = argv[++i] || '';
    else if (k === '--unknown') a.unknown = true;
    else if (k === '--hits') a.hits = true;
    else if (k === '--days' || k === '--limit') {
      const r = num(k, argv[++i], 1, 100000);
      if (typeof r === 'string') return { ...a, error: r };
      a[k.slice(2)] = r;
    } else if (k.startsWith('--')) return { ...a, error: `知らない指定です: ${k}` };
    else a.urls.push(k);
  }
  if (a.unknown && a.hits) return { ...a, error: '--unknown と --hits はどちらか一方にしてください。' };
  if ((a.unknown || a.hits) && !a.jsonl) return { ...a, error: '--unknown / --hits には --jsonl <file> が必要です。' };
  if (a.jsonl && !a.unknown && !a.hits) return { ...a, error: '--jsonl には --unknown か --hits を付けてください。' };
  if (!a.jsonl && !a.urls.length) return { ...a, error: 'URL か --jsonl を指定してください。' };
  return a;
}

function readRecords(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line); if (j && typeof j === 'object') out.push(j); } catch { /* 壊れた行は読み飛ばす */ }
  }
  return out;
}

/** jsonl から調査対象の url を取り出す */
function pickUrls(records, { unknown, hits, days, limit }) {
  const seen = new Set();
  const out = [];
  for (const r of records) {
    if (!r || !r.inRange || !r.url || seen.has(r.url)) continue;
    const ok = unknown ? !r.latest : hits ? (r.latest && typeof r.daysAgo === 'number' && r.daysAgo <= days) : false;
    if (!ok) continue;
    seen.add(r.url);
    out.push(r.url);
    if (out.length >= limit) break;
  }
  return out;
}

/** trace から集計用の分類を出す */
function classify(trace) {
  const result = trace.find((t) => t.step === 'result') || {};
  const fetchFailed = trace.some((t) => t.step === 'abort');
  const links = trace.find((t) => t.step === 'news_links');
  const noNewsLink = !fetchFailed && !!links && links.found === 0;
  const dateSteps = trace.filter((t) => t.step === 'unread');
  const datesFound = dateSteps.reduce((n, t) => n + (t.datesFound || 0), 0);
  const unread = new Set();
  for (const t of dateSteps) for (const e of t.examples || []) unread.add(e.pattern);
  const anyCand = trace.some((t) => t.step === 'candidate');
  const noDateAtAll = !fetchFailed && !result.date && datesFound === 0 && !anyCand && unread.size === 0;
  return { result, fetchFailed, noNewsLink, unreadPatterns: [...unread], noDateAtAll, datesFound };
}

/** trace を読みやすい日本語の行にする(最大 MAX_LINES 行) */
function formatTrace(url, trace) {
  const L = [];
  const cut = (s, n = 110) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  L.push('■ ' + url);
  const fetches = trace.filter((t) => t.step === 'fetch');
  L.push(`[取得 ${fetches.length}回]`);
  fetches.slice(0, 7).forEach((f) => L.push(`  ${f.ok ? 'OK' : 'NG'} ${f.status === null ? '---' : f.status} ${cut(f.url, 70)} ${f.bytes}B${f.reason ? ' 理由=' + f.reason : ''}${f.finalUrl && f.finalUrl !== f.url ? ' → ' + cut(f.finalUrl, 50) : ''}`));
  if (fetches.length > 7) L.push(`  …ほか${fetches.length - 7}回`);
  for (const t of trace) {
    if (t.step === 'abort') L.push('[中止] ' + t.reason);
    else if (t.step === 'wp') L.push(`[WordPress判定] ${t.isWp ? 'はい' : 'いいえ'}(${t.reason})`);
    else if (t.step === 'feed') L.push(`[フィード] ${t.url ? cut(t.url, 70) : 'なし'}(${t.reason}${t.sameSite === false ? '・別サイトのため見ない' : ''})`);
    else if (t.step === 'news_links') {
      L.push(`[ニュース系リンク] 採用${t.picked.length}件${t.picked.length ? '' : '(無し)'}`);
      t.picked.forEach((p) => L.push(`  採用: 「${p.label}」 ${cut(p.url, 80)}`));
      t.skipped.slice(0, 5).forEach((p) => L.push(`  除外: 「${p.label}」 ${cut(p.url, 60)} 理由=${p.reason}`));
      if (t.skipped.length > 5) L.push(`  除外…ほか${t.skipped.length - 5}件`);
    } else if (t.step === 'candidate') L.push(`[採用した日付] ${t.source} ${t.date} ${cut(t.context, 90)}`);
    else if (t.step === 'top_dates') {
      L.push(`[トップの日付] 読めた${t.datesFound}件 / キーワード無しで捨てた${t.droppedCount}件`);
      t.droppedNoKeyword.forEach((d) => L.push(`  捨てた: ${d.date} ${cut(d.context, 90)}`));
    } else if (t.step === 'unread') {
      L.push(`[読めなかった日付っぽい文字列] ${cut(t.url, 60)}(読めた日付 ${t.datesFound}件)${t.examples.length ? '' : ' なし'}`);
      t.examples.forEach((e) => L.push(`  ${e.pattern}: ${cut(e.context, 90)}`));
    } else if (t.step === 'sitemap') L.push(`[sitemap] URL${t.urlCount}件 / 条件に合う日付 ${t.matched ? 'あり' : 'なし'}`);
    else if (t.step === 'note') L.push('[メモ] ' + t.message);
  }
  const r = trace.find((t) => t.step === 'result') || {};
  L.push(`[結果] ${r.date ? `${r.date}(${r.source}) ${cut(r.url || '', 60)}` : '日付なし'}${r.note ? ' / ' + r.note : ''}`);
  if (L.length > MAX_LINES) { const n = L.length - (MAX_LINES - 2); return [...L.slice(0, MAX_LINES - 2), `  …(${n}行省略)`, L[L.length - 1]]; }
  return L;
}

/** 集計の行 */
function summaryLines(items) {
  const byPattern = {};
  let noNews = 0, failed = 0, noDate = 0;
  for (const c of items) {
    if (c.fetchFailed) failed++;
    if (c.noNewsLink) noNews++;
    if (c.noDateAtAll) noDate++;
    for (const p of c.unreadPatterns) byPattern[p] = (byPattern[p] || 0) + 1;
  }
  const L = [`集計(調査 ${items.length}サイト)`, `  取得失敗(トップが取れない): ${failed}件`, `  ニュース系リンクが無い: ${noNews}件`,
    `  日付がまったく無い(読めた日付も、読めない日付っぽい文字列も無い): ${noDate}件`, '  読めなかった日付パターン別(そのパターンを含むサイト数):'];
  const keys = Object.keys(byPattern).sort((a, b) => byPattern[b] - byPattern[a]);
  if (!keys.length) L.push('    (なし)');
  keys.forEach((k) => L.push(`    ${k}: ${byPattern[k]}件`));
  const hasResult = items.filter((c) => c.result.date).length;
  L.push(`  結果が出たサイト: ${hasResult}件 / 日付なし: ${items.length - hasResult}件`);
  return L;
}

async function investigate(url, { detect = detectLatestPost, now } = {}) {
  const trace = [];
  try { await detect(url, { trace, ...(now ? { now } : {}) }); } catch (e) { trace.push({ step: 'abort', reason: '例外: ' + (e && e.message) }); }
  return trace;
}

async function main(argv, { log = console.log, detect } = {}) {
  const a = parseArgs(argv);
  if (a.error) { log(a.error + '\n' + USAGE); return 2; }
  let urls = a.urls;
  if (a.jsonl) {
    if (!fs.existsSync(a.jsonl)) { log('jsonl が見つかりません: ' + a.jsonl); return 2; }
    urls = urls.concat(pickUrls(readRecords(a.jsonl), a));
    log(`${a.jsonl} から ${urls.length}件を調べます(${a.unknown ? '範囲内で更新日なし' : `範囲内で${a.days}日以内`}、上限${a.limit}件)`);
  }
  const items = [];
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      const trace = await investigate(url, { detect });
      items.push(classify(trace));
      log('\n' + '='.repeat(70) + '\n' + formatTrace(url, trace).join('\n')); // 1サイト分をまとめて出す
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  log('\n' + '='.repeat(70) + '\n' + summaryLines(items).join('\n'));
  return 0;
}

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });

module.exports = { parseArgs, pickUrls, classify, formatTrace, summaryLines, main };
