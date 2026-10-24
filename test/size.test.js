'use strict';
const cp = require('../src/companyProfile');
const { extractCompanySize: ex, classifySize, scoreProfileLink, findCompanySize } = cp;
const ff = require('../cli/find-forms');
const promote = require('../cli/warehouse-promote');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  ✗ ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);
const page = (body) => `<html><body>${body}</body></html>`;
const tbl = (label, value) => page(`<table><tr><th>${label}</th><td>${value}</td></tr></table>`);

function fakeSite(pages, log) {
  return async (url) => {
    if (log) log.push(url);
    const u = new URL(url);
    const key = u.origin + u.pathname;
    const body = pages[key] !== undefined ? pages[key] : pages[url];
    if (body === undefined) return { finalUrl: url, status: 404, headers: {}, body: '' };
    return { finalUrl: url, status: 200, headers: {}, body };
  };
}
const noRobots = async () => '';

(async () => {
  /* ---- 従業員数: 表 / dl / 文章 ---- */
  eq(ex(tbl('従業員数', '25名')).employees, 25, 'table basic');
  eq(ex(page('<table><tr><td>資本金</td><td>1,000万円</td></tr><tr><td>従業員</td><td>8人</td></tr></table>')).employees, 8, 'table td/td, 従業員');
  eq(ex(page('<table><tr><th>設立</th><td>1990年</td><th>従業員数</th><td>15名</td></tr></table>')).employees, 15, 'one row, two pairs');
  eq(ex(page('<dl><dt>従業員数</dt><dd>12名</dd></dl>')).employees, 12, 'dl dt/dd');
  eq(ex(page('<dl><dt>社員数</dt><dd>約40人</dd></dl>')).employees, 40, '社員数 + 約');
  eq(ex(page('<p>従業員数：25名</p>')).employees, 25, 'plain text colon');
  eq(ex(page('<div>従業員数 18名 資本金 500万円</div>')).employees, 18, 'plain text space');
  eq(ex(page('<ul><li>職員数:7名</li></ul>')).employees, 7, '職員数 plain');
  eq(ex(tbl('スタッフ数', '5名')).employees, 5, 'スタッフ数');
  eq(ex(tbl('従業者数', '9人')).employees, 9, '従業者数');
  eq(ex(tbl('従業員数', '２５名')).employees, 25, 'full-width digits');
  eq(ex(tbl('従業員数', '1,200名')).employees, 1200, 'commas');
  eq(ex(tbl('従業員数', '約30名')).employees, 30, '約');
  eq(ex(tbl('従業員数', '<span>20</span>')).employees, 20, 'bare number in cell');
  eq(ex(tbl('従業員数', '合計 30名（正社員20名 パート10名）')).employees, 30, '合計');
  eq(ex(tbl('従業員数', '正社員20名 パート5名 計25名')).employees, 25, '計');
  eq(ex(tbl('従業員数', '単体 120名 / グループ 300名')).employees, 120, '単体 vs グループ');
  eq(ex(tbl('従業員数', 'グループ合計 300名、当社 80名')).employees, 80, 'グループ合計 then 当社');
  eq(ex(tbl('従業員数', '正社員 12名 パート 8名')).employees, 20, '正社員+パート sum');
  eq(ex(tbl('従業員数', '男性15名、女性5名')).employees, 20, '男女 sum');
  eq(ex(tbl('従業員数', '20名（男性15名・女性5名）')).employees, 20, 'first number wins over breakdown');
  eq(ex(tbl('従業員数', '20名(うち男性15名、女性5名)')).employees, 20, 'うち breakdown ignored');
  eq(ex(tbl('従業員数', '2024年4月現在 25名')).employees, 25, 'year before number ignored');
  eq(ex(tbl('従業員数', '25名（2024年4月1日現在）')).employees, 25, 'year after number ignored');
  eq(ex(tbl('従業員数', '2024年4月現在')).employees, null, 'only a date -> null');
  eq(ex(page('<p>従業員の皆様の声を大切にします</p>')).employees, null, 'no number -> null');
  eq(ex(page('<p>お問い合わせください</p>')).employees, null, 'unrelated page');
  eq(ex(tbl('従業員数', '25名')).employeesText, '25名', 'employeesText');

  /* ---- 資本金 ---- */
  eq(ex(tbl('資本金', '1,000万円')).capitalYen, 10000000, 'capital 1,000万円');
  eq(ex(tbl('資本金', '3億5,000万円')).capitalYen, 350000000, 'capital 3億5,000万円');
  eq(ex(tbl('資本金', '10,000千円')).capitalYen, 10000000, 'capital 千円');
  eq(ex(tbl('資本金', '金500万円')).capitalYen, 5000000, 'capital 金500万円');
  eq(ex(tbl('資本金', '１億円')).capitalYen, 100000000, 'capital full-width 億');
  eq(ex(tbl('資本金', '5千万円')).capitalYen, 50000000, 'capital 千万');
  eq(ex(tbl('資本金', '5,000,000円')).capitalYen, 5000000, 'capital plain 円');
  eq(ex(page('<p>資本金：300万円</p>')).capitalYen, 3000000, 'capital plain text');
  eq(ex(tbl('資本金', '未定')).capitalYen, null, 'capital unknown');
  eq(ex(tbl('資本金', '1,000万円')).capitalText, '1,000万円', 'capitalText');

  /* ---- 上場 ---- */
  eq(ex(page('<table><tr><th>上場市場</th><td>東京証券取引所プライム市場</td></tr></table>')).listed, true, 'listed 東証(項目欄)');
  eq(ex(page('<dl><dt>証券コード</dt><dd>1234</dd></dl>')).listed, true, 'listed 証券コード欄');
  eq(ex(page('<p>当社(証券コード：6789)は</p>')).listed, true, 'listed 証券コード文中');
  eq(ex(page('<p>東京証券取引所プライム市場上場</p>')).listed, null, '文章中の東証は読まない');
  eq(ex(page('<table><tr><th>従業員数</th><td>12名</td></tr><tr><th>主要取引先</th><td>トヨタ自動車(東証プライム上場)</td></tr></table>')).listed, null, '取引先欄の東証は読まない');
  eq(ex(page('<table><tr><th>上場区分</th><td>非上場</td></tr></table>')).listed, false, '上場区分 非上場');
  eq(ex(page('<p>証券コード：1234</p>')).listed, true, 'listed 証券コード');
  eq(ex(page('<p>非上場</p>')).listed, false, '非上場 -> false');
  eq(ex(page('<p>未上場</p>')).listed, false, '未上場 -> false');
  eq(ex(page('<p>当社は小さな工場です</p>')).listed, null, 'listed unknown');
  eq(ex(page('<p>上場企業様との取引多数</p>')).listed, null, '上場企業様 not self');

  /* ---- classifySize ---- */
  eq(classifySize({ employees: 20 }), 'small', 'classify 20 small');
  eq(classifySize({ employees: 21 }), 'large', 'classify 21 large');
  eq(classifySize({ employees: 30 }, { maxEmployees: 50 }), 'small', 'classify custom max');
  eq(classifySize({ employees: 5, listed: true, capitalYen: 9e9 }), 'small', 'employees win');
  eq(classifySize({ employees: null, listed: true }), 'large', 'listed -> large');
  eq(classifySize({ employees: null, capitalYen: 100000000 }), 'large', 'capital 1億 -> large');
  eq(classifySize({ employees: null, capitalYen: 99999999 }), 'unknown', 'capital under -> unknown');
  eq(classifySize({ employees: null, capitalYen: 5000000 }), 'unknown', 'small capital only -> unknown');
  eq(classifySize({}), 'unknown', 'empty -> unknown');
  eq(classifySize(null), 'unknown', 'null -> unknown');

  /* ---- scoreProfileLink ---- */
  ok(scoreProfileLink({ url: 'https://a.jp/company/', text: '会社概要' }) > 0, 'score 会社概要');
  for (const t of ['会社案内', '企業情報', '企業概要', '会社情報', '事業所概要', '当社について']) {
    ok(scoreProfileLink({ url: 'https://a.jp/x', text: t }) > 0, 'score text ' + t);
  }
  for (const p of ['about', 'company', 'corporate', 'profile', 'outline', 'gaiyo', 'gaiyou']) {
    ok(scoreProfileLink({ url: 'https://a.jp/' + p + '.html', text: '' }) > 0, 'score path ' + p);
  }
  ok(scoreProfileLink({ url: 'https://a.jp/x', text: 'About Us' }) > 0, 'score text About');
  eq(scoreProfileLink({ url: 'https://a.jp/news', text: 'ニュース' }), 0, 'score none');
  eq(scoreProfileLink({ url: 'https://a.jp/privacy', text: 'プライバシーポリシー' }), 0, 'score privacy 0');
  eq(scoreProfileLink({ url: 'https://a.jp/company/privacy', text: '個人情報' }), 0, 'score privacy path 0');
  eq(scoreProfileLink({ url: 'https://a.jp/sitemap', text: 'サイトマップ' }), 0, 'score sitemap 0');
  eq(scoreProfileLink({ url: 'https://a.jp/company.pdf', text: '会社概要' }), 0, 'score pdf 0');
  const rec = scoreProfileLink({ url: 'https://a.jp/recruit/', text: '採用情報' });
  ok(rec > 0 && rec < scoreProfileLink({ url: 'https://a.jp/company/', text: '会社概要' }), 'recruit low but positive');

  /* ---- findCompanySize ---- */
  const TOP = 'https://shop.jp/';
  const topHtml = page('<a href="/news">NEWS</a><a href="/company/">会社概要</a><a href="/recruit/">採用情報</a><a href="https://other.jp/company/">会社概要</a><a href="/privacy">プライバシー</a>');
  const profHtml = page('<table><tr><th>従業員数</th><td>12名</td></tr><tr><th>資本金</th><td>1,000万円</td></tr></table>');

  // 取得済みページに答えがあれば追加取得なし
  let log = [];
  let r = await findCompanySize(TOP, { pages: [{ url: TOP, body: profHtml }], fetchPage: fakeSite({}, log), fetchRobots: noRobots });
  eq([r.employees, r.sizeClass, log.length, r.profileUrl], [12, 'small', 0, TOP], 'reuse pages: no refetch');
  eq(r.capitalYen, 10000000, 'reuse pages: capital');

  // 会社概要リンクをたどる(再取得なしでトップは取得済み)
  log = [];
  r = await findCompanySize(TOP, { pages: [{ url: TOP, body: topHtml }], fetchPage: fakeSite({ 'https://shop.jp/company/': profHtml }, log), fetchRobots: noRobots });
  eq([r.employees, r.sizeClass, r.profileUrl, log], [12, 'small', 'https://shop.jp/company/', ['https://shop.jp/company/']], 'follow profile link');
  eq(r.checkedPages, 2, 'checkedPages 2');
  ok(r.note.length <= 100, 'note short');

  // pagesなし: トップも取得する
  log = [];
  r = await findCompanySize(TOP, { fetchPage: fakeSite({ [TOP]: topHtml, 'https://shop.jp/company/': profHtml }, log), fetchRobots: noRobots });
  eq([r.employees, log], [12, [TOP, 'https://shop.jp/company/']], 'standalone fetches top then profile');

  // 追加取得は最大2ページ
  const many = page('<a href="/a/company">会社概要</a><a href="/b/about">会社案内</a><a href="/c/profile">企業情報</a><a href="/d/outline">企業概要</a>');
  log = [];
  r = await findCompanySize(TOP, { pages: [{ url: TOP, body: many }], fetchPage: fakeSite({ 'https://shop.jp/a/company': page('なし'), 'https://shop.jp/b/about': page('なし'), 'https://shop.jp/c/profile': profHtml }, log), fetchRobots: noRobots });
  eq(log.length, 2, 'max 2 extra fetches');
  eq(r.employees, null, 'third candidate not fetched');
  eq(r.sizeClass, 'unknown', 'not found -> unknown');
  ok(/従業員数の記載なし/.test(r.note), 'note: not described');

  // 外部ホストのリンクは辿らない
  log = [];
  r = await findCompanySize(TOP, { pages: [{ url: TOP, body: page('<a href="https://other.jp/company/">会社概要</a>') }], fetchPage: fakeSite({ 'https://other.jp/company/': profHtml }, log), fetchRobots: noRobots });
  eq([log.length, r.sizeClass], [0, 'unknown'], 'off-host link ignored');
  ok(/見つからない/.test(r.note), 'note: no profile link');

  // robots.txt
  log = [];
  r = await findCompanySize(TOP, { pages: [{ url: TOP, body: topHtml }], fetchPage: fakeSite({ 'https://shop.jp/company/': profHtml, 'https://shop.jp/recruit/': page('<p>従業員数 30名</p>') }, log), fetchRobots: async () => 'User-agent: *\nDisallow: /company' });
  eq([log, r.employees, r.sizeClass], [['https://shop.jp/recruit/'], 30, 'large'], 'robots disallow skips, recruit page used');

  // 規模が大きい
  r = await findCompanySize(TOP, { pages: [{ url: TOP, body: tbl('従業員数', '150名') }], fetchPage: fakeSite({}), fetchRobots: noRobots });
  eq(r.sizeClass, 'large', 'large via employees');
  r = await findCompanySize(TOP, { pages: [{ url: TOP, body: tbl('従業員数', '30名') }], fetchPage: fakeSite({}), fetchRobots: noRobots, maxEmployees: 50 });
  eq(r.sizeClass, 'small', 'maxEmployees option');
  r = await findCompanySize(TOP, { pages: [{ url: TOP, body: page('<table><tr><th>上場市場</th><td>東証プライム</td></tr></table>') }], fetchPage: fakeSite({}), fetchRobots: noRobots });
  eq([r.listed, r.sizeClass], [true, 'large'], 'listed -> large');

  // エラーは unknown(投げない)
  r = await findCompanySize(TOP, { fetchPage: async () => { throw Object.assign(new Error('接続できません'), { userSafe: true }); }, fetchRobots: noRobots });
  eq([r.sizeClass, r.note], ['unknown', '接続できません'], 'top fetch error -> unknown');
  r = await findCompanySize(TOP, { fetchPage: fakeSite({}), fetchRobots: noRobots });
  eq(r.sizeClass, 'unknown', 'top 404 -> unknown');
  ok(/HTTP 404/.test(r.note), 'note has HTTP 404');
  r = await findCompanySize(TOP, { pages: [{ url: TOP, body: topHtml }], fetchPage: async () => { throw new Error('boom'); }, fetchRobots: noRobots });
  eq(r.sizeClass, 'unknown', 'profile fetch error -> unknown');
  r = await findCompanySize(TOP, { pages: [{ url: TOP, body: topHtml }], fetchPage: fakeSite({}), fetchRobots: async () => { throw new Error('x'); } });
  eq(r.sizeClass, 'unknown', 'robots error tolerated');
  r = await findCompanySize('https://www.instagram.com/shop/', { fetchPage: async () => { throw new Error('should not fetch'); }, fetchRobots: noRobots });
  eq([r.sizeClass, /自社サイトではない/.test(r.note)], ['unknown', true], 'non-own site skipped');
  r = await findCompanySize(TOP, { pages: [{ url: TOP, body: null }], fetchPage: async () => { throw new Error('boom'); } });
  eq(r.sizeClass, 'unknown', 'bad pages never throw');

  /* ---- find-forms: 引数・対象クエリ・CSV・記録 ---- */
  let o = ff.parseArgs(['--source', 'warehouse', '--prefecture', '兵庫県', '--category', '製造, 建設,工事', '--with-size', '--max-employees', '30']);
  eq([o.category, o.withSize, o.sizeOnly, o.maxEmployees], [['製造', '建設', '工事'], true, false, 30], 'parse with-size/category/max');
  o = ff.parseArgs(['--source', 'warehouse', '--size-only']);
  eq([o.sizeOnly, o.withSize, o.maxEmployees], [true, false, 20], 'parse size-only default max 20');
  let threw = false; try { ff.parseArgs(['--size-only']); } catch { threw = true; }
  ok(threw, '--size-only needs warehouse');
  threw = false; try { ff.parseArgs(['--category', '製造']); } catch { threw = true; }
  ok(threw, '--category needs warehouse');
  threw = false; try { ff.parseArgs(['--source', 'warehouse', '--max-employees', '0']); } catch { threw = true; }
  ok(threw, 'invalid --max-employees');

  let q = ff.buildWarehouseSizeTargetQuery({ prefecture: '兵庫県', category: ['製造', '建設'], limit: 100 });
  eq(q.params, [['兵庫県'], '%製造%', '%建設%', 100], 'size query params');
  ok(/FROM stoc_master\.shops/.test(q.sql) && /size_checked_at IS NULL/.test(q.sql), 'size query targets unchecked');
  ok(/\(category_main LIKE \? OR category_main LIKE \?\)/.test(q.sql), 'size query category OR');
  ok(!/form_status/.test(q.sql), 'size query ignores form_status');
  q = ff.buildWarehouseSizeTargetQuery({ prefecture: null, category: [], limit: 10 });
  ok(!/prefecture IN/.test(q.sql) && !/category/.test(q.sql) && q.params.length === 1, 'size query no filters');
  q = ff.buildWarehouseSizeTargetQuery({ prefecture: '兵庫県', category: ['100%_off'], limit: 5 });
  eq(q.params[1], '%100\\%\\_off%', 'size query escapes wildcards');
  q = ff.buildWarehouseTargetQuery({ recheckDays: 90, errorRetryDays: 7, prefecture: '兵庫県', limit: 500, retryNeedsBrowser: false, category: ['製造', '建設'] });
  eq(q.params, [['兵庫県'], '%製造%', '%建設%', 7, 90, 500], 'warehouse query with category params');
  ok(/category_main LIKE \? OR category_main LIKE \?/.test(q.sql), 'warehouse query category');
  q = ff.buildWarehouseTargetQuery({ recheckDays: 90, errorRetryDays: 7, prefecture: '兵庫県', limit: 500, retryNeedsBrowser: false });
  eq(q.params, [['兵庫県'], 7, 90, 500], 'warehouse query unchanged without category');

  eq(ff.sizeToShopUpdate({ employees: 12, capitalYen: 10000000, listed: null, sizeClass: 'small', note: 'x'.repeat(300), profileUrl: 'https://a.jp/c' }),
    { employees: 12, capital_yen: 10000000, listed: null, size_class: 'small', size_note: 'x'.repeat(100), profile_url: 'https://a.jp/c' }, 'sizeToShopUpdate');
  eq(ff.sizeToShopUpdate({ listed: true, sizeClass: 'large' }).listed, 1, 'listed true -> 1');
  eq(ff.sizeToShopUpdate({ listed: false, sizeClass: 'weird' }).size_class, 'unknown', 'bad class -> unknown');

  const store = { id: 5, name: '店', prefecture: '兵庫県', website_url: 'https://a.jp/' };
  const base = { status: 'no_form', note: '' };
  eq(ff.csvRow(store, base).split(',').length, ff.CSV_COLUMNS.length, 'csv columns unchanged without --with-size');
  const withSize = ff.csvRow(store, { ...base, size: { employees: 12, capitalYen: 10000000, listed: false, sizeClass: 'small', profileUrl: 'https://a.jp/c' } }, { withSize: true });
  eq(withSize.split(',').length, ff.CSV_COLUMNS.length + 5, 'csv has 5 extra columns with --with-size');
  ok(/,12,10000000,非上場,小規模,https:\/\/a\.jp\/c/.test(withSize), 'csv size cells');
  const so = ff.csvRow(store, { status: 'size', size: { employees: null, sizeClass: 'unknown', note: '会社概要ページが見つからない' } }, { sizeOnly: true });
  eq(so.split(',').length, ff.SIZE_ONLY_CSV_COLUMNS.length, 'size-only csv columns');

  // makeFinder: フォーム探しで取得したページを使い回す
  log = [];
  const site = fakeSite({
    [TOP]: page('<a href="/contact/">お問い合わせ</a><a href="/company/">会社概要</a>'),
    'https://shop.jp/contact/': page('<p>メールでご連絡ください</p>'),
    'https://shop.jp/company/': profHtml,
  }, log);
  const f = ff.makeFinder({ withSize: true, fetchPage: site, fetchRobots: noRobots });
  const fr = await f(TOP);
  eq(fr.size.employees, 12, 'makeFinder with-size: employees');
  eq(fr.status, 'no_form', 'makeFinder keeps form result');
  eq(log.filter((u) => u === TOP).length, 1, 'top fetched once in total');
  ok(log.length <= 4, 'total fetches bounded: ' + log.length);
  ok(!('size' in await ff.makeFinder({ fetchPage: site, fetchRobots: noRobots })(TOP)), 'no size without --with-size');
  const fe = await ff.makeFinder({ withSize: true, fetchPage: async () => { throw new Error('x'); }, fetchRobots: noRobots })(TOP);
  eq([fe.status, fe.size.sizeClass], ['error', 'unknown'], 'with-size: top error -> unknown, no refetch');
  const fo = await ff.makeFinder({ sizeOnly: true, fetchPage: site, fetchRobots: noRobots })(TOP);
  eq([fo.status, fo.size.employees], ['size', 12], 'makeFinder size-only');

  // processStores: --size-only の集計とwriterの呼び出し
  const written = [];
  const st = await ff.processStores({
    stores: [{ id: 1, website_url: 'https://s1.jp/' }, { id: 2, website_url: 'https://s2.jp/' }, { id: 3, website_url: 'https://s3.jp/' }],
    finder: async (u) => ({ status: 'size', size: { sizeClass: u.includes('s1') ? 'small' : u.includes('s2') ? 'large' : 'unknown' } }),
    writer: async (s, r) => { written.push([s.id, r.size.sizeClass]); }, concurrency: 1, sizeOnlyStats: true,
  });
  eq([st.small, st.large, st.sizeUnknown, st.error, st.done], [1, 1, 1, 0, 3], 'size-only stats');
  eq(written.length, 3, 'size-only writer called');

  /* ---- warehouse-promote ---- */
  const pq = (args) => promote.buildQuery(promote.parseArgs(['--out', 'x.csv', ...args]));
  ok(!/size_class/.test(pq([]).sql), 'promote: no size filter by default');
  { const q = pq(['--main-category', '製造,建設']); ok(/\(category_main LIKE \? OR category_main LIKE \?\)/.test(q.sql), 'promote: --main-category'); eq(q.params, ['%製造%', '%建設%'], 'promote: --main-category params'); }
  ok(/size_class IS NULL OR size_class <> 'large'/.test(pq(['--exclude-large']).sql), 'promote: --exclude-large');
  ok(/size_class = 'small'/.test(pq(['--small-only']).sql), 'promote: --small-only');
  ok(/size_class = 'small'/.test(pq(['--small-only', '--exclude-large']).sql) && !/<> 'large'/.test(pq(['--small-only', '--exclude-large']).sql), 'promote: small-only wins');
  eq(pq(['--exclude-large', '--prefecture', '兵庫県']).params, [['兵庫県']], 'promote: params unchanged');
  eq(promote.HEADERS.length, 11, 'promote: CSV headers unchanged');
  const cq = promote.buildSizeExcludedCountQuery(promote.parseArgs(['--out', 'x', '--exclude-large']));
  ok(/^SELECT COUNT\(\*\) AS n\nFROM/.test(cq.sql) && /size_class = 'large'$/.test(cq.sql) && !/ORDER BY/.test(cq.sql), 'promote: excluded-count query');

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
