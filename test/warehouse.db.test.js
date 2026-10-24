'use strict';
/**
 * DB結合テスト(ローカルのMySQL/MariaDBが必要。接続できなければスキップ)。
 * 環境変数: TEST_DB_HOST(127.0.0.1) TEST_DB_PORT(3306) TEST_DB_USER TEST_DB_PASS  ※CREATE/DROP DATABASE権限が必要
 * stoc_master / stoc_sales を作り直す(テスト専用サーバーで実行すること)。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const mysql = require('mysql2/promise');
const w = require('../src/warehouse');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}

const cfg = {
  host: process.env.TEST_DB_HOST || '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT || 3306),
  user: process.env.TEST_DB_USER || 'wht',
  password: process.env.TEST_DB_PASS || 'whtpass',
  multipleStatements: true,
  charset: 'utf8mb4',
};
const ROOT = path.join(__dirname, '..');
const URL1 = 'https://www.google.co.jp/maps/place/data=!4m7!3m6!1s0x60008ee1405f85a7:0xe9a994bb6fdb93c5!8m2!3d35.6894807!4d139.6916863!2z!16s';
const URL2 = 'https://www.google.co.jp/maps/place/data=!4m7!3m6!1s0x60008f00e94887b7:0x11cbe625c422d660!8m2!3d35.6894807!4d139.6916863!2z!16s';

function run(script, args) {
  const r = spawnSync('node', [path.join(ROOT, script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, WH_DB_HOST: cfg.host, WH_DB_PORT: String(cfg.port), WH_DB_USER: cfg.user, WH_DB_PASS: cfg.password },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

(async () => {
  // ===== 本番保護(このテストは stoc_sales / stoc_master を削除して作り直すため) =====
  // ① 明示的に許可しない限り実行しない
  if (process.env.WEBDOCK_DB_TEST_OK !== '1') {
    console.log('スキップ: このテストはデータベースを削除・再作成します。テスト専用サーバーでのみ WEBDOCK_DB_TEST_OK=1 を付けて実行してください。');
    process.exit(0);
  }
  // ② 本番サーバー(STOC営業管理が置かれている場所)では絶対に実行しない
  if (require('fs').existsSync('/var/www/stoc-sales-engine')) {
    console.error('中止: 本番サーバー上では実行できません(/var/www/stoc-sales-engine があります)。');
    process.exit(1);
  }
  let db;
  try { db = await mysql.createConnection(cfg); } catch (e) { console.log('DBに接続できないためスキップ: ' + e.message); process.exit(0); }
  const q = async (sql, p) => (await db.query(sql, p))[0];
  // ③ 既存の stores に実データらしき件数があれば中止
  try {
    const rows = await q('SELECT COUNT(*) AS n FROM stoc_sales.stores');
    if (rows[0].n > 50) { console.error(`中止: stoc_sales.stores に ${rows[0].n} 件あります。本番データの可能性があるため削除しません。`); process.exit(1); }
  } catch { /* テーブルが無ければ新規環境なので続行 */ }

  // --- セットアップ ---
  await q('DROP DATABASE IF EXISTS stoc_master; DROP DATABASE IF EXISTS stoc_sales; CREATE DATABASE stoc_sales CHARACTER SET utf8mb4');
  await q(`USE stoc_sales; CREATE TABLE users (id INT PRIMARY KEY AUTO_INCREMENT) ENGINE=InnoDB;
    CREATE TABLE stores (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(255), website_url VARCHAR(1000), prefecture VARCHAR(10), status VARCHAR(20) DEFAULT '', score INT DEFAULT 0, cid VARCHAR(20)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);
  const mig = fs.readFileSync('/home/claude/stoc-sales-engine/database/migrations/add_store_contact_channels.sql', 'utf8');
  await q('USE stoc_sales;\n' + mig);
  await q(fs.readFileSync(path.join(ROOT, 'sql/warehouse_schema.sql'), 'utf8'));

  // --- フィクスチャ ---
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whfix-'));
  fs.mkdirSync(path.join(dir, '兵庫県'));
  fs.mkdirSync(path.join(dir, '東京都'));
  const H = ['屋号', '業種', '郵便番号', '住所', '電話番号', '評価', '口コミ数', 'Googleマイビジネス登録有無', '登録URL', 'GMAP', '写真枚数'];
  const tsv = [H,
    ['slow style live bar 音の泉', 'カレー店', '650-0004', '兵庫県神戸市中央区中山手通１丁目２７?１０ 4階', '078-242-0124', '4.8', '15', '有り', '', URL1, '77'],
    ['trimmngsalon MERRY', 'トリミングサロン', '651-0097', '兵庫県神戸市中央区布引町２丁目４?１１ エムコート布引', '078-200-4556', '', '', '有り', '', URL2, '1'],
    ['GMAPなし食堂', '食堂', '670-0000', '兵庫県姫路市1?2', '079-111-2222', '3.5', '3', '', '', '', ''],
    ['', '名前なし', '', '', '', '', '', '', '', '', ''],
  ].map((r) => r.join('\t')).join('\r\n') + '\r\n';
  fs.writeFileSync(path.join(dir, '兵庫県', 'a.tsv'), w.encodeShiftJis(tsv));
  const csv = [H.concat(['Place ID', 'CID', '緯度', '経度']),
    ['slow style live bar 音の泉', '', '', '', '', '4.9', '20', '', 'http://onsen.example.jp', URL1, '80', 'ChIJxx', '', '', ''],
    ['東京の店', '美容院', '100-0001', '東京都千代田区1?1', '03-0000-0000', '4.0', '100', '有り', 'http://tokyo.example.jp', '', '5', '', '12345678901234567890', '35.68', '139.75'],
    ['引用"付き,\n改行店', '美容院', '', '東京都港区', '03-1111-1111', '', '', '', '', '', '', '', '', '35.6894807', '139.6916863'],
  ].map((r) => r.map((c) => (/[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c)).join(',')).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, '東京都', 'b.csv'), '﻿' + csv);

  // 14列の元データ(収集ツールの出力そのまま)
  fs.mkdirSync(path.join(dir, '大阪府'));
  const H14 = '屋号\t業種\t郵便番号\t住所\t電話番号\t評価\t口コミ件数\t緯度（世界測地系）\t経度（世界測地系）\t開閉店情報\tGoogleマイビジネス登録有無\t登録URL\t掲載元URL\t写真枚数';
  const U14 = (cid) => `https://www.google.co.jp/maps/place/data=!4m7!3m6!1s0x60008d00781a628f:${cid}!8m2!3d35.6894807!4d139.6916863!2z!16s`;
  const t14 = [H14,
    ['大阪の店A', 'ラーメン店、居酒屋', '530-0001', '大阪府大阪市北区1−1', '06-1', '4.2', '30', '34.7', '135.5', '', '有り', '', U14('0xaaaa000000000001'), '3'],
    ['大阪の閉業店', 'ラーメン店', '530-0002', '大阪府大阪市北区2−2', '06-2', '4.0', '10', '34.7', '135.5', '閉業', '有り', '', U14('0xaaaa000000000002'), '1'],
    ['大阪の臨時休業店', 'カフェ', '530-0003', '大阪府大阪市北区3−3', '06-3', '3.0', '5', '34.7', '135.5', '臨時休業', '有り', '', U14('0xaaaa000000000003'), '1'],
  ].map((r) => (Array.isArray(r) ? r.join('\t') : r)).join('\r\n') + '\r\n';
  fs.writeFileSync(path.join(dir, '大阪府', 'raw14.tsv'), w.encodeShiftJis(t14));

  // 営業アプリ側に cid2 の店舗と、finder用の店舗
  await q("INSERT INTO stoc_sales.stores (name, cid) VALUES ('MERRY(既存)', '0x11cbe625c422d660')");

  // --- dry-run ---
  let r = run('cli/warehouse-import.js', ['--root', dir, '--dry-run']);
  eq(r.code, 0, 'dry-run exit');
  eq(/読込4 .*スキップ1/.test(r.err) && /読込3 /.test(r.err), true, 'dry-run counts: ' + r.err);
  eq((await q("SHOW DATABASES LIKE 'stoc_master'")).length, 1, 'schema exists');
  eq((await q('SELECT COUNT(*) n FROM stoc_master.shops'))[0].n, 0, 'dry-run wrote nothing');

  // --- 取り込み ---
  r = run('cli/warehouse-import.js', ['--root', dir, '--batch', '2']);
  eq(r.code, 0, 'import exit: ' + r.err);
  let rows = await q('SELECT * FROM stoc_master.shops ORDER BY id');
  eq(rows.length, 8, 'rows after import (5 + 3 raw 14-col)');
  const by = (n) => rows.find((x) => x.name === n);
  const s1 = by('slow style live bar 音の泉');
  eq([s1.cid, s1.fallback_key, Number(s1.rating), s1.review_count, s1.photo_count, s1.website_url, s1.place_id, s1.prefecture], ['0xe9a994bb6fdb93c5', null, 4.9, 20, 80, 'http://onsen.example.jp', 'ChIJxx', '兵庫県'], 'duplicate cid merged (newer rating, filled website)');
  eq(s1.address_raw.includes('?') && s1.address.includes('－') && !s1.address.includes('?'), true, 'address raw/normalized');
  const nocid = by('GMAPなし食堂');
  eq([nocid.cid, /^[0-9a-f]{40}$/.test(nocid.fallback_key)], [null, true], 'fallback key row');
  const tk = by('東京の店');
  eq([tk.cid, tk.prefecture, Number(tk.lat), Number(tk.lng)], ['0x' + BigInt('12345678901234567890').toString(16), '東京都', 35.68, 139.75], 'CID column decimal -> hex, lat/lng');
  const qt = by('引用"付き,\n改行店');
  eq([!!qt, qt && qt.lat], [true, null], 'quoted newline name; bogus lat/lng -> NULL');
  eq(by('MERRY') === undefined, true, 'sanity');
  const merry = by('trimmngsalon MERRY');
  eq(merry.stoc_store_id, 1, 'link step set stoc_store_id');
  eq((await q('SELECT COUNT(*) n FROM stoc_master.shops WHERE stoc_store_id IS NOT NULL'))[0].n, 1, 'only one linked');
  let run1 = (await q('SELECT * FROM stoc_master.import_runs ORDER BY id'))[0];
  eq([run1.files, Number(run1.rows_read), Number(run1.inserted), Number(run1.updated), Number(run1.skipped), !!run1.finished_at], [3, 10, 8, 1, 1, true], 'import_runs row');
  const firstSeen = s1.first_seen_at.getTime();

  // --- 冪等性 ---
  r = run('cli/warehouse-import.js', ['--root', dir]);
  eq(r.code, 0, 're-import exit');
  eq((await q('SELECT COUNT(*) n FROM stoc_master.shops'))[0].n, 8, 'idempotent row count');
  const run2 = (await q('SELECT * FROM stoc_master.import_runs ORDER BY id'))[1];
  eq([Number(run2.inserted), Number(run2.updated)], [0, 9], 'second run: 0 inserted, 9 updated');
  eq((await q('SELECT first_seen_at FROM stoc_master.shops WHERE id = ?', [s1.id]))[0].first_seen_at.getTime(), firstSeen, 'first_seen_at kept');

  // --- link-only ---
  await q("UPDATE stoc_master.shops SET stoc_store_id = NULL");
  r = run('cli/warehouse-import.js', ['--link-only']);
  eq((await q('SELECT COUNT(*) n FROM stoc_master.shops WHERE stoc_store_id = 1'))[0].n, 1, 'link-only restores link');

  const o14 = rows.find((x) => x.name === '大阪の店A');
  eq([o14.category_main, o14.category, o14.business_status, o14.prefecture, Number(o14.lat), o14.review_count], ['ラーメン店', 'ラーメン店、居酒屋', null, '大阪府', 34.7, 30], '14-col import fields');
  eq(rows.find((x) => x.name === '大阪の閉業店').business_status, '閉業', 'business_status stored');
  // 再取り込みで開閉店情報が最新に追従(空→NULL)
  const f14 = path.join(dir, '大阪府', 'raw14.tsv');
  fs.writeFileSync(f14, w.encodeShiftJis(t14.replace('\t閉業\t', '\t\t')));
  run('cli/warehouse-import.js', ['--root', dir]);
  eq((await q("SELECT business_status FROM stoc_master.shops WHERE name = '大阪の閉業店'"))[0].business_status, null, 'status cleared by newer file');
  fs.writeFileSync(f14, w.encodeShiftJis(t14));
  run('cli/warehouse-import.js', ['--root', dir]);
  eq((await q("SELECT business_status FROM stoc_master.shops WHERE name = '大阪の閉業店'"))[0].business_status, '閉業', 'status restored');
  // 開閉店列のないファイルでは触らない
  run('cli/warehouse-import.js', ['--root', path.join(dir, '東京都')]);
  eq((await q("SELECT business_status FROM stoc_master.shops WHERE name = '大阪の閉業店'"))[0].business_status, '閉業', 'file without column leaves status');

  // --- promote ---
  const out = path.join(dir, 'out', 'promote.csv');
  r = run('cli/warehouse-promote.js', ['--out', out, '--prefecture', '兵庫県,東京都', '--mark', '--no-rules']);
  eq(r.code, 0, 'promote exit: ' + r.err);
  const text = new TextDecoder('shift_jis').decode(fs.readFileSync(out));
  const lines = w.parseDelimited(text, ',');
  eq(lines[0], ['屋号', '業種', '郵便番号', '住所', '電話番号', '評価', '口コミ数', 'Googleマイビジネス登録有無', '登録URL', 'GMAP', '写真枚数'], 'promote header');
  eq(lines.length, 5, 'promote rows = 4 (linked one excluded) + header');
  eq(lines.every((l) => l.length === 11), true, 'all rows 11 cols');
  eq(lines[1], ['東京の店', '美容院', '100-0001', '東京都千代田区1?1', '03-0000-0000', '4.0', '100', '有り', 'http://tokyo.example.jp', '', '5'], 'promote ordering (review DESC) + values');
  eq(lines[2][0], 'slow style live bar 音の泉', 'second by review_count');
  eq(lines[2][3], '兵庫県神戸市中央区中山手通１丁目２７?１０ 4階', 'raw address kept');
  eq(lines[2][9], URL1, 'GMAP kept');
  eq(lines.some((l) => l[0] === 'trimmngsalon MERRY'), false, 'linked store excluded');
  eq((await q('SELECT COUNT(*) n FROM stoc_master.shops WHERE promoted_at IS NOT NULL'))[0].n, 4, 'marked 4');
  r = run('cli/warehouse-promote.js', ['--out', out, '--prefecture', '兵庫県,東京都', '--no-rules']);
  eq(w.parseDelimited(new TextDecoder('shift_jis').decode(fs.readFileSync(out)), ',').length, 1, 'second promote: header only');
  // 閉業の扱い(大阪府)
  const outO = path.join(dir, 'out', 'osaka.csv');
  run('cli/warehouse-promote.js', ['--out', outO, '--prefecture', '大阪府', '--no-rules']);
  let ol = w.parseDelimited(new TextDecoder('shift_jis').decode(fs.readFileSync(outO)), ',');
  eq(ol.slice(1).map((l) => l[0]).sort(), ['大阪の店A', '大阪の臨時休業店'], 'closed excluded by default, 臨時休業 kept');
  eq(ol[0].length, 11, 'osaka 11 cols');
  eq(ol.find((l) => l[0] === '大阪の店A')[1], 'ラーメン店', 'export uses first category only (same as リスツール整形)');
  run('cli/warehouse-promote.js', ['--out', outO, '--prefecture', '大阪府', '--include-closed', '--no-rules']);
  ol = w.parseDelimited(new TextDecoder('shift_jis').decode(fs.readFileSync(outO)), ',');
  eq(ol.length, 4, '--include-closed includes closed');
  // filters
  await q('UPDATE stoc_master.shops SET promoted_at = NULL');
  r = run('cli/warehouse-promote.js', ['--out', out, '--prefecture', '東京都', '--category', '美容,ネイル', '--has-website', '--limit', '5', '--no-rules']);
  eq(w.parseDelimited(new TextDecoder('shift_jis').decode(fs.readFileSync(out)), ',').length, 2, 'filters: category+website');

  // --- 除外ルール / 電話番号重複 / limit / report-only / import --pattern ---
  fs.mkdirSync(path.join(dir, '福岡県'));
  const rawName = path.join(dir, '福岡県', 'gmp_福岡県_20261016-101752.csv');
  const cleaned = path.join(dir, '福岡県', 'fukuoka.csv');
  const rowF = (n, cat, ph, rv, u) => [n, cat, '810-0001', '福岡県福岡市1−1', ph, '4.0', rv, '有り', '', u, '1'].join(',');
  const UF = (n) => URL1.replace('0xe9a994bb6fdb93c5', '0xbbbb00000000000' + n);
  const body = [H.join(','),
    rowF('ダイワハウス 神戸営業所', '住宅', '092-000-0001', '90', UF(1)),
    rowF('福岡美容室A', '美容院、カフェ', '092-000-0002', '10', UF(2)),
    rowF('福岡美容室B(同電話)', '美容院', '092-000-0002', '50', UF(3)),
    rowF('福岡エステC', 'エステ', '092-000-0003', '30', ''),
    rowF('福岡ネイルD', 'ネイル', '', '5', ''),
    rowF('福岡ネイルE', 'ネイル', '', '4', ''),
  ].join('\n') + '\n';
  fs.writeFileSync(rawName, '﻿' + body);
  fs.writeFileSync(cleaned, '﻿' + [H.join(','), rowF('整形後ファイル', 'x', '092-999-9999', '1', '')].join('\n') + '\n');
  r = run('cli/warehouse-import.js', ['--root', path.join(dir, '福岡県'), '--pattern', 'gmp_*.csv']);
  eq(r.code, 0, 'pattern import exit: ' + r.err);
  eq(/対象ファイル 1件/.test(r.err), true, 'pattern: only 1 file: ' + r.err);
  eq((await q("SELECT COUNT(*) n FROM stoc_master.shops WHERE prefecture = '福岡県'"))[0].n, 6, 'pattern: raw rows imported');
  eq((await q("SELECT COUNT(*) n FROM stoc_master.shops WHERE name = '整形後ファイル'"))[0].n, 0, 'pattern: cleaned sibling skipped');

  const outF = path.join(dir, 'out', 'fukuoka.csv');
  const readF = () => w.parseDelimited(new TextDecoder('shift_jis').decode(fs.readFileSync(outF)), ',');
  r = run('cli/warehouse-promote.js', ['--out', outF, '--prefecture', '福岡県']);
  eq(r.code, 0, 'rules promote exit: ' + r.err);
  eq(readF().slice(1).map((l) => l[0]), ['福岡美容室B(同電話)', '福岡エステC'], 'rules: ダイワハウス excluded, same phone deduped (higher review kept), shops without phone excluded');
  eq(readF().find((l) => l[0] === '福岡美容室B(同電話)')[1], '美容院', 'first category exported');
  eq(/ルールで除外: 3\b/.test(r.err) && /電話番号の重複で除外: 1\b/.test(r.err) && /書き出し対象: 2\b/.test(r.err) && /走査した行: 6\b/.test(r.err), true, 'stats printed: ' + r.err);
  eq(/屋号:[^ ]+ : 1/.test(r.err), true, 'top keywords printed');
  // 福岡エステC: 業種に除外語がなければ残る(上で確認済み)。--no-dedupe-phone
  r = run('cli/warehouse-promote.js', ['--out', outF, '--prefecture', '福岡県', '--no-dedupe-phone']);
  eq(readF().length, 4, '--no-dedupe-phone keeps both same-phone rows (3 + header)');
  // limit は絞り込み後: 上位(口コミ順)の先頭はダイワハウス(除外)なので、limit 2 でも2件出る
  r = run('cli/warehouse-promote.js', ['--out', outF, '--prefecture', '福岡県', '--limit', '2']);
  eq(readF().slice(1).map((l) => l[0]), ['福岡美容室B(同電話)', '福岡エステC'], '--limit counted after filtering');
  // --no-rules
  r = run('cli/warehouse-promote.js', ['--out', outF, '--prefecture', '福岡県', '--no-rules', '--no-dedupe-phone']);
  eq(readF().length, 7, '--no-rules keeps all 6');
  // mark は書き出した分だけ
  await q('UPDATE stoc_master.shops SET promoted_at = NULL');
  r = run('cli/warehouse-promote.js', ['--out', outF, '--prefecture', '福岡県', '--limit', '2', '--mark']);
  eq((await q("SELECT name FROM stoc_master.shops WHERE promoted_at IS NOT NULL ORDER BY name")).map((x) => x.name).sort(), ['福岡エステC', '福岡美容室B(同電話)'], '--mark marks only written rows');
  await q('UPDATE stoc_master.shops SET promoted_at = NULL');
  // report-only はファイルを書かない
  const outR = path.join(dir, 'out', 'report.csv');
  r = run('cli/warehouse-promote.js', ['--out', outR, '--prefecture', '福岡県', '--report-only', '--mark']);
  eq([r.code, fs.existsSync(outR), /ルールで除外: 3\b/.test(r.err)], [0, false, true], '--report-only writes no file');
  eq((await q('SELECT COUNT(*) n FROM stoc_master.shops WHERE promoted_at IS NOT NULL'))[0].n, 0, '--report-only marks nothing');
  r = run('cli/warehouse-promote.js', ['--prefecture', '福岡県', '--report-only']);
  eq(r.code, 0, '--report-only needs no --out');

  // --- find-forms DB writer ---
  const ff = require('../cli/find-forms');
  const S = async (name, url, extra) => (await q('INSERT INTO stoc_sales.stores (name, website_url, prefecture, score) VALUES (?,?,?,?)', [name, url, '兵庫県', extra || 0])).insertId;
  const id1 = await S('F1', 'http://f1.example.jp');
  const id2 = await S('F2(sent)', 'http://f2.example.jp');
  const id3 = await S('F3', 'http://f3.example.jp');
  const id4 = await S('F4(ig)', 'http://f4.example.jp');
  const id5 = await S('F5(unknown-new)', 'http://f5.example.jp');
  const id6 = await S('F6(unknown-nf)', 'http://f6.example.jp');
  await q("INSERT INTO stoc_sales.store_contact_channels (store_id, inquiry_status) VALUES (?, 'sent')", [id2]);
  await q("INSERT INTO stoc_sales.store_contact_channels (store_id, inquiry_status) VALUES (?, 'no_form')", [id6]);
  await q("INSERT INTO stoc_sales.store_contact_channels (store_id, instagram_url, instagram_status) VALUES (?, 'https://instagram.com/old', 'found')", [id4]);
  process.env.FINDER_DB_HOST = cfg.host; process.env.FINDER_DB_PORT = String(cfg.port);
  process.env.FINDER_DB_USER = cfg.user; process.env.FINDER_DB_PASS = cfg.password; process.env.FINDER_DB_NAME = 'stoc_sales';
  const pool = ff.createPool();
  const writer = ff.makeDbWriter(pool);
  let current = {};
  const finder = async (url) => current[new URL(url).hostname];
  const res = (o) => ({ status: 'url_found', inquiryUrl: null, hasCaptcha: false, kind: 'onsite', emails: [], instagram: null, note: '', ...o });
  const stores = await ff.fetchTargets(pool, { recheckDays: 90, errorRetryDays: 7 }, 100);
  eq(stores.map((s) => s.id).sort((a, b) => a - b), [id1, id3, id4, id5, id6], 'target query valid & selects expected stores');
  eq(stores.some((s) => s.id === id2), false, 'sent store not a target');
  const mk = (id, host) => ({ id, name: 'n', website_url: 'http://' + host, prefecture: '兵庫県' });
  current = {
    'f1.example.jp': res({ inquiryUrl: 'http://f1.example.jp/contact', emails: ['info@f1.example.jp'], instagram: 'https://instagram.com/f1' }),
    'f2.example.jp': res({ inquiryUrl: 'http://f2.example.jp/contact' }),
    'f3.example.jp': res({ status: 'no_form' }),
    'f5.example.jp': res({ status: 'unknown', note: '要ブラウザ確認(JSで作られたサイト)' }),
    'f6.example.jp': res({ status: 'unknown' }),
    'f4.example.jp': res({ status: 'no_form', instagram: 'https://instagram.com/new' }),
  };
  await ff.processStores({ stores: [mk(id1, 'f1.example.jp'), mk(id2, 'f2.example.jp'), mk(id3, 'f3.example.jp'), mk(id4, 'f4.example.jp'), mk(id5, 'f5.example.jp'), mk(id6, 'f6.example.jp')], finder, writer, concurrency: Number(process.env.T_CONC || 2) });
  const ch = async (id) => (await q('SELECT * FROM stoc_sales.store_contact_channels WHERE store_id = ?', [id]))[0];
  const c1 = await ch(id1);
  eq([c1.inquiry_status, c1.email_status, c1.instagram_url, c1.instagram_status], ['url_found', 'found', 'https://instagram.com/f1', 'found'], 'store1 channels');
  eq((await ch(id2)).inquiry_status, 'sent', 'sent not overwritten');
  eq((await ch(id3)).inquiry_status, 'no_form', 'no_form recorded');
  const c4 = await ch(id4);
  eq([c4.instagram_url, c4.inquiry_status], ['https://instagram.com/old', 'no_form'], 'instagram not overwritten when set');
  const c5 = await ch(id5);
  eq([c5.inquiry_status, c5.inquiry_last_checked_at !== null], ['unknown', true], 'unknown result: not no_form, last_checked updated');
  const c6 = await ch(id6);
  eq([c6.inquiry_status, c6.inquiry_last_checked_at !== null], ['no_form', true], 'unknown result keeps existing status, updates last_checked');
  const cand = async (id, type) => q('SELECT value, is_active, source FROM stoc_sales.contact_channel_candidates WHERE store_id = ? AND channel_type = ? ORDER BY id', [id, type]);
  eq((await cand(id1, 'email')).map((x) => x.value), ['info@f1.example.jp'], 'email candidate');
  eq((await cand(id1, 'inquiry_url')).map((x) => [x.value, x.is_active]), [['http://f1.example.jp/contact', 1]], 'inquiry candidate active');
  // 2回目: 別URL
  current['f1.example.jp'] = res({ inquiryUrl: 'http://f1.example.jp/inquiry' });
  await ff.processStores({ stores: [mk(id1, 'f1.example.jp')], finder, writer });
  eq((await cand(id1, 'inquiry_url')).map((x) => [x.value, x.is_active]), [['http://f1.example.jp/contact', 0], ['http://f1.example.jp/inquiry', 1]], 'second URL deactivates previous');
  // 元のURLが戻った場合は再有効化
  current['f1.example.jp'] = res({ inquiryUrl: 'http://f1.example.jp/contact' });
  await ff.processStores({ stores: [mk(id1, 'f1.example.jp')], finder, writer });
  eq((await cand(id1, 'inquiry_url')).map((x) => [x.value, x.is_active]), [['http://f1.example.jp/contact', 1], ['http://f1.example.jp/inquiry', 0]], 'old URL reactivated');
  await pool.end();

  // ===== 倉庫でのフォーム探し(migrate_002 / 倉庫モード / 引き継ぎ) =====
  const mig2 = fs.readFileSync(path.join(ROOT, 'sql/warehouse_migrate_002.sql'), 'utf8');
  // 旧スキーマに戻してから2回適用(冪等)
  await q('ALTER TABLE stoc_master.shops DROP COLUMN form_note, DROP COLUMN form_kind, DROP COLUMN form_captcha, DROP INDEX idx_pref_form');
  await q("ALTER TABLE stoc_master.shops MODIFY form_status ENUM('unknown','url_found','no_form','error') NOT NULL DEFAULT 'unknown'");
  await q(mig2);
  await q(mig2);
  const colsOf = async () => (await q("SELECT COLUMN_NAME c, COLUMN_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='stoc_master' AND TABLE_NAME='shops' AND COLUMN_NAME IN ('form_note','form_kind','form_captcha','form_status') ORDER BY c"));
  const cols = await colsOf();
  eq(cols.map((c) => c.c), ['form_captcha', 'form_kind', 'form_note', 'form_status'], 'migrate_002 adds columns');
  eq(/needs_browser/.test(cols.find((c) => c.c === 'form_status').t), true, 'enum has needs_browser');
  eq((await q("SELECT COUNT(*) n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='stoc_master' AND TABLE_NAME='shops' AND INDEX_NAME='idx_pref_form'"))[0].n, 2, 'index (prefecture, form_status) exists once');

  process.env.WH_DB_HOST = cfg.host; process.env.WH_DB_PORT = String(cfg.port);
  process.env.WH_DB_USER = cfg.user; process.env.WH_DB_PASS = cfg.password;
  const whPool = ff.createWarehousePool();
  const whWriter = ff.makeWarehouseWriter(whPool);
  await q('DELETE FROM stoc_master.shops');
  const SH = async (name, url, pref, rv, extra) => (await q(
    'INSERT INTO stoc_master.shops (cid, name, website_url, prefecture, review_count, first_seen_at, last_seen_at, form_status, form_checked_at, email) VALUES (?,?,?,?,?,NOW(),NOW(),?,?,?)',
    [extra && extra.cid || null, name, url, pref, rv, extra && extra.status || 'unknown', extra && extra.checked || null, extra && extra.email || null])).insertId;
  const w1 = await SH('W1', 'http://w1.example.jp', '大阪府', 50, { cid: '0xc1' });
  const w2 = await SH('W2', 'http://w2.example.jp', '大阪府', 40, { cid: '0xc2' });
  const w3 = await SH('W3', 'http://w3.example.jp', '大阪府', null);
  const w4 = await SH('W4', 'http://w4.example.jp', '大阪府', 30);
  const w5 = await SH('W5', 'http://w5.example.jp', '大阪府', 20, { cid: '0xc5', email: 'keep@w5.example.jp' });
  const wTok = await SH('Tokyo', 'http://tokyo2.example.jp', '東京都', 99);
  const wNoUrl = await SH('NoUrl', '', '大阪府', 90);
  const wNb = await SH('NeedsBrowserOld', 'http://nb.example.jp', '大阪府', 10, { status: 'needs_browser', checked: '2020-01-01 00:00:00' });
  const wErrOld = await SH('ErrOld', 'http://eo.example.jp', '大阪府', 9, { status: 'error', checked: '2020-01-01 00:00:00' });
  const wErrNew = await SH('ErrNew', 'http://en.example.jp', '大阪府', 8, { status: 'error', checked: new Date() });
  const wNfOld = await SH('NfOld', 'http://no.example.jp', '大阪府', 7, { status: 'no_form', checked: '2020-01-01 00:00:00' });
  const wNfNew = await SH('NfNew', 'http://nn.example.jp', '大阪府', 6, { status: 'no_form', checked: new Date() });
  const wUnkChecked = await SH('UnkChecked', 'http://uc.example.jp', '大阪府', 5, { status: 'unknown', checked: '2020-01-01 00:00:00' });
  const baseOpts = { source: 'warehouse', recheckDays: 90, errorRetryDays: 7, prefecture: '大阪府', retryNeedsBrowser: false };
  let tg = await ff.fetchTargets(whPool, baseOpts, 100);
  eq(tg.map((x) => x.id), [w1, w2, w4, w5, wErrOld, wNfOld, w3], 'wh targets: prefecture, status, order (review DESC, NULL last)');
  eq((await ff.fetchTargets(whPool, { ...baseOpts, retryNeedsBrowser: true }, 100)).map((x) => x.id).includes(wNb), true, 'needs_browser retried only with flag');
  eq((await ff.fetchTargets(whPool, { ...baseOpts, prefecture: '大阪府,東京都' }, 100)).some((x) => x.id === wTok), true, 'prefecture list');
  eq((await ff.fetchTargets(whPool, baseOpts, 2)).map((x) => x.id), [w1, w2], 'limit');

  const hostRes = {
    'w1.example.jp': res({ inquiryUrl: 'http://w1.example.jp/contact', kind: 'external', hasCaptcha: true, emails: ['info@w1.example.jp'], instagram: 'https://instagram.com/w1' }),
    'w2.example.jp': res({ status: 'no_form', note: 'フォームなし' }),
    'w3.example.jp': res({ status: 'unknown', note: '要ブラウザ確認(JSで作られたサイト)' }),
    'w4.example.jp': res({ status: 'error', note: '調査に失敗しました' }),
    'w5.example.jp': res({ inquiryUrl: 'http://w5.example.jp/c', emails: ['new@w5.example.jp'] }),
    'eo.example.jp': res({ status: 'no_form' }),
    'no.example.jp': res({ status: 'url_found', inquiryUrl: 'http://no.example.jp/contact' }),
  };
  await ff.processStores({ stores: tg, finder: async (url) => hostRes[new URL(url).hostname], writer: whWriter, concurrency: 3 });
  const sh = async (id) => (await q('SELECT * FROM stoc_master.shops WHERE id = ?', [id]))[0];
  let x = await sh(w1);
  eq([x.form_status, x.form_url, x.form_kind, x.form_captcha, x.email, x.instagram_url, x.form_checked_at !== null], ['url_found', 'http://w1.example.jp/contact', 'external', 1, 'info@w1.example.jp', 'https://instagram.com/w1', true], 'wh url_found row');
  x = await sh(w2); eq([x.form_status, x.form_url, x.form_note, x.form_kind], ['no_form', null, 'フォームなし', null], 'wh no_form row');
  x = await sh(w3); eq([x.form_status, x.form_note, x.form_checked_at !== null], ['needs_browser', '要ブラウザ確認(JSで作られたサイト)', true], 'wh unknown -> needs_browser');
  x = await sh(w4); eq(x.form_status, 'error', 'wh error row');
  x = await sh(w5); eq([x.form_status, x.email, x.form_captcha], ['url_found', 'keep@w5.example.jp', 0], 'wh existing email kept');
  eq((await sh(wErrOld)).form_status, 'no_form', 'wh error retried');
  eq((await sh(wNfOld)).form_status, 'url_found', 'wh no_form rechecked');
  eq((await sh(wNb)).form_status, 'needs_browser', 'needs_browser untouched');
  eq((await sh(wTok)).form_status, 'unknown', 'other prefecture untouched');
  eq((await ff.fetchTargets(whPool, baseOpts, 100)).map((r) => r.id), [], 'wh loop makes progress: no targets left');
  // dry-run CSV(store_id列に shops.id)
  const dcsv = path.join(dir, 'wh-dry.csv');
  await ff.processStores({ stores: [{ id: w4, name: 'W4', website_url: 'http://w4.example.jp', prefecture: '大阪府' }], finder: async () => res({ inquiryUrl: 'http://w4.example.jp/c' }), writer: (() => { const fsx = require('fs'); fsx.writeFileSync(dcsv, ''); return async (s, r) => fsx.appendFileSync(dcsv, ff.csvRow(s, r)); })() });
  eq(fs.readFileSync(dcsv, 'utf8').startsWith(w4 + ',W4,大阪府,http://w4.example.jp,フォームあり,http://w4.example.jp/c,自社,なし'), true, 'dry-run csv row uses shops.id');
  await whPool.end();

  // --- 昇格のシミュレーション + 引き継ぎ(照合順序を本番と同じく食い違わせる) ---
  await q('ALTER TABLE stoc_sales.stores MODIFY cid VARCHAR(20) COLLATE utf8mb4_unicode_ci NULL');
  await q('ALTER TABLE stoc_master.shops MODIFY cid VARCHAR(20) COLLATE utf8mb4_general_ci NULL');
  const colls = await q("SELECT TABLE_SCHEMA s, COLLATION_NAME c FROM information_schema.COLUMNS WHERE TABLE_NAME IN ('stores','shops') AND COLUMN_NAME='cid' ORDER BY s");
  eq(colls.map((c) => c.c), ['utf8mb4_general_ci', 'utf8mb4_unicode_ci'], 'cid collations differ across databases');
  // w1: 新規 / w2(no_form): 営業側にも作るが対象外 / w5: 営業側は 'sent' 済み
  const st1 = (await q("INSERT INTO stoc_sales.stores (name, cid) VALUES ('W1店', '0xc1')")).insertId;
  const st2 = (await q("INSERT INTO stoc_sales.stores (name, cid) VALUES ('W2店', '0xc2')")).insertId;
  const st5 = (await q("INSERT INTO stoc_sales.stores (name, cid) VALUES ('W5店', '0xc5')")).insertId;
  await q("INSERT INTO stoc_sales.store_contact_channels (store_id, inquiry_status, email_status, instagram_url, instagram_status) VALUES (?, 'sent', 'sent', 'https://instagram.com/mine', 'dm_sent')", [st5]);
  r = run('cli/warehouse-import.js', ['--link-only', '--carry-forms']);
  eq(r.code, 0, 'carry exit: ' + r.err);
  eq(/引き継ぎ完了/.test(r.err), true, 'carry summary printed: ' + r.err);
  eq((await sh(w1)).stoc_store_id, st1, 'linked despite collation mismatch');
  const cch = async (id) => (await q('SELECT * FROM stoc_sales.store_contact_channels WHERE store_id = ?', [id]))[0];
  const cd = async (id) => (await q('SELECT channel_type t, value v, source s, is_active a FROM stoc_sales.contact_channel_candidates WHERE store_id = ? ORDER BY t, v', [id]));
  let k = await cch(st1);
  eq([k.inquiry_status, k.email_status, k.instagram_url, k.instagram_status, k.inquiry_last_checked_at !== null], ['url_found', 'found', 'https://instagram.com/w1', 'found', true], 'carried channel row');
  eq(await cd(st1), [{ t: 'inquiry_url', v: 'http://w1.example.jp/contact', s: 'finder', a: 1 }, { t: 'email', v: 'info@w1.example.jp', s: 'finder', a: 1 }], 'carried candidates');
  k = await cch(st5);
  eq([k.inquiry_status, k.email_status, k.instagram_url, k.instagram_status], ['sent', 'sent', 'https://instagram.com/mine', 'dm_sent'], 'sent / existing values not overwritten');
  eq((await cd(st5)).map((c) => c.v), ['http://w5.example.jp/c', 'keep@w5.example.jp'], 'candidates added even for sent store');
  eq([await cch(st2), (await cd(st2)).length], [undefined, 0], 'no_form shop not carried');
  // 既存 no_form -> url_found / unknown メール -> found
  await q("INSERT INTO stoc_master.shops (cid, name, website_url, prefecture, first_seen_at, last_seen_at, form_status, form_url, form_checked_at, email) VALUES ('0xc9','W9','http://w9.example.jp','大阪府',NOW(),NOW(),'url_found','http://w9.example.jp/c',NOW(),'a@w9.example.jp')");
  const st9 = (await q("INSERT INTO stoc_sales.stores (name, cid) VALUES ('W9店', '0xc9')")).insertId;
  await q("INSERT INTO stoc_sales.store_contact_channels (store_id, inquiry_status, inquiry_last_checked_at) VALUES (?, 'no_form', '2030-01-01 00:00:00')", [st9]);
  const before = [(await q('SELECT COUNT(*) n FROM stoc_sales.contact_channel_candidates'))[0].n];
  r = run('cli/warehouse-import.js', ['--link-only', '--carry-forms']);
  k = await cch(st9);
  eq([k.inquiry_status, k.email_status, new Date(k.inquiry_last_checked_at).getFullYear()], ['url_found', 'found', 2030], 'no_form upgraded; last_checked uses GREATEST');
  // 再実行しても同じ
  const snap = async () => JSON.stringify([await q('SELECT store_id, inquiry_status, email_status, instagram_url, instagram_status, inquiry_last_checked_at, email_last_checked_at FROM stoc_sales.store_contact_channels ORDER BY store_id'), await q('SELECT store_id, channel_type, value FROM stoc_sales.contact_channel_candidates ORDER BY id')]);
  const s1snap = await snap();
  r = run('cli/warehouse-import.js', ['--link-only', '--carry-forms']);
  eq([r.code, await snap()], [0, s1snap], 'carry-forms idempotent');
  eq((await q('SELECT COUNT(*) n FROM stoc_sales.contact_channel_candidates'))[0].n > before[0] - 1, true, 'candidates kept');
  // promote: --form-found の統計行
  r = run('cli/warehouse-promote.js', ['--out', path.join(dir, 'out', 'wf.csv'), '--prefecture', '大阪府', '--form-found', '--no-rules']);
  eq(/書き出し対象: \d+\(うちフォームあり \d+\)/.test(r.err), true, 'promote stats show form count: ' + r.err);
  r = run('cli/warehouse-promote.js', ['--out', path.join(dir, 'out', 'wf.csv'), '--prefecture', '大阪府', '--form-found', '--no-rules']);
  eq(/うちフォームあり (\d+)/.exec(r.err)[1] === /書き出し対象: (\d+)/.exec(r.err)[1], true, '--form-found rows all have a form');

  await db.end();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
