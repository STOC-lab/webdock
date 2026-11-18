'use strict';
/**
 * 見本ページの作成(管理画面の「見本ページ → 見本を作る」と同じ処理)。
 *
 *   node cli/sample-pages.js --ids-file ids.txt --label 兵庫_健康系_20261118 [--out sample_hyogo.csv]
 *   node cli/sample-pages.js --csv visit_list.csv --label 兵庫_健康系_20261118 [--out sample_hyogo.csv]
 *
 * --ids-file : 倉庫IDを並べたテキスト(改行・カンマ・スペース区切り)
 * --csv      : 1行目に「倉庫ID」の見出しがあるCSV。その列の右に「見本コード」「見本URL」を足して出力する
 * --out      : 出力するCSV(省略時は sample_<label>.csv)。UTF-8(BOM付き)
 * 倉庫DB(WH_DB_*)が必要。同じ店の見本がすでにあれば作り直さず、既存のコードを使う。
 * 見本のURLは SAMPLE_BASE_URL で変えられる(未設定なら https://webdock.stoc-plus.site/s/<コード>)。
 */
const fs = require('fs');
const path = require('path');
try { require('dotenv').config(); } catch { /* dotenv任意 */ }
const wh = require('../src/warehouse');
const SP = require('../src/samplePages');
const { REASON } = require('../src/adminSamples');

const USAGE = '使い方: node cli/sample-pages.js (--ids-file ids.txt | --csv list.csv) --label リストの名前 [--out 出力.csv]';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { if (i + 1 >= argv.length) return (a.error = `${k} の値がありません。`, ''); return argv[++i]; };
    if (k === '--ids-file') a.idsFile = v();
    else if (k === '--csv') a.csv = v();
    else if (k === '--label') a.label = v();
    else if (k === '--out') a.out = v();
    else if (k === '-h' || k === '--help') a.help = true;
    else a.error = `知らない引数です: ${k}`;
  }
  if (!a.help && !a.error) {
    if (!a.idsFile === !a.csv) a.error = '--ids-file か --csv のどちらか一方を指定してください。';
    else if (!a.label || /[\u0000-\u001f\u007f]/.test(a.label) || a.label.length > 100) a.error = '--label(リストの名前・100文字まで)を指定してください。';
  }
  return a;
}

/** 入力ファイルから { header, rows } を作る(管理画面と同じ読み方) */
function loadInput(a) {
  if (a.csv) {
    const text = wh.decodeBuffer(fs.readFileSync(a.csv));
    const rows = wh.parseDelimited(text, wh.detectDelimiter(text.split(/\r?\n/, 1)[0]));
    return SP.readCsvRows(rows);
  }
  const { ids, ignored } = SP.parseIdList(wh.decodeBuffer(fs.readFileSync(a.idsFile)));
  if (ignored) return { error: `数字ではない値が${ignored}個あります。倉庫IDだけを書いてください。` };
  if (!ids.length) return { error: '倉庫IDが見つかりませんでした。' };
  return { header: ['倉庫ID'], idCol: 0, rows: ids.map((id) => ({ cells: [id], id })) };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { console.log(USAGE); return; }
  if (a.error) { console.error('エラー: ' + a.error + '\n' + USAGE); process.exit(2); }
  const parsed = loadInput(a);
  if (parsed.error) { console.error('エラー: ' + parsed.error); process.exit(2); }
  const ids = [...new Set(parsed.rows.map((r) => r.id).filter(Boolean))];
  if (!ids.length) { console.error('エラー: 倉庫IDが1つも見つかりませんでした。'); process.exit(2); }
  if (ids.length > SP.MAX_IDS) { console.error(`エラー: 一度に作れるのは${SP.MAX_IDS}件までです(今回 ${ids.length}件)。ファイルを分けてください。`); process.exit(2); }
  const pool = require('./warehouse-import').makePool();
  try {
    const r = await SP.createStore(pool).createForShops(ids, a.label);
    const out = a.out || `sample_${a.label.replace(/[\\/:*?"<>|\s]/g, '_')}.csv`;
    fs.writeFileSync(path.resolve(out), SP.buildResultCsv(parsed, r.byId));
    console.log(`リスト「${a.label}」: ${ids.length}件 → 新規作成 ${r.created} / すでにあった ${r.existing} / 作らなかった ${r.skipped.length}`);
    for (const s of r.skipped.slice(0, 50)) console.log(`  作らなかった: 倉庫ID ${s.id} ${s.name || ''} … ${REASON[s.reason]}`);
    if (r.skipped.length > 50) console.log(`  ほか ${r.skipped.length - 50}件`);
    console.log('CSV: ' + path.resolve(out));
  } finally { await pool.end(); }
}

module.exports = { parseArgs, loadInput };
if (require.main === module) main().catch((e) => { console.error(e && e.userSafe ? 'エラー: ' + e.message : e); process.exit(1); });
