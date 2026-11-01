'use strict';
// ブログ更新の判定(src/blogActivity.js)のテスト。ネット不要。
const B = require('../src/blogActivity');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);

const NOW = Date.UTC(2026, 10, 1, 0, 0, 0); // 2026-11-01
const iso = (days) => new Date(NOW - days * 86400000).toISOString();
const rfc = (days) => new Date(NOW - days * 86400000).toUTCString();
const day = (days) => iso(days).slice(0, 10);

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title><lastBuildDate>${rfc(0)}</lastBuildDate>
<item><title>a</title><pubDate>${rfc(5)}</pubDate></item><item><title>b</title><pubDate>${rfc(40)}</pubDate></item>
<item><title>c</title><pubDate>${rfc(200)}</pubDate></item></channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>a</title><updated>${iso(3)}</updated></entry>
<entry><title>b</title><published>${iso(100)}</published><updated>${iso(1)}</updated></entry></feed>`;
const URLSET = `<urlset><url><loc>https://ex.com/</loc><lastmod>${day(1)}</lastmod></url>
<url><loc>https://ex.com/about/</loc><lastmod>${day(2)}</lastmod></url>
<url><loc>https://ex.com/blog/a</loc><lastmod>${day(10)}</lastmod></url>
<url><loc>https://ex.com/news/b</loc><lastmod>${day(50)}</lastmod></url>
<url><loc>https://ex.com/2024/05/c</loc><lastmod>${day(300)}</lastmod></url></urlset>`;
const INDEX = `<sitemapindex><sitemap><loc>https://ex.com/page-sitemap.xml</loc><lastmod>${day(1)}</lastmod></sitemap>
<sitemap><loc>https://ex.com/post-sitemap.xml</loc><lastmod>${day(20)}</lastmod></sitemap></sitemapindex>`;
const WP = JSON.stringify([{ date: iso(2) }, { date: iso(30) }, { date: iso(400) }]);

// ---- 解析 ----
const r1 = B.parseFeed(RSS, NOW);
eq([r1.kind, r1.dates.length], ['rss', 3], 'RSS2: 3件(lastBuildDateは数えない)');
const r2 = B.parseFeed(ATOM, NOW);
eq([r2.kind, r2.dates.length], ['atom', 2], 'Atom: 2件');
eq(new Date(Math.max(...r2.dates)).toISOString(), iso(3), 'Atom: 更新日(updated)と公開日(published)。公開日があれば公開日');
eq(B.parseFeed('<html></html>', NOW), null, 'フィードでなければ null');
eq(B.parseFeed(`<rss><channel><item><pubDate>${rfc(-5)}</pubDate></item><item><pubDate>Tue, 01 Jan 1999 00:00:00 GMT</pubDate></item><item><pubDate>こわれた</pubDate></item></channel></rss>`, NOW).dates, [], '未来(5日先)・1999年・壊れた日付は無視');
eq(B.parseFeed(`<rss><channel><item><pubDate>${rfc(-0.5)}</pubDate></item></channel></rss>`, NOW).dates.length, 1, '12時間先までは許す(1日以内)');
eq(B.parseFeed('<rss><channel><item><title>途中で', NOW).dates, [], '壊れたXMLでも落ちない');
eq(B.parseFeed(`<rss><channel><item><pubDate><![CDATA[${rfc(2)}]]></pubDate></item></channel></rss>`, NOW).dates.length, 1, 'CDATAの日付');
eq(B.parseFeed(`<rdf:RDF><item><dc:date>${iso(4)}</dc:date></item></rdf:RDF>`, NOW).dates.length, 1, 'RSS1.0 dc:date');
const w = B.parseWpJson(WP, NOW);
eq([w.kind, w.dates.length], ['wp-json', 3], 'WP REST');
eq(B.parseWpJson('not json', NOW), null, 'JSONでなければ null');
eq(B.parseWpJson('{"code":"rest_no_route"}', NOW), null, 'WPのエラー応答(配列でない)は null');
eq(B.parseWpJson('[{"date":"2999-01-01T00:00:00"},{"x":1}]', NOW).dates, [], 'WP: 未来・日付なしは無視');
const sm = B.parseSitemap(URLSET);
eq([sm.index, sm.entries.length], [false, 5], 'サイトマップ urlset');
eq(B.parseSitemap(INDEX).index, true, 'サイトマップ index');
eq(B.parseSitemap('<html/>'), null, 'サイトマップでなければ null');

// ---- サイトマップの集計 ----
const s1 = B.summarizeSitemap(sm, NOW);
eq([s1.posts90d, s1.latestAt.toISOString().slice(0, 10)], [2, day(10)], 'urlset: 記事らしいパス(/blog /news)だけ数える。静的ページは除く');
const s2 = B.summarizeSitemap(B.parseSitemap(`<urlset><url><loc>https://ex.com/a.html</loc><lastmod>${day(3)}</lastmod></url><url><loc>https://ex.com/b.html</loc><lastmod>${day(100)}</lastmod></url></urlset>`), NOW);
eq([s2.posts90d, !!s2.note], [1, true], '記事らしいURLが無いときは全URLで数えて注記');
const s3 = B.summarizeSitemap(B.parseSitemap(INDEX), NOW);
eq([s3.posts90d, s3.latestAt.toISOString().slice(0, 10)], [null, day(20)], 'index: 再帰せず、記事用らしい子の更新日だけ(件数は数えない)');
eq(B.summarizeSitemap(B.parseSitemap('<urlset><url><loc>https://ex.com/blog/x</loc></url></urlset>'), NOW), null, 'lastmodが無ければ null');
eq(B.summarizeSitemap(B.parseSitemap(`<urlset><url><loc>https://ex.com/blog/x</loc><lastmod>${day(-30)}</lastmod></url></urlset>`), NOW), null, '未来のlastmodだけなら null');

// ---- 外部ブログ ----
eq(B.detectExternalBlog('<a href="https://ameblo.jp/shopname/">ブログ</a>'), 'ameblo.jp', 'ameblo');
eq(B.detectExternalBlog('<a href="https://ameblo.jp/">x</a>'), null, 'amebloのトップだけは除く');
eq(B.detectExternalBlog('<a href="https://note.com/abc">n</a>'), 'note.com', 'note');
eq(B.detectExternalBlog('<a href="https://note.com/intent/post?url=x">n</a>'), null, 'noteの共有ボタンは除く');
eq(B.detectExternalBlog('<a href="https://shop.hatenablog.com/">n</a>'), 'hatenablog', 'はてなブログ');
eq(B.detectExternalBlog('<a href="http://blog.livedoor.jp/shop/">n</a>'), 'livedoor', 'livedoor');
eq(B.detectExternalBlog('<a href="https://www.instagram.com/shop/">i</a>'), null, 'Instagramはブログではない');
eq(B.blogSourceValue({ source: null, external: 'hatenablog' }), 'external:hatenablog', 'blog_source: external:名前');
eq(B.blogSourceValue({ source: 'rss', external: 'note.com' }), 'rss', 'blog_source: 内部の取得元が優先');
ok(['ameblo.jp', 'note.com', 'hatenablog', 'livedoor', 'fc2', 'seesaa', 'exblog', 'jugem', 'nifty', 'blogspot'].every((n) => ('external:' + n).length <= 20), 'blog_source(VARCHAR(20))に収まる名前');

// ---- フィード発見 ----
const HOME = (extra) => ({ finalUrl: 'https://ex.com/', body: `<html><head>${extra || ''}</head><body>x</body></html>` });
eq(B.discoverFeedLinks(`<link rel="alternate" type="application/rss+xml" title="r" href="/feed/"><link rel='alternate' type='application/atom+xml' href='https://ex.com/atom.xml'><link rel="alternate" type="application/rss+xml" title="コメント" href="/comments/feed/"><link rel="stylesheet" href="/a.css">`, 'https://ex.com/'),
  ['https://ex.com/feed/', 'https://ex.com/atom.xml'], 'link rel=alternate(コメントのフィード・css除外)');

function fakeFetch(map) {
  const calls = [];
  const f = async (u) => { calls.push(u); const v = map[u]; if (v === undefined) return { status: 404, body: '' }; if (v instanceof Error) throw v; return { status: 200, body: v }; };
  f.calls = calls;
  return f;
}

(async () => {
  // リンクがあればそれを使い、1回で終わる
  let f = fakeFetch({ 'https://ex.com/blog/rss': RSS });
  let r = await B.detectBlogActivity(HOME('<link rel="alternate" type="application/rss+xml" href="/blog/rss">'), f, { now: NOW });
  eq([r.source, r.posts90d, r.latestAt.toISOString()], ['rss', 2, iso(5)], 'リンク先のRSS: 90日2件・最新');
  eq(f.calls, ['https://ex.com/blog/rss'], 'リンクがあれば追加取得は1回');

  // Atom
  f = fakeFetch({ 'https://ex.com/feed/': ATOM });
  r = await B.detectBlogActivity(HOME(), f, { now: NOW });
  eq([r.source, r.posts90d], ['atom', 1], '/feed/ がAtom(公開日で数える)');

  // /feed/ が無く ?feed=rss2
  f = fakeFetch({ 'https://ex.com/?feed=rss2': RSS });
  r = await B.detectBlogActivity(HOME(), f, { now: NOW });
  eq([r.source, f.calls.length], ['rss', 2], '/feed/ → ?feed=rss2 の順');

  // WordPressらしいサイトは wp-json を ?feed=rss2 より先に
  f = fakeFetch({ 'https://ex.com/wp-json/wp/v2/posts?per_page=20&_fields=date': WP });
  r = await B.detectBlogActivity(HOME('<link rel="stylesheet" href="/wp-content/themes/a.css">'), f, { now: NOW });
  eq([r.source, r.posts90d, f.calls], ['wp-json', 2, ['https://ex.com/feed/', 'https://ex.com/wp-json/wp/v2/posts?per_page=20&_fields=date']], 'WordPress: /feed/ → wp-json');

  // 追加取得は最大3回
  f = fakeFetch({});
  r = await B.detectBlogActivity(HOME(), f, { now: NOW });
  eq([r.source, f.calls.length], [null, 3], '何も無ければ追加取得は最大3回で打ち切り');
  f = fakeFetch({});
  r = await B.detectBlogActivity(HOME('<link rel="alternate" type="application/rss+xml" href="/a"><link rel="alternate" type="application/atom+xml" href="/b">'), f, { now: NOW });
  eq(f.calls.length, 3, 'リンク2本が失敗しても合計3回まで');
  f = fakeFetch({ 'https://ex.com/sitemap.xml': URLSET });
  r = await B.detectBlogActivity(HOME(), f, { now: NOW });
  eq([r.source, r.posts90d, f.calls.length], ['sitemap', 2, 3], 'sitemap.xml(3回目)');
  f = fakeFetch({ 'https://ex.com/sitemap.xml': 'x'.repeat(1024 * 1024 + 10) });
  r = await B.detectBlogActivity(HOME(), f, { now: NOW });
  eq(r.source, null, '1MBを超えるサイトマップは使わない');
  f = fakeFetch({ 'https://ex.com/feed/': new Error('boom') });
  r = await B.detectBlogActivity(HOME(), f, { now: NOW });
  eq(r.source, null, '取得で例外が出ても落ちない');

  // 別ホストのリンクは取りに行かない
  f = fakeFetch({ 'https://feeds.other.com/x': RSS });
  r = await B.detectBlogActivity(HOME('<link rel="alternate" type="application/rss+xml" href="https://feeds.other.com/x">'), f, { now: NOW });
  ok(!f.calls.includes('https://feeds.other.com/x'), '別ホストのフィードは取得しない');

  // robots.txt: Disallow なら取得しない(robotsの取得は3回に数えない)
  f = fakeFetch({ 'https://ex.com/feed/': RSS, 'https://ex.com/?feed=rss2': RSS });
  let robotsCalls = 0;
  r = await B.detectBlogActivity(HOME(), f, { now: NOW, fetchRobots: async () => { robotsCalls++; return 'User-agent: *\nDisallow: /feed\n'; } });
  eq([f.calls.includes('https://ex.com/feed/'), robotsCalls, r.source], [false, 1, 'rss'], 'robots.txt の Disallow を守る(robotsは1回だけ取得)');

  // 外部ブログの記録
  f = fakeFetch({});
  r = await B.detectBlogActivity(HOME('<a href="https://ameblo.jp/shop/">blog</a>'), f, { now: NOW });
  eq([r.source, r.external, B.blogSourceValue(r)], [null, 'ameblo.jp', 'external:ameblo.jp'], '外部ブログは取得せず記録だけ');
  ok(!f.calls.some((u) => /ameblo/.test(u)), '外部ブログは取りに行かない');

  // 壊れた finalUrl
  r = await B.detectBlogActivity({ finalUrl: 'xx', body: '' }, fakeFetch({}), { now: NOW });
  eq(r.source, null, 'finalUrlが壊れていても落ちない');

  console.log(`blog: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
