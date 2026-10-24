'use strict';
const ff = require('../src/formFinder');
const { processStores } = require('../cli/find-forms');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  ✗ ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);

const FORM = '<form action="/send" method="post"><input type="text" name="name"><input type="email" name="mail"><textarea name="body"></textarea><input type="submit" value="送信"></form>';
const page = (body) => `<html><body>${body}</body></html>`;

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
  // extractLinks
  const links = ff.extractLinks('<a href="/contact#x">お問い合わせ</a><a href="mailto:a@b.jp">m</a><a href="tel:1">t</a><a href="javascript:void(0)">j</a><a href="https://x.com/a">x</a>', 'https://a.jp/top/');
  eq(links, [{ url: 'https://a.jp/contact', text: 'お問い合わせ' }, { url: 'https://x.com/a', text: 'x' }], 'extractLinks');

  // scoreContactLink
  ok(ff.scoreContactLink({ url: 'https://www.a.jp/contact/', text: 'お問い合わせ' }, 'a.jp') > 0, 'same-site www ignored');
  eq(ff.scoreContactLink({ url: 'https://a.jp/news', text: 'ニュース' }, 'a.jp'), 0, 'no signal');
  eq(ff.scoreContactLink({ url: 'https://a.jp/reserve/contact', text: 'ご予約' }, 'a.jp'), 0, 'exclude reserve');
  eq(ff.scoreContactLink({ url: 'https://a.jp/recruit/form', text: '採用エントリー' }, 'a.jp'), 0, 'exclude recruit');
  eq(ff.scoreContactLink({ url: 'https://other.com/contact', text: 'お問い合わせ' }, 'a.jp'), 0, 'other external 0');
  ok(ff.scoreContactLink({ url: 'https://form.run/@abc', text: 'こちら' }, 'a.jp') > 0, 'form.run external ok');
  ok(ff.scoreContactLink({ url: 'https://docs.google.com/forms/d/e/1/viewform', text: 'フォーム' }, 'a.jp') > 0, 'google forms ok');
  eq(ff.scoreContactLink({ url: 'https://docs.google.com/document/d/1', text: 'お問い合わせ' }, 'a.jp'), 0, 'google docs not form');
  ok(ff.scoreContactLink({ url: 'https://a.jp/x', text: 'お問合せ' }, 'a.jp') > ff.scoreContactLink({ url: 'https://a.jp/mail', text: 'x' }, 'a.jp'), 'text beats path');

  // detectForm
  eq(ff.detectForm(page(FORM)), { hasContactForm: true, hasCaptcha: false, kind: 'onsite' }, 'textarea form');
  ok(ff.detectForm(page('<form><input type="email" name="e"><button>送る</button></form>')).hasContactForm, 'email + button submit');
  ok(!ff.detectForm(page('<form><input type="email" name="e"></form>')).hasContactForm, 'email without submit');
  eq(ff.detectForm(page('<form action="/"><input type="text" name="s"><input type="submit"></form>')).hasContactForm, false, 'search form only');
  eq(ff.detectForm(page('<form><input type="text" name="q"><button type="submit">検索</button></form>')).hasContactForm, false, 'search q');
  eq(ff.detectForm(page('<form><input type="text" name="id"><input type="password" name="pw"><textarea></textarea></form>')).hasContactForm, false, 'login excluded');
  const ifr = ff.detectForm(page('<iframe src="https://ws.formzu.net/fgen/S123/"></iframe>'));
  eq([ifr.hasContactForm, ifr.kind], [true, 'external'], 'iframe form service');
  eq(ff.detectForm(page('<iframe src="https://www.youtube.com/embed/x"></iframe>')).hasContactForm, false, 'youtube iframe no');
  eq(ff.detectForm(page(FORM + '<div class="g-recaptcha"></div>')).hasCaptcha, true, 'g-recaptcha');
  eq(ff.detectForm(page(FORM + '<script src="https://www.google.com/recaptcha/api.js"></script>')).hasCaptcha, true, 'recaptcha api.js');
  eq(ff.detectForm(page(FORM + '<div class="h-captcha"></div><script src="https://hcaptcha.com/1/api.js"></script>')).hasCaptcha, true, 'hcaptcha');
  eq(ff.detectForm(page(FORM + '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>')).hasCaptcha, true, 'turnstile');

  // extractEmails
  const em = ff.extractEmails(page('<a href="mailto:Info@Shop.jp?subject=a">x</a> 連絡先: foo@gmail.com info@shop.jp test@shop.jp xxx@shop.jp a@example.com your-email@x.jp <img src="logo@2x.png"> sample@shop.jp'), 'www.shop.jp');
  eq(em, ['info@shop.jp', 'foo@gmail.com'], 'emails filtered/ordered');
  eq(ff.extractEmails(page('foo@gmail.com bar@shop.jp'), 'shop.jp'), ['bar@shop.jp', 'foo@gmail.com'], 'same domain first');

  // extractInstagram
  eq(ff.extractInstagram(page('<a href="https://www.instagram.com/p/ABC/">post</a><a href="https://instagram.com/reel/x">r</a><a href="https://www.instagram.com/explore/">e</a><a href="https://instagram.com/my_salon.hy?igshid=1">me</a>')), 'https://www.instagram.com/my_salon.hy/', 'instagram skips /p/');
  eq(ff.extractInstagram(page('<a href="https://www.instagram.com/p/ABC/">post</a>')), null, 'only post -> null');
  eq(ff.extractInstagram(page('<a href="https://www.instagram.com/accounts/login/">l</a>')), null, 'accounts excluded');

  // non-own site
  ok(ff.NON_OWN_SITE_HOSTS.includes('instagram.com') && !ff.NON_OWN_SITE_HOSTS.includes('peraichi.com'), 'host list');
  let called = 0;
  const r0 = await ff.findContact('https://www.instagram.com/shop/', { fetchPage: async () => { called++; return {}; }, fetchRobots: noRobots });
  eq([r0.status, r0.note, called], ['no_form', '自社サイトではない(一覧)', 0], 'instagram host -> no_form');

  // findContact: normal flow
  const log1 = [];
  const site1 = fakeSite({
    'https://shop.jp/': page('<a href="/news">NEWS</a><a href="/contact/">お問い合わせ</a><a href="https://www.instagram.com/shop_hy/">ig</a> info@shop.jp'),
    'https://shop.jp/contact/': page(FORM + '<div class="g-recaptcha"></div>'),
  }, log1);
  const r1 = await ff.findContact('https://shop.jp/', { fetchPage: site1, fetchRobots: noRobots });
  eq([r1.status, r1.inquiryUrl, r1.kind, r1.hasCaptcha], ['url_found', 'https://shop.jp/contact/', 'onsite', true], 'contact flow');
  eq([r1.emails, r1.instagram, r1.checkedPages], [['info@shop.jp'], 'https://www.instagram.com/shop_hy/', 2], 'collected');

  // Japanese text link to /otoiawase.html
  const r2 = await ff.findContact('https://shop.jp/', { fetchPage: fakeSite({
    'https://shop.jp/': page('<a href="/otoiawase.html">お問合せ</a>'),
    'https://shop.jp/otoiawase.html': page(FORM),
  }), fetchRobots: noRobots });
  eq([r2.status, r2.inquiryUrl], ['url_found', 'https://shop.jp/otoiawase.html'], 'otoiawase.html');

  // top page has the form
  const r3 = await ff.findContact('https://shop.jp/', { fetchPage: fakeSite({ 'https://shop.jp/': page(FORM) }), fetchRobots: noRobots });
  eq([r3.status, r3.inquiryUrl, r3.checkedPages], ['url_found', 'https://shop.jp/', 1], 'top has form');

  // search-only contact page -> no_form
  const r4 = await ff.findContact('https://shop.jp/', { fetchPage: fakeSite({
    'https://shop.jp/': page('<a href="/contact">お問い合わせ</a>'),
    'https://shop.jp/contact': page('<form><input name="s" type="text"><input type="submit"></form>'),
  }), fetchRobots: noRobots });
  eq(r4.status, 'no_form', 'search only -> no_form');

  // external form.run link, not fetched
  const log5 = [];
  const r5 = await ff.findContact('https://shop.jp/', { fetchPage: fakeSite({
    'https://shop.jp/': page('<a href="https://form.run/@shop-abc">お問い合わせはこちら</a>'),
  }, log5), fetchRobots: noRobots });
  eq([r5.status, r5.inquiryUrl, r5.kind, log5.length], ['url_found', 'https://form.run/@shop-abc', 'external', 1], 'external form.run');

  // max pages
  const log6 = [];
  const many = page(['/contact1', '/contact2', '/contact3', '/contact4', '/contact5', '/inquiry'].map((p) => `<a href="${p}">お問い合わせ</a>`).join(''));
  const r6 = await ff.findContact('https://shop.jp/', { fetchPage: fakeSite({ 'https://shop.jp/': many }, log6), fetchRobots: noRobots });
  eq([r6.status, log6.length <= 4, r6.checkedPages <= 4], ['no_form', true, true], 'max 4 pages');
  eq(log6.length, 4, 'exactly 4 fetched (top + 3)');

  // robots disallow
  const log7 = [];
  const r7 = await ff.findContact('https://shop.jp/', { fetchPage: fakeSite({
    'https://shop.jp/': page('<a href="/contact/">お問い合わせ</a>'),
    'https://shop.jp/contact/': page(FORM),
  }, log7), fetchRobots: async () => 'User-agent: Googlebot\nDisallow:\n\nUser-agent: *\nDisallow: /contact\n' });
  eq([r7.status, log7], ['no_form', ['https://shop.jp/']], 'robots disallow skips');

  // top-page error
  const r8 = await ff.findContact('https://shop.jp/', { fetchPage: async () => { throw Object.assign(new Error('サイトへ接続できませんでした。'), { userSafe: true }); }, fetchRobots: noRobots });
  eq([r8.status, r8.note], ['error', 'サイトへ接続できませんでした。'], 'top error');
  const r9 = await ff.findContact('https://shop.jp/', { fetchPage: async () => { throw new Error('secret internals'); }, fetchRobots: noRobots });
  eq([r9.status, r9.note.includes('secret')], ['error', false], 'non-userSafe message hidden');

  // ---- (1)(2) 自社サイトではない判定 ----
  const fs = require('fs'), path = require('path'), os = require('os');
  const realRules = ff.parseNonOwnTerms(fs.readFileSync(path.join(__dirname, '..', 'rules', 'non_own_site_terms.txt'), 'utf8'));
  ok(realRules.url.includes('ekiten') && realRules.host.includes('ekiten.jp'), 'rules: ekiten in #@url and #@host');
  ok(realRules.host.includes('gnavi.co.jp') && realRules.host.includes('lin.ee'), 'rules: #@host section parsed');
  ok(realRules.url.includes('prtimes') && !realRules.url.includes('gnavi.co.jp'), 'rules: #@url section parsed');
  ok(realRules.url.length > 100 && new Set(realRules.url).size === realRules.url.length, 'rules: many, deduped');
  const pr = ff.parseNonOwnTerms('# c\n#@url\n  HTTPS://Foo.com/Bar \nhttp://foo.com/bar\n//baz.jp\n#@host\nX.com\nx.com\n');
  eq(pr, { url: ['foo.com/bar', 'baz.jp'], host: ['x.com'] }, 'parse: trim/strip scheme/lowercase/dedupe');
  const tmpRules = path.join(os.tmpdir(), 'nonown-' + process.pid + '.txt');
  fs.writeFileSync(tmpRules, '#@host\nmyportal.example\n');
  eq(ff.loadNonOwnTerms(tmpRules).host, ['myportal.example'], 'custom file loads');
  fs.unlinkSync(tmpRules);

  const nonOwn = async (u) => { let n = 0; const r = await ff.findContact(u, { fetchPage: async () => { n++; return {}; }, fetchRobots: noRobots }); return [r.status, r.note, n]; };
  const NOTE_L = '自社サイトではない(一覧)', NOTE_B = '自社サイトではない(地図・公共・掲載ページ)';
  eq(await nonOwn('https://harikyu-ehime.or.jp/clinic/abc/'), ['no_form', NOTE_B, 0], 'harikyu listing');
  eq(await nonOwn('https://www.ehimeda.or.jp/search/?&c=1&d=566'), ['no_form', NOTE_B, 0], 'ehimeda search');
  eq((await nonOwn('https://www.google.co.jp/maps/place/data=!4m7!3m6'))[0], 'no_form', 'google maps');
  ok(ff.matchesBuiltinNonOwn('https://www.google.co.jp/maps/place/data=!4m7'), 'google maps builtin rule');
  eq(await nonOwn('https://www.town.ikata.ehime.jp/soshiki/34/18078.html'), ['no_form', NOTE_B, 0], 'town.ikata');
  eq((await nonOwn('http://www.qq.pref.ehime.jp/x'))[0], 'no_form', 'pref host');
  eq(await nonOwn('https://saijo.mypl.net/article/newopen_niihama-saijo/106465'), ['no_form', NOTE_L, 0], 'mypl.net via list');
  eq((await nonOwn('http://www.undernavi.com/shikoku/ehime/uwajima/irokoi-u/'))[0], 'no_form', 'undernavi');
  eq((await nonOwn('http://www.happy-t.co.jp/shopcms/info_4845.html'))[0], 'no_form', 'happy-t shopcms');
  eq((await nonOwn('http://agora-m.co.jp/about/floor-oceandream/'))[0], 'no_form', 'agora floor');
  eq((await nonOwn('https://haisha-yoyaku.jp/bun2sdental/detail/index/id/1'))[0], 'no_form', 'haisha-yoyaku');
  eq(await nonOwn('https://www.ekiten.jp/shop_123/'), ['no_form', NOTE_L, 0], 'ekiten via list');
  eq((await nonOwn('https://localplace.jp/t000261837/'))[0], 'no_form', 'localplace');
  eq((await nonOwn('http://r.gnavi.co.jp/abc/'))[0], 'no_form', 'gnavi');
  eq((await nonOwn('http://www.iryou.teikyouseido.mhlw.go.jp/x/y'))[0], 'no_form', 'mhlw');
  eq((await nonOwn('https://maps.app.goo.gl/abc'))[0], 'no_form', 'maps.app.goo.gl');
  eq((await nonOwn('https://goo.gl/maps/abc'))[0], 'no_form', 'goo.gl/maps');
  eq((await nonOwn('https://maps.google.co.jp/x'))[0], 'no_form', 'maps.google.*');
  eq((await nonOwn('https://city.himeji.lg.jp/'))[0], 'no_form', 'lg.jp');
  ok(ff.matchesBuiltinNonOwn('https://x.example.lg.jp/') && ff.matchesBuiltinNonOwn('https://www.mof.go.jp/'), 'lg.jp/go.jp builtin');
  // 自社サイトは誤判定しない
  ok(!ff.nonOwnReason('https://sportsizakaya-syakarikiya.com/dishes/'), 'deep own site (1 segment) is own');
  ok(!ff.nonOwnReason('https://www.kamegaike.com/'), 'kamegaike root is own');
  ok(!ff.nonOwnReason('https://sites.google.com/view/shop/list/page'), 'sites.google.com exempt from heuristic');
  ok(!ff.nonOwnReason('https://example-shop.com/index.html'), 'index.html only is root');
  ok(!ff.nonOwnReason('https://example-shop.com/home'), '/home is root');
  ok(!ff.nonOwnReason('https://abc.co.jp/about/company/'), 'two segments w/o keyword on .co.jp is own');
  ok(ff.nonOwnReason('https://abc.co.jp/shop/12?x=1'), 'keyword + 2 segments');
  ok(ff.nonOwnReason('https://abc.or.jp/a?b=1'), '.or.jp segment+query');
  const rKame = await ff.findContact('https://www.kamegaike.com/', { fetchPage: fakeSite({
    'https://www.kamegaike.com/': page('<a href="/contact/">お問い合わせ</a>'),
    'https://www.kamegaike.com/contact/': page('<title>お問い合わせ | 亀ヶ池</title>' + FORM),
  }), fetchRobots: noRobots });
  eq([rKame.status, rKame.inquiryUrl], ['url_found', 'https://www.kamegaike.com/contact/'], 'kamegaike url_found');
  const rDish = await ff.findContact('https://sportsizakaya-syakarikiya.com/dishes/', { fetchPage: fakeSite({
    'https://sportsizakaya-syakarikiya.com/dishes/': page('<a href="/contact/">お問い合わせ</a>'),
    'https://sportsizakaya-syakarikiya.com/contact/': page(FORM),
  }), fetchRobots: noRobots });
  eq(rDish.status, 'url_found', 'deep own site still searched');

  // ---- (3) 団体ガード ----
  const orgSite = {
    'https://own.jp/about/a/': page('<a href="/contact/">お問い合わせ</a>'),
    'https://own.jp/contact/': page('<html><head><title>愛媛県鍼灸協会 お問い合わせ</title></head><body>' + FORM + '</body></html>'),
  };
  const rOrg = await ff.findContact('https://own.jp/about/a/', { fetchPage: fakeSite(orgSite), fetchRobots: noRobots });
  eq([rOrg.status, rOrg.inquiryUrl, rOrg.note], ['no_form', null, '団体の窓口のため除外'], 'org guard rejects from deep path');
  const rOrgRoot = await ff.findContact('https://own.jp/', { fetchPage: fakeSite({ 'https://own.jp/': orgSite['https://own.jp/about/a/'], 'https://own.jp/contact/': orgSite['https://own.jp/contact/'] }), fetchRobots: noRobots });
  eq(rOrgRoot.status, 'url_found', 'org guard not applied at site root');
  const rOrgH1 = await ff.findContact('https://own.jp/about/a/', { fetchPage: fakeSite({
    'https://own.jp/about/a/': orgSite['https://own.jp/about/a/'],
    'https://own.jp/contact/': page('<h1>歯科医師会事務局</h1>' + FORM),
  }), fetchRobots: noRobots });
  eq(rOrgH1.note, '団体の窓口のため除外', 'org guard via h1');

  // ---- (4) JSビルダー ----
  const rWix = await ff.findContact('https://example.wixsite.com/mysite', { fetchPage: fakeSite({ 'https://example.wixsite.com/mysite': page('<div id="SITE_CONTAINER"></div>') }), fetchRobots: noRobots });
  eq([rWix.status, rWix.note], ['unknown', '要ブラウザ確認(JSで作られたサイト)'], 'wixsite no links -> unknown');
  const rGen = await ff.findContact('https://shop.jp/', { fetchPage: fakeSite({ 'https://shop.jp/': '<html><head><meta name="generator" content="Wix.com Website Builder"></head><body></body></html>' }), fetchRobots: noRobots });
  eq(rGen.status, 'unknown', 'meta generator Wix -> unknown');
  const rScr = await ff.findContact('https://shop.jp/', { fetchPage: fakeSite({ 'https://shop.jp/': page('<script src="https://static.parastorage.com/x.js"></script>') }), fetchRobots: noRobots });
  eq(rScr.status, 'unknown', 'parastorage script -> unknown');
  const rJim = await ff.findContact('https://shop.jp/', { fetchPage: fakeSite({ 'https://shop.jp/': page('<a href="/contact/">お問い合わせ</a>'), 'https://shop.jp/contact/': page('<script src="//u.jimcdn.com/x"></script><script src="https://assets.jimdocdn.com/a.js"></script>nothing') }), fetchRobots: noRobots });
  eq(rJim.status, 'unknown', 'jimdocdn after candidate without form -> unknown');
  const rWixForm = await ff.findContact('https://a.wixsite.com/s', { fetchPage: fakeSite({ 'https://a.wixsite.com/s': page(FORM) }), fetchRobots: noRobots });
  eq(rWixForm.status, 'url_found', 'builder with form still url_found');
  for (const h of ['sites.google.com/view/x', 'x.jimdofree.com', 'x.amebaownd.com', 'x.studio.site', 'x.mystrikingly.com', 'x.peraichi.com', 'x.goope.jp', 'x.crayonsite.net', 'x.kujira.biz', 'x.kaginawa.jp', 'x.gorp.jp']) {
    ok(ff.isJsBuilder(h.split('/')[0], ''), 'builder host ' + h);
  }
  ok(!ff.isJsBuilder('shop.jp', page('hello')), 'plain site not builder');
  const { csvRow } = require('../cli/find-forms');
  ok(csvRow({ id: 1, name: 'n', prefecture: 'p', website_url: 'u' }, { status: 'unknown', note: 'x', emails: [] }).includes(',要確認,'), 'csv 要確認');
  const stU = await processStores({ stores: [{ id: 9, website_url: 'https://u.jp/' }], finder: async () => ({ status: 'unknown' }), writer: async () => {} });
  eq([stU.unknown, stU.error], [1, 0], 'progress counts unknown');

  // ---- (5) Cloudflare メール ----
  const cfHex = (addr, key) => key.toString(16).padStart(2, '0') + [...addr].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');
  eq(ff.decodeCfEmail(cfHex('info@shop.jp', 0x5a)), 'info@shop.jp', 'cf decode');
  const cfA = cfHex('info@shop.jp', 0x5a), cfB = cfHex('Owner@Gmail.com', 0x13);
  eq(ff.extractEmails(page(`<a href="/cdn-cgi/l/email-protection#${cfA}">[email&#160;protected]</a>`), 'shop.jp'), ['info@shop.jp'], 'cf href decoded');
  eq(ff.extractEmails(page(`<span class="__cf_email__" data-cfemail="${cfB}">[email&#160;protected]</span>`), 'shop.jp'), ['owner@gmail.com'], 'cf data-cfemail decoded (free mail)');
  eq(ff.extractEmails(page(`<a data-cfemail='${cfHex('x@agency.com', 7)}'>.</a>`), 'shop.jp'), [], 'cf other company domain filtered');

  // ---- (6) 画像リンク ----
  eq(ff.extractLinks('<a href="/contact"><img src="a.png" alt="お問い合わせ"></a>', 'https://a.jp/'), [{ url: 'https://a.jp/contact', text: 'お問い合わせ' }], 'img alt link');
  eq(ff.extractLinks('<a href="/c" title="お問合せ"><img src="a.png"></a><a href="/d" aria-label="資料請求"></a>', 'https://a.jp/').map((l) => l.text), ['お問合せ', '資料請求'], 'anchor title/aria-label');
  eq(ff.extractLinks('<a href="/c"><img src="a.png" title="ご相談"></a>', 'https://a.jp/')[0].text, 'ご相談', 'img title');
  const rImg = await ff.findContact('https://shop.jp/', { fetchPage: fakeSite({
    'https://shop.jp/': page('<a href="/xyz"><img src="b.png" alt="お問い合わせ"></a>'),
    'https://shop.jp/xyz': page(FORM),
  }), fetchRobots: noRobots });
  eq([rImg.status, rImg.inquiryUrl], ['url_found', 'https://shop.jp/xyz'], 'image-alt contact link followed');

  // processStores
  const stores = [
    { id: 1, name: 'A本店', website_url: 'https://www.chain.jp/', prefecture: '兵庫県' },
    { id: 2, name: 'A支店', website_url: 'http://chain.jp/shop2', prefecture: '兵庫県' },
    { id: 3, name: 'B', website_url: 'https://b.jp/', prefecture: '兵庫県' },
    { id: 4, name: 'C', website_url: 'https://slow.jp/', prefecture: '兵庫県' },
  ];
  const finderCalls = [];
  const written = [];
  const stats = await processStores({
    stores, concurrency: 3, siteTimeoutMs: 100,
    finder: async (url) => {
      finderCalls.push(url);
      if (url.includes('slow.jp')) await new Promise((r) => setTimeout(r, 1000));
      return { status: url.includes('chain') ? 'url_found' : 'no_form', inquiryUrl: 'https://chain.jp/contact', emails: [], note: '' };
    },
    writer: async (s, r) => { written.push([s.id, r.status]); },
  });
  eq(finderCalls.filter((u) => u.includes('chain.jp')).length, 1, 'same host finder once');
  eq(written.map((w) => w[0]).sort(), [1, 2, 3, 4], 'writer per store');
  eq(written.filter((w) => w[0] <= 2).map((w) => w[1]), ['url_found', 'url_found'], 'result shared');
  eq(written.find((w) => w[0] === 4)[1], 'error', 'site timeout -> error');
  eq([stats.done, stats.found, stats.none, stats.error], [4, 2, 1, 1], 'stats');

  // stop flag
  let n = 0;
  const w2 = [];
  await processStores({ stores, concurrency: 1, shouldStop: () => n++ >= 1, finder: async () => ({ status: 'no_form' }), writer: async (s) => { w2.push(s.id); } });
  eq(w2.length, 2, 'shouldStop halts new stores (in-flight group finishes)');

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
