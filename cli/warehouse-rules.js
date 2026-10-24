'use strict';

/**
 * リスツールの設定(.listt)から除外ルールJSONを作る
 *   node cli/warehouse-rules.js --from rules/source/GMAPSTOC.listt --name 問い合わせ営業
 * → rules/<name>.json
 */

const fs = require('fs');
const path = require('path');
const { parseListt } = require('../src/rules');

function parseArgs(argv) {
  const o = { from: null, name: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') o.from = argv[++i];
    else if (argv[i] === '--name') o.name = argv[++i];
    else throw new Error('不明なオプション: ' + argv[i]);
  }
  if (!o.from || !o.name) throw new Error('--from <.listt> と --name <ルール名> を指定してください');
  if (/[\\/]/.test(o.name)) throw new Error('--name にパス区切りは使えません');
  return o;
}

function build(from) {
  const r = parseListt(fs.readFileSync(from, 'utf8'));
  const counts = {};
  for (const k of Object.keys(r.exclude)) counts[k] = r.exclude[k].length;
  for (const k of Object.keys(r.other)) counts['other:' + k] = r.other[k].length;
  return {
    meta: { source_file: path.basename(from), generated_at: new Date().toISOString(), counts, ignored_count: r.ignored.length },
    replace: r.replace,
    dedupeColumns: r.dedupeColumns,
    exclude: r.exclude,
    other: r.other,
    excludeEmpty: r.excludeEmpty,
    ignored: r.ignored,
  };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const json = build(o.from);
  const dest = path.join(__dirname, '..', 'rules', o.name + '.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(json, null, 2) + '\n');
  console.log(`書き出し: ${dest}`);
  console.log('除外キーワード数: ' + Object.entries(json.meta.counts).map(([k, v]) => `${k}=${v}`).join(' '));
  console.log('置換: ' + json.replace.map((x) => `${x.column} ${x.regex ? '/' + x.from + '/' : x.from} -> "${x.to}"`).join('; '));
  console.log('重複除去列: ' + (json.dedupeColumns.join(',') || 'なし'));
  console.log(`無視した値: ${json.ignored.length}件` + json.ignored.map((x) => ` [${x.column}:${JSON.stringify(x.value)}:${x.reason}]`).join(''));
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('エラー: ' + e.message); process.exit(1); }
}

module.exports = { parseArgs, build };
