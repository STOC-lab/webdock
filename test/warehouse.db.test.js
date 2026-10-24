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
  eq(readF().slice(1).map((l) => l[0]), ['福岡美容室B(同電話)', '福岡エステC', '福岡ネイルD', '福岡ネイルE'], 'rules: ダイワハウス excluded, same phone deduped (higher review kept), empty phones all kept');
  eq(readF().find((l) => l[0] === '福岡美容室B(同電話)')[1], '美容院', 'first category exported');
  eq(/ルールで除外: 1\b/.test(r.err) && /電話番号の重複で除外: 1\b/.test(r.err) && /書き出し対象: 4\b/.test(r.err) && /走査した行: 6\b/.test(r.err), true, 'stats printed: ' + r.err);
  eq(/屋号:[^ ]+ : 1/.test(r.err), true, 'top keywords printed');
  // 福岡エステC: 業種に除外語がなければ残る(上で確認済み)。--no-dedupe-phone
  r = run('cli/warehouse-promote.js', ['--out', outF, '--prefecture', '福岡県', '--no-dedupe-phone']);
  eq(readF().length, 6, '--no-dedupe-phone keeps both same-phone rows (5 + header)');
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
  eq([r.code, fs.existsSync(outR), /ルールで除外: 1\b/.test(r.err)], [0, false, true], '--report-only writes no file');
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
  await q("INSERT INTO stoc_sales.store_contact_channels (store_id, inquiry_status) VALUES (?, 'sent')", [id2]);
  await q("INSERT INTO stoc_sales.store_contact_channels (store_id, instagram_url, instagram_status) VALUES (?, 'https://instagram.com/old', 'found')", [id4]);
  process.env.FINDER_DB_HOST = cfg.host; process.env.FINDER_DB_PORT = String(cfg.port);
  process.env.FINDER_DB_USER = cfg.user; process.env.FINDER_DB_PASS = cfg.password; process.env.FINDER_DB_NAME = 'stoc_sales';
  const pool = ff.createPool();
  const writer = ff.makeDbWriter(pool);
  let current = {};
  const finder = async (url) => current[new URL(url).hostname];
  const res = (o) => ({ status: 'url_found', inquiryUrl: null, hasCaptcha: false, kind: 'onsite', emails: [], instagram: null, note: '', ...o });
  const stores = await ff.fetchTargets(pool, { recheckDays: 90, errorRetryDays: 7 }, 100);
  eq(stores.map((s) => s.id).sort((a, b) => a - b), [id1, id3, id4], 'target query valid & selects expected stores');
  eq(stores.some((s) => s.id === id2), false, 'sent store not a target');
  const mk = (id, host) => ({ id, name: 'n', website_url: 'http://' + host, prefecture: '兵庫県' });
  current = {
    'f1.example.jp': res({ inquiryUrl: 'http://f1.example.jp/contact', emails: ['info@f1.example.jp'], instagram: 'https://instagram.com/f1' }),
    'f2.example.jp': res({ inquiryUrl: 'http://f2.example.jp/contact' }),
    'f3.example.jp': res({ status: 'no_form' }),
    'f4.example.jp': res({ status: 'no_form', instagram: 'https://instagram.com/new' }),
  };
  await ff.processStores({ stores: [mk(id1, 'f1.example.jp'), mk(id2, 'f2.example.jp'), mk(id3, 'f3.example.jp'), mk(id4, 'f4.example.jp')], finder, writer, concurrency: Number(process.env.T_CONC || 2) });
  const ch = async (id) => (await q('SELECT * FROM stoc_sales.store_contact_channels WHERE store_id = ?', [id]))[0];
  const c1 = await ch(id1);
  eq([c1.inquiry_status, c1.email_status, c1.instagram_url, c1.instagram_status], ['url_found', 'found', 'https://instagram.com/f1', 'found'], 'store1 channels');
  eq((await ch(id2)).inquiry_status, 'sent', 'sent not overwritten');
  eq((await ch(id3)).inquiry_status, 'no_form', 'no_form recorded');
  const c4 = await ch(id4);
  eq([c4.instagram_url, c4.inquiry_status], ['https://instagram.com/old', 'no_form'], 'instagram not overwritten when set');
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

  await db.end();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
