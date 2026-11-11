'use strict';
// 夜間フォーム探し(時間帯・ホストの門番・エラーの再試行・定番パス・対象クエリ・管理画面)のテスト。DB不要。
const express = require('express');
const ng = require('../src/nightGuard');
const ff = require('../src/formFinder');
const fnd = require('../cli/find-forms');
const { registerAdminWarehouse, parseNightForm } = require('../src/adminWarehouse');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  ✗ ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);
const FORM = '<form action="/send" method="post"><input type="text" name="name"><input type="email" name="mail"><textarea name="body"></textarea><input type="submit" value="送信"></form>';
const page = (b) => `<html><body>${b}</body></html>`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// メモリ上の偽ストア(DBの門番と同じ約束事)
function fakeStore() {
  const rows = new Map();
  const st = {
    rows,
    async peek(host, reuseMs) {
      const r = rows.get(host);
      if (!r) return { busy: false, waitMs: 0, reuse: null };
      const waitMs = Math.max(0, r.next - Date.now());
      const reuse = r.json && Date.now() - r.at < reuseMs ? JSON.parse(r.json) : null;
      return { busy: r.holder !== null && waitMs > 0, waitMs, reuse };
    },
    async tryLock(host, holder, lockMs) {
      const r = rows.get(host);
      if (!r || r.next <= Date.now()) { rows.set(host, { holder, next: Date.now() + lockMs, json: r && r.json, at: r && r.at }); return true; }
      return false;
    },
    async release(host, holder, gapMs, json) {
      const r = rows.get(host);
      if (!r || r.holder !== holder) return;
      r.holder = null; r.next = Date.now() + gapMs;
      if (json !== null) { r.json = json; r.at = Date.now(); }
    },
  };
  return st;
}
const okResult = (o = {}) => ({ status: 'no_form', inquiryUrl: null, hasCaptcha: false, kind: 'none', emails: [], instagram: null, checkedPages: 1, note: 'x', ...o });
const errResult = (note) => okResult({ status: 'error', note });

(async () => {
  // ---- 時間帯 ----
  ok(ng.inWindow(23, 22, 6) && ng.inWindow(0, 22, 6) && ng.inWindow(5, 22, 6), '22-6: 夜は中');
  ok(!ng.inWindow(6, 22, 6) && !ng.inWindow(12, 22, 6) && !ng.inWindow(21, 22, 6), '22-6: 昼は外(終了時刻は含まない)');
  ok(ng.inWindow(1, 1, 5) && !ng.inWindow(5, 1, 5) && !ng.inWindow(0, 1, 5), '日またぎでない時間帯');
  ok(ng.inWindow(12, 3, 3), '開始=終了は終日');
  eq([ng.parseHour('22'), ng.parseHour('24'), ng.parseHour('-1'), ng.parseHour('x'), ng.parseHour(''), ng.parseHour('6.5')], [22, null, null, null, null, null], 'parseHour');
  const sc = { start: 22, end: 6, enabled: true, from: '2026-11-09 22:00' };
  ok(!ng.isOpen(sc, new Date(2026, 10, 9, 3, 0)), 'from より前は夜でも閉');
  ok(!ng.isOpen(sc, new Date(2026, 10, 9, 21, 59)), 'from の直前は閉');
  ok(ng.isOpen(sc, new Date(2026, 10, 9, 22, 0)), 'from の時刻から開');
  ok(ng.isOpen(sc, new Date(2026, 10, 10, 2, 0)), '翌朝も開');
  ok(!ng.isOpen({ ...sc, from: null, enabled: false }, new Date(2026, 10, 10, 2, 0)), '停止中は閉');
  ok(ng.isOpen({ ...sc, from: '' }, new Date(2026, 10, 10, 23, 0)), 'from が空なら制限なし');
  eq(ng.parseFrom('2026-11-09 22:00').getHours(), 22, 'parseFrom');
  eq(ng.parseFrom('明日'), null, 'parseFrom 不正');
  eq(ng.windowStartOf({ start: 22 }, new Date(2026, 10, 10, 2, 0)).getDate(), 9, '今夜の開始(日またぎの朝は前日22時)');
  eq(ng.windowStartOf({ start: 22 }, new Date(2026, 10, 10, 23, 0)).getDate(), 10, '今夜の開始(夜は当日22時)');
  // 設定: DB優先 → .env → 既定
  eq(ng.scheduleFromRows(null, {}).source, 'default', '表なし+env なし = 既定');
  eq([ng.scheduleFromRows(null, {}).start, ng.scheduleFromRows(null, {}).end], [22, 6], '既定は22-6');
  eq(ng.scheduleFromRows(null, { FORM_NIGHT_START: '23', FORM_NIGHT_END: '5' }).start, 23, '表なしは.envの予備');
  eq(ng.scheduleFromRows({ night_start: '20', night_end: '4', night_enabled: '0' }, { FORM_NIGHT_START: '23' }).start, 20, '表があれば表が優先');
  eq(ng.scheduleFromRows({ night_start: '20', night_end: '4', night_enabled: '0' }, {}).enabled, false, 'enabled=0');
  eq(ng.scheduleFromRows({}, { FORM_NIGHT_START: '23' }).start, 23, '空の表は.envへ');
  // 設定の読み取り係: DBが読めないときは前の値のまま
  let boom = false;
  const rd = ng.createScheduleReader({ store: { read: async () => { if (boom) throw new Error('db down'); return { night_start: '1', night_end: '2', night_enabled: '1' }; } }, now: () => new Date(2026, 10, 9, 1, 30), onError: () => {} });
  await rd.refresh();
  ok(rd.isOpenNow(), 'reader: 開');
  boom = true; await rd.refresh();
  eq(rd.current().start, 1, 'reader: 読めなくても前の値');

  // ---- エラーの種類 ----
  eq(['HTTP 503', 'HTTP 500', 'HTTP 429', 'サイトへ接続できませんでした。', 'サイトの応答がありませんでした。', 'サイト全体の制限時間(60秒)を超えました', 'タイムアウトしました。'].map(ng.classifyError), Array(7).fill('transient'), '一時的');
  eq(['HTTP 403', 'HTTP 401', 'HTTP 410', 'ドメインが見つかりませんでした。URLをご確認ください。', 'この宛先は診断できません。'].map(ng.classifyError), Array(5).fill('permanent'), '永続的');
  eq([ng.classifyError('HTTP 404'), ng.classifyError('その他'), ng.classifyError('')], ['notfound', 'other', 'other'], '404・その他');

  // ---- 門番 ----
  const mk = (over = {}) => { const store = fakeStore(); const sleeps = []; const gate = ng.createHostGate({ store, gapMs: 40, lockMs: 5000, sleep: async (ms) => { sleeps.push(ms); await wait(1); }, retryDelays: [30000, 90000], ...over }); return { store, sleeps, gate }; };
  { // 一時的エラー: 30秒→90秒の2回まで(3回目の失敗でそのまま返す)
    const { gate, sleeps, store } = mk();
    let calls = 0;
    const r = await gate.run('a.jp', async () => { calls++; return errResult('HTTP 503'); }, 'https://a.jp/');
    eq(calls, 3, '一時的エラーは最初+2回=3回');
    eq(sleeps.filter((x) => x >= 30000), [30000, 90000], '間は30秒・90秒');
    eq([r.status, r.note, r.retries], ['error', 'HTTP 503', 2], '最終結果はエラーのまま');
    eq(store.rows.get('a.jp').json, undefined, '一時的エラーは使い回し用に保存しない');
  }
  { // 2回目で成功
    const { gate } = mk(); let calls = 0;
    const r = await gate.run('b.jp', async () => (++calls < 2 ? errResult('サイトへ接続できませんでした。') : okResult({ status: 'url_found', inquiryUrl: 'https://b.jp/c' })), 'https://b.jp/');
    eq([calls, r.status, r.retries], [2, 'url_found', 1], '再試行で成功');
  }
  { // 403・ドメインなしは再試行しない
    for (const note of ['HTTP 403', 'ドメインが見つかりませんでした。URLをご確認ください。', 'HTTP 401']) {
      const { gate } = mk(); let calls = 0;
      const r = await gate.run('c.jp', async () => { calls++; return errResult(note); }, 'https://c.jp/');
      eq([calls, r.note], [1, note], `${note}は再試行しない・理由を残す`);
    }
  }
  { // 404: トップで再試行(深いURLのとき)
    const { gate } = mk(); const urls = [];
    const r = await gate.run('d.jp', async (u) => { urls.push(u); return u === 'https://d.jp/' ? okResult({ status: 'url_found', inquiryUrl: 'https://d.jp/contact' }) : errResult('HTTP 404'); }, 'https://d.jp/shop/12');
    eq([urls, r.status, r.rootRetried], [['https://d.jp/shop/12', 'https://d.jp/'], 'url_found', true], '404はトップで再試行');
    const g2 = mk(); const u2 = [];
    const r2 = await g2.gate.run('e.jp', async (u) => { u2.push(u); return errResult('HTTP 404'); }, 'https://e.jp/');
    eq([u2.length, r2.note], [1, 'HTTP 404'], 'すでにトップなら再試行しない');
    const g3 = mk(); const u3 = [];
    const r3 = await g3.gate.run('f.jp', async (u) => { u3.push(u); return errResult('HTTP 404'); }, 'https://f.jp/a/b');
    eq([u3.length, r3.note, r3.rootRetried], [2, 'HTTP 404', true], 'トップも404ならそのまま404');
  }
  { // 使い回し: 7日以内の結果は訪問しない
    const { gate } = mk(); let calls = 0;
    const visit = async () => { calls++; return okResult({ status: 'no_form', note: '候補なし' }); };
    await gate.run('g.jp', visit, 'https://g.jp/');
    const r = await gate.run('g.jp', visit, 'https://g.jp/x');
    eq([calls, r.reused, r.note], [1, true, '候補なし'], '2回目は使い回し(取得しない)');
    // 規模が要るのに規模の無い結果は使い回さない
    const r2 = await gate.run('g.jp', visit, 'https://g.jp/', { needSize: true });
    eq([calls, !!r2.reused], [2, false], 'needSize で規模が無ければ取り直す');
  }
  { // 並列で同じホスト: 同時に訪問しない・間隔を守る(使い回しを無効にして純粋に順番待ちを見る)
    const store = fakeStore(); const gate = ng.createHostGate({ store, gapMs: 60, lockMs: 5000, reuseMs: 0, sleep: wait, pollMs: 10 });
    let active = 0, maxActive = 0; const starts = [];
    const visit = async () => { active++; maxActive = Math.max(maxActive, active); starts.push(Date.now()); await wait(20); active--; return okResult(); };
    await Promise.all([1, 2, 3, 4].map(() => gate.run('h.jp', visit, 'https://h.jp/')));
    eq(maxActive, 1, '同じホストは同時に1つだけ');
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    ok(gaps.every((g) => g >= 60 + 15), `訪問の間隔は 終了+間隔 以上 (${gaps.join(',')})`);
    // 別ホストは同時に進む
    let a2 = 0, m2 = 0;
    const v2 = async () => { a2++; m2 = Math.max(m2, a2); await wait(30); a2--; return okResult(); };
    await Promise.all(['x1.jp', 'x2.jp', 'x3.jp'].map((h) => gate.run(h, v2, `https://${h}/`)));
    ok(m2 >= 2, '別のホストは並行して調べる');
  }
  { // 待ち切れない → deferred(何も書かない)
    const store = fakeStore(); store.rows.set('z.jp', { holder: 'other', next: Date.now() + 100000 });
    const gate = ng.createHostGate({ store, maxWaitMs: 30, sleep: wait, pollMs: 5 });
    const r = await gate.run('z.jp', async () => okResult(), 'https://z.jp/');
    eq(r.deferred, true, '順番待ちが長すぎたら見送り');
  }
  { // exclusive: 順番だけ守る(使い回さない)
    const store = fakeStore(); const gate = ng.createHostGate({ store, gapMs: 40, sleep: wait, pollMs: 5 });
    let a = 0, m = 0;
    await Promise.all([1, 2, 3].map(() => gate.exclusive('k.jp', async () => { a++; m = Math.max(m, a); await wait(10); a--; })));
    eq(m, 1, 'exclusive は同時に1つ');
  }
  { // 別プロセスが取っているロック(期限切れ前)の間は訪問しない
    const store = fakeStore(); store.rows.set('l.jp', { holder: 'p2', next: Date.now() + 80 });
    const gate = ng.createHostGate({ store, gapMs: 10, sleep: wait, pollMs: 10, reuseMs: 0 });
    const t0 = Date.now(); let startedAt = 0;
    await gate.run('l.jp', async () => { startedAt = Date.now(); return okResult(); }, 'https://l.jp/');
    ok(startedAt - t0 >= 70, '他プロセスのロックが切れるまで待つ');
  }

  // ---- processStores に門番をつなぐ ----
  {
    const { gate } = mk({ retryDelays: [1, 1] });
    const written = []; let calls = 0;
    const st = await fnd.processStores({ stores: [{ id: 1, website_url: 'https://p1.jp/' }, { id: 2, website_url: 'https://p1.jp/' }, { id: 3, website_url: 'https://p2.jp/' }],
      finder: async (u) => { calls++; return u.includes('p2') ? errResult('HTTP 503') : okResult({ status: 'url_found', inquiryUrl: 'https://p1.jp/c' }); },
      writer: async (s, r) => { written.push([s.id, r.status]); }, concurrency: 2, gate });
    eq([st.found, st.error, st.retried, calls], [2, 1, 1, 4], '門番つき processStores(同ホスト1回・p2は3回)');
    const g2 = ng.createHostGate({ store: { peek: async () => ({ busy: true, waitMs: 1000, reuse: null }), tryLock: async () => false, release: async () => {} }, maxWaitMs: 5, sleep: wait, pollMs: 2 });
    const w2 = [];
    const st2 = await fnd.processStores({ stores: [{ id: 9, website_url: 'https://busy.jp/' }], finder: async () => okResult(), writer: async (s) => { w2.push(s.id); }, gate: g2 });
    eq([w2.length, st2.deferred, st2.error], [0, 1, 0], '見送りは書き込まず、エラーにも数えない');
  }

  // ---- 定番パス・sitemap ----
  {
    const smXml = '<urlset><url><loc>https://s.jp/news/1</loc></url><url><loc>https://s.jp/company/contact/</loc></url><url><loc>https://other.jp/contact</loc></url><url><loc>https://s.jp/inquiry.html</loc></url></urlset>';
    eq(ff.sitemapContactUrls(smXml, 's.jp'), ['https://s.jp/inquiry.html', 'https://s.jp/company/contact/'], 'sitemap: 同一ホストの問い合わせURLを短い順');
    const fakeSite = (pages, log) => async (url) => {
      log.push(url); const u = new URL(url); const key = u.origin + u.pathname;
      return pages[key] !== undefined ? { finalUrl: url, status: 200, headers: {}, body: pages[key] } : { finalUrl: url, status: 404, headers: {}, body: '' };
    };
    const noRobots = async () => '';
    // リンクなし → /contact を試して見つける(sitemap は404)
    let log = [];
    let r = await ff.findContact('https://s.jp/', { fetchPage: fakeSite({ 'https://s.jp/': page('<p>こんにちは</p>'), 'https://s.jp/contact': page(FORM) }, log), fetchRobots: noRobots });
    eq([r.status, r.inquiryUrl], ['url_found', 'https://s.jp/contact'], 'リンクなしでも /contact で見つかる');
    ok(log.length <= ff.MAX_PAGES, `取得ページ数は上限内 (${log.length})`);
    // sitemap にある問い合わせURLを優先
    log = [];
    r = await ff.findContact('https://s.jp/', { fetchPage: fakeSite({ 'https://s.jp/': page('<p>top</p>'), 'https://s.jp/sitemap.xml': smXml, 'https://s.jp/company/contact/': page(FORM) }, log), fetchRobots: noRobots });
    eq([r.status, r.inquiryUrl], ['url_found', 'https://s.jp/company/contact/'], 'sitemap の問い合わせURLで見つかる');
    // どこにも無い → 上限(MAX_PAGES)を超えない
    log = [];
    r = await ff.findContact('https://s.jp/', { fetchPage: fakeSite({ 'https://s.jp/': page('<p>top</p>') }, log), fetchRobots: noRobots });
    eq(r.status, 'no_form', 'どこにも無ければフォームなし');
    eq(log.length, ff.MAX_PAGES, `取得ページ数は MAX_PAGES ちょうどまで (${log.length})`);
    eq(r.checkedPages, ff.MAX_PAGES, 'checkedPages も上限');
    // JSサイト: 定番パスでも無ければ要確認のまま
    log = [];
    r = await ff.findContact('https://js.jp/', { fetchPage: fakeSite({ 'https://js.jp/': '<html><body><div id="__next"></div><script src="/_next/static/a.js"></script></body></html>' }, log), fetchRobots: noRobots });
    ok(['unknown', 'no_form'].includes(r.status) && log.length <= ff.MAX_PAGES, 'JSサイトも上限内');
    log = [];
    r = await ff.findContact('https://js.jp/', { fetchPage: fakeSite({ 'https://js.jp/': '<html><body><div id="__next"></div><script src="/_next/static/a.js"></script></body></html>', 'https://js.jp/contact': page(FORM) }, log), fetchRobots: noRobots });
    eq(r.status, 'url_found', 'JSサイトでも /contact にフォームがあれば見つかる');
    // robots.txt で /contact を禁止 → 取得しない
    log = [];
    r = await ff.findContact('https://s.jp/', { fetchPage: fakeSite({ 'https://s.jp/': page('<p>top</p>'), 'https://s.jp/contact': page(FORM) }, log), fetchRobots: async () => 'User-agent: *\nDisallow: /contact\n' });
    ok(!log.some((u) => u.endsWith('/contact')) && r.status !== 'url_found', 'robots.txt を守る');
    // 無効化
    log = [];
    r = await ff.findContact('https://s.jp/', { fetchPage: fakeSite({ 'https://s.jp/': page('<p>top</p>'), 'https://s.jp/contact': page(FORM) }, log), fetchRobots: noRobots, fallbackPaths: false });
    eq([r.status, log.length], ['no_form', 1], 'fallbackPaths:false で従来どおり');
  }

  // ---- 対象クエリ ----
  {
    const base = { recheckDays: 90, errorRetryDays: 7, prefecture: '鳥取県', limit: 500, retryNeedsBrowser: false };
    let q = fnd.buildWarehouseTargetQuery(base);
    eq(q.params, [['鳥取県'], 7, 90, 90, 500], '既定: 一時的7日・永続的90日・なし90日');
    ok(/NOT \(COALESCE\(form_note, ''\) IN \('HTTP 403'/.test(q.sql) && /form_status = 'error' AND \(COALESCE/.test(q.sql), '永続的なエラーを分けている');
    ok(!/merged_into/.test(q.sql) && !/phone/.test(q.sql), '通常モードは統合済み・電話の条件なし');
    q = fnd.buildWarehouseTargetQuery({ ...base, night: true, priority: true, cursor: { rc: 12, id: 345 } });
    ok(/stoc_sales\.stores st WHERE st\.id = stoc_master\.shops\.stoc_store_id AND st\.merged_into IS NOT NULL/.test(q.sql), '統合済みの店を外す');
    ok(/phone REGEXP '\[0-9\]'/.test(q.sql), '電話番号あり');
    ok(/ORDER BY COALESCE\(review_count, -1\) DESC, id/.test(q.sql), '口コミの多い順');
    eq(q.params, [['鳥取県'], 7, 90, 90, 12, 12, 345, 500], 'cursor のパラメータ順');
    ok(/category_main, postal/.test(q.sql) && /site_host/.test(q.sql), 'ルール判定に必要な列を読む');
    q = fnd.buildWarehouseSizeTargetQuery({ prefecture: null, category: [], limit: 10, night: true });
    ok(/merged_into IS NOT NULL/.test(q.sql) && q.params.length === 1, '規模チェックにも統合済み除外');
    q = fnd.buildWarehouseNoSalesTargetQuery({ prefecture: null, category: [], limit: 10, night: true });
    ok(/merged_into IS NOT NULL/.test(q.sql), 'お断り判定にも統合済み除外');
    ok(!/merged_into/.test(fnd.buildWarehouseNoSalesTargetQuery({ prefecture: null, category: [], limit: 10 }).sql), '--night が無ければ従来どおり');
    eq([fnd.wantsPriority({ night: true, source: 'warehouse', category: [] }), fnd.wantsPriority({ night: true, source: 'warehouse', category: ['製造'] }), fnd.wantsPriority({ night: true, source: 'warehouse', category: [], withSize: true }), fnd.wantsPriority({ night: false, source: 'warehouse', category: [] })], [true, false, false, false], '優先順位は専用モードでは使わない');
    // fetchPrioritized: 電話なし・ルール除外を読み飛ばし、cursor を進める
    const rows = [
      { id: 1, review_count: 50, phone: '078-000-0000', category: '美容院', category_main: '美容院', name: 'A' },
      { id: 2, review_count: 40, phone: '-', category: '美容院', category_main: '美容院', name: 'B' },
      { id: 3, review_count: null, phone: '078-111-1111', category: '美容院', category_main: '美容院', name: 'C' },
    ];
    const calls = [];
    const pool = { query: async (sql, params) => { calls.push(params); return [rows]; } };
    const state = { cursor: null };
    const got = await fnd.fetchPrioritized(pool, { recheckDays: 90, errorRetryDays: 7, night: true, source: 'warehouse', category: [] }, 10, state);
    eq(got.map((r) => r.id), [1, 3], '電話なしは読み飛ばす');
    eq(state.cursor, { rc: -1, id: 3 }, 'cursor は最後に読んだ行(口コミ無しは -1)');
  }
  eq([fnd.parseArgs(['--source', 'warehouse', '--night']).night, fnd.parseArgs(['--source', 'warehouse', '--night', '--ignore-window']).ignoreWindow, fnd.parseArgs([]).permanentRetryDays], [true, true, 90], '引数');
  for (const bad of [['--night'], ['--source', 'warehouse', '--ignore-window'], ['--source', 'warehouse', '--permanent-retry-days', '0']]) {
    let threw = false; try { fnd.parseArgs(bad); } catch { threw = true; }
    ok(threw, `不正な引数 ${bad.join(' ')}`);
  }

  // ---- 管理画面 ----
  eq(parseNightForm({ start: '22', end: '6', enabled: '1', from: '2026-11-09 22:00' }).values, { night_start: '22', night_end: '6', night_enabled: '1', night_from: '2026-11-09 22:00' }, 'フォーム検証: 正常');
  eq(parseNightForm({ start: '22', end: '6', from: '' }).values.night_enabled, '0', 'チェックなし=停止');
  ok(parseNightForm({ start: '25', end: '6' }).error, '範囲外の時刻');
  ok(parseNightForm({ start: '22', end: '6', from: 'あした' }).error, '日時の形が不正');
  {
    const saved = [];
    const sched = { start: 22, end: 6, enabled: true, from: '2026-11-09 22:00', source: 'db', tableReady: true };
    const app = express();
    registerAdminWarehouse(app, {
      password: 'correct-horse-battery', allowIps: '203.0.113.10', secret: 's', jobs: { start() {}, get() {}, list: () => [], running: () => null },
      queryStats: async () => ({ total: 0, rows: [], sizeAvailable: true }),
      nightStore: { schedule: async () => sched, save: async (m) => { saved.push(m); }, stats: async () => ({ since: '2026-11-08 22:00:00', totals: { found: 5, none: 3, needs: 2, err: 4, tonight: 7, remaining: 100 }, rows: [{ prefecture: '鳥取県', found: 5, none: 3, needs: 2, err: 4, tonight: 7, remaining: 100 }], reasons: [{ note: 'HTTP 403', n: 4 }] }) },
    });
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}/admin/warehouse`;
    const H = { 'X-Real-IP': '203.0.113.10' };
    const URLENC = { 'Content-Type': 'application/x-www-form-urlencoded' };
    const lr = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { ...H, ...URLENC }, body: 'password=correct-horse-battery' });
    const cookie = (lr.headers.get('set-cookie') || '').split(';')[0];
    const get = (p) => fetch(base + p, { headers: { ...H, cookie }, redirect: 'manual' });
    const nightRes = await get('/night');
    const html = await nightRes.text();
    eq(nightRes.status, 200, '夜間フォーム探しの画面');
    ok(html.includes('22時〜6時') && html.includes('鳥取県') && html.includes('HTTP 403') && html.includes('今夜'), '設定・県別の件数・エラー理由・今夜の処理を表示');
    ok(html.includes('>5<') || html.includes('5</td>'), 'あり件数');
    const csrf = (/name="_csrf" value="([^"]+)"/.exec(html) || [])[1];
    const post = (body) => fetch(base + '/night/settings', { method: 'POST', redirect: 'manual', headers: { ...H, ...URLENC, cookie }, body });
    const bad = await post('start=25&end=6&_csrf=' + csrf);
    eq([bad.status, saved.length], [400, 0], '不正な時刻は保存しない');
    const noCsrf = await post('start=21&end=5&enabled=1');
    eq([noCsrf.status, saved.length], [403, 0], 'CSRFなしは拒否');
    const good = await post(`start=21&end=5&enabled=1&from=&_csrf=${csrf}`);
    eq([good.status, saved[0]], [200, { night_start: '21', night_end: '5', night_enabled: '1', night_from: '' }], '保存できる');
    ok((await good.text()).includes('保存しました'), '保存の通知');
    server.close();
  }

  console.log(`night: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
