'use strict';
// 取り込み時の website_url の残し方(SQL 文字列と JS 判定 pickWebsiteUrl)のテスト
const { upsertSql, websiteReplaceCond, pickWebsiteUrl } = require('../cli/warehouse-import');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}

// [名前, 既存, 取り込み, 期待]
const CASES = [
  ['既存NULL → 取り込みを採用', null, 'https://a.com/', 'https://a.com/'],
  ["既存'' → 取り込み(http)を採用", '', 'http://a.com/', 'http://a.com/'],
  ['既存NULL・取り込みも空 → 空のまま', null, '', ''],
  ['既存NULL・取り込みNULL → 空のまま', null, null, null],
  ["既存''・取り込みNULL → 空のまま", '', null, null],
  ['既存http・取り込みhttps → 置き換え', 'http://a.com/', 'https://a.com/', 'https://a.com/'],
  ['ホストが違っても置き換える', 'http://old.com/', 'https://new.com/', 'https://new.com/'],
  ['大文字・前後空白でも判定できる', '  HTTP://A.com/ ', ' HTTPS://b.com/', ' HTTPS://b.com/'],
  ['既存https・取り込みhttp → 既存を残す', 'https://a.com/', 'http://a.com/', 'https://a.com/'],
  ['両方https・異なる → 既存を残す', 'https://a.com/', 'https://b.com/', 'https://a.com/'],
  ["既存http・取り込み'' → 既存を残す", 'http://a.com/', '', 'http://a.com/'],
  ['既存https・取り込みNULL → 既存を残す', 'https://a.com/', null, 'https://a.com/'],
  ['両方http・異なる → 既存を残す', 'http://a.com/', 'http://b.com/', 'http://a.com/'],
  ['既存http・取り込みがスキーム無し → 既存を残す', 'http://a.com/', 'a.com', 'http://a.com/'],
];

// JS の判定(全ケース)
for (const [n, e, i, want] of CASES) eq(pickWebsiteUrl(e, i), want, 'JS: ' + n);

// SQL 文字列
const cond = websiteReplaceCond();
eq(cond.includes("website_url IS NULL OR website_url = ''"), true, 'SQL: 既存が空の条件');
eq(cond.includes("LOWER(TRIM(website_url)) LIKE 'http://%'"), true, 'SQL: 既存httpの条件');
eq(cond.includes("LOWER(TRIM(VALUES(website_url))) LIKE 'https://%'"), true, 'SQL: 取り込みhttpsの条件');

const sql = upsertSql(1, true, true);
const sqlOld = upsertSql(1, true, false);
const wIdx = sql.indexOf('website_url = IF(');
const sIdx = sql.indexOf('site_host = IF(');
eq(sIdx > 0 && wIdx > sIdx, true, 'SQL: site_host の代入が website_url より前');
eq(sql.includes(`site_host = IF(${cond}, VALUES(site_host), site_host)`), true, 'SQL: site_host が website_url と同じ条件で連動');
eq(sql.includes(`website_url = IF(${cond}, VALUES(website_url), website_url)`), true, 'SQL: website_url の代入');
eq(sql.split('website_url = IF(').length - 1, 1, 'SQL: website_url の代入は1回だけ');
eq(sqlOld.includes('site_host'), false, 'SQL: site_host 列なしのときは site_host を書かない');
eq(sqlOld.includes(`website_url = IF(${cond}`), true, 'SQL: site_host 列なしでも website_url は同ルール');
// 他の列は fillIfEmpty のまま
for (const c of ['phone', 'category', 'address', 'gmap_url']) {
  eq(sql.includes(`${c} = IF(${c} IS NULL OR ${c} = '', VALUES(${c}), ${c})`), true, 'SQL: ' + c + ' は従来の fillIfEmpty');
}

// SQL の条件を実際に評価して JS と一致するか確認(node:sqlite があるときだけ。VALUES(website_url) は ? に置換)
let DB = null;
try { DB = require('node:sqlite').DatabaseSync; } catch (e) { /* なければ省略 */ }
if (DB) {
  const db = new DB(':memory:');
  const expr = cond.replace('VALUES(website_url)', '?');
  for (const [n, e, i] of CASES) {
    const row = db.prepare(`SELECT CASE WHEN ${expr} THEN ? ELSE website_url END AS r FROM (SELECT ? AS website_url)`).get(i, i, e);
    // 取り込みNULLのとき MySQL の VALUES() も NULL。置き換え側(既存が空)なら NULL になる
    eq(row.r, pickWebsiteUrl(e, i), 'SQL評価==JS: ' + n);
  }
  db.close();
} else console.log('  (node:sqlite なし: SQL評価の突き合わせは省略)');

console.log(`importurl.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
