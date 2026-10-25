'use strict';
// B2B(建設・製造)向け文面・営業お断り検出・Shift_JIS入力・移行SQL のテスト(DB不要)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifyIndustry, pickFindingB2b, buildB2bMessage, jstDateJa, loadTemplates } = require('../src/outreach');
const { runBatch, parseInputBuffer, parseDelimited, buildWarehouseQuery, B2B_COLUMNS, COLUMNS } = require('../cli/batch-scan');
const { detectNoSales, findContact, NOTE_NO_SALES } = require('../src/formFinder');
const wh = require('../src/warehouse');
const promote = require('../cli/warehouse-promote');
const G = require('../src/outreachGroups');
const { parseArgs } = require('../cli/batch-scan');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);

const KEYS = ['cert', 'https_redirect', 'tls_version', 'headers', 'cookies', 'mixed', 'cms', 'js_libs', 'ext_scripts', 'mail'];
const mk = (o, ev) => KEYS.map((k) => ({ key: k, status: (o && o[k]) || 'ok', evidence: (ev && ev[k]) || '' }));

(async () => {
  // 業種区分
  eq(classifyIndustry('建設会社'), '建設', '建設会社');
  eq(classifyIndustry('板金施工請負業者'), '建設', '板金施工請負業者');
  eq(classifyIndustry('金属加工業'), '製造', '金属加工業');
  eq(classifyIndustry('自動車整備工場'), '整備', '自動車整備工場');
  eq(classifyIndustry('食品製造業者'), '製造', '食品製造業者');
  eq(classifyIndustry('不明'), 'その他', '不明');
  eq(classifyIndustry(''), 'その他', '空');
  eq(classifyIndustry('美容院,建設会社'), 'その他', '主業種(先頭)だけ見る');

  // 指摘の優先順位と除外
  eq(pickFindingB2b(mk()), null, 'すべてok');
  eq(pickFindingB2b(mk({ mail: 'bad' })), null, 'mailだけ -> なし');
  eq(pickFindingB2b(mk({ cookies: 'bad', ext_scripts: 'warn', mail: 'warn' })), null, 'cookies等だけ -> なし');
  eq(pickFindingB2b(mk({ mixed: 'bad', js_libs: 'warn' })), 'mixed', 'mixed が js_libs より先');
  eq(pickFindingB2b(mk({ mixed: 'warn' })), null, 'mixed warn は使わない');
  eq(pickFindingB2b(mk({ https_redirect: 'warn', js_libs: 'warn' })), 'https_redirect', 'https_redirect warn');
  eq(pickFindingB2b(mk({ https_redirect: 'bad' })), 'no_https', 'https非対応(bad)は no_https');
  eq(pickFindingB2b(mk({ https_redirect: 'bad', mixed: 'bad' })), 'no_https', 'no_https が最優先');
  eq(pickFindingB2b(mk({ https_redirect: 'unknown' })), null, 'https_redirect unknown は指摘にしない');
  eq(pickFindingB2b(mk({ https_redirect: 'unknown', js_libs: 'warn' })), 'js_libs', 'unknown は飛ばして次の指摘へ');
  eq(pickFindingB2b(mk({ js_libs: 'warn', cms: 'warn', headers: 'bad' })), 'js_libs', 'js_libs > cms > headers');
  eq(pickFindingB2b(mk({ cms: 'warn', headers: 'bad' })), 'cms', 'cms > headers');
  eq(pickFindingB2b(mk({ headers: 'warn', tls_version: 'warn' })), 'headers', 'headers > tls');
  eq(pickFindingB2b(mk({ tls_version: 'warn' })), 'tls_version', 'tls warn');
  // 証明書
  eq(pickFindingB2b(mk({ cert: 'bad' }, { cert: '有効期限: 2026-01-01(残り-20日)' })), 'cert_expired', '期限切れ');
  eq(pickFindingB2b(mk({ cert: 'warn' }, { cert: '有効期限: 2026-11-10(残り16日)' })), 'cert_expiring', '30日以内');
  eq(pickFindingB2b(mk({ cert: 'bad' }, { cert: '有効期限: 2027-01-01(残り60日) / 検証エラー: 不一致' })), null, '期限は先だが不一致 -> 使わない');
  eq(pickFindingB2b(mk({ cert: 'warn' })), null, '日数が読めない -> 使わない');
  eq(pickFindingB2b(mk({ cert: 'bad', js_libs: 'warn' }, { cert: '(残り-1日)' })), 'cert_expired', '期限切れが js_libs より先');
  eq(pickFindingB2b(mk({ mixed: 'bad', cert: 'bad' }, { cert: '(残り-1日)' })), 'mixed', 'mixed が cert より先');

  // 文面
  const T = loadTemplates();
  ok(T.b2b && T.b2bShort && T.findingsB2b && T.subjects.length === 3, 'B2B用テンプレートを読める');
  eq(T.config['返信先メールアドレス'], 'morisawa@stoc.co.jp', '返信先は morisawa のみ');
  const at = new Date('2026-10-25T03:00:00Z');
  const build = (o) => buildB2bMessage(T, { name: '株式会社テスト', category: '建設会社', domain: 'test.jp', results: mk({ mixed: 'bad' }), scannedAt: at, seq: 0, ...o });
  const m = build();
  eq(m.industry, '建設', '業種');
  ok(m.send && m.use === '標準', '送る/標準');
  ok(!/\{[^{}]+\}/.test(m.body) && !/\{[^{}]+\}/.test(m.shortBody) && !/\{[^{}]+\}/.test(m.subject), 'プレースホルダー残りなし');
  ok(m.body.includes('協力会社様・発注者様・求職者様がご覧になる'), '閲覧者(建設)');
  ok(m.body.includes('2026年10月25日に確認'), '確認日');
  ok(m.body.includes('morisawa@stoc.co.jp 宛に') && !m.body.includes('kit@'), '返信先');
  ok(m.body.includes('TEL:0120-830-046/兵庫県姫路市北条梅原町229') && m.body.includes('森澤 梓'), '署名');
  ok(!/https?:\/\//.test(m.body.replace('http:// で開いた', '').replace('https://', '')) , '本文にURLなし');
  ok(m.length > 300 && m.length < 700, '標準の長さ ' + m.length);
  ok([...m.shortBody].length < m.length, '短縮は標準より短い');
  eq(build({ category: '金属加工業' }).body.includes('取引先様・調達ご担当者様・求職者様'), true, '閲覧者(製造)');
  eq(build({ category: '自動車整備工場' }).body.includes('お客様・取引先様・求職者様'), true, '閲覧者(整備)');
  eq(build({ category: '' }).body.includes('取引先様・求職者様がご覧'), true, '閲覧者(その他)');
  // 指摘なし
  const none = build({ results: mk({ mail: 'bad' }) });
  eq([none.send, none.reason, none.body], [false, '初回に使える指摘なし', ''], '指摘なし');
  // 文字数
  const len = m.length;
  eq(build({ maxChars: len }).use, '標準', 'ちょうどは標準');
  eq(build({ maxChars: len - 1 }).use, '短縮', '超えたら短縮');
  const over = build({ maxChars: 50 });
  eq([over.send, over.reason, over.use], [false, '文字数超過', '短縮'], '短縮も超過');
  eq(build({ maxChars: 0 }).use, '標準', '0は無効');
  // 件名
  eq([0, 1, 2, 3, 4].map((i) => build({ seq: i }).subject.slice(0, 6)), ['御社Webサ', '「test.', '公開Webサ', '御社Webサ', '「test.'], '件名の巡回');
  eq(build({ subjectNo: 2, seq: 0 }).subject, '「test.jp」の設定確認に関するご連絡', '件名の固定');
  eq(build({ subjectNo: 9, seq: 1 }).subject.slice(0, 2), '「t', '範囲外の固定は無視');
  eq(jstDateJa(new Date('2026-12-31T16:00:00Z')), '2027年1月1日', 'JSTの日付');

  // runBatch b2b
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2b-test-'));
  try {
    const out = path.join(dir, 'r.csv');
    const scan = async (url) => ({ results: url.includes('good') ? mk() : mk({ mixed: 'bad' }), score: 50, grade: 'D' });
    const rows = [
      { store_id: '10', name: '甲建設', url: 'https://bad.jp', prefecture: '兵庫県', category: '建設会社', formUrl: 'https://bad.jp/contact', captcha: 'なし', noSales: '', phone: '079-222-3333', address: '兵庫県姫路市北条1-1' },
      { store_id: '11', name: '乙製作所', url: 'https://good.jp', prefecture: '', category: '金属加工業', formUrl: '', captcha: '', noSales: '' },
    ];
    await runBatch({ rows, scan, out, templates: T, templateMode: 'b2b', log: () => {}, subject: 3, maxChars: 0 });
    const t = parseDelimited(fs.readFileSync(out, 'utf8'), ',');
    eq(t[0], [...COLUMNS, ...B2B_COLUMNS], 'b2bの列');
    const r1 = t[1], r2 = t[2];
    const col = (n) => t[0].indexOf(n);
    eq(r1[col('送信推奨')], 'はい', '送る');
    eq(r1[col('業種区分')], '建設', '業種区分');
    eq(r1[col('件名')], '公開Webサイトの確認結果のご案内(費用はかかりません)', '件名固定3');
    eq(Number(r1[col('本文文字数')]), [...r1[col('本文')]].length, '本文文字数');
    eq([r1[col('使用本文')], r1[col('問い合わせURL')], r1[col('画像認証')]], ['標準', 'https://bad.jp/contact', 'なし'], '使用本文/URL/画像認証');
    ok(r1[col('短縮本文')].includes('甲建設 ご担当者様'), '短縮本文あり');
    eq([t[0][t[0].length - 2], t[0][t[0].length - 1], r1[col('電話番号')], r1[col('住所')]], ['電話番号', '住所', '079-222-3333', '兵庫県姫路市北条1-1'], '電話番号・住所を末尾に引き継ぐ');
    eq(r2[col('送信推奨')], '送らない:初回に使える指摘なし', '送らない+理由');
    eq(r2[col('本文')], '', '送らない時は本文なし');
    // 従来モードの列は増えない
    const out2 = path.join(dir, 'w.csv');
    await runBatch({ rows, scan, out: out2, templates: T, templateMode: 'west', log: () => {} });
    eq(parseDelimited(fs.readFileSync(out2, 'utf8'), ',')[0].length, 25, 'west は25列');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // Shift_JIS の promote CSV
  const csv = '屋号,業種,郵便番号,住所,電話番号,評価,口コミ数,Googleマイビジネス登録有無,登録URL,GMAP,写真枚数\r\n'
    + '甲建設,建設会社,670-0001,兵庫県姫路市北条1,079-000-0000,4.0,3,あり,https://a.jp,https://g,5\r\n'
    + '乙製作所,金属加工業,100-0001,東京都千代田区1,03-0000-0000,,,なし,,,\r\n';
  const sjis = wh.encodeShiftJis(csv);
  let utf8Fail = false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(sjis); } catch { utf8Fail = true; }
  ok(utf8Fail, 'テスト用データは UTF-8 として読めない(SJIS)');
  const pr = parseInputBuffer(sjis);
  eq(pr[0], { store_id: '', name: '甲建設', url: 'https://a.jp', prefecture: '兵庫県', category: '建設会社', phone: '079-000-0000', address: '兵庫県姫路市北条1' }, 'SJIS 1行目(電話番号・住所も読む)');
  eq([pr[1].name, pr[1].url, pr[1].prefecture], ['乙製作所', '', '東京都'], 'SJIS 2行目');
  eq(parseInputBuffer(Buffer.from('﻿' + csv, 'utf8'))[0].name, '甲建設', 'UTF-8(BOM)も読める');

  // 倉庫検索SQL
  const q = buildWarehouseQuery({ prefecture: '兵庫県', mainCategory: '製造,建設', excludeLarge: true, formFound: true, limit: 100 }, { noSalesCol: true });
  ok(q.sql.includes('category_main LIKE ? OR category_main LIKE ?') && q.sql.includes("form_status = 'url_found'") && q.sql.includes('form_no_sales = 0')
    && q.sql.includes("size_class <> 'large'") && q.sql.includes('form_url, form_captcha, phone, address_raw, form_no_sales'), '倉庫SQL');
  eq(q.params, [['兵庫県'], '%製造%', '%建設%', 100], '倉庫SQLの引数');
  ok(!buildWarehouseQuery({}, { noSalesCol: false }).sql.includes('form_no_sales'), '列なしなら form_no_sales を使わない');
  ok(buildWarehouseQuery({ smallOnly: true, excludeLarge: true }, {}).sql.includes("size_class = 'small'"), 'small-only 優先');

  // クレーム登録店の除外
  { const bs = require('../cli/batch-scan.js');
    const both = bs.buildWarehouseQuery({}, { storeFlags: true }).sql;
    ok(both.includes('NOT EXISTS (SELECT 1 FROM stoc_sales.sales_logs clm WHERE clm.store_id = stoc_store_id AND clm.deleted_at IS NULL AND clm.call_result = \'クレーム\')')
      && both.includes('NOT EXISTS (SELECT 1 FROM stoc_sales.store_flags f WHERE f.store_id = stoc_store_id AND f.flag = \'クレーム\' AND f.cleared_at IS NULL)'), 'クレーム除外: 両方のNOT EXISTS');
    const only = bs.buildWarehouseQuery({}, {}).sql;
    ok(only.includes('NOT EXISTS (SELECT 1 FROM stoc_sales.sales_logs') && !only.includes('store_flags'), 'クレーム除外: store_flagsなしなら sales_logs のみ');
    const cq = bs.buildClaimExcludedCountQuery({ prefecture: '兵庫県', limit: 5 }, { storeFlags: true });
    ok(cq.sql.startsWith('SELECT COUNT(*) AS n FROM stoc_master.shops') && cq.sql.includes('stoc_store_id IS NOT NULL AND (EXISTS (')
      && cq.sql.includes('store_flags') && !cq.sql.includes('NOT EXISTS') && !cq.sql.includes('LIMIT') && !cq.sql.includes('ORDER BY'), 'クレーム除外: 件数SQL');
    eq(cq.params, [['兵庫県']], 'クレーム除外: 件数SQLの引数(LIMITなし)');
    // 権限なし → GRANT 付きで中止
    const denied = { query: async (sql) => { if (sql.includes('sales_logs')) throw Object.assign(new Error('SELECT command denied'), { errno: 1142 }); return [[{ n: 1 }]]; } };
    let msg = '';
    try { await bs.checkClaimAccess(denied, { WH_DB_USER: 'whuser', WH_DB_HOST: '127.0.0.1' }); } catch (e) { msg = e.message; }
    ok(msg.includes("GRANT SELECT ON stoc_sales.sales_logs TO 'whuser'@'localhost';") && msg.includes("GRANT SELECT ON stoc_sales.store_flags TO 'whuser'@'localhost';"), '権限なしのエラーに GRANT 文');
    let msg2 = '';
    try { await bs.checkClaimAccess(denied, {}); } catch (e) { msg2 = e.message; }
    ok(msg2.includes("TO 'stoc_wh'@'localhost';"), '既定ユーザー stoc_wh');
    // store_flags が情報スキーマで見えず直接SELECTも「表なし」→ sales_logs のみで続行
    const noFlags = { query: async (sql) => { if (sql.includes('information_schema')) return [[{ n: 0 }]]; if (sql.includes('store_flags')) throw Object.assign(new Error('no table'), { errno: 1146 }); return [[{ 1: 1 }]]; } };
    eq((await bs.checkClaimAccess(noFlags, {})).storeFlags, false, 'store_flags なし');
    // 見えないが権限なし(1142)→ 中止
    const flagDenied = { query: async (sql) => { if (sql.includes('information_schema')) return [[{ n: 0 }]]; if (sql.includes('store_flags')) throw Object.assign(new Error('denied'), { errno: 1142 }); return [[{ 1: 1 }]]; } };
    let msg3 = ''; try { await bs.checkClaimAccess(flagDenied, {}); } catch (e) { msg3 = e.message; }
    ok(msg3.includes('GRANT SELECT ON stoc_sales.store_flags'), 'store_flags 権限なしも中止');
    const withFlags = { query: async (sql) => (sql.includes('information_schema') ? [[{ n: 1 }]] : [[{ 1: 1 }]]) };
    eq((await bs.checkClaimAccess(withFlags, {})).storeFlags, true, 'store_flags あり'); }

  // 営業お断り検出
  for (const t of ['営業目的のお問い合わせはご遠慮ください', '営業目的でのご連絡はお断りします', '営業のご連絡はお断りしております', '営業メールはご遠慮ください',
    'セールスはお断りします', '売り込みはお断り', '勧誘はお断りいたします', '営業・勧誘のお電話', '営業利用を禁止します', '<p>営業電話は<b>お断り</b>です</p>']) {
    ok(detectNoSales(t), '検出: ' + t);
  }
  for (const t of ['営業時間 9:00-18:00', '営業日:月〜金', '営業所のご案内', '営業部 お問い合わせ', '営業担当までご連絡ください', '営業のご相談はお気軽に', 'お問い合わせはこちら', '', '<script>営業お断り</script>ご予約']) {
    ok(!detectNoSales(t), '誤検出なし: ' + t);
  }
  // findContact
  const page = (body, url) => ({ status: 200, finalUrl: url, body });
  const form = '<form action="/send" method="post"><input name="name"><input name="email"><textarea name="msg"></textarea><input type="submit"></form>';
  const pages = {
    'https://ex.jp/': page('<a href="/contact">お問い合わせ</a>', 'https://ex.jp/'),
    'https://ex.jp/contact': page('<p>営業目的のお問い合わせはご遠慮ください</p>' + form, 'https://ex.jp/contact'),
    'https://ok.jp/': page('<a href="/contact">お問い合わせ</a>', 'https://ok.jp/'),
    'https://ok.jp/contact': page('<p>営業時間 9時から</p>' + form, 'https://ok.jp/contact'),
    'https://top.jp/': page('<p>営業はお断りします</p>' + form, 'https://top.jp/'),
  };
  const opts = { fetchPage: async (u) => pages[u], fetchRobots: async () => '' };
  const ns = await findContact('https://ex.jp/', opts);
  eq([ns.status, ns.noSales, ns.note.includes(NOTE_NO_SALES)], ['url_found', true, true], 'フォームのページに営業お断り');
  const okr = await findContact('https://ok.jp/', opts);
  eq([okr.status, okr.noSales], ['url_found', false], '営業時間は誤検出しない');
  const tp = await findContact('https://top.jp/', opts);
  eq([tp.status, tp.noSales], ['url_found', true], 'トップページに営業お断り');

  // 移行SQL 004
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'warehouse_migrate_004.sql'), 'utf8');
  ok(sql.includes('form_no_sales TINYINT(1) NULL') && sql.includes('information_schema.COLUMNS') && sql.includes('PREPARE st FROM @s'), '004: 冪等な追加');
  // PREPARE文字列の中に引用符が入れ子になっていないこと(単一引用符の数が偶数)
  const stmt = sql.split('\n').filter((l) => l.startsWith('SET @s'));
  ok(stmt.length === 1 && (stmt[0].match(/'/g) || []).length % 2 === 0, '004: 引用符の数');
  // 003 のように文字列リテラルを含む場合は '' に倍加されていること(ENUM 等は 004 では使わない)
  ok(!/ENUM\('/.test(sql), '004: 入れ子の文字列リテラルなし');

  // promote: 営業お断りの除外
  const base = promote.parseArgs(['--out', 'x.csv', '--form-found']);
  ok(!promote.buildQuery(base).sql.includes('form_no_sales'), 'フラグなしでは従来のSQL');
  const withNs = promote.buildQuery({ ...base, noSalesFilter: true }).sql;
  ok(withNs.includes('form_no_sales IS NULL OR form_no_sales = 0'), 'promote: form_no_sales=1 を外す');
  { const bs = require('../cli/batch-scan.js');
    const q1 = bs.buildWarehouseQuery({ formFound: true }, { noSalesCol: true }).sql;
    ok(/form_no_sales = 0/.test(q1) && !/form_no_sales IS NULL/.test(q1), 'batch-scan: フォームありで文面を作るときは営業お断り確認済み(=0)だけ'); }
  const cnt = promote.buildNoSalesExcludedCountQuery({ ...base, noSalesFilter: true }).sql;
  ok(cnt.startsWith('SELECT COUNT(*) AS n') && cnt.endsWith('form_no_sales = 1') && !cnt.includes('ORDER BY'), 'promote: 除外件数SQL');
  // 偽プールで統計行
  const pool = { query: async (sql) => (sql.startsWith('SELECT COUNT') ? [[{ n: 7 }]] : [[]]) };
  const sel = await promote.selectRows(pool, { ...base, noSalesFilter: true }, null);
  eq(sel.stats.noSalesExcluded, 7, 'promote: 営業お断りで除外の件数');
  const lines = []; promote.printStats(sel.stats, (l) => lines.push(l));
  ok(lines.some((l) => l.startsWith('営業お断りで除外: 7')), 'promote: 統計行');

  // --no-sales-only(既存フォームの営業お断り確認)
  const ff = require('../cli/find-forms');
  const pa = ff.parseArgs(['--source', 'warehouse', '--prefecture', '兵庫県', '--no-sales-only', '--loop']);
  ok(pa.noSalesOnly && pa.loop && pa.prefecture === '兵庫県', 'no-sales-only: 引数');
  ok(!ff.parseArgs([]).noSalesOnly, 'no-sales-only: 既定はオフ');
  for (const bad of [['--source', 'warehouse', '--no-sales-only', '--size-only'], ['--source', 'warehouse', '--no-sales-only', '--with-size'], ['--no-sales-only']]) {
    let err = null; try { ff.parseArgs(bad); } catch (e) { err = e; }
    ok(err && /--no-sales-only/.test(err.message), 'no-sales-only: 排他/倉庫のみ ' + bad.join(' '));
  }
  const nq = ff.buildWarehouseNoSalesTargetQuery({ prefecture: '兵庫県', category: ['製造'], limit: 500, afterId: 120 });
  ok(/form_status = 'url_found'/.test(nq.sql) && nq.sql.includes('form_no_sales IS NULL') && nq.sql.includes("form_url <> ''") && nq.sql.includes('id > ?') && nq.sql.includes('category_main LIKE ?') && /ORDER BY id\s+LIMIT \?$/.test(nq.sql), 'no-sales-only: 対象SQLの形');
  eq(nq.params, [120, ['兵庫県'], '%製造%', 500], 'no-sales-only: パラメータ(afterId→都道府県→業種→limit)');
  eq(ff.buildWarehouseNoSalesTargetQuery({ limit: 5 }).params, [0, 5], 'no-sales-only: 既定は afterId=0');
  eq(ff.appendNoSalesNote(null), NOTE_NO_SALES, 'note: 空なら単独');
  eq(ff.appendNoSalesNote('外部フォームサービス'), '外部フォームサービス/' + NOTE_NO_SALES, 'note: 追記');
  eq(ff.appendNoSalesNote('x'.repeat(100)).length, 100, 'note: 100文字に収める');
  ok(ff.appendNoSalesNote('x'.repeat(100)).endsWith(NOTE_NO_SALES), 'note: 追記が切れない');
  eq(ff.appendNoSalesNote('a/' + NOTE_NO_SALES), 'a/' + NOTE_NO_SALES, 'note: 重複しない');
  const okRobots = async () => '';
  const mkNs = (res) => ({ fetchRobots: okRobots, fetchPage: async () => res });
  eq(await ff.checkNoSalesRow({ form_url: 'https://a.jp/contact' }, mkNs({ status: 200, body: '<p>営業目的のお問い合わせはお断りします</p>' })), { ok: true, noSales: true }, 'row: お断りあり');
  eq(await ff.checkNoSalesRow({ form_url: 'https://a.jp/contact' }, mkNs({ status: 200, body: '<p>営業時間 9:00-18:00</p>' })), { ok: true, noSales: false }, 'row: お断りなし');
  const e1 = await ff.checkNoSalesRow({ form_url: 'https://a.jp/contact' }, mkNs({ status: 404, body: 'x' }));
  ok(!e1.ok && e1.note, 'row: HTTPエラーはNULLのまま');
  const e2 = await ff.checkNoSalesRow({ form_url: 'https://a.jp/contact' }, { fetchRobots: okRobots, fetchPage: async () => { throw new Error('boom'); } });
  ok(!e2.ok, 'row: 取得例外はNULLのまま');
  let fetched = false;
  const e3 = await ff.checkNoSalesRow({ form_url: 'https://a.jp/contact' }, { fetchRobots: async () => 'User-agent: *\nDisallow: /contact', fetchPage: async () => { fetched = true; return { status: 200, body: '' }; } });
  ok(!e3.ok && !fetched, 'row: robots除外は取得しない');
  // 書き込み: お断りあり=1+note、なし=0のみ
  const execs = [];
  const nsw = ff.makeNoSalesWriter({ execute: async (sql, p) => { execs.push([sql, p]); } });
  await nsw({ id: 7, form_note: '自社' }, true);
  await nsw({ id: 8, form_note: '自社' }, false);
  ok(execs[0][0].includes('form_no_sales = ?, form_note = ?') && execs[0][0].includes('form_no_sales IS NULL'), 'writer: 1のときnote追記');
  eq(execs[0][1], [1, '自社/' + NOTE_NO_SALES, 7], 'writer: 値(1)');
  ok(!execs[1][0].includes('form_note') && execs[1][0].includes('form_no_sales IS NULL'), 'writer: 0のときnoteは触らない');
  eq(execs[1][1], [0, 8], 'writer: 値(0)');
  // 処理: 失敗はスキップ集計、全件処理
  const written = [];
  const st = await ff.processNoSales({
    rows: [{ id: 1, form_url: 'p' }, { id: 2, form_url: 'n' }, { id: 3, form_url: 'e' }],
    check: async (r) => (r.form_url === 'p' ? { ok: true, noSales: true } : r.form_url === 'n' ? { ok: true, noSales: false } : { ok: false, note: '取得に失敗しました' }),
    writer: async (r, res) => { written.push([r.id, res.ok]); }, concurrency: 2,
  });
  eq([st.done, st.noSales, st.clean, st.skipped, st.error], [3, 1, 1, 1, 0], 'processNoSales: 集計');
  eq(written.length, 3, 'processNoSales: 全件writerを通る');
  // CSV
  const hdr = ff.NO_SALES_CSV_COLUMNS.join(',');
  eq(hdr, 'store_id,店名,都道府県,問い合わせURL,営業お断り,備考', 'CSV: 見出し');
  eq(ff.noSalesCsvRow({ id: 1, name: 'A', prefecture: '兵庫県', form_url: 'https://a.jp/c' }, { ok: true, noSales: true }), '1,A,兵庫県,https://a.jp/c,あり,' + NOTE_NO_SALES + '\r\n', 'CSV: あり');
  eq(ff.noSalesCsvRow({ id: 2, name: 'B', prefecture: '兵庫県', form_url: 'https://b.jp/c' }, { ok: true, noSales: false }), '2,B,兵庫県,https://b.jp/c,なし,\r\n', 'CSV: なし');
  eq(ff.noSalesCsvRow({ id: 3, name: 'C', prefecture: '兵庫県', form_url: 'https://c.jp/c' }, { ok: false, note: 'robots.txtで除外' }), '3,C,兵庫県,https://c.jp/c,,robots.txtで除外\r\n', 'CSV: 取得不可');


  // ---- グループ分け(送信ツールが全社同一本文のため) ----
  eq(G.GROUP_ORDER, ['no_https', 'mixed', 'https_redirect', 'cert_expired', 'cert_soon', 'js_libs', 'cms', 'headers', 'tls_version'], 'グループ優先順');
  eq(G.groupKeyOfFinding('cert_expiring'), 'cert_soon', '証明書期限間近は cert_soon');
  eq(G.groupKeyOfFinding('cert_expired'), 'cert_expired', '期限切れ');
  eq(G.groupKeyOfFinding('no_https'), 'no_https', 'no_https');
  eq(G.groupKeyOfFinding('https_redirect'), 'https_redirect', 'https_redirect');
  eq(G.groupKeyOfFinding('unknown'), '', 'unknown はグループ無し');
  eq(G.batchCode('no_https', new Date('2026-10-25T03:00:00Z')), 'WD-NO-HTTPS-20261025', 'バッチコード no_https');
  {
    const mkr = (id, type) => ({ store_id: id, 店名: 'S' + id, URL: `https://s${id}.jp/`, 問い合わせURL: `https://s${id}.jp/c`, 画像認証: '', 指摘種別: type, 送信推奨: type ? 'はい' : 'いいえ' });
    const gg = G.groupRows([mkr(1, 'no_https'), mkr(2, 'https_redirect'), mkr(3, ''), mkr(4, 'unknown')]);
    eq(gg.groups.map((g) => g.key + ':' + g.rows.length), ['no_https:1', 'https_redirect:1'], 'no_https と https_redirect は別グループ(unknownは入らない)');
    const nb = G.renderGroupBodies(T, 'no_https', new Date('2026-10-25T03:00:00Z'));
    ok(nb.body.includes('サイト全体が暗号化(https)に対応していない状態'), 'no_https 本文の指摘');
    ok(nb.body.includes('暗号化されないまま送られる場合がある'), 'no_https 本文の困ること');
  }
  eq(G.groupKeyOfFinding(''), '', '空は無し');
  eq(G.jstMonthJa(new Date('2026-10-25T03:00:00Z')), '2026年10月', '確認月');
  eq(G.jstMonthJa(new Date('2026-12-31T16:00:00Z')), '2027年1月', '確認月(JST繰り上がり)');
  const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2b-group-'));
  try {
    const gout = path.join(gdir, 'out.csv');
    const gscan = async (url) => {
      if (url.includes('mix')) return { results: mk({ mixed: 'bad', js_libs: 'warn' }), score: 40, grade: 'D' };
      if (url.includes('exp')) return { results: mk({ cert: 'bad' }, { cert: '(残り-3日)' }), score: 40, grade: 'D' };
      if (url.includes('soon')) return { results: mk({ cert: 'warn' }, { cert: '(残り10日)' }), score: 60, grade: 'C' };
      if (url.includes('cms')) return { results: mk({ cms: 'warn' }), score: 60, grade: 'C' };
      if (url.includes('none')) return { results: mk({ mail: 'bad' }), score: 60, grade: 'C' };
      if (url.includes('fail')) throw Object.assign(new Error('x'), { userSafe: true });
      return { results: mk(), score: 100, grade: 'A' };
    };
    const grows = [
      ['1', '甲建設', 'mix1.jp'], ['2', '乙工業', 'mix2.jp'], ['3', '丙製作所', 'exp1.jp'], ['4', '丁建設', 'soon1.jp'], ['5', '戊工務店', 'cms1.jp'],
      ['6', '己機械', 'none1.jp'], ['7', '庚金属', 'fail1.jp'], ['8', '辛工場', 'none2.jp'],
    ].map(([id, name, d]) => ({ store_id: id, name, url: 'https://' + d, prefecture: '兵庫県', category: '建設会社', formUrl: 'https://' + d + '/c', captcha: 'なし', noSales: '', phone: '079-000-000' + id, address: '兵庫県姫路市テスト' + id }));
    await runBatch({ rows: grows, scan: gscan, out: gout, templates: T, templateMode: 'b2b', log: () => {} });
    const recs = (() => { const t = parseDelimited(fs.readFileSync(gout, 'utf8'), ','); return t.slice(1).map((r) => Object.fromEntries(t[0].map((h, i) => [h, r[i] || '']))); })();
    const gg = G.groupRows(recs);
    eq(gg.groups.map((x) => [x.key, x.rows.length]), [['mixed', 2], ['cert_expired', 1], ['cert_soon', 1], ['cms', 1]], '1社1グループ・優先順・証明書は2分割(mixedとjs_libs併発はmixedのみ)');
    eq(gg.groups.reduce((a, x) => a + x.rows.length, 0), 5, '合計=送信推奨の数');
    eq(gg.excluded, { '初回に使える指摘なし': 2, '診断できず': 1 }, '除外理由の集計');
    eq(gg.excludedTotal, 3, '除外合計');
    ok(gg.groups.every((x) => x.rows.every((r) => r['送信推奨'] === 'はい')), 'グループは送信推奨=はいのみ');

    const gtime = new Date('2026-10-25T03:00:00Z');
    const gd = path.join(gdir, 'groups');
    fs.mkdirSync(gd);
    fs.writeFileSync(path.join(gd, 'group_mixed_99件.csv'), 'old'); // 古いファイルは消える
    const w = G.writeGroupFiles(gd, recs, T, gtime);
    eq(fs.readdirSync(gd).sort(), [...w.files].sort(), '古いファイルは消え、出力だけが残る');
    eq(w.files.filter((n) => n.endsWith('.csv')).sort(), ['group_cert_expired_1件.csv', 'group_cert_expired_1件_確認用.csv', 'group_cert_soon_1件.csv', 'group_cert_soon_1件_確認用.csv', 'group_cms_1件.csv', 'group_cms_1件_確認用.csv', 'group_mixed_2件.csv', 'group_mixed_2件_確認用.csv'], 'CSVのファイル名(確認用つき)');
    ok(w.files.includes('group_mixed_本文.txt') && w.files.includes('group_mixed_本文_短縮.txt') && w.files.includes('group_mixed_件名.txt') && w.files.includes('まとめ.txt'), 'txtのファイル名');
    const adminRe = /^group_[a-z_]+_(\d+件(?:_確認用)?\.csv|本文\.txt|本文_短縮\.txt|件名\.txt)$/;
    ok(w.files.every((n) => adminRe.test(n) || n === 'まとめ.txt'), '全ファイル名が管理画面の許可パターンに合う');
    const csvText = fs.readFileSync(path.join(gd, 'group_mixed_2件.csv'), 'utf8');
    const csvLines = csvText.split('\r\n');
    eq(csvLines[0], '﻿送信先URL,会社名,,レポートURL,業種,評価・口コミ,STOCバッチコード,電話番号,住所', '送信用CSV: BOM付きUTF-8・ヘッダー行が完全一致');
    eq(csvLines[1], 'https://mix1.jp/c,甲建設,,mix1.jp,建設会社,,WD-MIXED-20261025,079-000-0001,兵庫県姫路市テスト1', '送信用CSV: 列順(URL,会社名,空,ドメイン,業種,空,バッチコード,電話,住所)');
    ok(csvLines[2].startsWith('https://mix2.jp/c,乙工業,,mix2.jp,') && csvLines.every((l) => l === '' || parseDelimited(l, ',')[0].length === 9), '送信用CSV: 全行9列');
    ok(csvLines[1].split(',')[6] === G.batchCode('mixed', gtime) && G.batchCode('cert_expired', gtime) === 'WD-CERT-EXPIRED-20261025' && /^WD-[A-Z0-9-]+-\d{8}$/.test(G.batchCode('cert_soon', gtime)), 'バッチコード形式');
    const chk = fs.readFileSync(path.join(gd, 'group_mixed_2件_確認用.csv'), 'utf8');
    ok(chk.startsWith('﻿store_id,会社名,ドメイン,都道府県,業種区分,URL,問い合わせURL,画像認証,電話番号,住所\r\n'), '確認用CSV: 列');
    ok(chk.includes('1,甲建設,mix1.jp,兵庫県,建設,https://mix1.jp,https://mix1.jp/c,なし,079-000-0001,兵庫県姫路市テスト1') && chk.includes('2,乙工業'), '確認用CSV: 行(電話・住所つき)');
    ok(adminRe.test('group_mixed_2件_確認用.csv') && !adminRe.test('group_mixed_2件_確認用.txt') && !adminRe.test('group_Mixed_2件_確認用.csv'), '管理画面の許可パターン: 確認用.csv');
    for (const n of w.files.filter((x) => x.endsWith('.txt') && x !== 'まとめ.txt')) {
      const txt = fs.readFileSync(path.join(gd, n), 'utf8');
      ok(!/[{}]/.test(txt), '{}のプレースホルダー残りなし(タグは[company]/[param1]): ' + n);
      ok(!/甲建設|乙工業|丙製作所|丁建設|戊工務店|mix1|exp1|soon1|cms1/.test(txt), '会社固有の文言なし: ' + n);
    }
    const mixedBody = fs.readFileSync(path.join(gd, 'group_mixed_本文.txt'), 'utf8');
    const mixedShort = fs.readFileSync(path.join(gd, 'group_mixed_本文_短縮.txt'), 'utf8');
    ok(mixedBody.includes('2026年10月に御社サイト「[param1]」を確認したところ、ページの一部(画像や部品など)が暗号化されない通信で読み込まれている状態を確認しました。'), '標準本文: 確認月と指摘');
    ok(mixedBody.includes('morisawa@stoc.co.jp 宛に') && mixedBody.includes('TEL:0120-830-046/兵庫県姫路市北条梅原町229'), '標準本文: 返信先・署名');
    ok([...mixedShort].length < [...mixedBody].length, '短縮は標準より短い');
    ok(mixedShort.includes('2026年10月に御社サイト「[param1]」を外部から確認したところ'), '短縮本文: 確認月');
    ok(mixedBody.startsWith('[company] ご担当者様\n') && mixedShort.startsWith('[company] ご担当者様\n'), '本文: 先頭に会社名タグ[company]');
    ok(!mixedBody.includes('御社名') && mixedBody.includes('「レポート希望」とお送りください。') && mixedShort.includes('ご希望の場合は「レポート希望」とご返信ください。'), '御社名を添える文言は無い');
    ok(fs.readFileSync(path.join(gd, 'group_cert_soon_本文.txt'), 'utf8').includes('有効期限が近づいている'), 'cert_soon は期限間近の文言');
    ok(fs.readFileSync(path.join(gd, 'group_cert_expired_本文.txt'), 'utf8').includes('有効期限が切れている'), 'cert_expired は期限切れの文言');
    const subj = fs.readFileSync(path.join(gd, 'group_mixed_件名.txt'), 'utf8').trim().split('\n');
    eq(subj.length, 3, '件名は3候補');
    ok(subj[1] === '2. 「[param1]」の設定確認に関するご連絡' && !/mix1|exp1|soon1|cms1/.test(subj.join('')), '件名2はドメインタグ・実ドメインなし');
    // 独自の差し込みタグ(引数 --merge-tags 相当)
    const gd3 = path.join(gdir, 'custom');
    G.writeGroupFiles(gd3, recs, T, gtime, { 会社名: '%company%', ドメイン: '%domain%' });
    const cb = fs.readFileSync(path.join(gd3, 'group_mixed_本文.txt'), 'utf8');
    ok(cb.startsWith('%company% ご担当者様') && cb.includes('「%domain%」') && !/[{}]/.test(cb), '独自タグが本文に入る');
    ok(fs.readFileSync(path.join(gd3, 'group_mixed_件名.txt'), 'utf8').includes('「%domain%」の設定確認'), '独自タグが件名に入る');
    // www. は除く・スキーム無しも可
    eq([G.domainOfUrl('https://www.Example.co.jp/a?b'), G.domainOfUrl('foo.jp/x'), G.domainOfUrl(''), G.domainOfUrl('https://www2.x.jp')], ['example.co.jp', 'foo.jp', '', 'www2.x.jp'], 'ドメイン抽出');
    const gd4 = path.join(gdir, 'www');
    G.writeGroupFiles(gd4, [{ store_id: '9', 店名: 'W社', 都道府県: '', 業種区分: '', URL: 'https://www.wtest.jp/', 問い合わせURL: 'https://www.wtest.jp/c', 画像認証: '', 指摘種別: 'cms', 送信推奨: 'はい' }], T, gtime);
    ok(fs.readFileSync(path.join(gd4, 'group_cms_1件.csv'), 'utf8').includes('https://www.wtest.jp/c,W社,,wtest.jp,'), 'CSVのドメインはwww除去');
    // 送信先URLなし・画像認証ありはグループに入れない
    const base = { 都道府県: '', 業種区分: '', 業種: '建設会社', 指摘種別: 'cms', 送信推奨: 'はい', 画像認証: 'なし' };
    const exRows = [
      { ...base, store_id: '1', 店名: 'OK社', URL: 'https://ok.jp', 問い合わせURL: 'https://ok.jp/c' },
      { ...base, store_id: '2', 店名: 'URLなし社', URL: 'https://nu.jp', 問い合わせURL: '' },
      { ...base, store_id: '3', 店名: 'CAPTCHA社', URL: 'https://cp.jp', 問い合わせURL: 'https://cp.jp/c', 画像認証: 'あり' },
    ];
    const ge = G.groupRows(exRows);
    eq(ge.groups.map((x) => [x.key, x.rows.length]), [['cms', 1]], '除外: OKのみグループ入り');
    eq(ge.excluded, { '送信先URLなし': 1, '画像認証あり': 1 }, '除外: 理由の集計');
    const gd5 = path.join(gdir, 'excl');
    G.writeGroupFiles(gd5, exRows, T, gtime);
    const sum5 = fs.readFileSync(path.join(gd5, 'まとめ.txt'), 'utf8');
    ok(sum5.includes('送信先URLなし: 1社') && sum5.includes('画像認証あり: 1社') && sum5.includes('送らない: 2社'), 'まとめ: 送信先URLなし・画像認証あり');
    const t5 = fs.readFileSync(path.join(gd5, 'group_cms_1件.csv'), 'utf8') + fs.readFileSync(path.join(gd5, 'group_cms_1件_確認用.csv'), 'utf8');
    ok(t5.includes('OK社') && !t5.includes('URLなし社') && !t5.includes('CAPTCHA社'), '除外した会社はCSVに出ない');
    const sum = fs.readFileSync(path.join(gd, 'まとめ.txt'), 'utf8');
    ok(sum.indexOf('mixed(') < sum.indexOf('cert_expired(') && sum.indexOf('cert_expired(') < sum.indexOf('cert_soon(') && sum.indexOf('cert_soon(') < sum.indexOf('cms('), 'まとめ: 優先順');
    ok(sum.includes('mixed(混在コンテンツ) / 2社 / ' + [...mixedBody.replace(/\n$/, '')].length + '文字 / ' + [...mixedShort.replace(/\n$/, '')].length + '文字'), 'まとめ: 件数と文字数');
    ok(sum.includes('初回に使える指摘なし: 2社') && sum.includes('診断できず: 1社') && sum.includes('送らない: 3社'), 'まとめ: 除外理由');
    ok(sum.includes('1グループ=1回の送信。本文はグループごとに違います。最初の100社は送る前に人が確認してください。'), 'まとめ: 注意書き');
    // 全社0件でもまとめは出る
    const gd2 = path.join(gdir, 'empty');
    const w2 = G.writeGroupFiles(gd2, [], T, gtime);
    eq(w2.files, ['まとめ.txt'], '0件ならまとめのみ');
  } finally { fs.rmSync(gdir, { recursive: true, force: true }); }
  // 引数: --group-out
  eq(parseArgs(['--template', 'b2b', '--group-out', '/x/g']).groupOut, '/x/g', '--group-out を読む');
  eq(parseArgs(['--merge-tags', '{"a":"b"}']).mergeTags, '{"a":"b"}', '--merge-tags を読む');
  eq(parseArgs(['--template', 'b2b']).groupOut, undefined, '--group-out 省略');
  console.log(`b2b: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
