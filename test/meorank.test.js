'use strict';
// MEO順位(src/meoRank.js)のテスト。fetchをモックするのでネットワーク・DB不要
const M = require('../src/meoRank');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}

/** pagesByQuery: { 検索語: [[id...], [id...], ...] }。呼び出しを calls に記録 */
function mock(pagesByQuery, { apiKey = 'K' } = {}) {
  const calls = [];
  let t = 1000;
  const deps = {
    apiKey,
    now: () => t,
    advance: (ms) => { t += ms; },
    sleeps: [],
    sleep: async (ms) => { deps.sleeps.push(ms); },
    fetch: async (url, opt) => {
      const body = JSON.parse(opt.body);
      calls.push({ url, opt, body });
      const pages = pagesByQuery[body.textQuery] || [[]];
      const idx = body.pageToken ? Number(body.pageToken) : 0;
      const ids = pages[idx] || [];
      const out = { places: ids.map((id) => ({ id })) };
      if (idx + 1 < pages.length) out.nextPageToken = String(idx + 1);
      return { ok: true, status: 200, json: async () => out };
    },
  };
  return { deps, calls };
}
const range = (a, b, p) => Array.from({ length: b - a + 1 }, (_, i) => p + (a + i));

(async () => {
  // ---- フィールドマスク・リクエスト形 ----
  eq(M.FIELD_MASK, 'places.id,nextPageToken', 'フィールドマスクは固定');
  {
    M.clearCache();
    const { deps, calls } = mock({ 'A店 姫路': [['p1']] });
    const id = await M.findPlaceId({ name: 'A店', address: '姫路' }, deps);
    eq(id, 'p1', '1件目のID');
    const c = calls[0];
    eq(c.url, 'https://places.googleapis.com/v1/places:searchText', 'エンドポイント固定');
    eq(c.opt.headers['X-Goog-FieldMask'], 'places.id,nextPageToken', 'ヘッダーのフィールドマスク');
    eq(c.opt.headers['X-Goog-Api-Key'], 'K', 'APIキーヘッダー');
    eq([c.body.languageCode, c.body.regionCode, c.body.pageSize], ['ja', 'JP', 20], '本文の固定値');
  }
  // ---- ページ送り ----
  {
    M.clearCache();
    const { deps, calls } = mock({ 'kw': [range(1, 20, 'x'), [...range(21, 30, 'x').slice(0, 0), ...Array.from({ length: 20 }, (_, i) => i === 0 ? 'mine' : 'y' + i)]] });
    eq(await M.rankFor({ placeId: 'mine', keyword: 'kw' }, deps), 21, '2ページ目の先頭は21位');
    eq(calls.length, 2, '2回呼ぶ');
    eq(deps.sleeps, [2000], '次ページ前に2秒待つ');
    eq(calls.every((c) => c.opt.headers['X-Goog-FieldMask'] === 'places.id,nextPageToken'), true, '全呼び出しでマスク固定');
  }
  {
    M.clearCache();
    const { deps } = mock({ k1: [['a', 'mine']] });
    eq(await M.rankFor({ placeId: 'mine', keyword: 'k1' }, deps), 2, '1ページ目2位');
  }
  // ---- 60件で圏外 ----
  {
    M.clearCache();
    const { deps, calls } = mock({ k2: [range(1, 20, 'a'), range(1, 20, 'b'), range(1, 20, 'c'), range(1, 20, 'd')] });
    eq(await M.rankFor({ placeId: 'mine', keyword: 'k2' }, deps), null, '圏外はnull');
    eq(calls.length, 3, '最大3ページ');
  }
  // ---- checkRanks ----
  {
    M.clearCache();
    const { deps } = mock({ 'B店 神戸': [['mine']], q1: [['mine']], q2: [range(1, 20, 'a')] });
    const r = await M.checkRanks({ name: 'B店', address: '神戸', keywords: ['q1', 'q2'] }, deps);
    eq(r.placeId, 'mine', 'placeId');
    eq(r.results.map((x) => [x.keyword, x.rank]), [['q1', 1], ['q2', null]], '順位と圏外');
    eq(typeof r.results[0].checkedAt, 'string', 'checkedAt');
  }
  {
    M.clearCache();
    const { deps } = mock({});
    const r = await M.checkRanks({ name: 'C店', address: 'x', keywords: ['q'] }, deps);
    eq(r, { placeId: null, error: 'Googleマップで店舗を特定できませんでした' }, '店舗特定できない');
  }
  // ---- キー未設定 ----
  {
    M.clearCache();
    const { deps, calls } = mock({}, { apiKey: '' });
    const r = await M.checkRanks({ name: 'D', address: 'x', keywords: ['q'] }, deps);
    eq(r.error, 'MEO順位を調べるには、管理者がGoogleのAPIキーを設定してください', 'キー未設定の案内');
    eq(calls.length, 0, 'キー無しでは通信しない');
  }
  // ---- キャッシュ(24時間)----
  {
    M.clearCache();
    const { deps, calls } = mock({ 'E店 x': [['mine']], q: [['mine']] });
    await M.checkRanks({ name: 'E店', address: 'x', keywords: ['q'] }, deps);
    const n = calls.length;
    await M.checkRanks({ name: 'E店', address: 'x', keywords: ['q'] }, deps);
    eq(calls.length, n, '2回目はキャッシュ');
    deps.advance(24 * 60 * 60 * 1000 + 1);
    await M.checkRanks({ name: 'E店', address: 'x', keywords: ['q'] }, deps);
    eq(calls.length, n * 2, '24時間後は再取得');
  }
  // ---- HTTPエラー ----
  {
    M.clearCache();
    const { deps } = mock({});
    deps.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
    let msg = '';
    try { await M.findPlaceId({ name: 'F', address: '' }, deps); } catch (e) { msg = e.message; }
    eq(/403/.test(msg), true, 'HTTPエラーは例外');
  }
  // ---- suggestKeywords ----
  eq(M.suggestKeywords({ address: '兵庫県姫路市北条梅原町229', category: '美容室' }), ['姫路市 美容室', '姫路 美容室', '姫路市 美容室 おすすめ'], '姫路の例');
  eq(M.suggestKeywords({ address: '大阪府大阪市北区梅田1-1', category: '歯科' })[0], '大阪市 歯科', '政令市は市');
  eq(M.suggestKeywords({ address: '東京都渋谷区1-1', category: 'カフェ' })[0], '渋谷区 カフェ', '区');
  eq(M.suggestKeywords({ address: '兵庫県神崎郡福崎町1', category: '工務店' })[0], '福崎町 工務店', '郡の町');
  eq(M.suggestKeywords({ address: '', category: '美容室' }), [], '住所なし');
  eq(M.suggestKeywords({ address: '兵庫県姫路市1', category: '' }), [], '業種なし');
  eq(M.suggestKeywords({ address: '兵庫県姫路市1', category: '美容室、ネイル' })[0], '姫路市 美容室', '業種は先頭');
  // ---- 連打防止 ----
  M.resetCooldown();
  eq(M.tooSoon('u', 1000), false, '初回OK');
  eq(M.tooSoon('u', 3000), true, '2秒後は拒否');
  eq(M.tooSoon('v', 3000), false, '別ユーザーはOK');
  eq(M.tooSoon('u', 6100), false, '5秒後はOK');

  console.log(`meorank: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
