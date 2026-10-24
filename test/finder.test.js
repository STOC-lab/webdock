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
  eq([r0.status, r0.note, called], ['no_form', '自社サイトではない', 0], 'instagram host -> no_form');

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
