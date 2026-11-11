'use strict';
/**
 * 倉庫から直接送る(--direct。営業管理に入れない)のテスト。DB・ネット不要(偽の接続・偽のページ)。
 *   確かめること: 営業管理に未登録の店が通る / 9列CSVの評価・電話・住所が倉庫の値 / webdock_sends・webdock_send_batches へのINSERT /
 *   失敗したらページを消す / バッチコードの頭が whd_ / まとめ.txt の文言 / 対象外の6県の拒否 / フリーダイヤルのみ一致は送らない /
 *   営業管理(stoc_sales)には書かない
 * 営業管理経由の出力が変わらないことは test/golden.test.js が確かめる。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const O = require('../src/outreachSingle');
const WS = require('../src/warehouseSends');
const PG = require('../src/pages');
const { loadTemplates } = require('../src/outreach');
const { parseArgs, directArgsError } = require('../cli/batch-scan');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);

const T = loadTemplates();
const NOW = new Date('2026-11-10T01:02:03Z'); // 日本時間 2026-11-10 10:02:03
const ENV = { PUBLIC_BASE_URL: 'https://webdock.example.test' };
const SHA1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');
const REAL_RANDOM = Math.random;
const fixRandom = () => { Math.random = () => 0x1a2b / 0x10000; };
const restoreRandom = () => { Math.random = REAL_RANDOM; };

/** 偽の接続: 発行されたSQLを記録する。failOn に正規表現を渡すと、そのSQLで例外 */
function fakePool({ failOn, failErr } = {}) {
  const log = [];
  const conn = {
    async beginTransaction() { log.push({ op: 'begin' }); },
    async commit() { log.push({ op: 'commit' }); },
    async rollback() { log.push({ op: 'rollback' }); },
    release() { log.push({ op: 'release' }); },
    async query(sql, params) {
      log.push({ op: 'query', sql, params });
      if (failOn && failOn.test(sql)) throw failErr || new Error('boom');
      return [{ affectedRows: 1 }];
    },
  };
  return { log, async getConnection() { return conn; }, async query(sql, params) { log.push({ op: 'pool', sql, params }); return [[]]; } };
}
const sqlsOf = (log) => log.filter((l) => l.sql).map((l) => l.sql);
const writesToStoc = (log) => log.filter((l) => l.sql && /\bstoc_sales\b/.test(l.sql) && /^\s*(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i.test(l.sql));

// 診断結果の行。stoc_store_id が空 = 営業管理に未登録の店(倉庫から直接送るときも通る)
const rec = (id, key, o = {}) => ({
  store_id: String(5000 + id), stoc_store_id: '', 店名: `倉庫名${id}`, URL: `https://www.k${id}.co.jp/`, 業種: '金属加工業', 業種区分: '製造',
  問い合わせURL: `https://www.k${id}.co.jp/contact/`, 画像認証: 'なし', 営業お断り: '', 指摘種別: key, 送信推奨: 'はい', PHP版: '', ...o,
});
const ROWS = () => [
  rec(1, 'no_https'),
  rec(2, 'cms', { 業種: '建設会社', 業種区分: '建設' }),
  rec(3, 'mixed', { stoc_store_id: '77' }), // 倉庫の行が営業管理の店に紐付いている
  rec(4, 'js_libs', { 問い合わせURL: '' }), // 送信先URLなし
  rec(5, 'headers', { store_id: '' }), // 倉庫の店IDなし
  rec(6, 'cms'), // 倉庫に店がない
];
// 倉庫の店(shops)。fetchWarehouseShops と同じ形
const SHOPS = () => new Map([
  [5001, { name: '株式会社倉庫一', phone: '06-1111-0001', address: '大阪府大阪市中央区1-2-3', gbp_rating: '4.2', gbp_review_count: 15, website_url: 'https://www.k1.co.jp/' }],
  [5002, { name: '建設二', phone: '', address: '京都府京都市1-1', gbp_rating: null, gbp_review_count: 3, website_url: 'https://www.k2.co.jp/' }],
  [5003, { name: '三号商会', phone: null, address: null, gbp_rating: '3.0', gbp_review_count: null, website_url: 'https://www.k3.co.jp/' }],
]);
const RESULTS = new Map(ROWS().filter((r) => r.store_id).map((r) => [r.store_id, [{ key: 'https', title: 'HTTPS', status: 'bad', summary: `要約${r.store_id}`, remedy: '要対策' }]]));

function parseCsv(text) {
  return text.replace(/^﻿/, '').split('\r\n').filter(Boolean).map((l) => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out;
  });
}

/** 直接送信の実行。pool は倉庫の送信履歴への書き込みを記録する偽の接続 */
async function runDirect(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-'));
  const calls = { fetchShops: [], pagesCreate: [], pagesRemove: [] };
  const pool = over.pool || fakePool();
  let tok = 0;
  const pages = {
    async create(rows) { calls.pagesCreate.push(JSON.parse(JSON.stringify(rows))); return rows.map(() => `Tok${String(++tok).padStart(7, '0')}`); },
    async remove(t) { calls.pagesRemove.push(t); },
  };
  fixRandom();
  let error = null, res = null;
  try {
    res = await O.buildSingleFiles({
      rows: ROWS(), outDir: dir, templates: T, now: NOW, direct: true, dryRun: !!over.dryRun, withPage: over.withPage, pages, env: ENV, resultsByStore: RESULTS,
      filter: { prefecture: '大阪府,京都府', main_category: '製造,建設', limit: 0 },
      preExcluded: { '倉庫の送信履歴で送信済み(日数以内)': 4 },
      matchedByShop: over.matchedByShop || new Map([['5003', 77], ['5001', 900]]),
      reviewRows: over.reviewRows || [{ row: { store_id: '5100', name: '本部系', address: '東京都千代田区1-1-1', phone: '03-0000-0005' }, free: [{ number: '0120555555', stores: 2 }], freeIds: [105, 106] }],
      wh: {
        fetchShops: async (ids) => { calls.fetchShops.push(ids); return SHOPS(); },
        createBatch: async (o) => { calls.createBatch = (calls.createBatch || []).concat([JSON.parse(JSON.stringify(o))]); return WS.createBatch(pool, o); },
      },
    });
  } catch (e) { error = e; } finally { restoreRandom(); }
  const files = {};
  for (const n of fs.readdirSync(dir).sort()) files[n] = fs.readFileSync(path.join(dir, n), 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return { res, error, files, calls, pool };
}

(async () => {
  // ---- バッチコード・送信先URLの正規化 ----
  fixRandom();
  eq(WS.newBatchCode(NOW), 'whd_20261110_100203_1a2b', 'バッチコード: whd_ + 日本時間 + 16進4桁');
  restoreRandom();
  ok(WS.WH_BATCH_CODE_RE.test(WS.newBatchCode()) && !/^sender_/.test(WS.newBatchCode()), 'バッチコードの頭は whd_(STOCの sender_ と混ざらない)');
  ok(!WS.WH_BATCH_CODE_RE.test('sender_20261110_100203_1a2b') && !WS.WH_BATCH_CODE_RE.test('whd_20261110_100203_1A2B'), 'sender_ や大文字は不可');
  eq(WS.normalizeFormUrl(' HTTPS://Www.Example.CO.jp:443/Contact/#top '), 'https://www.example.co.jp/Contact', '正規化: 小文字ホスト・既定ポート・#・末尾/');
  eq(WS.normalizeFormUrl('https://a.jp/'), 'https://a.jp', '正規化: ルートの/');
  eq(WS.normalizeFormUrl('https://a.jp/form?id=1&x=2'), 'https://a.jp/form?id=1&x=2', '正規化: ?以降は残す');
  eq(WS.normalizeFormUrl('not a url'), 'not a url', '正規化: URLでなければそのまま');
  eq(WS.formUrlKey('https://A.jp/c/'), SHA1('https://a.jp/c'), 'form_url_key は正規化したURLのSHA1(40桁)');
  ok(/^[0-9a-f]{40}$/.test(WS.formUrlKey('https://a.jp')), 'form_url_key は16進40文字');
  eq(WS.formUrlKey('https://a.jp/c'), WS.formUrlKey('HTTPS://a.jp/c/#x'), '見た目が違っても同じ送信先は同じキー');

  // ---- 対象外の6県 ----
  eq(WS.DIRECT_EXCLUDED_PREFECTURES, ['兵庫県', '岡山県', '徳島県', '香川県', '愛媛県', '高知県'], '対象外は兵庫・岡山・徳島・香川・愛媛・高知');
  eq(WS.directPrefectureError(['大阪府', '京都府']), null, '対象外でなければエラーなし');
  for (const p of WS.DIRECT_EXCLUDED_PREFECTURES) ok(WS.directPrefectureError(['大阪府', p]) && WS.directPrefectureError(`大阪府,${p}`).includes(p), `${p}を含むと拒否`);
  const base = ['--source', 'warehouse', '--template', 'b2b', '--single-out', '/tmp/x', '--direct'];
  eq(directArgsError(parseArgs([...base, '--prefecture', '大阪府,京都府'])), null, 'CLI: 対象外でなければ通る');
  ok(directArgsError(parseArgs([...base, '--prefecture', '大阪府,愛媛県'])), 'CLI: 6県が含まれていたら診断前にエラー');
  ok(directArgsError(parseArgs([...base])), 'CLI: --prefecture なし(全県)は対象外の県が含まれるのでエラー');
  const pa = parseArgs([...base, '--prefecture', '大阪府', '--min-days-since-sent-wh', '30', '--dry-run']);
  eq([pa.direct, pa.withPage, pa.minDaysSinceSentWh, pa.dryRun], [true, true, 30, true], 'CLI: --direct は専用ページ付き・日数・--dry-run');
  eq(parseArgs(['--source', 'warehouse']).direct, undefined, 'CLI: --direct なしなら今までどおり');

  // ---- 直接送信の実行(営業管理に未登録の店が通る) ----
  const r = await runDirect();
  ok(!r.error, '実行できる: ' + (r.error && r.error.message));
  const code = r.res.batches[0].code;
  ok(WS.WH_BATCH_CODE_RE.test(code), 'バッチコードの頭が whd_: ' + code);
  eq(r.res.batches.map((b) => [b.count, b.file]), [[3, `send_${code}.csv`]], '送信対象は3社(未登録の店・紐付け済みの店)');
  eq(r.res.items.map((i) => i.rec.store_id), ['5001', '5002', '5003'], '営業管理に未登録(stoc_store_id が空)の店が通る');
  eq(r.res.excluded, { '送信先URLなし': 1, '倉庫の店IDなし': 1, '倉庫に店がない': 1 }, '送らない理由(営業管理に未登録とは言わない)');
  eq(r.calls.fetchShops, [[5001, 5002, 5003, 5006]], '店の情報は倉庫から取る(倉庫の店ID)');

  // 9列CSV: 評価・電話・住所は倉庫の値(STOCの形に合わせた S.ratingInfo / S.contactPhone)
  const csv = parseCsv(r.files[`send_${code}.csv`]);
  eq(csv[0], O.SENDER_HEADER, '9列CSVのヘッダは営業管理経由と同じ');
  eq(csv.slice(1).map((x) => x.length), [9, 9, 9], '9列');
  eq([csv[1][0], csv[1][1], csv[1][5], csv[1][6], csv[1][7], csv[1][8]], ['https://www.k1.co.jp/contact/', '株式会社倉庫一', '評価4.2(口コミ15件)', code, '06-1111-0001', '大阪府大阪市中央区1-2-3'], '1行目: 会社名・評価・コード・電話・住所は倉庫の値');
  eq([csv[2][5], csv[2][7], csv[2][8]], ['(口コミ3件)', '', '京都府京都市1-1'], '2行目: 口コミのみ・電話なし');
  eq([csv[3][5], csv[3][7], csv[3][8]], ['評価3.0', '', ''], '3行目: 電話・住所が null でも空欄');
  ok(csv[1][3].startsWith('https://webdock.example.test/r/Tok0000001'), '4列目は専用ページのURL');
  ok(csv[1][2].startsWith('御社サイト(k1.co.jp)を確認したところ、'), '3列目は専用ページ版の一文');

  // 専用ページ: 倉庫の店・営業管理の店IDなし・origin=warehouse
  eq(r.calls.pagesCreate.length, 1, '専用ページを作る(withPage を渡さなくても必ず付く)');
  eq(r.calls.pagesCreate[0].map((p) => [p.shopId, p.stocStoreId, p.origin, p.batchCode]), [['5001', null, 'warehouse', code], ['5002', null, 'warehouse', code], ['5003', null, 'warehouse', code]], '専用ページ: stocStoreId は null・origin は warehouse');

  // 倉庫の送信履歴へのINSERT(1トランザクション)
  const ops = r.pool.log.map((l) => l.op);
  eq(ops, ['begin', 'query', 'query', 'commit', 'release'], '1トランザクション(batches → sends → commit)');
  const [qb, qs] = r.pool.log.filter((l) => l.op === 'query');
  ok(/^INSERT INTO stoc_master\.webdock_send_batches \(batch_code, item_count, filter_json, out_dir\) VALUES/.test(qb.sql), 'webdock_send_batches へのINSERT');
  eq(qb.params.slice(0, 2), [code, 3], 'バッチ: コードと件数');
  const f = JSON.parse(qb.params[2]);
  eq([f.source, f.direct, f.with_page, f.batch_no, f.min_days_since_sent_wh], ['webdock_direct', true, true, 1, undefined], 'バッチの絞り込み条件: source=webdock_direct');
  ok(typeof qb.params[3] === 'string' && qb.params[3].startsWith('direct-'), 'バッチ: 出力フォルダ名');
  eq(qs.sql, 'INSERT INTO stoc_master.webdock_sends (shop_id,batch_code,finding_key,finding_sentence,page_token,form_url,form_url_key,matched_stoc_store_id) VALUES ?', 'webdock_sends へのINSERT');
  const vals = qs.params[0];
  eq(vals.map((v) => [v[0], v[1], v[2], v[4], v[5], v[6], v[7]]), [
    [5001, code, 'no_https', 'Tok0000001', 'https://www.k1.co.jp/contact/', SHA1('https://www.k1.co.jp/contact'), 900],
    [5002, code, 'cms', 'Tok0000002', 'https://www.k2.co.jp/contact/', SHA1('https://www.k2.co.jp/contact'), null],
    [5003, code, 'mixed', 'Tok0000003', 'https://www.k3.co.jp/contact/', SHA1('https://www.k3.co.jp/contact'), 77],
  ], 'webdock_sends の値(店ID・コード・指摘・ページ・送信先URL・SHA1・一致した営業管理の店)');
  ok(vals.every((v) => typeof v[3] === 'string' && v[3].startsWith('御社サイト(')), '指摘の一文を残す');
  eq(r.calls.pagesRemove, [], '成功したらページは消さない');

  // 営業管理(stoc_sales)には書き込まない
  eq(writesToStoc(r.pool.log), [], '営業管理(stoc_sales)への書き込みSQLがない');
  ok(sqlsOf(r.pool.log).every((s) => /stoc_master\./.test(s) && !/\bstoc_sales\b/.test(s)), '発行したSQLはすべて倉庫(stoc_master)だけ');

  // まとめ.txt・result.json
  const sum = r.files['まとめ.txt'];
  ok(sum.includes('営業管理には登録していません。送信結果の取り込みは今後の機能で対応します'), 'まとめ.txt: 営業管理には登録していません・取り込みは今後の機能');
  ok(!sum.includes('STOC営業管理にバッチを登録済みです') && !sum.includes('結果はバッチコードでSTOCへ戻ります'), 'まとめ.txt: STOCへ戻る旨は書かない');
  ok(sum.includes('倉庫の送信履歴で送信済み(日数以内): 4社') && sum.includes('フリーダイヤル・ナビダイヤル(0120/0800/0570)だけで営業管理の店と一致した店(要確認・送っていません): 1社 → 要確認_freedial.csv'), 'まとめ.txt: 診断前の除外・要確認の件数');
  ok(sum.includes('origin=warehouse') && !sum.includes('見込み客(/report-leads)'), 'まとめ.txt: 専用ページは倉庫だけに記録');
  const rj = JSON.parse(r.files['result.json']);
  eq([rj.direct, rj.withPage, rj.dryRun, rj.reviewCount, rj.note], [true, true, false, 1, '営業管理には登録していません。送信結果の取り込みは今後の機能で対応します'], 'result.json: direct');
  // フリーダイヤルのみ一致は送らない・一覧に出す
  ok(!csv.some((x) => x.join(',').includes('本部系')) && !r.files['確認用.csv'].includes('5100'), 'フリーダイヤルのみ一致の店は送信CSV・確認用に入らない');
  const rv = parseCsv(r.files['要確認_freedial.csv']);
  eq(rv, [['store_id', '店名', '住所', '電話番号', '一致したフリーダイヤル等', 'その番号を持つ営業管理の店数', '営業管理の店ID'], ['5100', '本部系', '東京都千代田区1-1-1', '03-0000-0005', '0120555555', '2', '105 / 106']], '要確認_freedial.csv');
  const chk = parseCsv(r.files['確認用.csv']);
  eq(chk.slice(1).map((x) => x[1]), ['900', '', '77'], '確認用.csv: 一致した営業管理の店ID(なければ空)');

  // ---- 失敗したらページを消す ----
  {
    const bad = await runDirect({ pool: fakePool({ failOn: /INSERT INTO stoc_master\.webdock_sends/ }) });
    ok(bad.error && /boom/.test(bad.error.message), '履歴の書き込みに失敗したら例外');
    eq(bad.calls.pagesRemove, [['Tok0000001', 'Tok0000002', 'Tok0000003']], '作った専用ページを消す');
    eq(bad.pool.log.map((l) => l.op), ['begin', 'query', 'query', 'rollback', 'release'], 'ROLLBACK する');
    eq(writesToStoc(bad.pool.log), [], '失敗時も営業管理へは書かない');
    ok(!('send_whd' in bad.files) && !Object.keys(bad.files).some((n) => n.startsWith('send_')), '失敗したら送信CSVは作らない');
    const perm = await runDirect({ pool: fakePool({ failOn: /INSERT INTO stoc_master\.webdock_send_batches/, failErr: Object.assign(new Error('denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR', errno: 1142 }) }) });
    ok(perm.error && perm.error.stocCheck && perm.error.message.includes('GRANT SELECT, INSERT, UPDATE ON stoc_master.webdock_sends'), '権限がなければ GRANT を示して中止');
    const nt = await runDirect({ pool: fakePool({ failOn: /webdock_send_batches/, failErr: Object.assign(new Error("Table doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 }) }) });
    ok(nt.error && nt.error.stocCheck && nt.error.message.includes('warehouse_migrate_010.sql'), '表がなければ移行010を案内');
  }

  // ---- 試し(--dry-run): 倉庫に何も書かない ----
  {
    const d = await runDirect({ dryRun: true });
    ok(!d.error, '試しは実行できる: ' + (d.error && d.error.message));
    eq([d.calls.pagesCreate.length, d.pool.log.length, d.calls.createBatch], [0, 0, undefined], '試し: ページも送信履歴も書かない');
    eq(d.res.batches.map((b) => b.code), ['DRYRUN'], '試し: 仮のバッチコード');
    ok(d.files['まとめ.txt'].includes('*** 倉庫から直接(--dry-run) ***') && d.files['まとめ.txt'].includes('営業管理には登録していません'), '試し: まとめ.txt');
    eq(JSON.parse(d.files['result.json']).dryRun, true, '試し: result.json');
  }

  // ---- 6県以外でも、倉庫から直接のオプションを渡さなければ今までどおり(関数の分岐) ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-stoc-'));
    let err = null;
    try { await O.buildSingleFiles({ rows: ROWS(), outDir: dir, templates: T, now: NOW, dryRun: true, stoc: { fetchStores: async () => new Map() } }); } catch (e) { err = e; }
    ok(!err, '営業管理経由: direct なしは今までどおり');
    const txt = fs.readFileSync(path.join(dir, 'まとめ.txt'), 'utf8');
    ok(txt.includes('STOC未登録(--dry-run-stoc)') && !txt.includes('倉庫から直接') && !fs.existsSync(path.join(dir, '要確認_freedial.csv')), '営業管理経由: まとめ.txt・ファイルは今までどおり(要確認は出さない)');
    ok(!('direct' in JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'))), '営業管理経由: result.json に direct を足さない');
    let e2 = null;
    try { await O.buildSingleFiles({ rows: [], outDir: dir, templates: T, direct: true, dryRun: true }); } catch (e) { e2 = e; }
    ok(e2 && /wh/.test(e2.message), '直接なのに wh がなければ例外');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- 倉庫の店の取り出し ----
  {
    const pool = { async query(sql, params) { this.q = { sql, params }; return [[{ id: 5001, name: 'A', phone: '06-1', address_raw: '大阪府1', rating: '4.5', review_count: 9, website_url: 'https://a.jp' }]]; } };
    const m = await WS.fetchWarehouseShops(pool, [5001, '5001', 0, -1, 'x', 5001.5]);
    eq([...m.entries()], [[5001, { name: 'A', phone: '06-1', address: '大阪府1', gbp_rating: '4.5', gbp_review_count: 9, website_url: 'https://a.jp' }]], '倉庫の店: STOCの店と同じ名前の項目にそろえる');
    ok(/^SELECT id, name, phone, address_raw, rating, review_count, website_url FROM stoc_master\.shops WHERE id IN \(\?\)$/.test(pool.q.sql) && JSON.stringify(pool.q.params) === '[[5001]]', '倉庫の店: SELECT だけ・店IDは整数のみ');
  }

  // ---- 履歴の書き込み: 入力の検査 ----
  {
    const pool = fakePool();
    let e1 = null, e2 = null, e3 = null;
    try { await WS.createBatch(pool, { code: 'sender_20261110_100203_1a2b', items: [{ shopId: 1, formUrl: 'https://a.jp' }] }); } catch (e) { e1 = e; }
    ok(e1 && /形式が不正/.test(e1.message) && pool.log.length === 0, 'sender_ のコードは履歴に書けない(STOCと混ざらない)');
    try { await WS.createBatch(pool, { code: 'whd_20261110_100203_1a2b', items: [] }); } catch (e) { e2 = e; }
    ok(e2 && pool.log.length === 0, '0件は書かない');
    const many = Array.from({ length: 1200 }, (_, i) => ({ shopId: i + 1, formUrl: `https://a${i}.jp`, key: 'cms', sentence: 's', pageToken: 'T', matchedStocStoreId: i === 0 ? 5 : undefined }));
    await WS.createBatch(pool, { code: 'whd_20261110_100203_1a2b', items: many, filter: { x: 1 } });
    eq(pool.log.filter((l) => l.op === 'query' && /webdock_sends/.test(l.sql)).map((l) => l.params[0].length), [500, 500, 200], '履歴: 500件ずつ');
    eq(pool.log.filter((l) => l.op === 'query' && /webdock_sends/.test(l.sql))[0].params[0][0][7], 5, '履歴: 一致した営業管理の店ID');
    const tooMany = Array.from({ length: 5001 }, (_, i) => ({ shopId: i + 1, formUrl: 'https://a.jp' }));
    try { await WS.createBatch(fakePool(), { code: 'whd_20261110_100203_1a2b', items: tooMany }); } catch (e) { e3 = e; }
    ok(e3 && /5000件まで/.test(e3.message), '1バッチは5000件まで');
  }

  // ---- 権限の事前確認(営業管理は読み取りだけ) ----
  {
    const pool = fakePool();
    await WS.checkDirectAccess(pool, { dryRun: true });
    const s1 = sqlsOf(pool.log);
    ok(s1.length >= 7 && s1.every((s) => /^SELECT /.test(s)), '試し: 読み取り(SELECT)だけ');
    ok(s1.some((s) => /FROM stoc_sales\.stores/.test(s)) && s1.some((s) => /FROM stoc_sales\.sales_logs/.test(s)) && s1.some((s) => /FROM stoc_sales\.inquiry_export_items/.test(s)) && s1.some((s) => /FROM stoc_sales\.inquiry_export_batches/.test(s)), '営業管理は stores・sales_logs・inquiry_export_* を読む');
    const pool2 = fakePool();
    let pagesChecked = 0;
    await WS.checkDirectAccess(pool2, { checkPages: async () => { pagesChecked++; } });
    const s2 = sqlsOf(pool2.log);
    eq(s2.filter((s) => /^INSERT/.test(s)).map((s) => s.match(/INTO (\S+)/)[1]), ['stoc_master.webdock_send_batches', 'stoc_master.webdock_sends'], '書き込みの確認は倉庫の履歴の表だけ(0行を対象にした文)');
    ok(s2.filter((s) => /^INSERT/.test(s)).every((s) => /WHERE 1 = 0$/.test(s)), '確認では何も書かない');
    eq(writesToStoc(pool2.log), [], '営業管理への書き込みの確認はしない(権限も要らない)');
    eq(pagesChecked, 1, '専用ページ(倉庫側)の確認を呼ぶ');
    let none = 0;
    await WS.checkDirectAccess(fakePool(), { dryRun: true, checkPages: async () => { none++; } });
    eq(none, 0, '試しでは専用ページの書き込みを確認しない');
    const denied = { async query(sql) { if (/webdock_sends/.test(sql) && /^INSERT/.test(sql)) throw Object.assign(new Error('denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR', errno: 1142 }); return [[]]; } };
    let e1 = null;
    try { await WS.checkDirectAccess(denied, {}); } catch (e) { e1 = e; }
    ok(e1 && e1.stocCheck && e1.message.includes('GRANT SELECT, INSERT, UPDATE ON stoc_master.webdock_send_batches') && !/GRANT[^\n]*stoc_sales/.test(e1.message), '権限がなければ倉庫の表の GRANT を示す(営業管理への GRANT は求めない)');
    const missing = { async query() { throw Object.assign(new Error('no table'), { errno: 1146 }); } };
    let e2 = null;
    try { await WS.checkDirectAccess(missing, { dryRun: true }); } catch (e) { e2 = e; }
    ok(e2 && e2.stocCheck && e2.message.includes('warehouse_migrate_010.sql'), '表がなければ移行010を案内');
  }
  // 専用ページの確認も倉庫側だけ
  {
    const pool = fakePool();
    await PG.checkWarehousePageAccess(pool);
    ok(sqlsOf(pool.log).length === 4 && sqlsOf(pool.log).every((s) => /stoc_master\.webdock_pages/.test(s) && !/stoc_sales/.test(s)), '専用ページの確認: 倉庫の webdock_pages だけ(営業管理の権限は要らない)');
    const nocol = { async query() { throw Object.assign(new Error("Unknown column 'origin'"), { errno: 1054 }); } };
    let e = null;
    try { await PG.checkWarehousePageAccess(nocol); } catch (x) { e = x; }
    ok(e && e.pageCheck && e.message.includes('warehouse_migrate_010.sql'), 'origin 列がなければ移行010を案内');
  }
  // 専用ページの作成: origin は直接送信のときだけ書く(営業管理経由のSQLは今までどおり)
  {
    const pool = { log: [], async query(sql, params) { this.log.push({ sql, params }); return [{}]; } };
    const store = PG.createPageStore(pool, { env: {} });
    await store.create([{ shopId: '1', stocStoreId: 10, batchCode: 'sender_x', domain: 'a.jp', company: 'A', findingKey: 'cms', sentence: 's', findings: [], audience: 'x' }]);
    ok(!/origin/.test(pool.log[0].sql) && pool.log[0].params[0][0].length === 10, '営業管理経由: origin 列を書かない(今までと同じSQL)');
    await store.create([{ shopId: '2', stocStoreId: null, batchCode: 'whd_x', domain: 'b.jp', company: 'B', findingKey: 'cms', sentence: 's', findings: [], audience: 'x', origin: 'warehouse' }]);
    ok(pool.log[1].sql.includes('audience,origin) VALUES ?') && pool.log[1].params[0][0].length === 11 && pool.log[1].params[0][0][10] === 'warehouse' && pool.log[1].params[0][0][2] === null, '直接: origin=warehouse・stoc_store_id は NULL');
  }

  console.log(`direct: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { restoreRandom(); console.error(e); process.exit(1); });
