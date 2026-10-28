'use strict';
// GBP(Googleマップ)の更新日の読み取りのテスト。ネット・ブラウザ不要(偽の画面テキスト・偽のブラウザを使う)。
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../src/gbpActivity');
const { parseArgs, rowsFromJsonl } = require('../cli/gbp-debug');
const { toJstDate } = require('../src/freshness');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);

const NOW = new Date('2026-10-27T03:00:00Z'); // 日本時間 2026-10-27 12:00
const P = (t) => G.parseRelativeJa(t, NOW);
const sum = (r) => r && [r.raw, r.approxDays, r.precision, toJstDate(r.date)];

(async () => {
  // ---- parseRelativeJa ----
  eq(sum(P('たった今')), ['たった今', 0, 'day', '2026-10-27'], 'たった今');
  eq(sum(P('5 分前')), ['5 分前', 0, 'day', '2026-10-27'], '分前');
  eq(sum(P('3 時間前')), ['3 時間前', 0, 'day', '2026-10-27'], '時間前(同じ日)');
  eq(sum(P('15 時間前'))[1], 1, '15時間前は日本時間で昨日');
  eq(sum(P('昨日')), ['昨日', 1, 'day', '2026-10-26'], '昨日');
  eq(sum(P('4 日前')), ['4 日前', 4, 'day', '2026-10-23'], '日前');
  eq(sum(P('1 週間前')), ['1 週間前', 7, 'week', '2026-10-20'], '1週間前');
  eq(sum(P('3 週間前')), ['3 週間前', 21, 'week', '2026-10-06'], '週間前');
  eq(sum(P('先週')), ['先週', 7, 'week', '2026-10-20'], '先週');
  eq(sum(P('2 か月前')), ['2 か月前', 60, 'month', '2026-08-28'], 'か月前');
  eq(P('2 ヶ月前').approxDays, 60, 'ヶ月前');
  eq(P('2 カ月前').approxDays, 60, 'カ月前');
  eq(P('２ヶ月前').approxDays, 60, '全角数字');
  eq(sum(P('1　週間前')), ['1 週間前', 7, 'week', '2026-10-20'], '全角空白');
  eq(sum(P('3週間前')), ['3 週間前', 21, 'week', '2026-10-06'], '空白なし');
  eq(sum(P('1 年前')), ['1 年前', 365, 'year', '2025-10-27'], 'nbsp・年前');
  eq(P('2 年前').approxDays, 730, '2年前');
  eq(P('この店は良いです'), null, '相対表記なし');
  eq(P(''), null, '空');
  eq(P(null), null, 'null');
  ok(P('4 日前').date.toISOString() === '2026-10-22T15:00:00.000Z', '日本時間の0時(UTCで前日15時)');

  // ---- extractGbpActivity: 実画面を想定したテキスト ----
  const FULL = [
    '山田工務店', '4.3', '(52)', '工務店', '概要', 'クチコミ', '基本情報',
    'オーナーからの最新情報', '', '年末年始の営業のお知らせ', '2 週間前', '12月29日から1月3日までお休みをいただきます。',
    'もっと見る', '',
    'クチコミ', '並べ替え', '',
    '佐藤 花子', 'Local Guide・12 件のクチコミ', '★★★★★', '3 日前', '丁寧に対応していただきました。',
    'オーナーからの返信', '1 日前', 'ありがとうございます。またお越しください。', '',
    '鈴木 一郎', '1 件のクチコミ', '★★★★☆', '1 か月前', '見積りが早かったです。',
    'オーナーからの返信', '3 週間前', 'ご利用ありがとうございました。', '',
    '高橋', '2 件のクチコミ', '★★★☆☆', '5 か月前', '普通でした。',
  ].join('\n');
  const e1 = G.extractGbpActivity(FULL, NOW);
  eq([e1.post && e1.post.raw, e1.post && e1.post.approxDays], ['2 週間前', 14], '最新情報の時刻');
  eq([e1.ownerReply.raw, e1.ownerReply.approxDays], ['1 日前', 1], '返信は最も新しいもの');
  eq([e1.review.raw, e1.review.approxDays], ['3 日前', 3], '口コミ(返信の時刻は除く: 返信1日前は口コミにならない)');
  ok(e1.debug.contexts.ownerReply.includes('オーナーからの返信') && e1.debug.contexts.post.includes('2 週間前'), '判定に使った前後の文字列');
  ok(e1.debug.headings.post.includes('オーナーからの最新情報') && e1.debug.headings.review.includes('クチコミ'), '見つけた見出し');

  // 最新情報なし
  const NOPOST = FULL.split('\n').filter((l) => !['オーナーからの最新情報', '年末年始の営業のお知らせ'].includes(l)).join('\n').replace('2 週間前\n12月29日', '12月29日');
  const e2 = G.extractGbpActivity(NOPOST, NOW);
  eq(e2.post, null, '最新情報の見出しが無ければ post は null');
  eq(e2.ownerReply.raw, '1 日前', '最新情報なしでも返信は取れる');

  // 返信なし・口コミだけ
  const REVONLY = '店名\nクチコミ\n田中\n3 件のクチコミ\n2 か月前\nよかった\n山本\n1 年前\nふつう';
  const e3 = G.extractGbpActivity(REVONLY, NOW);
  eq([e3.post, e3.ownerReply, e3.review.raw], [null, null, '2 か月前'], '口コミだけ');

  // 返信の時刻は40文字を超えたら使わない
  const FAR = 'クチコミ\n田中\n1 週間前\nオーナーからの返信\n' + 'あ'.repeat(60) + '\n2 日前';
  const e4 = G.extractGbpActivity(FAR, NOW);
  eq(e4.ownerReply, null, '返信の直後40文字より先の時刻は返信にしない');
  eq(e4.review.raw, '2 日前', 'その時刻は口コミ側');

  // 最新情報の範囲は次の欄(クチコミ)まで: 見出しのあとでも「クチコミ」より後ろは最新情報にしない
  const POSTSCOPE = '最新情報\n営業日変更\n3 週間前\nクチコミ\n田中\n2 日前\n良い';
  const e5 = G.extractGbpActivity(POSTSCOPE, NOW);
  eq([e5.post.raw, e5.review.raw], ['3 週間前', '2 日前'], '最新情報の範囲は次の欄まで');
  const e6 = G.extractGbpActivity('アップデート\nセール開始\n昨日\n基本情報\n', NOW);
  eq(e6.post.raw, '昨日', 'アップデートの見出し');
  eq(G.extractGbpActivity('', NOW).post, null, '空の本文');
  eq(G.extractGbpActivity('全角　３　日前', NOW).review, null, '口コミ欄の見出しが無ければ口コミにしない');
  eq(G.extractGbpActivity('オーナーからの返信\n２ 週間前', NOW).ownerReply.approxDays, 14, '全角数字の返信');

  // ---- 確認画面の判定 ----
  ok(G.isBlockedPage({ url: 'https://www.google.com/sorry/index?continue=...' }), '/sorry/ のURL');
  ok(G.isBlockedPage({ url: 'https://www.google.com/maps', text: '通常と異なるトラフィックが検出されました' }), '通常と異なるトラフィック');
  ok(G.isBlockedPage({ url: 'https://www.google.com/maps', text: 'reCAPTCHA' }), 'reCAPTCHA');
  ok(G.isBlockedPage({ url: 'x', text: 'Our systems have detected unusual traffic from your computer network' }), 'unusual traffic');
  ok(!G.isBlockedPage({ url: 'https://www.google.com/maps/place/x', text: '山田工務店 クチコミ' }), '通常の画面は確認画面ではない');

  // ---- gbpUrlOf ----
  eq(G.gbpUrlOf({ cid: '1234567890123456789', placeId: 'ChIJabcdefghij' }), 'https://www.google.com/maps?cid=1234567890123456789&hl=ja', 'cid が先');
  eq(G.gbpUrlOf({ cid: '', placeId: 'ChIJabcdefghij' }), 'https://www.google.com/maps/place/?q=place_id:ChIJabcdefghij&hl=ja', 'place_id');
  eq(G.gbpUrlOf({ gmapUrl: 'https://www.google.com/maps/place/foo/@34,135,17z' }), 'https://www.google.com/maps/place/foo/@34,135,17z', 'gmap_url(google maps)');
  eq(G.gbpUrlOf({ gmapUrl: 'https://maps.google.co.jp/?q=x' }), 'https://maps.google.co.jp/?q=x', 'maps.google.co.jp');
  eq(G.gbpUrlOf({ gmapUrl: 'https://evil.example.com/maps/place/x' }), '', 'google 以外は使わない');
  eq(G.gbpUrlOf({ gmapUrl: 'https://www.google.com.evil.com/maps/x' }), '', 'google.com.evil.com は使わない');
  eq(G.gbpUrlOf({ gmapUrl: 'https://www.google.com/search?q=x' }), '', 'maps 以外は使わない');
  eq(G.gbpUrlOf({ gmapUrl: 'javascript:alert(1)' }), '', 'javascript: は使わない');
  eq(G.gbpUrlOf({ cid: 'abc;rm', placeId: '' }), '', 'cid が数字以外なら使わない');
  eq(G.gbpUrlOf({}), '', '何も無い');
  eq(G.gbpUrlOf(null), '', 'null');

  // ---- createGbpChecker ----
  const rowA = { cid: '111111111', store_id: '1' };
  const rowB = { cid: '222222222', store_id: '2' };
  const rowC = { cid: '333333333', store_id: '3' };
  const mkChecker = (fetch, extra = {}) => {
    const sleeps = [];
    const events = [];
    const checker = G.createGbpChecker({
      launch: async () => { events.push('launch'); return { close: async () => { events.push('close'); } }; },
      fetch, sleep: async (ms) => { sleeps.push(ms); events.push('sleep'); }, random: () => 0.5, now: () => NOW, log: (m) => events.push('log:' + m), ...extra,
    });
    return { checker, sleeps, events };
  };
  {
    // 直列: 同時に2件は動かない・呼んだ順・間に4〜8秒の待ち・キャッシュ
    let running = 0, maxRunning = 0; const order = [];
    const { checker, sleeps, events } = mkChecker(async (row) => {
      running++; maxRunning = Math.max(maxRunning, running); order.push(row.cid);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { url: G.gbpUrlOf(row), ok: true, blocked: false, post: null, ownerReply: null, review: null, note: '', debug: {} };
    });
    const ps = [checker.check(rowA), checker.check(rowB), checker.check(rowA), checker.check(rowC)];
    const rs = await Promise.all(ps);
    eq(maxRunning, 1, '同時に動くのは1件だけ');
    eq(order, ['111111111', '222222222', '333333333'], '呼んだ順・同じcidは1回だけ');
    eq(sleeps, [6000, 6000], '店舗の間に待つ(4000〜8000の範囲。2件目・3件目の前だけ)');
    ok(rs[0] === rs[2], 'キャッシュは同じ結果');
    eq(events.filter((x) => x === 'launch').length, 1, 'ブラウザは1回だけ起動');
    await checker.close(); await checker.close();
    eq(events.filter((x) => x === 'close').length, 1, 'close で閉じる(2回呼んでも1回)');
    eq(checker.stats.fetched, 3, '読んだ件数');
  }
  {
    // 待ち時間の範囲
    const waits = [];
    const c = G.createGbpChecker({ launch: async () => ({ close: async () => {} }), fetch: async (row) => ({ url: '', ok: true, blocked: false, note: '', debug: {} }),
      sleep: async (ms) => waits.push(ms), random: () => 0.999999, log: () => {} });
    await c.check(rowA); await c.check(rowB);
    ok(waits[0] >= 4000 && waits[0] <= 8000, '待ちは4〜8秒: ' + waits[0]);
    const w2 = [];
    const c2 = G.createGbpChecker({ launch: async () => ({ close: async () => {} }), fetch: async () => ({ ok: true, blocked: false, debug: {} }), sleep: async (ms) => w2.push(ms), random: () => 0, log: () => {} });
    await c2.check(rowA); await c2.check(rowB);
    eq(w2, [4000], '最小は4秒');
    await c.close(); await c2.close();
  }
  {
    // 確認画面で停止: 以降は fetch を呼ばない
    const seen = [];
    const { checker, events } = mkChecker(async (row) => {
      seen.push(row.cid);
      return row.cid === '222222222' ? { url: '', ok: false, blocked: true, post: null, ownerReply: null, review: null, note: 'Googleの確認画面が出ました', debug: {} }
        : { url: '', ok: true, blocked: false, post: null, ownerReply: null, review: null, note: '', debug: {} };
    });
    const r1 = await checker.check(rowA);
    const r2 = await checker.check(rowB);
    const r3 = await checker.check(rowC);
    const r4 = await checker.check(rowA);
    eq(seen, ['111111111', '222222222'], '確認画面のあとは開かない');
    eq([r1.ok, r2.blocked, r3.blocked, r3.note, r3.ok], [true, true, true, 'Googleの確認画面が出たため中止', false], '確認画面の結果と中止の注記');
    eq(r4.ok, true, '中止前に読めた分はキャッシュから返る');
    ok(events.some((e) => e.startsWith('log:') && e.includes('確認画面')), '中止をログに出す');
    eq(checker.stats.blocked, true, 'stats.blocked');
    await checker.close();
  }
  {
    // 利用者の中断(stop): 読まずに aborted
    let calls = 0;
    const { checker } = mkChecker(async () => { calls++; return { ok: true, blocked: false, debug: {} }; });
    await checker.check(rowA);
    checker.stop();
    const r = await checker.check(rowB);
    eq([calls, r.aborted], [1, true], '中断後は読まない');
    await checker.close();
  }
  {
    // fetch が例外 → 失敗の結果(全体は止まらない)
    const { checker } = mkChecker(async (row) => { if (row.cid === '111111111') throw new Error('boom'); return { ok: true, blocked: false, debug: {} }; });
    const r1 = await checker.check(rowA); const r2 = await checker.check(rowB);
    eq([r1.ok, r1.note, r2.ok], [false, 'GBPを読めませんでした', true], '例外でも続ける');
    await checker.close();
  }
  {
    // URL が無い行・起動失敗(Playwright 未導入など)
    const logs = [];
    const c = G.createGbpChecker({ launch: async () => { throw new Error('browserType.launch: Executable doesn\'t exist'); }, fetch: async () => { throw new Error('呼ばれない'); }, sleep: async () => {}, log: (m) => logs.push(m) });
    eq((await c.check({})).note, 'GoogleマップのURLがありません', 'URLなし');
    const r = await c.check(rowA);
    ok(!r.ok && r.note.includes('起動できませんでした'), '起動失敗: ' + r.note);
    await c.check(rowB);
    eq(logs.length, 1, '起動失敗のログは1回だけ');
    eq(c.stats.unavailable, true, 'unavailable');
    await c.close();
  }
  {
    // playwright が入っていない環境(このコンテナ): 既定の launch は未導入メッセージを返し、落ちない
    let has = true; try { require.resolve('playwright'); } catch { has = false; }
    if (!has) {
      const logs = [];
      const c = G.createGbpChecker({ log: (m) => logs.push(m) });
      const r = await c.check(rowA);
      eq([r.ok, r.note, logs], [false, G.MISSING_PLAYWRIGHT, [G.MISSING_PLAYWRIGHT]], 'Playwright未導入: スキップしてログに出す');
      ok(G.MISSING_PLAYWRIGHT.includes('npm i playwright && npx playwright install --with-deps chromium'), '導入手順のメッセージ');
      await c.close();
    }
  }

  // ---- fetchGbpActivity(偽のブラウザ) ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbptest-'));
  function fakeBrowser(script) {
    const log = [];
    const page = {
      _url: '', closed: false,
      async goto(u) { log.push('goto ' + u); this._url = script.redirect || u; },
      url() { return this._url; },
      async waitForLoadState() {}, async waitForTimeout() {},
      async waitForSelector(sel) { if (script.noH1) throw new Error('timeout'); },
      async screenshot({ path: p }) { fs.writeFileSync(p, 'png'); },
      async evaluate(fn) {
        if (fn.name === 'readBodyTextInPage') return script.blockText || '';
        if (fn.name === 'scrollPanelInPage') { log.push('scroll'); return 1; }
        if (fn.name === 'readPanelTextInPage') { const t = script.texts[Math.min(this._reads++, script.texts.length - 1)]; return t; }
        return '';
      },
      _reads: 0,
      getByRole(role, { name }) {
        const key = role + ':' + name.source;
        const present = (script.roles || []).find((r) => name.test(r.name) && r.role === role);
        return { first() { return this; }, async count() { return present ? 1 : 0; }, async click() { log.push('click ' + role + ' ' + present.name); } };
      },
      async close() { this.closed = true; log.push('close'); },
    };
    return { log, page, browser: { async newContext(o) { log.push('ctx ' + o.locale + ' ' + o.timezoneId); return { async newPage() { return page; } }; } } };
  }
  {
    const fb = fakeBrowser({ texts: ['山田工務店\n最新情報\n営業案内\n2 週間前\nクチコミ', '山田工務店\nクチコミ\n田中\n3 日前\nよい\nオーナーからの返信\n1 日前\nどうも'],
      roles: [{ role: 'tab', name: 'クチコミ' }, { role: 'button', name: 'クチコミを並べ替え' }, { role: 'menuitemradio', name: '新しい順' }] });
    const r = await G.fetchGbpActivity({ cid: '999888777', store_id: '9' }, { browser: fb.browser, now: NOW, debugDir: dir });
    eq([r.ok, r.blocked, r.url], [true, false, 'https://www.google.com/maps?cid=999888777&hl=ja'], '偽ブラウザ: 読めた');
    eq([r.post.raw, r.ownerReply.raw, r.review.raw], ['2 週間前', '1 日前', '3 日前'], '偽ブラウザ: 抽出');
    ok(fb.log.includes('ctx ja-JP Asia/Tokyo') && fb.log.includes('click tab クチコミ') && fb.log.includes('click menuitemradio 新しい順') && fb.log.includes('scroll') && fb.log[fb.log.length - 1] === 'close', '偽ブラウザ: ja-JP/Tokyo・タブ・並べ替え・スクロール・page を閉じる: ' + fb.log.join('|'));
    ok(fs.existsSync(path.join(dir, '999888777.png')) && fs.readFileSync(path.join(dir, '999888777.txt'), 'utf8').includes('山田工務店'), '偽ブラウザ: screenshot と innerText を保存');
    eq(r.debug.tabs, ['クチコミ', '新しい順'], '偽ブラウザ: 開いたタブ');
  }
  {
    // タブも並べ替えも無い画面でも続行
    const fb = fakeBrowser({ texts: ['店\nクチコミ\n1 か月前'] });
    const r = await G.fetchGbpActivity({ placeId: 'ChIJabcdefghij' }, { browser: fb.browser, now: NOW });
    eq([r.ok, r.review && r.review.raw], [true, '1 か月前'], 'タブが無くても続行');
  }
  {
    // 確認画面(URL)
    const fb = fakeBrowser({ texts: ['x'], redirect: 'https://www.google.com/sorry/index?continue=x' });
    const r = await G.fetchGbpActivity({ cid: '123456789' }, { browser: fb.browser, now: NOW, debugDir: dir });
    eq([r.ok, r.blocked], [false, true], '確認画面(URL)で blocked');
  }
  {
    // 確認画面(本文)
    const fb = fakeBrowser({ texts: ['x'], blockText: '通常と異なるトラフィックが検出されました' });
    eq((await G.fetchGbpActivity({ cid: '123456789' }, { browser: fb.browser, now: NOW })).blocked, true, '確認画面(本文)で blocked');
  }
  {
    // 同意画面: 「すべて拒否」が無ければ失敗、あれば押して続行
    const fb1 = fakeBrowser({ texts: ['x'], redirect: 'https://consent.google.com/m?continue=x', roles: [] });
    const r1 = await G.fetchGbpActivity({ cid: '123456789' }, { browser: fb1.browser, now: NOW });
    eq([r1.ok, r1.blocked, r1.note], [false, false, 'Googleの同意画面を通過できませんでした'], '同意画面でボタン無し');
    const fb2 = fakeBrowser({ texts: ['店\nクチコミ\n2 日前'], redirect: 'https://consent.google.com/m?continue=x', roles: [{ role: 'button', name: 'すべて拒否' }] });
    const r2 = await G.fetchGbpActivity({ cid: '123456789' }, { browser: fb2.browser, now: NOW });
    ok(fb2.log.includes('click button すべて拒否'), '同意画面で「すべて拒否」を押す');
  }
  {
    // 全体タイムアウト
    const fb = fakeBrowser({ texts: ['x'] });
    fb.page.goto = async () => new Promise((r) => setTimeout(r, 300));
    const r = await G.fetchGbpActivity({ cid: '123456789' }, { browser: fb.browser, now: NOW, timeoutMs: 30 });
    eq([r.ok, r.note], [false, '時間切れ(0秒)'], 'タイムアウト');
    ok(fb.page.closed, 'タイムアウトでも page を閉じる');
    eq((await G.fetchGbpActivity({}, { browser: fb.browser })).note, 'GoogleマップのURLがありません', 'URLなし');
    eq((await G.fetchGbpActivity({ cid: '123456789' }, {})).note, G.MISSING_PLAYWRIGHT, 'browser なし');
  }

  // ---- gbp-debug の引数・jsonl ----
  eq(parseArgs(['--cid', '123', '--cid', '456', '--place-id', 'ChIJx', '--out', '/tmp/o']).cids, ['123', '456'], 'cid を複数');
  ok(parseArgs([]).error, '何も無ければエラー');
  ok(parseArgs(['--cid', 'abc']).error, 'cid が数字以外');
  ok(parseArgs(['--jsonl', 'a', '--limit', '0']).error, 'limit 0');
  eq(parseArgs(['--jsonl', 'a']).limit, 5, '既定 limit 5');
  {
    const f = path.join(dir, 'x.jsonl');
    fs.writeFileSync(f, [
      { store_id: '1', inRange: true, cid: '111111111' }, { store_id: '2', inRange: false, cid: '222222222' }, { store_id: '3', inRange: true },
      { store_id: '4', inRange: true, placeId: 'ChIJabcdefghij' }, { store_id: '5', inRange: true, cid: '555555555' },
    ].map((x) => JSON.stringify(x)).join('\n') + '\nこわれた行\n');
    eq(rowsFromJsonl(f, 5).map((r) => r.store_id), ['1', '4', '5'], 'jsonl: 範囲内で識別子のある行だけ');
    eq(rowsFromJsonl(f, 2).map((r) => r.store_id), ['1', '4'], 'jsonl: limit');
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`gbp: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
