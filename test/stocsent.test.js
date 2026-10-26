'use strict';
// 入力元「送信成功済みの店(営業管理)」(src/stocSentSource.js, batch-scan --source stoc-sent, 管理画面のビルダー)のテスト。DB不要
const path = require('path');
const X = require('../src/stocSentSource');
const EX = require('../src/exclusions');
const { classifyIndustry, audienceOf } = require('../src/outreach');
const { parseArgs, selectForScan } = require('../cli/batch-scan');
const { buildStocSentScanArgs } = require('../src/adminWarehouse');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);

(async () => {
  // ---- 選ぶSQL ----
  const q = X.buildSelectQuery({ prefecture: '兵庫県,大阪府', categoryLike: 'ラーメン,美容', excludeCategoryLike: 'ゴルフ' }, { db: 'stoc_sales', storeFlags: true });
  ok(q.sql.includes("s.inquiry_form_result = '成功'"), 'SQL: 送信成功');
  ok(q.sql.includes("s.website_url IS NOT NULL AND s.website_url <> ''"), 'SQL: URLあり');
  ok(q.sql.includes('s.prefecture IN (?)'), 'SQL: 県');
  ok(q.sql.includes('(s.category LIKE ? OR s.category LIKE ?)'), 'SQL: 業種LIKE');
  ok(q.sql.includes('(s.category IS NULL OR (s.category NOT LIKE ?))'), 'SQL: 業種除外(NULLは残す)');
  eq(q.params, [['兵庫県', '大阪府'], '%ラーメン%', '%美容%', '%ゴルフ%'], 'SQL: パラメータ');
  {
    // 「病院」だけは動物病院を残す特例
    const h = X.buildSelectQuery({ excludeCategoryLike: '病院' }, { db: 'stoc_sales' });
    ok(h.sql.includes('(s.category IS NULL OR (NOT (s.category LIKE ? AND s.category NOT LIKE ?)))'), 'SQL: 病院除外は動物病院を残す');
    eq(h.params, ['%病院%', '%動物病院%'], 'SQL: 病院除外のパラメータ');
    const h2 = X.buildSelectQuery({ excludeCategoryLike: '病院,ゴルフ' }, { db: 'stoc_sales' });
    ok(h2.sql.includes('NOT (s.category LIKE ? AND s.category NOT LIKE ?) AND s.category NOT LIKE ?'), 'SQL: 他の語との併用');
    eq(h2.params, ['%病院%', '%動物病院%', '%ゴルフ%'], 'SQL: 併用のパラメータ');
  }
  ok(q.sql.includes("clm.call_result = 'クレーム'") && q.sql.includes('clm.deleted_at IS NULL') && q.sql.includes('clm.store_id = s.id'), 'SQL: クレーム(sales_logs)');
  ok(q.sql.includes("f.flag = 'クレーム' AND f.cleared_at IS NULL"), 'SQL: クレーム(store_flags)');
  ok(q.sql.includes('ORDER BY s.inquiry_form_sent_at IS NULL, s.inquiry_form_sent_at ASC'), 'SQL: 古い順');
  ok(!/LIMIT/.test(q.sql), 'SQL: LIMITなし(除外のあとに数える)');
  const q2 = X.buildSelectQuery({}, { db: 'stoc_sales', storeFlags: false });
  ok(!q2.sql.includes('prefecture IN') && !q2.sql.includes('LIKE') && !q2.sql.includes('store_flags'), 'SQL: 条件なし(全国・全業種)');
  eq(q2.params, [], 'SQL: パラメータなし');
  eq(X.buildSelectQuery({ categoryLike: '100%_' }, { db: 'd' }).params, ['%100\\%\\_%'], 'LIKEのエスケープ');

  // ---- 送信先URLの優先順位(営業管理 resolveInquiryUrls と同じ) ----
  eq(X.pickInquiryUrl('https://w/', { manual_inquiry_url: ' https://m/ ', confirmed_inquiry_url: 'https://c/' }, 'https://k/'), 'https://m/', '手入力が最優先');
  eq(X.pickInquiryUrl('https://w/', { manual_inquiry_url: '', confirmed_inquiry_url: 'https://c/' }, 'https://k/'), 'https://c/', '次に送信成功URL');
  eq(X.pickInquiryUrl('https://w/', { manual_inquiry_url: null, confirmed_inquiry_url: ' ' }, 'https://k/'), 'https://k/', '次に候補URL');
  eq(X.pickInquiryUrl('https://w/', null, null), 'https://w/', '最後にウェブサイト');
  const cq = X.buildResolveQueries([1, 2], 'stoc_sales');
  ok(cq.candidates.sql.includes("channel_type = 'inquiry_url' AND is_active = 1 ORDER BY store_id, success_count DESC, try_count ASC, id ASC"), '候補の並び順');
  ok(cq.channels.sql.includes('manual_inquiry_url, confirmed_inquiry_url'), 'channels列');
  // 偽の接続で解決(候補は並び順の先頭だけ採用・表がなければウェブサイトURL)
  const fake = (noTables) => ({
    async query(sql) {
      if (noTables) throw Object.assign(new Error('no table'), { errno: 1146 });
      if (/store_contact_channels/.test(sql)) return [[{ store_id: 1, manual_inquiry_url: 'https://m1/', confirmed_inquiry_url: '' }, { store_id: 2, manual_inquiry_url: '', confirmed_inquiry_url: 'https://c2/' }]];
      return [[{ store_id: 3, value: 'https://best3/' }, { store_id: 3, value: 'https://second3/' }, { store_id: 2, value: 'https://k2/' }]];
    },
  });
  const stores = [1, 2, 3, 4].map((id) => ({ id, website_url: `https://w${id}/` }));
  const m = await X.resolveFormUrls(fake(false), stores, 'stoc_sales');
  eq([...m], [[1, 'https://m1/'], [2, 'https://c2/'], [3, 'https://best3/'], [4, 'https://w4/']], 'URL解決: 手入力>成功URL>候補先頭>サイト');
  eq([...(await X.resolveFormUrls(fake(true), stores, 'stoc_sales'))].map((x) => x[1]), ['https://w1/', 'https://w2/', 'https://w3/', 'https://w4/'], '表なし: サイトURL');
  let err = null; try { await X.resolveFormUrls({ async query() { throw Object.assign(new Error('denied'), { errno: 1142 }); } }, stores, 'd'); } catch (e) { err = e; }
  ok(err, '権限エラーは握りつぶさない');

  // ---- チェーン(営業管理内で同じホストが3店以上) ----
  const hosts = X.chainHostsOf(['https://www.chain.jp/a', 'http://chain.jp/b', 'https://CHAIN.jp', 'https://two.jp/', 'https://two.jp/x', '', null, 'https://solo.jp']);
  eq([...hosts], ['chain.jp'], 'チェーン: www/大文字を揃えて3店以上だけ');

  // ---- クレーム・失注/契約・日の浅さ ----
  const NOW = new Date('2026-10-26T03:00:00Z');
  const day = (n) => new Date(NOW.getTime() - n * 86400e3);
  const rows = [
    { id: 1, status: '未対応', inquiry_form_sent_at: day(30), is_claim: 0 },
    { id: 2, status: '未対応', inquiry_form_sent_at: day(30), is_claim: 1 },
    { id: 3, status: '失注', inquiry_form_sent_at: day(30), is_claim: 0 },
    { id: 4, status: '契約', inquiry_form_sent_at: day(30), is_claim: 0 },
    { id: 5, status: '未対応', inquiry_form_sent_at: day(13), is_claim: 0 },
    { id: 6, status: '未対応', inquiry_form_sent_at: day(14.5), is_claim: 0 },
    { id: 7, status: '未対応', inquiry_form_sent_at: null, is_claim: 0 },
    { id: 8, status: '未対応', inquiry_form_sent_at: day(1), is_claim: '1' },
  ];
  const f = X.filterStoreRows(rows, { minDays: 14, now: NOW });
  eq(f.rows.map((r) => r.id), [1, 6, 7], '除外後の店');
  eq(f.counts, { [EX.REASON.claim]: 2, '営業管理で失注・契約': 2, '最終送信から日が浅い': 1 }, '理由別の件数');
  eq(X.filterStoreRows(rows, { minDays: 0, now: NOW }).rows.map((r) => r.id), [1, 5, 6, 7], '日数0は日の浅さを見ない');
  eq(X.filterStoreRows(rows, { minDays: 30, now: NOW }).rows.map((r) => r.id), [1, 7], '30日: ちょうど30日前は残す(30日未満だけ外す)');

  // ---- 行への変換 + batch-scan 側の除外(送信済み・除外ドメイン・チェーン) ----
  const sr = X.toScanRow({ id: 11, name: 'ラーメン太郎', website_url: 'https://taro.jp/', prefecture: '兵庫県', category: 'ラーメン店', phone: '', phone_mobile: '090-1', phone_free: '', address: '姫路市' }, 'https://taro.jp/contact');
  eq(sr, { store_id: '11', name: 'ラーメン太郎', url: 'https://taro.jp/', prefecture: '兵庫県', category: 'ラーメン店', formUrl: 'https://taro.jp/contact', captcha: '', noSales: '', phone: '090-1', address: '姫路市', stocStoreId: '11' }, '行の形(電話はSTOCと同じ順)');
  const cand = [1, 2, 3, 4, 5].map((i) => X.toScanRow({ id: i, website_url: `https://s${i}.jp/`, name: 'n' }, ''));
  cand[3].url = 'https://shop.chain.jp/'; cand[4].url = 'https://www.listed.example.com/';
  const sel = selectForScan(cand, { resendSet: new Set([1]), excludeList: ['listed.example.com'], chainHosts: new Set(['shop.chain.jp']), chainReason: X.REASON.chain }, 0);
  eq(sel.rows.map((r) => r.store_id), ['2', '3'], '送信済み・除外ドメイン・チェーンを外す');
  eq(sel.counts, { 'WEBドック送信済み・送信予定': 1, 'チェーン・共通ドメイン(営業管理)': 1, '除外ドメイン指定': 1 }, 'チェーンの理由は(営業管理)付き');
  eq(selectForScan(cand, { chainHosts: new Set(['shop.chain.jp']) }, 0).counts, { 'チェーン・共通ドメイン': 1 }, '既定の理由は従来どおり');
  eq(selectForScan(cand, {}, 2).rows.length, 2, 'limit は除外のあと');

  // ---- 業種区分([param2]の閲覧者) ----
  for (const [cat, ind, aud] of [['ラーメン店', '飲食', 'お客様・ご予約のお客様'], ['美容院', '美容', 'お客様・ご予約のお客様'], ['歯科医院', '医療', '患者様・ご家族様'], ['不動産会社', 'その他', 'お客様・取引先様'], ['', 'その他', 'お客様・取引先様']]) {
    eq(classifyIndustry(cat), ind, '業種区分: ' + cat);
    eq(audienceOf(classifyIndustry(cat)), aud, '閲覧者: ' + cat);
  }

  // ---- CLI引数 ----
  const a = parseArgs(['--source', 'stoc-sent', '--template', 'b2b', '--single-out', 'd', '--prefecture', '兵庫県', '--category-like', 'a,b', '--exclude-category-like', '病院', '--min-days-since-sent', '7', '--nationwide']);
  eq([a.source, a.categoryLike, a.excludeCategoryLike, a.minDaysSinceSent, a.nationwide], ['stoc-sent', 'a,b', '病院', 7, true], 'parseArgs');

  // ---- 管理画面の引数 ----
  const exportDir = '/x/exports';
  const N = new Date('2026-10-26T01:15:00Z');
  const sb = buildStocSentScanArgs({ pref: ['兵庫県', '大阪府'], exclude_hospital: '1' }, { exportDir, now: N });
  eq(sb.args, ['cli/batch-scan.js', '--source', 'stoc-sent', '--template', 'b2b', '--prefecture', '兵庫県,大阪府', '--min-days-since-sent', '14', '--exclude-category-like', '病院',
    '--limit', '2000', '--concurrency', '5', '--out', path.join(exportDir, sb.exportFile), '--single-out', path.join(exportDir, sb.singleDir)], '既定: 2000件・14日・専用ページなし');
  ok(!sb.args.includes('--with-page') && sb.withPage === false, '専用ページは既定OFF');
  const sn = buildStocSentScanArgs({ nationwide: '1', limit_stoc: '500', min_days: '30', with_page_stoc: '1' }, { exportDir, now: N });
  ok(sn.args.includes('--nationwide') && !sn.args.includes('--prefecture') && !sn.args.includes('--exclude-category-like'), '全国: --nationwide・病院チェックなしなら除外なし');
  eq(sn.args.slice(sn.args.indexOf('--min-days-since-sent'), sn.args.indexOf('--min-days-since-sent') + 2), ['--min-days-since-sent', '30'], '日数');
  eq(sn.args[sn.args.indexOf('--limit') + 1], '500', '上限');
  ok(sn.args.includes('--with-page') && sn.withPage, '専用ページON');
  ok(buildStocSentScanArgs({}, { exportDir, now: N }).error, '県も全国もなし → 拒否(全国のうっかり防止)');
  ok(buildStocSentScanArgs({ pref: [] }, { exportDir, now: N }).error, '県が空 → 拒否');
  ok(buildStocSentScanArgs({ pref: ['東京都'], nationwide: '1' }, { exportDir, now: N }).error, '県と全国の両方 → 拒否');
  ok(buildStocSentScanArgs({ pref: ['火星県'] }, { exportDir, now: N }).error, '不正な県');
  ok(buildStocSentScanArgs({ pref: ['東京都'], limit_stoc: '1;x' }, { exportDir, now: N }).error, '不正な上限');
  ok(buildStocSentScanArgs({ pref: ['東京都'], min_days: '-1' }, { exportDir, now: N }).error, '不正な日数');
  ok(buildStocSentScanArgs({ pref: ['東京都'], min_days: '0' }, { exportDir, now: N }).args.includes('0'), '日数0は許可');

  console.log(`stocsent.test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
