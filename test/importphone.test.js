'use strict';
/**
 * 取り込みで CIDがない行を電話番号で既存の店と照合する(src/importMatch.js・cli/warehouse-import.js)のテスト。
 * DB不要の部分は常に実行。実DBの結合テストは WEBDOCK_DB_TEST_OK=1 のときだけ(テスト専用サーバーで。下の末尾)。
 */
const fs = require('fs');
const path = require('path');
const im = require('../src/importMatch');
const imp = require('../cli/warehouse-import');
const adminWh = require('../src/adminWarehouse');
const wh = require('../src/warehouse');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);

/* ---------- 電話番号のそろえ方 ---------- */
eq(im.phoneKeys('03-1234-5678'), ['0312345678', null], 'keys: 1つ');
eq(im.phoneKeys('03-1234-5678, 06-9999-0000'), ['0312345678', '0699990000'], 'keys: カンマ');
eq(im.phoneKeys('03-1234-5678/06-9999-0000'), ['0312345678', '0699990000'], 'keys: スラッシュ');
eq(im.phoneKeys('03-123-456、06-999-000、075-1-2'), ['03123456', '06999000'], 'keys: 読点・3つ目は索引にない');
eq(im.phoneKeys('０３－１２３４－５６７８'), ['0312345678', null], 'keys: 全角');
eq(im.phoneKeys(' , 03-1111-2222'), [null, '0311112222'], 'keys: 空の1つ目');
eq(im.phoneKeys(''), [null, null], 'keys: 空');
eq(im.phoneKeys(null), [null, null], 'keys: null');
eq(im.lookupNumbers('0120-123-456, 03-1234-5678'), ['0312345678'], 'lookup: フリーダイヤルは外す');
eq(im.lookupNumbers('0800-1-2345'), [], 'lookup: 0800');
eq(im.lookupNumbers('0570-123-456'), [], 'lookup: 0570');
eq(im.lookupNumbers('050-1234-5678'), ['05012345678'], 'lookup: 050 は普通の番号');
eq(im.lookupNumbers('12345'), [], 'lookup: 6桁未満');
eq(im.lookupNumbers('03-1234-5678 / 03-1234-5678'), ['0312345678'], 'lookup: 重複なし');
eq(im.lookupNumbers('内線12, 03-1111-2222'), ['0311112222'], 'lookup: 短い番号は外す');
eq(im.lookupNumbers('03-1234-5678, 06-9999-0000, 075-111-2222'), ['0312345678', '0699990000', '0751112222'], 'lookup: 入ってくる行は全部の番号で探す');

/* ---------- URL ---------- */
const D = im.decideUrl;
eq(D(null, 'https://a.com/'), 'fill', 'url: 既存NULL → 補う');
eq(D('', 'http://a.com/'), 'fill', "url: 既存'' → 補う");
eq(D('https://a.com/', ''), 'none', 'url: 取り込みが空');
eq(D(null, null), 'none', 'url: 両方空');
eq(D('http://a.com/', 'https://a.com/'), 'upgrade', 'url: 同じサイトの http→https は置き換え');
eq(D('http://www.a.com/', 'https://a.com/x'), 'upgrade', 'url: www違い・パス違いでも同じサイト');
eq(D('https://a.com/', 'http://a.com/'), 'none', 'url: https→http は置き換えない');
eq(D('https://a.com/', 'https://a.com/'), 'none', 'url: 同じ');
eq(D('http://a.com/', 'http://a.com/x'), 'none', 'url: 同じサイトで両方http');
eq(D('http://old.com/', 'https://new.com/'), 'differ', 'url: 別のサイトなら http→https でも置き換えず数える');
eq(D('https://a.com/', 'https://b.com/'), 'differ', 'url: 別のサイト');
eq(D('x://', 'y://'), 'differ', 'url: ホスト名が取り出せず文字が違う');
eq(D('x://', 'x://'), 'none', 'url: ホスト名が取り出せず文字が同じ');

/* ---------- 候補の決め方 ---------- */
eq(im.pickCandidate([], 'A').kind, 'none', 'pick: 候補なし');
eq(im.pickCandidate([{ name: '全然ちがう店' }], 'A店').kind, 'match', 'pick: 1件なら屋号が違っても同じ店');
eq(im.pickCandidate([{ name: '山田工業' }, { name: '山田工業所' }], '山田工業').kind, 'held', 'pick: 屋号が似た店が2件なら保留');
eq(im.pickCandidate([{ name: '山田工業' }, { name: '鈴木商店' }], '株式会社 山田工業').cand.name, '山田工業', 'pick: 法人格・空白を除いて似た1件');
eq(im.pickCandidate([{ name: '山田工業' }, { name: '鈴木商店' }], '佐藤').kind, 'held', 'pick: 似た店が0件なら保留');
eq(im.pickCandidate([{ name: 'ab' }, { name: 'cd' }], 'abc').kind, 'held', 'pick: 4文字未満の包含は似ているとみなさない(nameLike)');

/* ---------- 空欄を補う ---------- */
{
  const st = { phone: '03-1', category: null, postal: '', address: '東京都A', rating: null, review_count: 0, website_url: 'http://a.com/', lat: null };
  const p = im.planFill(st, { phone: '03-9', category: '工場', postal: '100-0001', address: '東京都B', rating: 4.2, review_count: 5, website_url: 'https://a.com/', lat: 35.1 });
  eq(p.set, { category: '工場', postal: '100-0001', rating: 4.2, lat: 35.1, website_url: 'https://a.com/' }, 'fill: 空欄だけ補う(0は空欄ではない・既存は上書きしない)');
  eq(p.url, 'upgrade', 'fill: URL判定');
  const p2 = im.planFill({ website_url: 'https://a.com/' }, { website_url: 'https://b.com/', category: 'x' });
  eq([p2.set, p2.url], [{ category: 'x' }, 'differ'], 'fill: 別サイトのURLは元を残す');
}

/* ---------- 照合(偽の倉庫で) ---------- */
function fakeStore(rows, { fbs = [], cids = [] } = {}) {
  const calls = { phone: 0 };
  return {
    calls,
    async existingCids(l) { return new Set(l.filter((c) => cids.includes(c))); },
    async existingFallbacks(l) { return new Set(l.filter((c) => fbs.includes(c))); },
    async phoneCandidates(prefs, nums) {
      calls.phone++;
      return rows.filter((r) => prefs.includes(r.prefecture) && nums.some((n) => r.phone_key1 === n || r.phone_key2 === n));
    },
  };
}
const shop = (id, name, pref, phone, extra) => { const k = im.phoneKeys(phone); return { id, name, prefecture: pref, phone, phone_key1: k[0], phone_key2: k[1], website_url: null, ...extra }; };
let seq = 0;
const rec = (name, pref, phone, extra) => ({ cid: null, fallback_key: 'fb' + (++seq), name, prefecture: pref, phone, website_url: null, ...extra });
const ctxOf = (o) => im.makeContext({ phoneEnabled: true, keepOverlay: false, ...o });

(async () => {
  // 基本: 1件一致・別県は照合しない・フリーダイヤル/空欄/短い/県なしは照合しない
  {
    const store = fakeStore([shop(1, '山田工業', '大阪府', '06-1111-2222'), shop(2, '東京店', '東京都', '03-1111-2222'), shop(3, '本部', '大阪府', '0120-111-222')]);
    const recs = [
      rec('山田工業(別表記)', '大阪府', '06-1111-2222', { category: '製造' }),   // 一致
      rec('別県の同番号', '大阪府', '03-1111-2222'),                              // 大阪には無い → 新規
      rec('フリーダイヤル', '大阪府', '0120-111-222'),                           // 照合しない → 新規
      rec('電話なし', '大阪府', null),                                            // 新規
      rec('短い', '大阪府', '12345'),                                            // 新規
      rec('県なし', null, '06-1111-2222'),                                       // 照合しない → 新規
      rec('2つ目の番号で', '大阪府', '06-9999-9999 / 06-1111-2222'),              // 一致
    ];
    const r = await im.classifyBatch(recs, store, ctxOf(), 'a.csv');
    eq([r.stats.phone, r.stats.inserted, r.stats.held, r.stats.cid, r.stats.exact], [2, 5, 0, 0, 0], '照合: 一致2・新規5');
    eq(r.fills.length, 1, '照合: 同じ店への補完は1つにまとまる');
    eq([r.fills[0].id, r.fills[0].set], [1, { category: '製造' }], '照合: 補う内容');
    eq(r.legacy.length, 5, '照合: 従来のupsertに渡すのは新規の5行');
    // 県なしの行は電話の検索自体に含まれない
    ok(store.calls.phone === 1, '照合: 電話の検索はバッチに1回');
  }
  // 候補が複数: 屋号で決まれば一致、決まらなければ保留(新規にも更新にもしない)
  {
    const store = fakeStore([shop(1, '山田工業', '大阪府', '06-1111-2222'), shop(2, '鈴木商店', '大阪府', '06-1111-2222')]);
    const ctx = ctxOf();
    const r = await im.classifyBatch([rec('山田工業 株式会社', '大阪府', '06-1111-2222'), rec('田中', '大阪府', '06-1111-2222')], store, ctx, 'b.csv');
    eq([r.stats.phone, r.stats.held, r.stats.inserted], [1, 1, 0], '複数: 屋号で1件に決まる/決まらないは保留');
    eq(r.fills.map((f) => f.id), [1], '複数: 山田工業に決まる');
    eq(r.legacy.length, 0, '複数: 保留は新しく追加しない');
    eq(ctx.heldSamples.map((h) => [h.name, h.count]), [['田中', 2]], '複数: 保留の例を残す');
  }
  // 同じ取り込みの中で先に新規にした店とも照合する(同じバッチ・次のバッチ・試し取り込み)
  {
    const store = fakeStore([]);
    const a = rec('新しい店', '東京都', '03-5555-6666', { website_url: 'http://n.example.jp/' });
    const b = rec('新しい店 本店', '東京都', '03-5555-6666 / 03-7777-8888', { website_url: 'https://n.example.jp/', category: '食堂' });
    const c = rec('さらに別表記', '東京都', '03-5555-6666', { website_url: 'https://other.example.jp/' });
    const ctx = ctxOf({ keepOverlay: true });
    const r1 = await im.classifyBatch([a, b], store, ctx, 'x.csv');
    eq([r1.stats.inserted, r1.stats.phone, r1.stats.phoneUrlFilled], [1, 1, 1], 'overlay: 同じバッチの重複を防ぐ(http→https は置き換え)');
    eq(r1.legacy, [a], 'overlay: 追加するのは先の1行だけ');
    eq([a.website_url, a.category], ['https://n.example.jp/', '食堂'], 'overlay: 先の行に補う');
    const r2 = await im.classifyBatch([c], store, ctx, 'y.csv');
    eq([r2.stats.inserted, r2.stats.phone, r2.stats.phoneUrlDiffered], [0, 1, 1], 'overlay: 次のバッチ(試し取り込み)でも照合・別サイトのURLは数える');
    eq(a.website_url, 'https://n.example.jp/', 'overlay: 別サイトのURLで元を上書きしない');
    // 本番(keepOverlay=false)では次のバッチはDBから引く。overlay は残さない
    const ctx2 = ctxOf();
    await im.classifyBatch([rec('P', '東京都', '03-1212-3434')], store, ctx2, 'z.csv');
    eq([ctx2.overlayByPref.size, ctx2.overlayFbs.size], [0, 0], 'overlay: 本番はバッチごとに空にする');
  }
  // CIDあり/CIDなしの順番: CIDあり行は電話で照合しない・fallback_keyの一致は従来どおり
  {
    const store = fakeStore([shop(1, '山田工業', '大阪府', '06-1111-2222')], { cids: ['0xaa'], fbs: ['fbX'] });
    const withCid = rec('CIDあり新規', '大阪府', '06-1111-2222', { cid: '0xbb', fallback_key: null });
    const withCidKnown = rec('CIDあり既存', '大阪府', '06-1111-2222', { cid: '0xaa', fallback_key: null });
    const exact = rec('同じ電話+屋号', '大阪府', '06-1111-2222', { fallback_key: 'fbX' });
    const r = await im.classifyBatch([withCid, withCidKnown, exact], store, ctxOf(), 'c.csv');
    eq([r.stats.cid, r.stats.exact, r.stats.phone, r.stats.inserted], [1, 1, 0, 1], 'CID→(従来の同一)→電話 の順');
    eq(r.fills.length, 0, 'CIDあり行は電話で別の店に補わない');
    eq(r.legacy.length, 3, 'CIDあり・従来一致は従来のupsert');
    // CIDあり行で新規にした店とも、あとのCIDなし行は電話で照合する
    const r2 = await im.classifyBatch([rec('CIDなし同番号', '大阪府', '06-3333-4444'), { ...rec('CIDあり', '大阪府', '06-3333-4444'), cid: '0xcc', fallback_key: null }], fakeStore([]), ctxOf(), 'd.csv');
    eq([r2.stats.inserted, r2.stats.phone], [2, 0], '先にCIDなしが新規になり、あとのCIDあり行は電話で照合しない');
    const cidFirst = { ...rec('CIDあり', '大阪府', '06-3333-4444'), cid: '0xdd', fallback_key: null };
    const r3 = await im.classifyBatch([cidFirst, rec('CIDなし同番号', '大阪府', '06-3333-4444')], fakeStore([]), ctxOf(), 'e.csv');
    eq([r3.stats.inserted, r3.stats.phone], [1, 1], 'CIDあり行で新規にした店とCIDなし行を照合する');
  }
  // 同じ既存の店に2回当たる: 2回目は1回目の結果を見る(URLを2回補わない)
  {
    const store = fakeStore([shop(1, '山田工業', '大阪府', '06-1111-2222')]);
    const r = await im.classifyBatch([
      rec('山田工業', '大阪府', '06-1111-2222', { website_url: 'http://y.example.jp/' }),
      rec('山田工業', '大阪府', '06-1111-2222', { website_url: 'https://y.example.jp/', category: '板金' }),
      rec('山田工業', '大阪府', '06-1111-2222', { website_url: 'https://z.example.jp/' }),
    ], store, ctxOf(), 'f.csv');
    eq([r.stats.phone, r.stats.phoneUrlFilled, r.stats.phoneUrlDiffered], [3, 2, 1], '2回目以降は補った後の値と比べる(補う→https化→別サイト)');
    eq(r.fills.length, 1, '1つの更新にまとまる');
    eq([r.fills[0].set.website_url, r.fills[0].set.category], ['https://y.example.jp/', '板金'], 'まとめた更新の内容');
  }
  // 索引がないとき(phoneEnabled=false): 電話の検索をしない・従来どおり新規
  {
    const store = fakeStore([shop(1, '山田工業', '大阪府', '06-1111-2222')]);
    const r = await im.classifyBatch([rec('山田工業', '大阪府', '06-1111-2222')], store, ctxOf({ phoneEnabled: false }), 'g.csv');
    eq([r.stats.inserted, r.stats.phone, store.calls.phone], [1, 0, 0], '索引なし: 電話の照合を飛ばす');
  }

  /* ---------- 書き込み(偽プール): SQL と履歴 ---------- */
  {
    const queries = [];
    const pool = { query: async (sql, p) => { queries.push([sql, p]); return [{ affectedRows: 1 }]; } };
    const fills = [
      { id: 7, before: { id: 7, website_url: 'http://a.com/', rating: null, review_count: 3, photo_count: null, has_hist: 1 },
        set: { category: '工場', rating: 4.5, website_url: 'https://a.com/' }, state: { id: 7, review_count: 3, photo_count: null, rating: 4.5 } },
    ];
    const hist = await imp.applyFills(pool, fills, true, true);
    const upd = queries[0];
    ok(/^UPDATE stoc_master\.shops SET last_seen_at = NOW\(\)/.test(upd[0]) && upd[0].endsWith('WHERE id = ?'), 'UPDATE: 形');
    ok(upd[0].includes("`category` = IF(`category` IS NULL OR `category` = '', ?, `category`)"), 'UPDATE: 文字の列は空欄のときだけ');
    ok(upd[0].includes('`rating` = IF(`rating` IS NULL, ?, `rating`)') && !upd[0].includes("`rating` = ''"), 'UPDATE: 数の列は NULL のときだけ(0を空欄とみなさない)');
    ok(upd[0].indexOf('site_host = IF(') > 0 && upd[0].indexOf('site_host = IF(') < upd[0].indexOf('website_url = IF('), 'UPDATE: site_host を website_url より前に代入');
    eq(upd[1], ['工場', 4.5, 'http://a.com/', 'a.com', 'http://a.com/', 'https://a.com/', 7], 'UPDATE: 値');
    eq(hist, 1, '履歴: 評価が空→値で1行');
    ok(queries[1][0].includes('INSERT INTO stoc_master.shop_metrics_history'), '履歴: INSERT');
    eq(queries[1][1].slice(0, 1), [7], '履歴: 店ID');
    // 履歴が変わらない・もう基準がある → 足さない
    eq(imp.planPhoneHistory([{ id: 1, before: { review_count: 3, photo_count: 2, rating: '4.0', has_hist: 1 }, state: { review_count: 3, photo_count: 2, rating: '4.0' } }]), [], '履歴: 変化なし・基準あり → なし');
    eq(imp.planPhoneHistory([{ id: 1, before: { review_count: 3, photo_count: 2, rating: '4.0', has_hist: 0 }, state: { review_count: 3, photo_count: 2, rating: '4.0' } }]), [[1, 3, 2, '4.0']], '履歴: 基準がなければ1行');
    eq(imp.planPhoneHistory([{ id: 1, before: { has_hist: 0 }, state: {} }]), [], '履歴: 値が全部なければ足さない');
  }
  {
    // importBatch: --dry-run は書かない
    const queries = [];
    const pool = { query: async (sql, p) => { queries.push(sql); return sql.includes('COUNT(*)') ? [[{ n: 0 }]] : [[]]; } };
    const store = fakeStore([shop(1, '山田工業', '大阪府', '06-1111-2222')]);
    const s = await imp.importBatch(pool, [rec('山田工業', '大阪府', '06-1111-2222', { category: 'x' }), rec('新店', '大阪府', '06-8888-9999')], ctxOf({ keepOverlay: true }), store, { dryRun: true, hasBs: false, hasSiteHost: false, hasHistory: false, source: 'a' });
    eq([s.phone, s.inserted, queries.length], [1, 1, 0], 'importBatch(dryRun): 件数は出すが書かない');
    const live = await imp.importBatch(pool, [rec('山田工業', '大阪府', '06-1111-2222', { category: 'x' }), rec('新店', '大阪府', '06-8888-9999')], ctxOf(), store, { dryRun: false, hasBs: false, hasSiteHost: false, hasHistory: false, source: 'a' });
    eq([live.phone, live.inserted], [1, 1], 'importBatch: 本番も同じ件数');
    ok(queries.some((q) => q.startsWith('INSERT INTO stoc_master.shops')) && queries.some((q) => q.startsWith('UPDATE stoc_master.shops SET last_seen_at')), 'importBatch: 新規は upsert・一致は UPDATE');
  }

  /* ---------- 画面・SQL・README ---------- */
  {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'warehouse_migrate_011.sql'), 'utf8');
    ok(sql.includes('phone_key1') && sql.includes('phone_key2') && sql.includes('idx_pref_phone1') && sql.includes('idx_pref_phone2'), '011: 列と索引');
    eq((sql.match(/PREPARE st FROM @s/g) || []).length, 9, '011: 条件つきの DDL が9つ(列2・索引2・記録の列5)');
    ok(!/CREATE TABLE|DROP |DELETE |TRUNCATE /i.test(sql), '011: 破壊的な文なし');
    const lits = [...sql.matchAll(/IF\(COUNT\(\*\) = 0, ((?:'(?:[^']|'')*'))\s*,\s*('SELECT 1')\)/g)].map((m) => m[1]);
    eq(lits.length, 9, '011: DDL文字列リテラルを9つ読める');
    ok(lits.every((l) => !/[^']'[^']/.test(l.slice(1, -1).replace(/''/g, ''))), '011: リテラル内の引用符は倍加');
    // 生成列の式を取り出して、JS と同じ結果になる式かを別の評価で突き合わせる必要があるのは実DBのとき(下)
    const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'import.ejs'), 'utf8');
    ok(view.includes('試し取り込み(倉庫には書き込まない)') && !view.includes('ドライラン'), '画面: ボタンの名前が「試し取り込み(倉庫には書き込まない)」');
    const s1 = adminWh.parseImportSummary(['x', '取り込み結果JSON: ' + JSON.stringify({ dryRun: true, cid: 1, phone: 2, phoneUrlFilled: 1, phoneUrlDiffered: 1, held: 3, inserted: 4, skipped: 5, exact: 0, rows: 15, files: 1, errors: 0, phoneMatching: true }), 'y']);
    eq([s1.dryRun, s1.phone, s1.held, s1.inserted], [true, 2, 3, 4], 'ジョブ画面: 結果の行を読む');
    eq(adminWh.parseImportSummary(['何もない']), null, 'ジョブ画面: 行がなければ null');
    eq(adminWh.parseImportSummary(['取り込み結果JSON: {壊れた']), null, 'ジョブ画面: 壊れた行は null');
    const jobView = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'job.ejs'), 'utf8');
    ok(['CIDで一致', '電話番号で一致', 'URLを補った', 'URLが異なった', '複数一致で保留', '新規', 'スキップ'].every((t) => jobView.includes(t)), 'ジョブ画面: 結果の項目');
  }

  /* ---------- 実DB(opt-in) ---------- */
  if (process.env.WEBDOCK_DB_TEST_OK === '1' && process.env.WEBDOCK_PHONE_DB_TEST === '1') {
    await dbTests();
  } else console.log('  (実DBの結合テストは省略: WEBDOCK_DB_TEST_OK=1 WEBDOCK_PHONE_DB_TEST=1 で実行。テスト専用サーバーのみ)');

  console.log(`importphone.test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

/** stoc_master を作り直して実際に取り込む(WEBDOCK_DB_TEST_OK=1 WEBDOCK_PHONE_DB_TEST=1。テスト専用サーバーのみ) */
async function dbTests() {
  const os = require('os');
  const { spawnSync } = require('child_process');
  const mysql = require('mysql2/promise');
  const cfg = { host: process.env.TEST_DB_HOST || '127.0.0.1', port: Number(process.env.TEST_DB_PORT || 3306), user: process.env.TEST_DB_USER || 'wht', password: process.env.TEST_DB_PASS || 'whtpass', multipleStatements: true, charset: 'utf8mb4' };
  if (fs.existsSync('/var/www/stoc-sales-engine')) { console.error('中止: 本番サーバー上では実行できません。'); process.exit(1); }
  const db = await mysql.createConnection(cfg);
  const q = async (sql, p) => (await db.query(sql, p))[0];
  try { const n = (await q('SELECT COUNT(*) AS n FROM stoc_master.shops'))[0].n; if (n > 50) { console.error(`中止: stoc_master.shops に ${n} 件あります。本番データの可能性があるため削除しません。`); process.exit(1); } } catch { /* 無ければ新規環境 */ }
  const ROOT = path.join(__dirname, '..');
  await q('DROP DATABASE IF EXISTS stoc_master');
  await q(fs.readFileSync(path.join(ROOT, 'sql/warehouse_schema.sql'), 'utf8'));
  for (const f of ['005', '008']) await q(fs.readFileSync(path.join(ROOT, `sql/warehouse_migrate_${f}.sql`), 'utf8'));
  const run = (args) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'cli/warehouse-import.js'), ...args], { encoding: 'utf8', env: { ...process.env, WH_DB_HOST: cfg.host, WH_DB_PORT: String(cfg.port), WH_DB_USER: cfg.user, WH_DB_PASS: cfg.password } });
    return { code: r.status, err: r.stderr };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whphone-'));
  fs.mkdirSync(path.join(dir, '大阪府'));
  const H = ['屋号', '業種', '郵便番号', '住所', '電話番号', '評価', '口コミ数', 'Googleマイビジネス登録有無', '登録URL', 'GMAP', '写真枚数'];
  const U = (n) => `https://www.google.co.jp/maps/place/data=!4m7!3m6!1s0x60008d00781a628f:0xcccc00000000000${n}!8m2!3d35.6894807!4d139.6916863!2z!16s`;
  const R = (name, cat, phone, url, gmap) => [name, cat, '530-0001', '大阪府大阪市北区1-1', phone, '4.0', '10', '有り', url, gmap, '3'];
  const write = (name, rows) => fs.writeFileSync(path.join(dir, '大阪府', name), '﻿' + [H, ...rows].map((r) => r.join(',')).join('\n') + '\n');
  // 1回目: CIDあり(基準) + CIDなし(新規)
  write('gmp_1.csv', [
    R('山田工業', '工場', '06-1111-2222', 'http://yamada.example.jp/', U(1)),
    R('鈴木商店', '', '06-3333-4444 / 06-5555-6666', '', U(2)),
    R('佐藤鉄工', '', '06-7777-8888', 'https://sato.example.jp/', ''),
  ]);
  const before = run(['--root', dir, '--pattern', 'gmp_*.csv']);
  eq(before.code, 0, 'db: 1回目 exit: ' + before.err);
  eq((await q('SELECT COUNT(*) n FROM stoc_master.shops'))[0].n, 3, 'db: 1回目の件数(索引なし)');
  ok(/電話番号の照合用の索引がない/.test(before.err), 'db: 索引がなければ警告を出して従来どおり動く');
  await q(fs.readFileSync(path.join(ROOT, 'sql/warehouse_migrate_011.sql'), 'utf8'));
  await q(fs.readFileSync(path.join(ROOT, 'sql/warehouse_migrate_011.sql'), 'utf8'));
  // 2回目: CIDなしの行
  write('gmp_2.csv', [
    R('山田工業(株)', '', '06-1111-2222', 'https://yamada.example.jp/', ''),   // 同じサイトの https → 置き換え
    R('鈴木商店 本店', '食品', '06-5555-6666', 'https://suzuki.example.jp/', ''), // 2つ目の番号で一致・URLを補う
    R('佐藤鉄工所', '鉄工', '06-7777-8888', 'https://other.example.jp/', ''),    // 別サイト → 元を残す
    R('新規の店', '', '06-9999-0000', '', ''),                                  // 新規
    R('新規の店 2号', '', '06-9999-0000', '', ''),                               // 同じファイル内の重複 → 先の店と一致
    R('フリーダイヤルの店', '', '0120-111-222', '', ''),
  ]);
  const dry = run(['--root', dir, '--pattern', 'gmp_2.csv', '--dry-run']);
  eq(dry.code, 0, 'db: 試し取り込み exit: ' + dry.err);
  eq((await q('SELECT COUNT(*) n FROM stoc_master.shops'))[0].n, 3, 'db: 試し取り込みは書かない');
  eq((await q('SELECT COUNT(*) n FROM stoc_master.import_runs'))[0].n, 1, 'db: 試し取り込みは記録も書かない');
  const real = run(['--root', dir, '--pattern', 'gmp_2.csv']);
  eq(real.code, 0, 'db: 取り込み exit: ' + real.err);
  const sum = (t) => JSON.parse(/取り込み結果JSON: (.*)/.exec(t)[1]);
  const sd = sum(dry.err), sr = sum(real.err);
  const pick = (s) => [s.cid, s.phone, s.phoneUrlFilled, s.phoneUrlDiffered, s.held, s.inserted, s.skipped];
  eq(pick(sr), [0, 4, 2, 1, 0, 2, 0], 'db: 件数(電話一致4・URL補完2・URL相違1・新規2)');
  eq(pick(sd), pick(sr), 'db: 試し取り込みと本番で同じ件数');
  const rows = await q('SELECT name, category, website_url, site_host FROM stoc_master.shops ORDER BY id');
  eq(rows.length, 5, 'db: 新規2店(新規の店・フリーダイヤルの店)だけ増える');
  const by = (n) => rows.find((x) => x.name === n);
  eq(by('山田工業').website_url, 'https://yamada.example.jp/', 'db: 同じサイトの http→https は置き換え');
  eq(by('山田工業').site_host, 'yamada.example.jp', 'db: site_host');
  eq([by('鈴木商店').website_url, by('鈴木商店').category], ['https://suzuki.example.jp/', '食品'], 'db: 空欄だけ補う');
  eq(by('鈴木商店').site_host, 'suzuki.example.jp', 'db: 電話で一致してURLを補ったとき site_host も新しいホスト名になる(空→値)');
  eq(by('佐藤鉄工').site_host, 'sato.example.jp', 'db: 別サイトのURLで元を残したとき site_host も元のまま');
  eq([by('佐藤鉄工').website_url, by('佐藤鉄工').category], ['https://sato.example.jp/', '鉄工'], 'db: 別サイトのURLで上書きしない');
  const last = (await q('SELECT * FROM stoc_master.import_runs ORDER BY id DESC LIMIT 1'))[0];
  eq([Number(last.phone_matched), Number(last.phone_url_filled), Number(last.phone_url_differed), Number(last.held), Number(last.inserted), Number(last.updated)], [4, 2, 1, 0, 2, 4], 'db: import_runs に記録');
  // 3回目(同じファイル): 変化なし・増えない
  const again = run(['--root', dir, '--pattern', 'gmp_2.csv']);
  eq(again.code, 0, 'db: 再実行 exit');
  eq((await q('SELECT COUNT(*) n FROM stoc_master.shops'))[0].n, 5, 'db: 再実行しても増えない');
  // 生成列の値が JS と同じ
  const keys = await q("SELECT phone, phone_key1 a, phone_key2 b FROM stoc_master.shops WHERE name = '鈴木商店'");
  eq([keys[0].a, keys[0].b], im.phoneKeys(keys[0].phone), 'db: 生成列と phoneKeys が同じ');
  // 複数一致は保留
  await q("INSERT INTO stoc_master.shops (name, prefecture, phone, fallback_key, first_seen_at, last_seen_at) VALUES ('同番号A', '大阪府', '06-4444-0000', SHA1('a'), NOW(), NOW()), ('同番号B', '大阪府', '06-4444-0000', SHA1('b'), NOW(), NOW())");
  write('gmp_3.csv', [R('どちらでもない店', '', '06-4444-0000', '', '')]);
  const held = run(['--root', dir, '--pattern', 'gmp_3.csv']);
  eq([sum(held.err).held, sum(held.err).inserted], [1, 0], 'db: 複数一致は保留して追加しない');
  ok(/複数一致で保留した行/.test(held.err) && held.err.includes('どちらでもない店'), 'db: 保留の行を表示');
  eq((await q('SELECT COUNT(*) n FROM stoc_master.shops'))[0].n, 7, 'db: 保留は増やさない');
  // バッチをまたいだ重複: 先のバッチで追加した新規店と、あとのバッチのCIDなし行を照合する(--batch 1 = 1行ずつ)
  fs.mkdirSync(path.join(dir, '京都府'));
  fs.writeFileSync(path.join(dir, '京都府', 'gmp_k.csv'), '﻿' + [H, R('京の店', '', '075-111-2222', '', '').map((c, i) => (i === 3 ? '京都府京都市1-1' : c)), R('京の店 別表記', '', '075-111-2222', '', '').map((c, i) => (i === 3 ? '京都府京都市1-1' : c))].map((r) => r.join(',')).join('\n') + '\n');
  const cross = run(['--root', path.join(dir, '京都府'), '--pattern', 'gmp_k.csv', '--batch', '1']);
  eq(cross.code, 0, 'db: --batch 1 exit: ' + cross.err);
  eq([sum(cross.err).inserted, sum(cross.err).phone], [1, 1], 'db: バッチをまたいでも先に追加した店と照合する');
  eq((await q("SELECT COUNT(*) n FROM stoc_master.shops WHERE prefecture = '京都府'"))[0].n, 1, 'db: バッチをまたいでも重複しない');
  // 試し取り込みは読み取り専用の接続(書こうとすると拒否される)
  const imp2 = require('../cli/warehouse-import');
  Object.assign(process.env, { WH_DB_HOST: cfg.host, WH_DB_PORT: String(cfg.port), WH_DB_USER: cfg.user, WH_DB_PASS: cfg.password });
  const rop = await imp2.makeReadOnlyPool();
  let werr = null;
  try { await rop.query("UPDATE stoc_master.shops SET name = name WHERE id = 1"); } catch (e) { werr = e.code; }
  eq(werr, 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION', 'db: 読み取り専用の接続では書き込めない');
  eq(Number((await rop.query('SELECT @@session.transaction_read_only AS ro'))[0][0].ro), 1, 'db: 読み取り専用が効いている');
  await rop.end();
  await db.end();
  fs.rmSync(dir, { recursive: true, force: true });
}
