'use strict';
// 単一本文方式(src/outreachSingle.js)と STOC バッチ登録(src/stocBatch.js)のテスト。DB不要(偽の接続を使う)
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../src/stocBatch');
const O = require('../src/outreachSingle');
const { classifyIndustry, audienceOf, loadTemplates } = require('../src/outreach');
const { parseArgs, parseDelimited } = require('../cli/batch-scan');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);

const T = loadTemplates();
const ENV = { WH_DB_USER: 'stoc_wh', WH_DB_HOST: '127.0.0.1' };

/** 偽の接続: 発行されたSQLを記録する。failOn に正規表現を渡すと、そのSQLで例外 */
function fakePool({ failOn, failErr, startId = 77 } = {}) {
  const log = [];
  const conn = {
    async beginTransaction() { log.push({ op: 'begin' }); },
    async commit() { log.push({ op: 'commit' }); },
    async rollback() { log.push({ op: 'rollback' }); },
    release() { log.push({ op: 'release' }); },
    async query(sql, params) {
      log.push({ op: 'query', sql, params });
      if (failOn && failOn.test(sql)) throw failErr || new Error('boom');
      if (/^INSERT INTO \S*inquiry_export_batches/.test(sql)) return [{ insertId: startId }];
      return [{ affectedRows: 1 }];
    },
  };
  return { log, async getConnection() { return conn; }, async query(sql, params) { log.push({ op: 'pool', sql, params }); return [[]]; } };
}

const store = (id, o = {}) => ({
  id, name: `会社${id}`, status: '未対応', phone: '', phone_mobile: '', phone_free: '', address: `兵庫県姫路市${id}`, prefecture: '兵庫県', category: '製造',
  website_url: `https://www.c${id}.jp/`, gbp_url: null, gbp_rating: null, gbp_review_count: null, score: 40, ...o,
});
const rec = (id, key, o = {}) => ({
  store_id: String(1000 + id), stoc_store_id: String(id), 店名: `倉庫名${id}`, URL: `https://www.c${id}.jp/`, 業種: '金属加工業', 業種区分: '製造',
  問い合わせURL: `https://www.c${id}.jp/contact`, 画像認証: 'なし', 営業お断り: '', 指摘種別: key, 送信推奨: 'はい', ...o,
});

(async () => {
  // ---- STOCと同じ整形 ----
  eq(S.ratingInfo({ gbp_rating: '4.2', gbp_review_count: 15 }), '評価4.2(口コミ15件)', '評価+口コミ');
  eq(S.ratingInfo({ gbp_rating: '4.0', gbp_review_count: null }), '評価4.0', '評価のみ');
  eq(S.ratingInfo({ gbp_rating: null, gbp_review_count: 3 }), '(口コミ3件)', '口コミのみ(STOCと同じ)');
  eq(S.ratingInfo({ gbp_rating: null, gbp_review_count: null }), '', 'なし');
  eq(S.ratingInfo({ gbp_rating: '0', gbp_review_count: 0 }), '', '0は空(PHPの偽)');
  eq(S.ratingInfo({ gbp_rating: '0.0', gbp_review_count: '0' }), '評価0.0', '"0.0"はPHPでは真');
  eq(S.ratingInfo({}), '', '列なし');
  eq(S.contactPhone({ phone: ' 079-1 ', phone_mobile: '090', phone_free: '0120' }), '079-1', '電話: phone 優先(trim)');
  eq(S.contactPhone({ phone: '  ', phone_mobile: '090-1', phone_free: '0120' }), '090-1', '電話: 空なら携帯');
  eq(S.contactPhone({ phone: null, phone_mobile: '', phone_free: '0120-1' }), '0120-1', '電話: 最後にフリーダイヤル');
  eq(S.contactPhone({}), '', '電話なし');
  eq(S.historyPhone('0123456789012345678901234'), '01234567890123456789', '履歴の電話は20文字');

  // ---- バッチコード ----
  const code = S.newBatchCode(new Date('2026-10-25T21:30:05Z'), () => 0xab1);
  eq(code, 'sender_20261026_063005_0ab1', 'バッチコードは日本時間・16進4桁');
  ok(S.BATCH_CODE_RE.test(S.newBatchCode()), 'コードの形式');
  eq(S.splitBatches(Array.from({ length: 12001 }, (_, i) => i), 5000).map((x) => x.length), [5000, 5000, 2001], '5000件で分割');
  eq(S.splitBatches([], 5000), [], '0件は分割なし');

  // ---- 業種区分・閲覧者 ----
  const cls = { 建設会社: '建設', 金属加工業: '製造', 自動車整備工場: '整備', 食品製造業者: '製造', 弁当製造業者: '製造', 居酒屋: '飲食', 弁当屋: '飲食', ラーメン店: '飲食',
    美容室: '美容', ネイルサロン: '美容', 歯科医院: '医療', 動物病院: '医療', 整骨院: '医療', 不明: 'その他', '': 'その他', 自動車整備工場クリニック: '整備', 食堂: '飲食' };
  for (const [c, w] of Object.entries(cls)) eq(classifyIndustry(c), w, '業種区分: ' + c);
  eq(audienceOf('建設'), '協力会社様・発注者様・求職者様', '閲覧者 建設');
  eq(audienceOf('製造'), '取引先様・調達ご担当者様・求職者様', '閲覧者 製造');
  eq(audienceOf('整備'), 'お客様・取引先様・求職者様', '閲覧者 整備');
  eq(audienceOf('その他'), 'お客様・取引先様', '閲覧者 その他');
  eq(audienceOf('飲食'), 'お客様・ご予約のお客様', '閲覧者 飲食');
  eq(audienceOf('美容'), 'お客様・ご予約のお客様', '閲覧者 美容');
  eq(audienceOf('医療'), '患者様・ご家族様', '閲覧者 医療');
  eq(audienceOf('謎'), 'お客様・取引先様', '未知はその他');

  // ---- 一文 ----
  for (const k of ['no_https', 'mixed', 'https_redirect', 'cert_expired', 'cert_expiring', 'js_libs', 'cms', 'headers', 'tls_version']) {
    const s = T.findingsB2b[k]['一文'];
    ok(s && s.startsWith('確認したところ、') && [...s].length <= 115, '一文あり・長さ: ' + k + ' ' + [...(s || '')].length);
  }

  // ---- 本文 ----
  const body = O.renderBody(T);
  ok(body.startsWith('[company]\n\n突然のご連絡失礼いたします。株式会社エストックの森澤と申します。\n[param2]がご覧になる御社サイト「[param1]」を'), '本文冒頭(タグはそのまま・姓だけ)');
  ok(body.includes('\n\n[name]\n\n被害を示すものではありませんが'), '本文: [name] 位置');
  ok(body.includes('「レポート希望」とご返信ください(morisawa@stoc.co.jp)。\n※侵入や負荷をかける検査は行っておりません。'), '本文: 返信先');
  ok(body.endsWith('株式会社エストック 森澤 梓\nTEL:0120-830-046/兵庫県姫路市北条梅原町229'), '本文: 署名');
  ok(!/\{[^}]*\}/.test(body), '本文: 未展開の{}なし');
  for (const tag of ['[company]', '[name]', '[param1]', '[param2]']) eq(body.split(tag).length - 1, 1, 'タグは1回: ' + tag);
  const T2 = { ...T, config: { ...T.config, 担当者名: '山田 太郎', 電話: '03-0000-0000' } };
  ok(O.renderBody(T2).includes('の山田と申します') && O.renderBody(T2).includes('TEL:03-0000-0000/'), '差出人は設定から');

  // ---- 候補の選別 ----
  const rows = [
    rec(1, 'no_https'), rec(2, 'cert_expiring'), rec(3, 'mixed', { stoc_store_id: '' }), rec(4, 'cms', { 問い合わせURL: '' }), rec(5, 'cms', { 画像認証: 'あり' }),
    rec(6, 'cms', { 営業お断り: 'あり' }), rec(7, 'cms', { 送信推奨: '送らない:初回に使える指摘なし', 指摘種別: '' }), rec(8, 'js_libs', { 問い合わせURL: 'https://www.c1.jp/contact' }),
    rec(9, 'headers', { 送信推奨: '送らない:診断できず', 指摘種別: '' }), rec(10, 'unknown'), rec(11, 'tls_version'), rec(12, 'headers', { stoc_store_id: 'abc' }),
  ];
  const pc = O.pickCandidates(rows);
  eq(pc.candidates.map((c) => c.stocId), [1, 2, 11], '送信候補(stoc_store_id必須・重複URLは先勝ち)');
  eq(pc.candidates.map((c) => c.key), ['no_https', 'cert_soon', 'tls_version'], 'cert_expiring は cert_soon');
  eq(pc.excluded, { 営業管理に未登録: 2, 送信先URLなし: 1, 画像認証あり: 1, 営業お断りの記載あり: 1, 初回に使える指摘なし: 1, 送信先URL重複: 1, 診断できず: 1, 指摘種別が不明: 1 }, '除外理由の件数');

  // ---- 一式の生成(偽STOC) ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'single-'));
  try {
    const stores = new Map([
      [1, store(1, { gbp_rating: '4.2', gbp_review_count: 15, phone: '', phone_mobile: '090-1111-2222' })],
      [2, store(2, { gbp_rating: '3.5' })],
      [11, store(11, { status: '契約' })],
    ]);
    const regs = [];
    const stoc = { fetchStores: async (ids) => { eq(ids, [1, 2, 11], 'STOCに問い合わせる店舗ID'); return stores; }, register: async (o) => { regs.push(o); return { code: o.code }; } };
    const res = await O.buildSingleFiles({ rows, outDir: dir, templates: T, now: new Date('2026-10-25T21:30:05Z'), stoc, filter: { prefecture: '兵庫県' }, memoDate: '2026-10-26' });
    eq(res.items.map((i) => i.stocId), [1, 2], '契約の店は除外');
    eq(res.excluded['営業管理で失注・契約'], 1, '契約の除外理由');
    eq(regs.length, 1, '登録は1バッチ');
    ok(S.BATCH_CODE_RE.test(regs[0].code) && regs[0].fileName === `send_${regs[0].code}.csv`, '登録するコードとファイル名');
    eq(regs[0].memo, 'WEBドック B2B診断 2026-10-26', 'メモ');
    eq(regs[0].items.map((i) => [i.stocId, i.formUrl, i.key]), [[1, 'https://www.c1.jp/contact', 'no_https'], [2, 'https://www.c2.jp/contact', 'cert_soon']], '登録する明細');
    const files = fs.readdirSync(dir).sort();
    eq(files, ['result.json', `send_${regs[0].code}.csv`, 'まとめ.txt', '本文.txt', '確認用.csv'].sort(), '出力ファイル');
    const raw = fs.readFileSync(path.join(dir, `send_${regs[0].code}.csv`), 'utf8');
    ok(raw.startsWith('﻿送信先URL,会社名,,レポートURL,業種,評価・口コミ,STOCバッチコード,電話番号,住所\r\n'), 'ヘッダー行・BOM');
    const t = parseDelimited(raw, ',');
    eq(t.length, 3, 'ヘッダー+2行');
    eq(t[1], ['https://www.c1.jp/contact', '会社1', T.findingsB2b.no_https['一文'], 'c1.jp', '取引先様・調達ご担当者様・求職者様', '評価4.2(口コミ15件)', regs[0].code, '090-1111-2222', '兵庫県姫路市1'], '1行目: 9列の対応');
    eq(t[2].slice(2, 8), [T.findingsB2b.cert_expiring['一文'], 'c2.jp', '取引先様・調達ご担当者様・求職者様', '評価3.5', regs[0].code, ''].slice(0, 6), '2行目: 評価のみ・電話なし');
    eq(t[2].length, 9, '9列');
    const chk = parseDelimited(fs.readFileSync(path.join(dir, '確認用.csv'), 'utf8'), ',');
    eq(chk[0], ['store_id', 'stoc_store_id', '会社名', 'ドメイン', '業種区分', '指摘', '一文', '送信先URL', '電話番号', '住所', 'バッチコード'], '確認用のヘッダー');
    eq(chk[1].slice(0, 6), ['1001', '1', '会社1', 'c1.jp', '製造', 'https非対応'], '確認用1行目');
    const sum = fs.readFileSync(path.join(dir, 'まとめ.txt'), 'utf8');
    ok(sum.includes('送信対象: 2社') && sum.includes('営業管理に未登録: 2社') && sum.includes('no_https(https非対応): 1社') && sum.includes('STOC営業管理にバッチを登録済み') && sum.includes('最初の100社'), 'まとめの内容');
    ok(/最頻の一文 \d+文字 \/ 最長の一文 \d+文字/.test(sum), 'まとめ: 文字数');
    eq(fs.readFileSync(path.join(dir, '本文.txt'), 'utf8'), body + '\n', '本文.txt');
    const rj = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
    eq([rj.dryRun, rj.batches[0].code, rj.count], [false, regs[0].code, 2], 'result.json');

    // 本文の長さ(典型値で置換)
    const bl = O.bodyLengths(body, res.items);
    ok(bl.typical > 150 && bl.longest >= bl.typical && bl.longest < 500, '本文の文字数の目安 ' + JSON.stringify(bl));

    // dry-run: 登録せず DRYRUN
    const dir2 = path.join(dir, 'dry');
    const regs2 = [];
    const r2 = await O.buildSingleFiles({ rows, outDir: dir2, templates: T, stoc: { fetchStores: async () => stores, register: async (o) => regs2.push(o) }, dryRun: true });
    eq([regs2.length, r2.batches.map((b) => b.code)], [0, ['DRYRUN']], 'dry-run: 登録しない・コードはDRYRUN');
    ok(fs.existsSync(path.join(dir2, 'send_DRYRUN.csv')) && fs.readFileSync(path.join(dir2, 'まとめ.txt'), 'utf8').includes('STOC未登録'), 'dry-run: CSVとまとめ');
    ok(fs.readFileSync(path.join(dir2, 'send_DRYRUN.csv'), 'utf8').includes(',DRYRUN,'), 'dry-run: 7列目');

    // 5000件超は複数バッチ(各バッチがそれぞれ登録される)
    const big = Array.from({ length: 5003 }, (_, i) => rec(i + 1, 'cms'));
    const bigStores = new Map(big.map((r, i) => [i + 1, store(i + 1)]));
    const regs3 = [];
    const dir3 = path.join(dir, 'big');
    const r3 = await O.buildSingleFiles({ rows: big, outDir: dir3, templates: T, stoc: { fetchStores: async () => bigStores, register: async (o) => { regs3.push(o); } }, now: new Date() });
    eq(regs3.map((o) => o.items.length), [5000, 3], '5003社は5000+3の2バッチ');
    eq(r3.batches.map((b) => b.count), [5000, 3], '結果のバッチ');
    eq(regs3.map((o) => [o.filter.batch_no, o.filter.batch_total]), [[1, 2], [2, 2]], 'filterにバッチ番号');
    eq(fs.readdirSync(dir3).filter((n) => n.startsWith('send_')).length, 2, '送信CSVは2つ');
    const rd = await O.buildSingleFiles({ rows: big, outDir: path.join(dir, 'big2'), templates: T, stoc: { fetchStores: async () => bigStores }, dryRun: true });
    eq(rd.batches.map((b) => b.code), ['DRYRUN', 'DRYRUN-2'], 'dry-run の複数バッチ');

    // 2つ目の登録で失敗: 登録済みコードを案内
    let n = 0;
    try {
      await O.buildSingleFiles({ rows: big, outDir: path.join(dir, 'big3'), templates: T, now: new Date(), stoc: { fetchStores: async () => bigStores, register: async () => { if (++n === 2) throw new Error('2回目失敗'); } } });
      ok(false, '例外になるはず');
    } catch (e) { ok(e.message.includes('2回目失敗') && /登録済みのバッチ: sender_\d{8}_\d{6}_[0-9a-f]{4}/.test(e.message), '途中失敗: 登録済みバッチを案内'); }

    // 0件
    const r0 = await O.buildSingleFiles({ rows: [], outDir: path.join(dir, 'zero'), templates: T, stoc: { fetchStores: async () => { throw new Error('呼ばれない'); }, register: async () => { throw new Error('呼ばれない'); } } });
    eq([r0.batches.length, fs.existsSync(path.join(dir, 'zero', 'まとめ.txt'))], [0, true], '0件でもまとめは出る');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // ---- 登録SQL(偽の接続) ----
  {
    const pool = fakePool();
    const items = Array.from({ length: 1201 }, (_, i) => ({
      stocId: i + 1, store: store(i + 1, { phone: '079-111-2222', gbp_url: 'https://g.example/' + (i + 1) }), formUrl: `https://c${i + 1}.jp/f`, key: 'cms', sentence: 'あ'.repeat(300),
    }));
    const r = await S.registerBatch(pool, {
      code: 'sender_20261026_010203_ab12', fileName: 'send_sender_20261026_010203_ab12.csv', items, memo: 'WEBドック B2B診断 2026-10-26',
      filter: { prefecture: '兵庫県', main_category: '製造,建設' }, userId: 5, env: ENV,
    });
    eq([r.batchId, r.count], [77, 1201], '戻り値');
    const ops = pool.log.map((l) => l.op === 'query' ? l.sql.replace(/\s+/g, ' ').match(/^(?:INSERT INTO|UPDATE) \S+/)[0] : l.op);
    eq(ops, ['begin', 'INSERT INTO stoc_sales.inquiry_export_batches', 'INSERT INTO stoc_sales.inquiry_export_items', 'INSERT INTO stoc_sales.inquiry_export_items', 'INSERT INTO stoc_sales.inquiry_export_items',
      'UPDATE stoc_sales.stores', 'UPDATE stoc_sales.stores', 'UPDATE stoc_sales.stores', 'commit', 'release'], '発行順: begin → batch → items(500件ずつ) → stores(500件ずつ) → commit');
    const q = pool.log.filter((l) => l.op === 'query');
    ok(q[0].sql.includes("VALUES (?,1,'csv',?,'exported',?,?,?,NOW(),?)"), 'バッチINSERT: system_id=1 csv exported NOW()');
    eq(q[0].params.slice(0, 2), ['sender_20261026_010203_ab12', 1201], 'バッチ: コード・件数');
    const fj = JSON.parse(q[0].params[2]);
    eq([fj.for_sender, fj.source, fj.prefecture, fj.main_category], [true, 'webdock_b2b', '兵庫県', '製造,建設'], 'filter_json');
    eq(q[0].params.slice(3), ['send_sender_20261026_010203_ab12.csv', 5, 'WEBドック B2B診断 2026-10-26'], 'exported_file / exported_by / memo');
    eq(q[1].params[0].length, 500, '明細は500件ずつ');
    eq(q[3].params[0].length, 201, '明細の最後は余り');
    const row = q[1].params[0][0];
    eq(row.slice(0, 11), [77, 1, '会社1', '079-111-2222', '兵庫県姫路市1', '兵庫県', '製造', 'https://www.c1.jp/', 'https://c1.jp/f', 'https://g.example/1', ''], '明細: 列の対応(website_url=STOC店舗、inquiry_url=フォーム)');
    eq([row[11], row[12], [...row[13]].length, row[14]], [40, 'WEBドック:cms', 200, 'pending'], '明細: score/approach_label/first_talk(200字)/pending');
    ok(q[1].sql.includes('(batch_id,store_id,shop_name,phone,address,prefecture,category,website_url,inquiry_url,gbp_url,report_url,score,approach_label,first_talk,send_status)'), '明細の列名はSTOCと同じ');
    eq(q[4].params[0].length, 500, 'stores更新は500件ずつ');
    ok(q[4].sql.includes('export_count = export_count + 1') && q[5].sql.includes('exported_at = NOW()'), 'stores更新SQL');
    eq(q[6].params[0].length, 201, 'stores更新の余り');
    // STOC_ITEM_WEBSITE_URL=form: item.website_url にフォームURL
    const pf = fakePool();
    await S.registerBatch(pf, { code: 'c', fileName: 'f', items: items.slice(0, 2), memo: 'm', filter: {}, env: { ...ENV, STOC_ITEM_WEBSITE_URL: 'form' } });
    eq(pf.log.filter((l) => l.op === 'query')[1].params[0].map((r) => [r[7], r[8]]), [['https://c1.jp/f', 'https://c1.jp/f'], ['https://c2.jp/f', 'https://c2.jp/f']], 'STOC_ITEM_WEBSITE_URL=form');
    // 失敗でロールバック
    const bad = fakePool({ failOn: /inquiry_export_items/ });
    let err = null;
    try { await S.registerBatch(bad, { code: 'c', fileName: 'f', items: items.slice(0, 3), memo: 'm', filter: {}, env: ENV }); } catch (e) { err = e; }
    ok(err && err.message === 'boom', '失敗は例外のまま');
    eq(bad.log.filter((l) => l.op !== 'query').map((l) => l.op), ['begin', 'rollback', 'release'], '失敗: begin → rollback → release(commitしない)');
    ok(!bad.log.some((l) => l.op === 'query' && /UPDATE/.test(l.sql)), '失敗: storesは更新しない');
    // 権限エラー
    const denied = fakePool({ failOn: /UPDATE/, failErr: Object.assign(new Error("UPDATE command denied to user 'stoc_wh'@'localhost' for column 'exported_at'"), { code: 'ER_COLUMNACCESS_DENIED_ERROR', errno: 1143 }) });
    let perr = null;
    try { await S.registerBatch(denied, { code: 'c', fileName: 'f', items: items.slice(0, 3), memo: 'm', filter: {}, env: ENV }); } catch (e) { perr = e; }
    ok(perr && perr.stocCheck && perr.message.includes('権限がありません'), '権限エラーは日本語メッセージ');
    eq(denied.log.filter((l) => l.op !== 'query').map((l) => l.op), ['begin', 'rollback', 'release'], '権限エラー: ロールバック');
    ok(await S.registerBatch(fakePool(), { code: 'c', fileName: 'f', items: [], memo: '', filter: {}, env: ENV }).then(() => false, () => true), '0件は登録しない');
  }

  // ---- 権限の事前確認 ----
  {
    const g = S.grantStatements(ENV);
    eq(g, ["GRANT SELECT, INSERT ON stoc_sales.inquiry_export_batches TO 'stoc_wh'@'localhost';", "GRANT SELECT, INSERT ON stoc_sales.inquiry_export_items TO 'stoc_wh'@'localhost';",
      "GRANT SELECT ON stoc_sales.stores TO 'stoc_wh'@'localhost';", "GRANT UPDATE (exported_at, export_count) ON stoc_sales.stores TO 'stoc_wh'@'localhost';"], 'GRANT文');
    eq(S.grantStatements({ WH_DB_USER: 'u1', WH_DB_HOST: '10.0.0.5', STOC_DB_NAME: 'sales2' })[0], "GRANT SELECT, INSERT ON sales2.inquiry_export_batches TO 'u1'@'10.0.0.5';", 'GRANT: ユーザー・ホスト・DB名');
    const okPool = fakePool();
    await S.checkStocAccess(okPool, { env: ENV });
    eq(okPool.log.length, 4, '確認: 4つの無害な検査');
    ok(okPool.log.every((l) => /WHERE 1 = 0/.test(l.sql)), '確認: どれも0行対象(何も書かない)');
    const roPool = fakePool();
    await S.checkStocAccess(roPool, { env: ENV, readOnly: true });
    eq(roPool.log.length, 1, 'dry-run は読み取りだけ確認');
    const deny = { async query(sql) { if (/^INSERT INTO \S*inquiry_export_items/.test(sql)) throw Object.assign(new Error('INSERT command denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR', errno: 1142 }); return [[]]; } };
    let e1 = null;
    try { await S.checkStocAccess(deny, { env: ENV }); } catch (e) { e1 = e; }
    ok(e1 && e1.stocCheck && g.every((x) => e1.message.includes(x)) && e1.message.includes('処理を中止しました'), '権限不足: 中止メッセージにGRANT4行');
    const broken = { async query() { throw new Error('connect ECONNREFUSED'); } };
    let e2 = null;
    try { await S.checkStocAccess(broken, { env: ENV }); } catch (e) { e2 = e; }
    ok(e2 && e2.stocCheck && e2.message.includes('ECONNREFUSED') && !e2.message.includes('GRANT'), '接続失敗はGRANTを案内しない');
    const fs1 = await S.fetchStocStores({ async query(sql, p) { return [p[0].map((id) => ({ id }))]; } }, [3, '4', 3, 'x', 0], ENV);
    eq([...fs1.keys()], [3, 4], '店舗取得: 重複・不正IDを除く');
  }

  // ---- CLI引数 ----
  eq(parseArgs(['--template', 'b2b', '--single-out', '/x/s']).singleOut, '/x/s', '--single-out');
  eq(parseArgs(['--dry-run-stoc']).dryRunStoc, true, '--dry-run-stoc');
  eq(parseArgs([]).dryRunStoc, undefined, '--dry-run-stoc 省略');

  console.log(`single: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
