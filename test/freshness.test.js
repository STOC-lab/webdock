'use strict';
// 最終更新日の判定(src/freshness.js)のテスト。ネット接続なし・偽の取得関数を使う。
const { detectLatestPost, toJstDate, daysAgo, extractDates } = require('../src/freshness');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);

const NOW = new Date('2026-10-27T03:00:00Z'); // 日本時間 2026-10-27 12:00
const SITE = 'https://example.co.jp/';

/** pages: { URL: body | { status, body } }。呼ばれたURLを calls に記録する */
function fake(pages) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const p = pages[url];
    if (p === undefined) return { finalUrl: url, status: 404, headers: {}, body: '' };
    if (p instanceof Error) throw p;
    const o = typeof p === 'string' ? { status: 200, body: p } : p;
    return { finalUrl: url, headers: {}, ...o };
  };
  fn.calls = calls;
  return fn;
}
const run = (pages, opts = {}) => { const f = fake(pages); return detectLatestPost(SITE, { fetchPage: f, now: NOW, ...opts }).then((r) => ({ r, f })); };
const day = (r) => (r.date ? toJstDate(r.date) : null);

(async () => {
  // ---- 日付の道具 ----
  eq(toJstDate(new Date('2026-10-26T16:00:00Z')), '2026-10-27', 'toJstDate: UTC16時は翌日');
  eq(toJstDate(new Date('2026-10-26T14:59:00Z')), '2026-10-26', 'toJstDate: 日本時間23:59');
  eq(daysAgo(new Date('2026-10-20T00:00:00+09:00'), NOW), 7, 'daysAgo 7日');
  eq(daysAgo(new Date('2026-10-27T00:10:00+09:00'), NOW), 0, 'daysAgo 当日');
  eq(daysAgo(new Date('2026-10-26T15:30:00Z'), new Date('2026-10-26T15:10:00Z')), 0, 'daysAgo 日本時間で同じ日');
  eq(extractDates('2026.10.5 / 2026/9/30 / 2026-8-1 / 2026年7月3日 / ２０２６．６．２', NOW).map((x) => toJstDate(x.date)),
    ['2026-10-05', '2026-09-30', '2026-08-01', '2026-07-03', '2026-06-02'], '日付の書き方5種(全角含む)');
  eq(extractDates('2026.13.5 2026.2.30 1999.1.1 12026.1.1', NOW).length, 0, '妥当でない日付・2000年より前は捨てる');
  eq(extractDates('© 2024 Example Co., Ltd. 2024', NOW).length, 0, '著作権の年だけは日付にしない');

  // ---- RSS ----
  {
    const html = '<html><head><link rel="alternate" type="application/rss+xml" title="RSS" href="/rss.xml"></head><body>hello</body></html>';
    const rss = `<?xml version="1.0"?><rss><channel><item><title><![CDATA[新商品のお知らせ]]></title><link>https://example.co.jp/n/2</link><pubDate>Fri, 23 Oct 2026 10:00:00 +0900</pubDate></item>
      <item><title>古い記事</title><link>https://example.co.jp/n/1</link><pubDate>Mon, 01 Jun 2026 10:00:00 +0900</pubDate></item></channel></rss>`;
    const { r } = await run({ [SITE]: html, 'https://example.co.jp/rss.xml': rss });
    eq([day(r), r.source, r.url, r.title], ['2026-10-23', 'rss', 'https://example.co.jp/n/2', '新商品のお知らせ'], 'RSS 最新の記事');
  }
  // ---- RSS(並びが古い順でも最新を取る)+ dc:date ----
  {
    const html = '<link rel="alternate" type="application/rss+xml" href="/index.rdf">';
    const rdf = '<rdf:RDF><item><title>A</title><link>https://example.co.jp/a</link><dc:date>2026-10-01T09:00:00+09:00</dc:date></item><item><title>B</title><link>https://example.co.jp/b</link><dc:date>2026-10-25T09:00:00+09:00</dc:date></item></rdf:RDF>';
    const { r } = await run({ [SITE]: html, 'https://example.co.jp/index.rdf': rdf });
    eq([day(r), r.source, r.title], ['2026-10-25', 'rss', 'B'], 'RDF dc:date の最新');
  }
  // ---- Atom ----
  {
    const html = '<link rel="alternate" type="application/atom+xml" href="https://example.co.jp/atom.xml">';
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>ブログ更新</title><link rel="alternate" href="https://example.co.jp/p/9"/><updated>2026-10-26T20:00:00Z</updated><published>2026-10-26T20:00:00Z</published></entry></feed>`;
    const { r } = await run({ [SITE]: html, 'https://example.co.jp/atom.xml': atom });
    eq([day(r), r.source, r.url, r.title], ['2026-10-27', 'rss', 'https://example.co.jp/p/9', 'ブログ更新'], 'Atom(UTCは日本時間の日付にする)');
  }
  // ---- WordPress: フィードの link が無いとき /feed/ を試す ----
  {
    const html = '<html><body><img src="/wp-content/uploads/a.png"></body></html>';
    const feed = '<rss><channel><item><title>WP記事</title><link>https://example.co.jp/wp1</link><pubDate>Thu, 22 Oct 2026 09:00:00 +0900</pubDate></item></channel></rss>';
    const { r, f } = await run({ [SITE]: html, 'https://example.co.jp/feed/': feed });
    eq([day(r), r.source], ['2026-10-22', 'rss'], 'wp-content があれば /feed/ を試す');
    ok(f.calls.includes('https://example.co.jp/feed/'), '/feed/ を取りに行った');
  }
  // ---- WordPress JSON ----
  {
    const html = '<html><head><link rel="https://api.w.org/" href="https://example.co.jp/wp-json/"></head><body></body></html>';
    const json = JSON.stringify([{ date: '2026-10-24T08:30:00', link: 'https://example.co.jp/2026/10/hello/', title: { rendered: '&#8220;こんにちは&#8221;' } }]);
    const { r } = await run({ [SITE]: html, 'https://example.co.jp/wp-json/wp/v2/posts?per_page=1&_fields=date,link,title': json });
    eq([day(r), r.source, r.url], ['2026-10-24', 'wordpress', 'https://example.co.jp/2026/10/hello/'], 'WordPress JSON');
    eq(r.title, '“こんにちは”', 'WordPress タイトルの文字参照を戻す');
  }
  // ---- お知らせページ ----
  {
    const top = '<html><body><nav><a href="/">ホーム</a><a href="/news/">お知らせ</a><a href="/about/">会社概要</a></nav></body></html>';
    const news = '<html><body><h1>お知らせ</h1><ul><li><span>2026.10.19</span><a href="/n/3">年末年始の営業について</a></li><li><span>2026.9.1</span><a href="/n/2">夏季休業</a></li></ul></body></html>';
    const { r } = await run({ [SITE]: top, 'https://example.co.jp/news/': news });
    eq([day(r), r.source, r.url, r.title], ['2026-10-19', 'news_page', 'https://example.co.jp/news/', '年末年始の営業について'], 'お知らせページ');
  }
  // ---- お知らせページ(リンクは href にだけキーワード・他サイトは追わない) ----
  {
    const top = '<a href="/topics/index.html"><img src="x.png"></a><a href="https://other.example.com/news/">外部NEWS</a>';
    const { r, f } = await run({ [SITE]: top, 'https://example.co.jp/topics/index.html': '<p>2026/10/10 更新</p>', 'https://other.example.com/news/': '<p>2026/10/26</p>' });
    eq([day(r), r.source], ['2026-10-10', 'news_page'], 'hrefだけ一致のリンクも見る');
    ok(!f.calls.includes('https://other.example.com/news/'), '別サイトのリンクは追わない');
  }
  // ---- トップページ: キーワードの近くの日付だけ ----
  {
    const near = '<html><body><section><h2>NEWS</h2><ul><li>2026.10.21 新メニュー開始</li><li>2026.9.30 臨時休業</li></ul></section></body></html>';
    const { r } = await run({ [SITE]: near });
    eq([day(r), r.source, r.title], ['2026-10-21', 'top_page', '新メニュー開始'], 'トップページのNEWS欄');
    const far = '<html><body><p>創業 2010.4.1 / 工場を拡張しました 2026.10.20</p></body></html>';
    const r2 = (await run({ [SITE]: far })).r;
    eq([r2.date, r2.source], [null, null], 'キーワードが無い日付は採用しない');
    ok(/日付が見つからない/.test(r2.note), 'note に理由');
    const tooFar = '<h2>お知らせ</h2>' + 'あ'.repeat(320) + '<p>2026.10.20</p>';
    eq((await run({ [SITE]: tooFar })).r.date, null, 'キーワードが300文字より前なら不採用');
  }
  // ---- 未来の日付・著作権表記 ----
  {
    const html = '<h2>お知らせ</h2><ul><li>2026.12.25 クリスマスイベント</li><li>2026.10.28 明日のセール</li><li>2026.10.15 通常のお知らせ</li></ul><footer>© 2026 Example</footer>';
    const { r } = await run({ [SITE]: html });
    eq(day(r), '2026-10-28', '明日(now+1日以内)までは採用');
    const html2 = '<h2>お知らせ</h2><ul><li>2026.12.25 クリスマスイベント</li><li>2026.10.15 通常のお知らせ</li></ul>';
    eq(day((await run({ [SITE]: html2 })).r), '2026-10-15', '未来の日付は捨てる');
    const html3 = '<h2>お知らせ</h2><footer>© 2024 Example Co.</footer>';
    eq((await run({ [SITE]: html3 })).r.date, null, '©年だけは不採用');
  }
  // ---- 全角数字 ----
  {
    const html = '<dl><dt>ニュース</dt><dd>２０２６年１０月２２日 秋の感謝祭</dd></dl>';
    const { r } = await run({ [SITE]: html });
    eq([day(r), r.source], ['2026-10-22', 'top_page'], '全角数字');
  }
  // ---- sitemap ----
  {
    const sm = `<urlset><url><loc>https://example.co.jp/about/</loc><lastmod>2026-10-26</lastmod></url>
      <url><loc>https://example.co.jp/blog/post-1/</loc><lastmod>2026-10-18T10:00:00+09:00</lastmod></url>
      <url><loc>https://example.co.jp/2026/09/old/</loc><lastmod>2026-09-02</lastmod></url></urlset>`;
    const { r } = await run({ [SITE]: '<html><body>何もなし</body></html>', 'https://example.co.jp/sitemap.xml': sm });
    eq([day(r), r.source, r.url], ['2026-10-18', 'sitemap', 'https://example.co.jp/blog/post-1/'], 'sitemap は記事らしいURLだけ');
    const idx = '<sitemapindex><sitemap><loc>https://example.co.jp/page-sitemap.xml</loc></sitemap><sitemap><loc>https://example.co.jp/post-sitemap.xml</loc></sitemap></sitemapindex>';
    const child = '<urlset><url><loc>https://example.co.jp/2026/10/x/</loc><lastmod>2026-10-23</lastmod></url></urlset>';
    const { r: r2, f } = await run({ [SITE]: '<html></html>', 'https://example.co.jp/sitemap.xml': idx, 'https://example.co.jp/post-sitemap.xml': child });
    eq([day(r2), r2.source], ['2026-10-23', 'sitemap'], 'sitemapindex は post を含む子だけ追加取得');
    ok(!f.calls.includes('https://example.co.jp/page-sitemap.xml'), 'page-sitemap は取らない');
    // 日付が他で見つかっていれば sitemap は見ない
    const { f: f3 } = await run({ [SITE]: '<h2>NEWS</h2>2026.10.20', 'https://example.co.jp/sitemap.xml': sm });
    ok(!f3.calls.includes('https://example.co.jp/sitemap.xml'), '日付があれば sitemap は見ない');
  }
  // ---- 複数の候補から最新を採る ----
  {
    const top = '<link rel="alternate" type="application/rss+xml" href="/rss"><a href="/news/">お知らせ</a>';
    const rss = '<rss><item><title>R</title><link>https://example.co.jp/r</link><pubDate>Mon, 05 Oct 2026 10:00:00 +0900</pubDate></item></rss>';
    const { r } = await run({ [SITE]: top, 'https://example.co.jp/rss': rss, 'https://example.co.jp/news/': '<p>2026.10.22 お知らせです</p>' });
    eq([day(r), r.source], ['2026-10-22', 'news_page'], 'RSSよりお知らせページが新しければそちら');
  }
  // ---- 取得失敗 ----
  {
    const r1 = (await run({ [SITE]: new Error('boom') })).r;
    eq([r1.date, r1.source], [null, null], 'トップが取れない');
    ok(/取得できず/.test(r1.note), 'note: 取得できず');
    const r2 = (await run({ [SITE]: { status: 500, body: 'err' } })).r;
    eq(r2.date, null, 'トップが500');
    // 途中の取得失敗は握りつぶして次へ
    const top = '<link rel="alternate" type="application/rss+xml" href="/rss"><a href="/news/">お知らせ</a>';
    const r3 = (await run({ [SITE]: top, 'https://example.co.jp/rss': new Error('x'), 'https://example.co.jp/news/': '<p>2026.10.20 a</p>' })).r;
    eq([day(r3), r3.source], ['2026-10-20', 'news_page'], 'フィード失敗でも次へ');
  }
  // ---- 取得回数の上限・全体の時間切れ ----
  {
    const top = '<link rel="alternate" type="application/rss+xml" href="/rss"><a href="/news/">お知らせ</a><a href="/blog/">ブログ</a><div>wp-content</div>';
    const { f } = await run({ [SITE]: top }, { maxRequests: 3 });
    eq(f.calls.length, 3, 'maxRequests=3 を超えない');
    const { f: f6 } = await run({ [SITE]: top });
    ok(f6.calls.length <= 6, '既定 6回を超えない: ' + f6.calls.length);
    const hang = () => new Promise(() => {});
    const t0 = Date.now();
    const r = await detectLatestPost(SITE, { fetchPage: hang, now: NOW, timeoutMs: 80 });
    ok(Date.now() - t0 < 1000, '全体タイムアウトで打ち切る');
    eq(r.date, null, 'タイムアウト時は date:null');
  }

  console.log(`freshness: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
