'use strict';
// STOC営業管理との照合(src/stocMatch.js)のテスト。DB不要(偽の接続)。
// 従来の判定(cli/warehouse-promote.js が使う matchPhone / matchNameAddr)が変わらないことと、店IDを持つ索引の判定を確かめる。
const M = require('../src/stocMatch');
const promote = require('../cli/warehouse-promote');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);

const st = (id, o = {}) => ({ id, name: `店${id}`, address: '', phone: '', phone_mobile: '', phone_free: '', phone_other: '', status: '未対応', ...o });
const STORES = [
  st(1, { name: 'ガスト 芦屋店', address: '兵庫県芦屋市楠町7-18', phone: '0797-11-2222', phone_free: '0120-214-616', status: '契約' }),
  st(2, { name: '一蘭 神戸玉津店', address: '兵庫県神戸市西区平野町向井46-1 ビル2F', phone_mobile: '090-1111-2222', phone_other: '０７９－２９８－７０７７' }),
  st(3, { name: '本部直営 姫路店', address: '兵庫県姫路市北条1-1', phone: '079-000-0003', phone_free: '0120214616', status: '失注' }),
  st(4, { name: 'ガスト芦屋店', address: '兵庫県芦屋市楠町７−１８', phone: '0797-11-2222' }), // 1と同じ電話・同じ住所
  st(5, { name: '山田工業', address: '兵庫県神戸市', phone: '078-555-0005', phone_mobile: '078-555-0005' }), // 同じ番号を2列に
  st(6, { name: 'ナビ', address: '大阪府大阪市北区1-2-3', phone: '0570-001-673' }),
];

(async () => {
  // ---- warehouse-promote は同じ関数を使っている(結果が変わらない) ----
  for (const k of ['phoneDigits', 'isFreeDial', 'buildPhoneIndex', 'matchPhone', 'normShopName', 'normShopAddr', 'addNameAddrIndex', 'matchNameAddr', 'loadStocIndex', 'loadStocPhoneIndex']) {
    ok(promote[k] === M[k], 'warehouse-promote から同じ関数: ' + k);
  }

  // ---- 従来の索引(店IDなし)は形も変わらない ----
  const plain = M.buildPhoneIndex(STORES);
  eq(plain.get('0797112222'), { n: 2, last: 4 }, '従来の索引: 件数と最後の店だけ');
  eq(plain.get('0785550005'), { n: 1, last: 5 }, '同じ店が2列に同じ番号 → 1店');
  eq(plain.get('0792987077'), { n: 1, last: 2 }, '全角の「その他」も索引に入る');
  ok(!plain.has('12345'), '6桁未満は入れない');
  eq(M.matchPhone(plain, '0797-11-2222'), { kind: 'registered' }, '従来: 固定一致');
  eq(M.matchPhone(plain, '0120-214-616'), { kind: 'review', free: [{ number: '0120214616', stores: 2 }] }, '従来: フリーダイヤルのみは要確認(店数つき)');
  eq(M.matchPhone(plain, '03-0000-0000'), { kind: null }, '従来: 不一致');
  const plainAddr = M.addNameAddrIndex(new Map(), STORES);
  ok(typeof [...plainAddr.values()][0][0] === 'string', '従来の店名+住所の索引は文字列の配列');
  ok(M.matchNameAddr(plainAddr, '(株)ガスト芦屋店 本店', '兵庫県芦屋市楠町7-18'), '従来: 店名+住所の一致');
  ok(!M.matchNameAddr(plainAddr, '山田工業', '兵庫県神戸市'), '従来: 市区町村までの住所は使わない');

  // ---- 店IDを持つ索引 ----
  const idx = M.buildPhoneIndex(STORES, { withIds: true });
  eq(idx.get('0797112222'), { n: 2, last: 4, ids: [1, 4] }, 'ids: 同じ番号の店ID');
  eq(idx.get('0785550005').ids, [5], 'ids: 同じ店の2列は1つ');
  eq(idx.get('0120214616').ids, [1, 3], 'ids: フリーダイヤルを持つ店');
  eq(M.matchPhoneIds(idx, '0797-11-2222'), { kind: 'registered', ids: [1, 4], freeIds: [], free: [] }, '固定一致: 両方の店ID');
  eq(M.matchPhoneIds(idx, '090 1111 2222'), { kind: 'registered', ids: [2], freeIds: [], free: [] }, '携帯一致');
  eq(M.matchPhoneIds(idx, '0792987077'), { kind: 'registered', ids: [2], freeIds: [], free: [] }, '「その他」列(全角)との一致');
  eq(M.matchPhoneIds(idx, '0120-214-616'), { kind: 'review', ids: [], freeIds: [1, 3], free: [{ number: '0120214616', stores: 2 }] }, 'フリーダイヤルのみ: 要確認・店ID');
  eq(M.matchPhoneIds(idx, '0570001673'), { kind: 'review', ids: [], freeIds: [6], free: [{ number: '0570001673', stores: 1 }] }, '0570も要確認');
  eq(M.matchPhoneIds(idx, '0120214616,079-000-0003'), { kind: 'registered', ids: [3], freeIds: [1, 3], free: [{ number: '0120214616', stores: 2 }] }, '複数番号: 固定一致なら登録済み(フリーダイヤルの店も控える)');
  eq(M.matchPhoneIds(idx, '079-000-0003/0797112222'), { kind: 'registered', ids: [1, 3, 4], freeIds: [], free: [] }, '複数番号: 全番号の一致を集める');
  eq(M.matchPhoneIds(idx, '12345'), { kind: null, ids: [], freeIds: [], free: [] }, '6桁未満は照合しない');
  eq(M.matchPhoneIds(idx, ''), { kind: null, ids: [], freeIds: [], free: [] }, '電話なし');
  // 判定(kind)は従来の matchPhone と同じ
  for (const p of ['0797-11-2222', '090 1111 2222', '0120-214-616', '0570001673', '0120214616,079-000-0003', '03-0000-0000', '12345', '', null]) {
    eq(M.matchPhoneIds(idx, p).kind, M.matchPhone(plain, p).kind, '判定は従来と同じ: ' + p);
  }
  let threw = false;
  try { M.matchPhoneIds(plain, '0797112222'); } catch { threw = true; }
  ok(threw, '店IDのない索引で matchPhoneIds は例外');

  const addr = M.addNameAddrIndex(new Map(), STORES, { withIds: true });
  eq(M.matchNameAddrIds(addr, 'ガスト 芦屋店', '兵庫県芦屋市楠町７−１８'), [1, 4], '店名+住所: 一致した店ID(全角・空白の違いは同じ)');
  eq(M.matchNameAddrIds(addr, '一蘭神戸玉津店', '兵庫県神戸市西区平野町向井46-1 別のビル'), [2], '店名+住所: 建物名は無視');
  eq(M.matchNameAddrIds(addr, 'マクドナルド芦屋店', '兵庫県芦屋市楠町7-18'), [], '店名が違えば不一致');
  eq(M.matchNameAddrIds(addr, '山田工業', '兵庫県神戸市'), [], '市区町村までの住所は使わない');
  ok(M.matchNameAddr(addr, 'ガスト芦屋店', '兵庫県芦屋市楠町7-18'), 'matchNameAddr は店IDつきの索引でも使える');
  ok(!M.matchNameAddr(addr, 'ガ芦屋', '兵庫県芦屋市楠町7-18'), '3文字以下の包含は一致にしない(店IDつき索引)');
  threw = false;
  try { M.matchNameAddrIds(plainAddr, 'ガスト芦屋店', '兵庫県芦屋市楠町7-18'); } catch { threw = true; }
  ok(threw, '店IDのない索引で matchNameAddrIds は例外');

  // ---- matchShop(電話 → 店名+住所の順) ----
  const index = { phone: idx, addr };
  eq(M.matchShop(index, { name: '別名', address_raw: '東京都', phone: '0797-11-2222' }), { kind: 'registered', by: 'phone', ids: [1, 4], freeIds: [], free: [] }, 'matchShop: 電話で一致');
  eq(M.matchShop(index, { name: 'ガスト芦屋店', address_raw: '兵庫県芦屋市楠町7-18', phone: '06-9999-9999' }), { kind: 'registered', by: 'nameaddr', ids: [1, 4], freeIds: [], free: [] }, 'matchShop: 電話不一致でも店名+住所');
  eq(M.matchShop(index, { name: '本部直営 姫路店', address: '兵庫県姫路市北条1-1', phone: '0120-214-616' }).by, 'nameaddr', 'matchShop: フリーダイヤルのみでも店名+住所が一致すれば登録済み(address 列も使える)');
  eq(M.matchShop(index, { name: '別の店', address_raw: '京都府京都市1-1-1', phone: '0120-214-616' }), { kind: 'review', by: 'phone', ids: [], freeIds: [1, 3], free: [{ number: '0120214616', stores: 2 }] }, 'matchShop: フリーダイヤルのみ一致は要確認');
  eq(M.matchShop(index, { name: '新しい店', address_raw: '京都府京都市1-1-1', phone: '075-000-0000' }), { kind: null, by: null, ids: [], freeIds: [], free: [] }, 'matchShop: 不一致');
  eq(M.matchShop(index, null).kind, null, 'matchShop: 空');

  // ---- loadStocIndex(偽の接続。id 範囲で読む) ----
  function fakePool(rows) {
    const log = [];
    return {
      log,
      async query(sql, params) {
        log.push({ sql, params });
        const [after, lim] = params;
        const withStatus = /\bstatus\b/.test(sql);
        return [rows.filter((r) => r.id > after).slice(0, lim).map((r) => {
          const { status, ...rest } = r;
          return withStatus ? r : rest;
        })];
      },
    };
  }
  {
    const pool = fakePool(STORES);
    const r = await M.loadStocIndex(pool, 'stoc_sales');
    eq(pool.log.map((l) => l.sql), ['SELECT id, name, address, phone, phone_mobile, phone_free, phone_other FROM stoc_sales.stores WHERE merged_into IS NULL AND id > ? ORDER BY id LIMIT ?'], '従来: SQLは変わらない(1ページで終わる)');
    eq(pool.log[0].params, [0, 100000], '従来: 10万件ずつ');
    eq(Object.keys(r), ['phone', 'addr'], '従来: 戻りは phone と addr だけ');
    eq(r.phone.get('0797112222'), { n: 2, last: 4 }, '従来: 店IDなし');
    eq(r.phone.size, plain.size, '従来: 一括で作った索引と同じ大きさ');
  }
  {
    const pool = fakePool(STORES);
    const r = await M.loadStocIndex(pool, 'stoc_x', { withIds: true, pageSize: 2 });
    eq(pool.log.map((l) => l.params), [[0, 2], [2, 2], [4, 2], [6, 2]], 'withIds: 2件ずつ id の続きから');
    ok(/^SELECT id, name, address, phone, phone_mobile, phone_free, phone_other, status FROM stoc_x\.stores WHERE merged_into IS NULL/.test(pool.log[0].sql), 'withIds: status も読む');
    eq(r.phone.get('0797112222'), { n: 2, last: 4, ids: [1, 4] }, 'withIds: ページをまたいでも店IDがそろう');
    eq(r.phone.get('0120214616').ids, [1, 3], 'withIds: フリーダイヤルの店ID(ページまたぎ)');
    eq([...r.status.entries()], [[1, '契約'], [2, '未対応'], [3, '失注'], [4, '未対応'], [5, '未対応'], [6, '未対応']], 'withIds: ステータス');
    eq(M.matchShop(r, { name: 'ガスト芦屋店', address_raw: '兵庫県芦屋市楠町7-18', phone: '' }).ids, [1, 4], 'withIds: 読んだ索引で照合');
    // ページ分けしても件数は一括のときと同じ
    const all = M.buildPhoneIndex(STORES, { withIds: true });
    eq([...r.phone.entries()].sort(), [...all.entries()].sort(), 'ページ分けしても一括と同じ索引');
  }
  {
    const pool = fakePool([]);
    const r = await M.loadStocIndex(pool, 'stoc_sales', { withIds: true });
    eq([r.phone.size, r.addr.size, r.status.size], [0, 0, 0], '店がなければ空');
  }

  console.log(`stocmatch: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
