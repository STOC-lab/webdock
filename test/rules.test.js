'use strict';
const fs = require('fs');
const path = require('path');
const { parseListt, compileRules } = require('../src/rules');
const { globToRegExp } = require('../cli/warehouse-import');
const { build } = require('../cli/warehouse-rules');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);

const SRC = path.join(__dirname, '..', 'rules', 'source', 'GMAPSTOC.listt');
const r = parseListt(fs.readFileSync(SRC, 'utf8'));

// --- 実ファイルの解析 ---
ok(r.exclude.name.length > 100, 'name keywords count ' + r.exclude.name.length);
for (const k of ['ダイワハウス', '積水ハウス', '警察', '店']) ok(r.exclude.name.includes(k), 'name has ' + k);
for (const k of ['役所', '郵便局']) ok(r.exclude.category.includes(k), 'category has ' + k);
ok(r.exclude.website.includes('instagram'), 'website has instagram');
ok(r.exclude.phone.includes('0078'), 'phone has 0078');
ok(r.exclude.name.concat(r.exclude.category).includes('B&B'), 'B&B decoded from &amp;');
ok(!r.exclude.name.some((k) => k.includes('&amp;')), 'no raw entities');
ok(r.exclude.name.includes('SS ') && r.exclude.name.includes('カーブス '), 'trailing spaces kept');
eq(r.ignored.length, 1, 'one ignored whitespace-only value (業種); the 電話番号 one means 電話番号なしを除外');
ok(r.ignored.every((x) => x.value.trim() === ''), 'ignored are whitespace-only');
ok(Object.values(r.exclude).every((l) => l.length === new Set(l).size), 'no duplicate keywords');
ok(Object.values(r.exclude).every((l) => l.every((k) => k.trim() !== '' && !/[\r\n]$/.test(k))), 'no empty / CRLF-terminated keywords');
eq(Object.keys(r.other), [], 'no unknown columns');
eq(r.replace, [{ column: '業種', from: '、.*', to: '', regex: true }], 'replace rule');
eq(r.dedupeColumns, ['電話番号'], 'dedupe column');

// --- 小さなXML ---
const mini = parseListt(`<x><option_filter_columns>
<column><out_column_name>屋号</out_column_name><filter>A&amp;B&lt;</filter><type>1</type></column>
<column><out_column_name>屋号</out_column_name><filter>A&amp;B&lt;</filter><type>1</type></column>
<column><out_column_name>屋号</out_column_name><filter> \r\n </filter><type>1</type></column>
<column><out_column_name>謎</out_column_name><filter>zz</filter><type>1</type></column>
</option_filter_columns></x>`);
eq(mini.exclude.name, ['A&B<'], 'entities + dedupe');
eq([mini.other, mini.ignored.length, mini.dedupeColumns], [{ '謎': ['zz'] }, 1, []], 'unknown column under other');

// --- 判定 ---
const check = compileRules(r);
const row = (o) => ({ name: 'ふつうの美容室', category_main: '美容院', website_url: '', phone: '078-000-0000', ...o });
eq(check(row({})), null, 'normal row kept');
eq(check(row({ name: 'ダイワハウス 神戸' })), { column: '屋号', keyword: 'ダイワハウス' }, 'name keyword');
eq(check(row({ name: 'ダイワハウス 神戸営業所' })).column, '屋号', 'name with 営業所 excluded (first match may be 営業)');
// リスツールと同じ挙動: 屋号キーワード「店」を含む名前はすべて除外される(例: ○○工務店)
eq(check(row({ name: '山田工務店' })), { column: '屋号', keyword: '店' }, '工務店 excluded by "店" (mirrors the tool)');
eq(check(row({ category_main: '役所' })).column, '業種', 'category 役所 excluded');
// 業種は先頭の1つだけで判定(置換が先に走るため)
eq(check(row({ category_main: '美容院' /* 全体: 美容院、カフェ */ })), null, 'first category 美容院 kept even if later category is cafe');
eq(check(row({ website_url: 'https://www.instagram.com/foo' })), { column: '登録URL', keyword: 'instagram' }, 'instagram url');
eq(check(row({ phone: '0078-12-3456' })), { column: '電話番号', keyword: '0078' }, 'phone 0078');
eq((check(row({ name: null, category_main: null, website_url: null, phone: null })) || {}).keyword, '(空欄)', 'no phone -> excluded (電話番号なしを除外)');
eq(check(row({ name: null, category_main: null, website_url: null, phone: '079-000-0000' })), null, 'other nulls kept');
eq(compileRules({ exclude: { name: ['SS '] } })({ name: 'ss x' }), null, 'case-sensitive');
eq(compileRules({ exclude: { name: ['SS '] } })({ name: 'SS x' }).keyword, 'SS ', 'trailing-space keyword matches');
eq(compileRules({ exclude: { name: ['SS '] } })({ name: 'SSx' }), null, 'trailing-space keyword needs the space');

// --- 保存済みJSONが.listtと一致 ---
const saved = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules', '問い合わせ営業.json'), 'utf8'));
const fresh = build(SRC);
eq([saved.exclude, saved.replace, saved.dedupeColumns, saved.ignored], [fresh.exclude, fresh.replace, fresh.dedupeColumns, fresh.ignored], 'rules/問い合わせ営業.json is up to date');
eq(saved.meta.source_file, 'GMAPSTOC.listt', 'meta source');

// --- glob ---
const g = globToRegExp('gmp_*.csv');
eq([g.test('gmp_長崎県_20261016-101752.csv'), g.test('GMP_a.CSV'), g.test('nagasaki.csv'), g.test('xgmp_a.csv'), g.test('gmp_a.csvx')], [true, true, false, false, false], 'glob');
eq(globToRegExp('a?.csv').test('ab.csv') && !globToRegExp('a?.csv').test('a.csv') && !globToRegExp('a.csv').test('abcsv'), true, 'glob ? and dot escaped');

// ---- 上書き設定(社内判断): 「店」を外す / 電話番号なしを除外 ----
{
  const { parseListt: pl, compileRules: cr, applyOverrides: ao } = require('../src/rules');
  const base = pl(require('fs').readFileSync(require('path').join(__dirname, '..', 'rules', 'source', 'GMAPSTOC.listt'), 'utf8'));
  eq(base.excludeEmpty.phone, true, 'listt: 電話番号の空白条件は「電話番号なしを除外」');
  const ov = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'rules', '問い合わせ営業.overrides.json'), 'utf8'));
  const c2 = cr(ao(base, ov));
  eq(c2({ name: '山田工務店', category_main: '工務店', phone: '079-000-0000' }), null, 'override: 工務店は残る(「店」を外した)');
  eq((c2({ name: '山田工務店', category_main: '工務店', phone: '' }) || {}).keyword, '(空欄)', '電話番号なしは除外');
  eq((c2({ name: 'ダイワハウス 神戸営業所', category_main: '住宅', phone: '078' }) || {}).column, '屋号', '営業所は引き続き除外');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
