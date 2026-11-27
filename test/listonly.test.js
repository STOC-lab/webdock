'use strict';
/**
 * 「送信リストだけ作る(診断なし・倉庫から直接)」(--direct --no-scan)のテスト。DB・ネット不要(偽の接続)。
 *   確かめること: 候補の選別(画像認証・営業お断り・フォームURLなし・重複) / 9列CSV(3列目は空・[param2]=お客様) / whd_ のコード /
 *   createBatch に key・sentence・pageToken が null・list_only の絞り込み / 試し(--dry-run)は何も書かない / 5,000件超は複数バッチ /
 *   まとめ.txt の文言 / 管理画面の引数 / --no-scan の引数検査
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../src/listOnly');
const S = require('../src/stocBatch');
const WS = require('../src/warehouseSends');
const { buildListOnlyArgs } = require('../src/adminWarehouse');
const { parseArgs, noScanArgsError } = require('../cli/batch-scan');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);

const NOW = new Date('2026-11-10T01:02:03Z');
const REAL_RANDOM = Math.random;

// 倉庫の行(loadWarehouseRows と同じ形)
const row = (id, o = {}) => ({
  store_id: String(id), name: `店${id}`, url: `https://www.s${id}.example.jp/`, formUrl: `https://www.s${id}.example.jp/contact/`,
  captcha: 'なし', noSales: '', phone: '', address: '', ...o,
});
const shop = (id) => ({ name: `倉庫店${id}`, phone: `06-0000-${String(id).slice(-4)}`, address: `大阪府${id}`, gbp_rating: '4.0', gbp_review_count: 10, website_url: `https://www.s${id}.example.jp/` });

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

async function run(rows, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listonly-'));
  const calls = { fetch: [], create: [] };
  let error = null, res = null;
  try {
    res = await L.buildListOnlyFiles({
      rows, outDir: dir, now: NOW, dryRun: !!over.dryRun, limit: over.limit || 0,
      filter: { prefecture: '大阪府', main_category: '美容', limit: 0 },
      preExcluded: { '倉庫の送信履歴で送信済み(日数以内)': 4 },
      matchedByShop: over.matchedByShop || new Map([['1', 900]]),
      reviewRows: over.reviewRows || [],
      wh: {
        fetchShops: async (ids) => { calls.fetch.push(ids); return new Map(ids.filter((i) => !(over.noShop || []).includes(i)).map((i) => [i, shop(i)])); },
        createBatch: async (o) => { calls.create.push(JSON.parse(JSON.stringify(o))); if (over.failAt === calls.create.length) throw new Error('boom'); return { code: o.code, count: o.items.length }; },
      },
    });
  } catch (e) { error = e; }
  const files = {};
  for (const n of fs.readdirSync(dir).sort()) files[n] = fs.readFileSync(path.join(dir, n), 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return { res, error, files, calls };
}

(async () => {
  Math.random = () => 0x1a2b / 0x10000;
  // ---- 候補の選別 ----
  {
    const rows = [
      row(1), row(2, { captcha: 'あり' }), row(3, { noSales: 'あり' }), row(4, { formUrl: '' }), row(5, { store_id: '' }),
      row(6, { formUrl: 'https://www.s1.example.jp/contact' }), // 1番と同じURL(末尾の/だけ違う)
      row(7), row(8, { formUrl: 'https://www.s7.example.jp/contact/' }), // 7番と同じURL
      row(9),
    ];
    const r = await run(rows, { noShop: [9] });
    ok(!r.error, '選別: エラーなし: ' + (r.error && r.error.message));
    eq(r.res.items.map((i) => i.shopId), [1, 7], '選別: 残るのは1と7');
    eq(r.res.excluded, { 画像認証あり: 1, 営業お断りの記載あり: 1, 送信先URLなし: 1, 倉庫の店IDなし: 1, 送信先URL重複: 2, 倉庫に店がない: 1 }, '選別: 除外理由の件数');
    eq(r.calls.fetch[0], [1, 7, 9], '選別: 倉庫の店は候補だけ引く');
    // CSV
    const csvName = Object.keys(r.files).find((n) => /^send_whd_\d{8}_\d{6}_[0-9a-f]{4}\.csv$/.test(n));
    ok(csvName, 'CSV名は send_whd_…csv');
    const t = parseCsv(r.files[csvName]);
    ok(r.files[csvName].startsWith('﻿'), 'CSV: BOM付き');
    eq(t[0], ['送信先URL', '会社名', '', 'レポートURL', '業種', '評価・口コミ', 'STOCバッチコード', '電話番号', '住所'], 'CSV: ヘッダー9列');
    eq(t.length, 3, 'CSV: ヘッダー+2社');
    ok(t.every((x) => x.length === 9), 'CSV: 全行9列');
    const code = csvName.replace(/^send_|\.csv$/g, '');
    eq(t[1], ['https://www.s1.example.jp/contact/', '倉庫店1', '', 's1.example.jp', 'お客様', S.ratingInfo(shop(1)), code, S.contactPhone(shop(1)), '大阪府1'], 'CSV: 1行目(3列目は空・4列目ドメイン・5列目お客様)');
    ok(WS.WH_BATCH_CODE_RE.test(code) && code === 'whd_20261110_100203_1a2b', 'バッチコードは whd_');
    // 倉庫の送信履歴
    eq(r.calls.create.length, 1, 'createBatch は1回');
    const c = r.calls.create[0];
    eq(c.items, [
      { shopId: 1, key: null, sentence: null, pageToken: null, formUrl: 'https://www.s1.example.jp/contact/', matchedStocStoreId: 900 },
      { shopId: 7, key: null, sentence: null, pageToken: null, formUrl: 'https://www.s7.example.jp/contact/', matchedStocStoreId: null },
    ], 'createBatch: key・sentence・pageToken は null・照合した営業管理の店ID');
    ok(c.filter.list_only === true && c.filter.direct === true && c.filter.with_page === false && c.filter.batch_no === 1 && c.filter.batch_total === 1, 'createBatch: list_only の絞り込み');
    eq(c.fileName, csvName, 'createBatch: ファイル名');
    // まとめ・result.json
    const sm = r.files['まとめ.txt'];
    ok(sm.includes('診断なし') && sm.includes('営業管理には登録していません') && sm.includes('毎時自動で倉庫に取り込まれます'), 'まとめ: 診断なし・営業管理に未登録・毎時取り込み');
    ok(sm.includes('倉庫の送信履歴で送信済み(日数以内): 4社') && sm.includes('画像認証あり: 1社') && sm.includes('送信対象: 2社'), 'まとめ: 件数');
    ok(!('要確認_freedial.csv' in r.files) && !('本文.txt' in r.files) && !('確認用.csv' in r.files), '要確認なし・本文なし');
    const js = JSON.parse(r.files['result.json']);
    eq([js.listOnly, js.direct, js.count, js.batches.length, js.withPage], [true, true, 2, 1, false], 'result.json');
  }
  // ---- 上限件数は、送れない店を外したあとで数える ----
  {
    const r = await run([row(1, { captcha: 'あり' }), row(2), row(3, { captcha: 'あり' }), row(4), row(5)], { limit: 2 });
    ok(!r.error, '上限: エラーなし');
    eq(r.res.items.map((i) => i.shopId), [2, 4], '上限2: 画像認証を外したあとの先頭2社(順序そのまま)');
    eq(r.calls.fetch[0], [2, 4], '上限: 倉庫の店は区切った分だけ引く');
    eq(r.calls.create[0].items.map((i) => i.shopId), [2, 4], '上限: 送信履歴に記録するのも区切った分だけ');
    eq([r.res.pickedCount, r.res.cutCount], [3, 1], '上限: 外した後3社・区切りで1社');
    const sm = r.files['まとめ.txt'];
    ok(sm.includes('上限件数: 2社') && sm.includes('上限 2社で区切って 送信対象 2社') && sm.includes('送れない店を外して 3社'), 'まとめ: 上限の説明');
    ok(!sm.includes('上限件数を超えた'), 'まとめ: 送らない理由には並べない');
    ok(sm.includes('送らない: 2社'), 'まとめ: 送らない社数は区切り分を含めない');
    const js = JSON.parse(r.files['result.json']);
    eq([js.limit, js.pickedCount, js.cutCount, js.count], [2, 3, 1, 2], 'result.json: 上限');
    const n = await run([row(1), row(2)], { limit: 5 });
    eq([n.res.items.length, n.res.cutCount], [2, 0], '上限が多ければ区切らない');
  }
  // ---- 要確認_freedial ----
  {
    const r = await run([row(1)], { reviewRows: [{ row: { store_id: '5100', name: '本部系', address: '東京', phone: '03-1' }, free: [{ number: '0120555555', stores: 2 }], freeIds: [105, 106] }] });
    ok(r.files['要確認_freedial.csv'] && r.files['要確認_freedial.csv'].includes('0120555555'), '要確認_freedial.csv を出す');
    ok(r.files['まとめ.txt'].includes('要確認・送っていません): 1社'), 'まとめ: 要確認の件数');
  }
  // ---- 試し(--dry-run) ----
  {
    const r = await run([row(1), row(2)], { dryRun: true });
    eq(r.calls.create.length, 0, '試し: createBatch を呼ばない');
    ok(r.files['send_DRYRUN.csv'] && r.res.batches[0].code === 'DRYRUN', '試し: コードは DRYRUN');
    ok(r.files['まとめ.txt'].includes('--dry-run'), '試し: まとめに明記');
  }
  // ---- 5,000件超は複数バッチ(同じ秒でもコードは重ならない) ----
  {
    const n = S.BATCH_MAX + 1;
    const r = await run(Array.from({ length: n }, (_, i) => row(i + 1)));
    eq(r.res.batches.map((b) => b.count), [S.BATCH_MAX, 1], '分割: 5,000+1');
    eq(new Set(r.res.batches.map((b) => b.code)).size, 2, '分割: コードは別');
    ok(r.res.batches.every((b) => WS.WH_BATCH_CODE_RE.test(b.code)), '分割: どちらも whd_ の形式');
    eq(r.calls.create.map((c) => [c.filter.batch_no, c.filter.batch_total]), [[1, 2], [2, 2]], '分割: batch_no / batch_total');
    const d = await run(Array.from({ length: n }, (_, i) => row(i + 1)), { dryRun: true });
    eq(d.res.batches.map((b) => b.code), ['DRYRUN', 'DRYRUN-2'], '分割(試し): DRYRUN, DRYRUN-2');
  }
  // ---- 2つ目の登録に失敗: 登録済みのコードを案内 ----
  {
    const r = await run(Array.from({ length: S.BATCH_MAX + 1 }, (_, i) => row(i + 1)), { failAt: 2 });
    ok(r.error && /boom/.test(r.error.message) && /登録済みのバッチ: whd_/.test(r.error.message), '失敗: 登録済みバッチのコードを案内');
  }
  // ---- 古いファイルを消す ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listonly-clean-'));
    fs.writeFileSync(path.join(dir, 'send_whd_old.csv'), 'x'); fs.writeFileSync(path.join(dir, 'まとめ.txt'), 'old'); fs.writeFileSync(path.join(dir, 'keep.txt'), 'k');
    await L.buildListOnlyFiles({ rows: [row(1)], outDir: dir, now: NOW, dryRun: true, wh: { fetchShops: async (ids) => new Map(ids.map((i) => [i, shop(i)])), createBatch: async () => ({}) } });
    const names = fs.readdirSync(dir);
    ok(!names.includes('send_whd_old.csv') && names.includes('keep.txt') && fs.readFileSync(path.join(dir, 'まとめ.txt'), 'utf8') !== 'old', '古い send_*.csv・まとめ.txt は消す(他のファイルは残す)');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  Math.random = REAL_RANDOM;

  // ---- 管理画面の引数 ----
  {
    const exportDir = '/x/exports';
    const now = new Date('2026-10-25T01:15:00Z');
    const b = buildListOnlyArgs({ pref: ['大阪府', '京都府'], main_category: '美容、エステ', size: 'exclude_large', limit: '3000', direct_days: '30' }, { exportDir, now });
    eq(b.args, ['cli/batch-scan.js', '--source', 'warehouse', '--template', 'b2b', '--prefecture', '大阪府,京都府', '--main-category', '美容,エステ', '--form-found', '--exclude-large',
      '--limit', '3000', '--single-out', '/x/exports/b2b_20261025-101500', '--direct', '--no-scan', '--min-days-since-sent-wh', '30'], '管理: 引数');
    eq([b.singleDir, b.direct, b.listOnly, b.withPage, b.estimateHours], ['b2b_20261025-101500', true, true, false, 1], '管理: 戻り値');
    eq(buildListOnlyArgs({ pref: ['大阪府'] }, { exportDir, now }).args.slice(-2), ['--min-days-since-sent-wh', '60'], '管理: 既定60日');
    ok(buildListOnlyArgs({ pref: ['大阪府', '兵庫県'] }, { exportDir, now }).error, '管理: 6県は拒否(兵庫)');
    for (const p of ['岡山県', '徳島県', '香川県', '愛媛県', '高知県']) ok(buildListOnlyArgs({ pref: [p] }, { exportDir, now }).error, `管理: ${p}は拒否`);
    ok(buildListOnlyArgs({ pref: ['大阪府'], preset: 'stocsent' }, { exportDir, now }).error, '管理: 送信成功済みの店は拒否');
    ok(buildListOnlyArgs({ pref: [] }, { exportDir, now }).error, '管理: 県なし');
    ok(buildListOnlyArgs({ pref: ['大阪府'], direct_days: '-1' }, { exportDir, now }).error, '管理: 不正な日数');
    ok(buildListOnlyArgs({ pref: ['大阪府'], limit: '1;x' }, { exportDir, now }).error, '管理: 不正な上限');
    ok(buildListOnlyArgs({ pref: ['大阪府'], limit: '1000001' }, { exportDir, now }).error, '管理: 上限超え');
    ok(!buildListOnlyArgs({ pref: ['大阪府'], limit: '1000000' }, { exportDir, now }).error, '管理: 上限100万まで');
    ok(buildListOnlyArgs({ pref: ['大阪府'], main_category: 'あ'.repeat(21) }, { exportDir, now }).error, '管理: 長すぎるキーワード');
  }

  // ---- --no-scan の引数検査 ----
  {
    const base = ['--source', 'warehouse', '--template', 'b2b', '--single-out', '/x/o', '--prefecture', '大阪府'];
    const a1 = parseArgs([...base, '--direct', '--no-scan']);
    eq([a1.noScan, a1.direct, !!a1.withPage, noScanArgsError(a1)], [true, true, false, null], '--direct --no-scan: 専用ページなし・検査OK');
    const a2 = parseArgs([...base, '--no-scan']);
    ok(noScanArgsError(a2), '--no-scan だけは拒否');
    const a3 = parseArgs([...base, '--direct']);
    eq([!!a3.noScan, a3.withPage, noScanArgsError(a3)], [false, true, null], '--direct だけ(診断あり)は今までどおり専用ページ付き');
  }

  console.log(`listonly: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { Math.random = REAL_RANDOM; console.error(e); process.exit(1); });
