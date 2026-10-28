'use strict';
/**
 * GBP(Googleマップ)の更新日の読み取りを、本番VPSで確かめる調査ツール。
 * 1件ずつ開き(店舗の間に4〜8秒待ちます)、開いたURL・最終URL・確認画面か・見つけた見出し・抽出結果・判定に使った前後の文字列を表示し、
 * <out>/<cid>.png(スクリーンショット)と <out>/<cid>.txt(画面の本文全部)を保存します。
 * Playwright が必要です: npm i playwright && npx playwright install --with-deps chromium
 *
 *   node cli/gbp-debug.js --cid <cid> [--cid ...] [--place-id <id>] [--out /tmp/gbp-debug] [--headed]
 *   node cli/gbp-debug.js --jsonl <phone_list の jsonl> [--limit 5]     範囲内で GBP の識別子がある行から
 * 確認画面(/sorry/ など)が出たら、そこで止めます。
 */
const fs = require('fs');
const path = require('path');
const { createGbpChecker, gbpUrlOf, MISSING_PLAYWRIGHT } = require('../src/gbpActivity');

const USAGE = '使い方: node cli/gbp-debug.js --cid <cid> [--cid ...] [--place-id <id>] [--out /tmp/gbp-debug] [--headed]\n'
  + '        node cli/gbp-debug.js --jsonl <file> [--limit 5] [--out /tmp/gbp-debug]';

function parseArgs(argv) {
  const a = { cids: [], placeIds: [], jsonl: '', limit: 5, out: '/tmp/gbp-debug', headed: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--cid') a.cids.push(argv[++i] || '');
    else if (k === '--place-id') a.placeIds.push(argv[++i] || '');
    else if (k === '--jsonl') a.jsonl = argv[++i] || '';
    else if (k === '--out') a.out = argv[++i] || '';
    else if (k === '--headed') a.headed = true;
    else if (k === '--limit') {
      const v = argv[++i];
      if (!/^\d+$/.test(String(v)) || Number(v) < 1 || Number(v) > 200) return { ...a, error: '--limit は 1〜200 の整数で指定してください。' };
      a.limit = Number(v);
    } else return { ...a, error: `知らない指定です: ${k}` };
  }
  if (a.cids.some((c) => !/^\d+$/.test(c))) return { ...a, error: '--cid は数字だけで指定してください。' };
  if (!a.out) return { ...a, error: '--out が空です。' };
  if (!a.cids.length && !a.placeIds.length && !a.jsonl) return { ...a, error: '--cid / --place-id / --jsonl のどれかを指定してください。' };
  return a;
}

/** jsonl から、範囲内で GBP の識別子(cid / place_id / gmap_url)がある行を最大 limit 件 */
function rowsFromJsonl(file, limit) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r || !r.inRange) continue;
    const row = { store_id: r.store_id, name: r.name || '', cid: r.cid || '', placeId: r.placeId || '', gmapUrl: r.gmapUrl || '' };
    if (!gbpUrlOf(row)) continue;
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

const fmt = (x) => (x ? `${x.raw}(約 ${toYmd(x.date)} / ${x.approxDays}日前 / ${x.precision})` : '(なし)');
const toYmd = (d) => require('../src/freshness').toJstDate(d instanceof Date ? d : new Date(d));

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.error) { console.error('エラー: ' + a.error + '\n' + USAGE); process.exit(2); }
  let rows = [
    ...a.cids.map((cid) => ({ cid })),
    ...a.placeIds.map((placeId) => ({ placeId })),
  ];
  if (a.jsonl) rows = rows.concat(rowsFromJsonl(a.jsonl, a.limit));
  if (!rows.length) { console.error('調べる店がありません(jsonl に、範囲内で cid / place_id / gmap_url のある行がありません)。'); process.exit(1); }
  fs.mkdirSync(a.out, { recursive: true });
  const checker = createGbpChecker({ headless: !a.headed, debugDir: a.out, log: (m) => console.log(m) });
  process.on('SIGINT', () => { checker.stop(); console.error('中断します。ブラウザを閉じています...'); });
  let stopped = false;
  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      console.log(`\n===== ${i + 1}/${rows.length} ${row.name || ''} =====`);
      console.log('開くURL: ' + (gbpUrlOf(row) || '(なし)'));
      const r = await checker.check(row);
      const d = r.debug || {};
      console.log('最終URL: ' + (d.finalUrl || '(不明)'));
      console.log('確認画面: ' + (r.blocked ? 'はい(ここで止めます)' : 'いいえ') + ' / 読めた: ' + (r.ok ? 'はい' : 'いいえ') + (r.note ? ' / 注記: ' + r.note : ''));
      if (r.note === MISSING_PLAYWRIGHT || /起動できませんでした/.test(r.note)) { stopped = true; break; }
      console.log('開いたタブ: ' + ((d.tabs || []).join(' → ') || '(概要のみ)') + ' / 本文の文字数: ' + (d.textLength || 0));
      const h = d.headings || {};
      console.log('見つけた見出し: 返信=' + JSON.stringify(h.ownerReply || []) + ' 最新情報=' + JSON.stringify(h.post || []) + ' 口コミ=' + JSON.stringify(h.review || []));
      console.log('抽出: 投稿 ' + fmt(r.post) + ' / 返信 ' + fmt(r.ownerReply) + ' / 口コミ ' + fmt(r.review));
      const c = d.contexts || {};
      console.log('判定に使った前後の文字列:\n  投稿: ' + (c.post || '-') + '\n  返信: ' + (c.ownerReply || '-') + '\n  口コミ: ' + (c.review || '-'));
      if (d.files && d.files.png) console.log('保存: ' + d.files.png + ' / ' + d.files.txt);
      if (r.blocked) { stopped = true; break; }
    }
  } finally {
    await checker.close();
  }
  console.log(`\n保存先: ${path.resolve(a.out)}(<cid>.png と <cid>.txt)` + (stopped ? '\n途中で止まりました(上の注記を見てください)。' : ''));
}

module.exports = { parseArgs, rowsFromJsonl };

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
