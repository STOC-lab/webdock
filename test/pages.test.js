'use strict';
// 御社専用ページ(/r/<token>)のテスト。DB不要(偽の接続を使う)。warehouse.db.test.js は動かさない
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const C = require('../src/pageCore');
const P = require('../src/pages');
const S = require('../src/stocBatch');
const O = require('../src/outreachSingle');
const EX = require('../src/exclusions');
const { registerPages, validateLead } = require('../src/pageRoutes');
const { registerAdminWarehouse, buildB2bScanArgs } = require('../src/adminWarehouse');
const { loadTemplates } = require('../src/outreach');
const { parseArgs, parseDelimited, loadResultsByStore } = require('../cli/batch-scan');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);
const T = loadTemplates();
const ENV = { WH_DB_USER: 'stoc_wh', WH_DB_HOST: '127.0.0.1' };
const SECRET = 'test-secret';

/** 偽の接続。発行されたSQLを記録する。handlers: [[正規表現, (sql,params)=>結果 or 例外]] を先に当てる */
function fakePool({ handlers = [], pages = {} } = {}) {
  const log = [];
  const base = (sql, params) => {
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(sql, params);
    if (/FROM stoc_master\.webdock_pages WHERE token = \?/.test(sql)) return [pages[params[0]] ? [pages[params[0]]] : []];
    if (/FROM \S*\.store_reports WHERE store_id/.test(sql)) return [[]];
    if (/^INSERT INTO \S*\.store_reports/.test(sql)) return [{ insertId: 5 }];
    if (/^INSERT INTO \S*\.store_report_views/.test(sql)) return [{ insertId: 900 }];
    if (/FROM \S*\.stores WHERE id/.test(sql)) return [[{ status: '未対応' }]];
    return [{ affectedRows: 1 }];
  };
  const q = async (sql, params, op) => { log.push({ op, sql: String(sql).replace(/\s+/g, ' ').trim(), params }); return base(String(sql).replace(/\s+/g, ' ').trim(), params); };
  const conn = {
    async beginTransaction() { log.push({ op: 'begin' }); }, async commit() { log.push({ op: 'commit' }); }, async rollback() { log.push({ op: 'rollback' }); },
    release() { log.push({ op: 'release' }); }, query: (s, p) => q(s, p, 'conn'),
  };
  return { log, query: (s, p) => q(s, p, 'pool'), async getConnection() { return conn; } };
}
const sqls = (pool, re) => pool.log.filter((l) => l.sql && re.test(l.sql));

const PAGE = (o = {}) => ({
  id: 11, token: 'AbCdEfGh12', shop_id: 321, stoc_store_id: 4567, stoc_batch_code: 'sender_20261026_100000_abcd', domain: 'example-seisakusho.co.jp',
  company_name: '株式会社サンプル製作所', finding_key: 'no_https',
  finding_sentence: '御社サイト(example-seisakusho.co.jp)を確認したところ、サイト全体が暗号化(https)に対応していない状態でした。',
  findings_json: JSON.stringify([
    { key: 'https_redirect', title: 'HTTPSへの自動転送', status: 'bad', summary: 'サイトがHTTPSになっていません', remedy: 'site' },
    { key: 'headers', title: 'セキュリティ用ヘッダー設定', status: 'warn', summary: '防御ヘッダーが一部未設定(2件)', remedy: 'site' },
    { key: 'mail', title: 'メールのなりすまし対策(SPF/DMARC)', status: 'ok', summary: 'なりすましメール対策が設定されています', remedy: 'dns' },
    { key: 'cookies', title: 'Cookie(クッキー)の保護設定', status: 'ok', summary: 'ok', remedy: 'site' },
    { key: 'cms', title: 'CMS', status: 'unknown', summary: '不明', remedy: 'site' },
  ]),
  audience: '取引先様・調達ご担当者様・求職者様', created_at: new Date('2026-10-26T01:00:00Z'), view_count: 0, lead_at: null, lead_stoc_at: null, opt_out_at: null, ...o,
});

async function boot({ pages = { AbCdEfGh12: PAGE() }, pool, handlers, limits, nowRef = { t: Date.parse('2026-10-26T03:00:00Z') }, notifyLog = [] } = {}) {
  const fp = pool || fakePool({ pages, handlers });
  const store = P.createPageStore(fp, { env: ENV, now: () => new Date(nowRef.t), log: () => {} });
  const app = express();
  registerPages(app, {
    store, secret: SECRET, now: () => nowRef.t, limits, env: { PUBLIC_BASE_URL: 'https://webdock.test' },
    notify: async (i) => { notifyLog.push(i); }, getIp: (req) => req.headers['x-test-ip'] || '203.0.113.9',
    sender: { company: '株式会社エストック', name: '森澤 梓', tel: '0120-830-046', mail: 'morisawa@stoc.co.jp' },
  });
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const port = server.address().port;
  const req = (p, o = {}) => fetch(`http://127.0.0.1:${port}${p}`, { redirect: 'manual', ...o, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', ...(o.headers || {}) } });
  return { server, fp, req, nowRef, notifyLog, store };
}
const URLENC = { 'Content-Type': 'application/x-www-form-urlencoded' };
const form = (o) => new URLSearchParams(o).toString();
const attr = (html, name) => { const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html); return m && m[1]; };

(async () => {
  /* ---------- トークン ---------- */
  const seen = new Set();
  let allOk = true;
  for (let i = 0; i < 2000; i++) { const t = C.newToken(); seen.add(t); if (!C.TOKEN_RE.test(t) || t.length !== 10) allOk = false; }
  ok(allOk, 'トークン: 10文字の英数字');
  eq(seen.size, 2000, 'トークン: 重複なし');
  // 偏りの除去: 248以上のバイトは捨てる(0..247 → 62で割った余り)
  eq(C.newToken(() => Buffer.from([255, 254, 248, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), '0123456789', 'トークン: 248以上は使わない');
  eq(C.newToken(() => Buffer.from([61, 62, 123, 124, 247, 246, 245, 244, 243, 242, 241, 240, 239, 238, 237, 236])), 'z0z0zyxwvu', 'トークン: 62での剰余');
  ok(C.isToken('AbCdEfGh12') && C.isToken('0000000000'), '正規表現: 正しい形');
  for (const bad of ['', 'abc', 'AbCdEfGh1', 'AbCdEfGh123', 'AbCdEfGh1_', 'AbCdEfGh1-', 'AbCdEfGh1 ', '../etc/pw', 'AbCdEfGh1%', 'ＡbCdEfGh12', 'AbCdEfGh12\n', null, undefined, 12345678901]) ok(!C.isToken(bad), '正規表現: 不正 ' + JSON.stringify(bad));
  eq(C.pageUrl('AbCdEfGh12', {}), 'https://webdock.stoc-plus.site/r/AbCdEfGh12', 'URL: 既定の基点');
  eq(C.pageUrl('AbCdEfGh12', { PUBLIC_BASE_URL: 'https://x.example/' }), 'https://x.example/r/AbCdEfGh12', 'URL: PUBLIC_BASE_URL(末尾の/は除く)');

  /* ---------- 署名 ---------- */
  const t0 = 1_800_000_000_000;
  const ft = C.makeFormToken(SECRET, 'request', 'AbCdEfGh12', t0);
  eq(C.verifyFormToken(SECRET, 'request', 'AbCdEfGh12', ft, t0 + 1000), { ok: true }, '署名: 正しい');
  eq(C.verifyFormToken(SECRET, 'request', 'AbCdEfGh12', ft, t0 + 23 * 3600e3).ok, true, '署名: 23時間後も有効');
  eq(C.verifyFormToken(SECRET, 'request', 'AbCdEfGh12', ft, t0 + 25 * 3600e3), { ok: false, reason: 'expired' }, '署名: 1日を過ぎると無効');
  eq(C.verifyFormToken(SECRET, 'request', 'AbCdEfGh12', ft, t0 - 3600e3).reason, 'future', '署名: 未来の時刻は無効');
  eq(C.verifyFormToken(SECRET, 'request', 'ZzCdEfGh12', ft, t0).reason, 'sig', '署名: 別のページのトークンでは無効');
  eq(C.verifyFormToken(SECRET, 'optout', 'AbCdEfGh12', ft, t0).reason, 'sig', '署名: 用途が違うと無効');
  eq(C.verifyFormToken('other', 'request', 'AbCdEfGh12', ft, t0).reason, 'sig', '署名: 秘密が違うと無効');
  eq(C.verifyFormToken(SECRET, 'request', 'AbCdEfGh12', ft.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')), t0).reason, 'sig', '署名: 改ざんは無効');
  eq(C.verifyFormToken(SECRET, 'request', 'AbCdEfGh12', ft.replace(/^\d+/, String(t0 + 999999)), t0 + 999999).reason, 'sig', '署名: 時刻の書き換えは無効');
  for (const bad of ['', 'x', undefined, null, '123.abc']) eq(C.verifyFormToken(SECRET, 'request', 'AbCdEfGh12', bad, t0).reason, 'format', '署名: 形式不正 ' + JSON.stringify(bad));
  const vt = C.makeViewToken(SECRET, 'AbCdEfGh12', 900);
  eq(C.verifyViewToken(SECRET, 'AbCdEfGh12', vt), 900, '閲覧署名: 正しい');
  eq(C.verifyViewToken(SECRET, 'AbCdEfGh12', C.makeViewToken(SECRET, 'AbCdEfGh12', 0)), 0, '閲覧署名: 0(STOC側の行なし)');
  eq(C.verifyViewToken(SECRET, 'AbCdEfGh12', vt.replace(/^900/, '901')), null, '閲覧署名: IDの書き換えは無効');
  eq(C.verifyViewToken(SECRET, 'ZzCdEfGh12', vt), null, '閲覧署名: 別ページでは無効');

  /* ---------- アクセス元の種類 ---------- */
  eq(C.classifyUa('Mozilla/5.0 (Windows NT 10.0) Chrome/130'), 'human', 'UA: ブラウザ');
  for (const ua of ['Googlebot/2.1', 'Mozilla/5.0 (compatible; bingbot/2.0)', 'facebookexternalhit/1.1', 'Slackbot-LinkExpanding', 'curl/8', 'python-requests/2', 'Mozilla/5.0 HeadlessChrome', 'Outlook-Preview', 'SomeCrawler', 'MySpider', 'WebPreview', '', undefined]) eq(C.classifyUa(ua), 'bot', 'UA: bot ' + JSON.stringify(ua));
  eq(C.classifyUa('Mozilla/5.0 Chrome/130', 'HEAD'), 'bot', 'HEADは数えない');

  /* ---------- 移行006 ---------- */
  const mig = fs.readFileSync(path.join(__dirname, '..', 'sql', 'warehouse_migrate_006.sql'), 'utf8');
  ok(/CREATE TABLE IF NOT EXISTS stoc_master\.webdock_pages/.test(mig), '移行006: 表を IF NOT EXISTS で作る');
  for (const c of ['id', 'token', 'shop_id', 'stoc_store_id', 'stoc_batch_code', 'domain', 'company_name', 'finding_key', 'finding_sentence', 'findings_json', 'audience', 'created_at', 'first_viewed_at', 'last_viewed_at', 'view_count', 'lead_at']) {
    ok(new RegExp(`^  ${c} `, 'm').test(mig), '移行006: 列 ' + c);
  }
  ok(/token CHAR\(10\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL/.test(mig), '移行006: tokenは大文字小文字を区別');
  ok(/UNIQUE KEY uq_token \(token\)/.test(mig), '移行006: tokenはUNIQUE');
  ok(/view_count INT NOT NULL DEFAULT 0/.test(mig), '移行006: view_count 既定0');
  // PREPARE する文字列の中の引用符は2重にする(文字列の中の ' が単独で残らない)
  const preps = [...mig.matchAll(/IF\(COUNT\(\*\) = 0, '((?:[^']|'')*)', 'SELECT 1'\)/g)];
  ok(preps.length >= 6, '移行006: 列の補いが6本以上 (' + preps.length + ')');
  for (const m of preps) ok(!/'/.test(m[1].replace(/''/g, '')), '移行006: PREPARE文字列の引用符は2重: ' + m[1].slice(0, 60));
  ok(preps.every((m) => /COMMENT ''/.test(m[1])), '移行006: COMMENT は2重の引用符');
  eq((mig.match(/PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;/g) || []).length, preps.length, '移行006: PREPAREの数が文の数と同じ');
  ok(!/DROP |TRUNCATE|DELETE FROM/i.test(mig), '移行006: 破壊的な文なし');
  // 何度実行しても同じ: CREATEは IF NOT EXISTS、ALTERは information_schema で列の有無を見る
  ok(preps.every((m) => /ADD COLUMN/.test(m[1])), '移行006: ALTERは列追加のみ');
  ok((mig.match(/information_schema\.COLUMNS/g) || []).length === preps.length, '移行006: 補いは列の有無を確認');

  /* ---------- 一文の前置・CSV・本文 ---------- */
  eq(O.pageSentence('確認したところ、サイト全体が…でした。', 'a.co.jp'), '御社サイト(a.co.jp)を確認したところ、サイト全体が…でした。', '一文: 御社サイト(ドメイン)を前置');
  eq(O.pageSentence('その他の文です。', 'a.co.jp'), '御社サイト(a.co.jp)について、その他の文です。', '一文: 書き出しが違う場合');
  eq(O.pageSentence('確認したところ、x', ''), '確認したところ、x', '一文: ドメインなしならそのまま');
  const fb = T.findingsB2b;
  ok(Object.values(fb).every((f) => f['一文'].startsWith('確認したところ、')), '一文: 既存の全文が「確認したところ、」で始まる');

  const body = O.renderBody(T, { withPage: true });
  ok(!/\{[^}]*\}/.test(body), '本文(専用ページ版): 未展開の{}なし');
  for (const tag of ['[company]', '[name]', '[param1]', '[param2]']) ok(body.includes(tag), '本文(専用ページ版): ' + tag);
  ok(body.includes('株式会社エストックの森澤と申します') && body.includes('TEL:0120-830-046/兵庫県姫路市北条梅原町229') && body.trim().endsWith('株式会社エストック 森澤 梓\nTEL:0120-830-046/兵庫県姫路市北条梅原町229'), '本文(専用ページ版): 差出人は設定から');
  ok(body.includes('▼御社サイトの確認結果(御社専用ページ)\n[param1]\n'), '本文(専用ページ版): [param1] は独立した行');
  ok(!body.includes('「[param1]」'), '本文(専用ページ版): ドメインの括弧書きはなくなる');
  ok(O.renderBody(T).includes('御社サイト「[param1]」'), '本文(従来版)は変わらない');
  const mkItem = (sentence, aud = '取引先様・調達ご担当者様・求職者様') => ({ sentence, audience: aud });
  const longest = O.pageSentence(fb.no_https['一文'], 'example-seisakusho.co.jp');
  const bl = O.bodyLengths(body, [mkItem(longest)], { withPage: true });
  ok(bl.typical > 250 && bl.longest < 700, `本文の文字数(専用ページ版): 最長 ${bl.longest}字`);
  ok(/注意: 最長の場合 500文字を超えます/.test(O.summaryText({ batches: [], items: [{ key: 'no_https', sentence: longest, audience: '取引先様・調達ご担当者様・求職者様' }], excluded: {}, body, dryRun: false, now: new Date(), scanned: 1, withPage: true })) === (bl.longest > 500), '本文が500字を超えるときだけ、まとめに注意が出る');
  const longestAll = Math.max(...Object.values(fb).map((f) => O.bodyLengths(body, [mkItem(O.pageSentence(f['一文'], 'very-long-domain-name-example.co.jp'))], { withPage: true }).longest));
  console.log(`  (本文の最長: ${longestAll}字)`);

  // buildSingleFiles
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pagetest-'));
  const store = (id, o = {}) => ({ id, name: `会社${id}`, status: '未対応', phone: '0791234567', phone_mobile: '', phone_free: '', address: `兵庫県姫路市${id}`, prefecture: '兵庫県', category: '製造', website_url: `https://s${id}.example.co.jp/`, gbp_url: null, gbp_rating: null, gbp_review_count: null, score: null, ...o });
  const row = (n, o = {}) => ({ store_id: String(1000 + n), stoc_store_id: String(n), 店名: `会社${n}`, URL: `https://www.s${n}.example.co.jp/`, 業種: '製造', 業種区分: '製造', 問い合わせURL: `https://s${n}.example.co.jp/contact`, 画像認証: 'なし', 営業お断り: '', 指摘種別: 'no_https', 送信推奨: 'はい', ...o });
  const rows = [row(1), row(2, { 指摘種別: 'cms' }), row(3, { 送信推奨: 'いいえ' })];
  const registered = [];
  const created = [];
  const removed = [];
  const stoc = { fetchStores: async (ids) => new Map(ids.map((i) => [i, store(i)])), register: async (o) => { registered.push(o); return { code: o.code }; } };
  const pagesApi = { create: async (list) => { created.push(list); return list.map((r, i) => `Tok${String(i).padStart(7, '0')}`); }, remove: async (t) => { removed.push(t); } };
  const resultsByStore = new Map([['1001', [{ key: 'https_redirect', title: 'HTTPS', status: 'bad', summary: 's', remedy: 'site' }]]]);
  const d1 = path.join(tmp, 'a');
  const res = await O.buildSingleFiles({ rows, outDir: d1, templates: T, now: new Date('2026-10-25T21:30:05Z'), stoc, withPage: true, pages: pagesApi, resultsByStore, env: { PUBLIC_BASE_URL: 'https://webdock.test' } });
  eq(res.items.length, 2, '専用ページ版: 送信対象2社');
  const csv = parseDelimited(fs.readFileSync(path.join(d1, res.batches[0].file), 'utf8').replace(/^﻿/, ''), ',');
  eq(csv[1][3], 'https://webdock.test/r/Tok0000000', 'CSV4列目: 専用ページのURL');
  eq(csv[2][3], 'https://webdock.test/r/Tok0000001', 'CSV4列目: 2社目');
  eq(csv[1][2], '御社サイト(s1.example.co.jp)を' + fb.no_https['一文'], 'CSV3列目: 御社サイト(ドメイン)を確認したところ、…');
  ok(csv[2][2].startsWith('御社サイト(s2.example.co.jp)を確認したところ、'), 'CSV3列目: 2社目も前置');
  eq(csv[1].length, 9, 'CSV: 9列のまま');
  eq(csv[1][6], res.batches[0].code, 'CSV7列目: バッチコード');
  eq(registered[0].items.map((i) => i.reportUrl), ['https://webdock.test/r/Tok0000000', 'https://webdock.test/r/Tok0000001'], 'STOC明細 report_url = ページのURL');
  eq(registered[0].filter.with_page, true, 'STOCバッチのfilterに with_page');
  eq(created.length, 1, 'ページ作成は1バッチ1回');
  eq(created[0].map((r) => [r.shopId, r.stocStoreId, r.batchCode, r.domain, r.company, r.findingKey]), [['1001', 1, res.batches[0].code, 's1.example.co.jp', '会社1', 'no_https'], ['1002', 2, res.batches[0].code, 's2.example.co.jp', '会社2', 'cms']], 'ページ行: 店・バッチ・ドメイン・指摘');
  ok(created[0][0].sentence.startsWith('御社サイト(s1.example.co.jp)を確認したところ、'), 'ページ行: 一文');
  eq(created[0][0].findings, resultsByStore.get('1001'), 'ページ行: 診断項目');
  eq(created[0][1].findings, undefined, 'ページ行: 診断記録がない店は項目なし');
  const bodyTxt = fs.readFileSync(path.join(d1, '本文.txt'), 'utf8');
  ok(bodyTxt.includes('[param1]') && bodyTxt.includes('御社専用ページ'), '本文.txt: 専用ページ版');
  const check = fs.readFileSync(path.join(d1, '確認用.csv'), 'utf8');
  ok(check.split('\n')[0].includes('専用ページURL') && check.includes('https://webdock.test/r/Tok0000000'), '確認用.csv: 専用ページURLの列');
  const summary = fs.readFileSync(path.join(d1, 'まとめ.txt'), 'utf8');
  ok(summary.includes('御社専用ページ版') && summary.includes('4列目'), 'まとめ: 専用ページ版の説明');
  eq(JSON.parse(fs.readFileSync(path.join(d1, 'result.json'), 'utf8')).withPage, true, 'result.json: withPage');
  eq(removed.length, 0, '成功時はページを消さない');

  // 試し(--dry-run-stoc): ページは作らない・STOCにも登録しない・URLは仮
  const created0 = created.length;
  const d2 = path.join(tmp, 'b');
  const dry = await O.buildSingleFiles({ rows, outDir: d2, templates: T, now: new Date(), stoc, dryRun: true, withPage: true, pages: null });
  eq(created.length, created0, '試し: ページを作らない');
  ok(/^https:\/\/webdock\.stoc-plus\.site\/r\/[0-9A-Za-z]{10}$/.test(parseDelimited(fs.readFileSync(path.join(d2, dry.batches[0].file), 'utf8').replace(/^﻿/, ''), ',')[1][3]), '試し: 仮のURL');
  ok(fs.readFileSync(path.join(d2, 'まとめ.txt'), 'utf8').includes('ページは作っていません'), '試し: まとめに明記');

  // STOC登録に失敗したら、作ったページを消す
  const d3 = path.join(tmp, 'c');
  const stocFail = { ...stoc, register: async () => { throw new Error('登録失敗'); } };
  let thrown = null;
  try { await O.buildSingleFiles({ rows, outDir: d3, templates: T, now: new Date(), stoc: stocFail, withPage: true, pages: pagesApi }); } catch (e) { thrown = e; }
  ok(thrown && /登録失敗/.test(thrown.message), '登録失敗は例外');
  eq(removed[0], ['Tok0000000', 'Tok0000001'], '登録失敗: 作ったページを削除');
  // 従来方式は変わらない
  const d4 = path.join(tmp, 'd');
  const plain = await O.buildSingleFiles({ rows, outDir: d4, templates: T, now: new Date(), stoc });
  const pcsv = parseDelimited(fs.readFileSync(path.join(d4, plain.batches[0].file), 'utf8').replace(/^﻿/, ''), ',');
  eq(pcsv[1][3], 's1.example.co.jp', '従来方式: 4列目はドメイン');
  eq(pcsv[1][2], fb.no_https['一文'], '従来方式: 一文は前置なし');
  eq(registered[registered.length - 1].items[0].reportUrl, '', '従来方式: report_urlは空');
  fs.rmSync(tmp, { recursive: true, force: true });

  // STOC明細 report_url を実際のSQLに入れる
  const sp = { log: [], async getConnection() { return { async beginTransaction() {}, async commit() {}, async rollback() {}, release() {}, async query(sql, params) { sp.log.push({ sql, params }); return /inquiry_export_batches/.test(sql) ? [{ insertId: 7 }] : [{}]; } }; } };
  await S.registerBatch(sp, { code: 'sender_20261026_100000_abcd', fileName: 'x.csv', items: [{ stocId: 1, store: store(1), formUrl: 'https://f/', key: 'no_https', sentence: 's', reportUrl: 'https://webdock.test/r/AbCdEfGh12' }], memo: 'm', env: ENV });
  const itemRow = sp.log.find((l) => /inquiry_export_items/.test(l.sql)).params[0][0];
  eq(itemRow[10], 'https://webdock.test/r/AbCdEfGh12', 'registerBatch: report_url 列にページのURL');

  /* ---------- 引数 ---------- */
  ok(parseArgs(['--single-out', 'd', '--with-page']).withPage, '引数: --with-page');
  const sc = buildB2bScanArgs({ pref: ['兵庫県'], main_category: '製造', with_page: '1', limit: '100' }, { exportDir: '/x', now: new Date(2026, 9, 25, 10, 15, 0) });
  eq(sc.args.slice(-1), ['--with-page'], '管理画面: チェックで --with-page');
  eq(sc.withPage, true, '管理画面: withPage');
  ok(!buildB2bScanArgs({ pref: ['兵庫県'] }, { exportDir: '/x', now: new Date() }).args.includes('--with-page'), '管理画面: 既定では付けない');
  // 診断記録(jsonl)から項目を読む
  const jl = path.join(os.tmpdir(), 'pt-' + process.pid + '.jsonl');
  fs.writeFileSync(jl, JSON.stringify({ store_id: '1001', results: [{ key: 'cert', title: 'T', status: 'ok', summary: 'S', why: 'w', fix: 'f', evidence: '<b>x</b>', remedy: 'site' }] }) + '\nbroken\n' + JSON.stringify({ store_id: '1002', results: null }) + '\n');
  const lr = loadResultsByStore(jl);
  eq(lr.get('1001'), [{ key: 'cert', title: 'T', status: 'ok', summary: 'S', remedy: 'site' }], '診断記録: 必要な項目だけ(証拠・HTMLは持たない)');
  ok(!lr.has('1002'), '診断記録: resultsなしは読まない');
  fs.rmSync(jl, { force: true });

  /* ---------- 権限の確認とGRANT ---------- */
  const g = P.grantStatements(ENV, 'stoc_sales');
  ok(g.includes("GRANT SELECT, INSERT, UPDATE, DELETE ON stoc_master.webdock_pages TO 'stoc_wh'@'localhost';"), 'GRANT: 専用ページの表');
  ok(g.includes("GRANT SELECT, INSERT ON stoc_sales.store_reports TO 'stoc_wh'@'localhost';") && g.includes("GRANT UPDATE (view_count, last_viewed_at) ON stoc_sales.store_reports TO 'stoc_wh'@'localhost';"), 'GRANT: store_reports');
  ok(g.some((x) => /GRANT SELECT, INSERT ON stoc_sales\.store_report_views/.test(x)) && g.some((x) => /GRANT UPDATE \(last_activity_at, view_duration_seconds, max_scroll_percentage, reached_cta, cta_clicked, cta_action, cta_action_at\) ON stoc_sales\.store_report_views/.test(x)), 'GRANT: store_report_views');
  ok(g.includes("GRANT INSERT ON stoc_sales.report_inquiries TO 'stoc_wh'@'localhost';") && g.includes("GRANT INSERT ON stoc_sales.sales_logs TO 'stoc_wh'@'localhost';"), 'GRANT: report_inquiries / sales_logs');
  eq(P.grantStatements({ WH_DB_USER: 'u', WH_DB_HOST: 'db.example' }, 'd2')[0], "GRANT SELECT, INSERT, UPDATE, DELETE ON stoc_master.webdock_pages TO 'u'@'db.example';", 'GRANT: ユーザー・ホスト・DB名を反映');
  const okPool = fakePool();
  await P.checkPageAccess(okPool, { env: ENV });
  ok(okPool.log.length >= 12 && okPool.log.every((l) => /1 = 0/.test(l.sql)), '権限確認: 何も書かない(0行を対象にした文だけ)');
  ok(okPool.log.some((l) => /^INSERT INTO stoc_sales\.report_inquiries \(store_id, report_id, name, phone, preferred_time, inquiry_type, ip_address, email\)/.test(l.sql)), '権限確認: 実際に使う列で検査');
  let pe = null;
  try { await P.checkPageAccess(fakePool({ handlers: [[/^INSERT INTO stoc_sales\.report_inquiries/, () => { throw Object.assign(new Error('INSERT command denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR', errno: 1142 }); }]] }), { env: ENV }); } catch (e) { pe = e; }
  ok(pe && pe.pageCheck && /倉庫DBユーザーにありません/.test(pe.message) && /GRANT INSERT ON stoc_sales\.report_inquiries TO 'stoc_wh'@'localhost';/.test(pe.message) && /GRANT SELECT, INSERT, UPDATE, DELETE ON stoc_master\.webdock_pages/.test(pe.message), '権限不足: 日本語のメッセージにGRANTを並べる');
  pe = null;
  try { await P.checkPageAccess(fakePool({ handlers: [[/FROM stoc_master\.webdock_pages/, () => { throw Object.assign(new Error("Table 'stoc_master.webdock_pages' doesn't exist"), { errno: 1146, code: 'ER_NO_SUCH_TABLE' }); }]] }), { env: ENV }); } catch (e) { pe = e; }
  ok(pe && /warehouse_migrate_006\.sql/.test(pe.message), '表がない: 移行006の案内');

  /* ---------- 配信不要の除外 ---------- */
  const ex = EX.applyPreScanExclusions([{ url: 'https://a.co.jp', stocStoreId: '5' }, { url: 'https://b.co.jp', stocStoreId: '6' }, { url: 'https://c.co.jp', stocStoreId: '' }], { optOutSet: new Set([5]) });
  eq(ex.rows.map((r) => r.stocStoreId), ['6', ''], '配信不要の店を診断前に外す');
  eq(ex.counts, { [EX.REASON.optout]: 1 }, '配信不要: 理由の件数');
  eq([...(await P.loadOptOutSet({ query: async () => [[{ stoc_store_id: 5 }, { stoc_store_id: '7' }, { stoc_store_id: null }]] }))].sort(), [5, 7], 'loadOptOutSet');
  eq((await P.loadOptOutSet({ query: async () => { throw Object.assign(new Error('x'), { errno: 1146 }); } })).size, 0, 'loadOptOutSet: 表がなければ空');
  let oe = null;
  try { await P.loadOptOutSet({ query: async () => { throw Object.assign(new Error('denied'), { errno: 1142 }); } }); } catch (e) { oe = e; }
  ok(oe && oe.stocCheck, 'loadOptOutSet: 読めなければ中止');

  /* ---------- 入力の検査 ---------- */
  eq(validateLead({ name: ' 山田 ', email: 'a@example.co.jp' }).ok, true, '入力: 必須だけでOK');
  eq(Object.keys(validateLead({}).errors), ['name', 'email'], '入力: 名前とメールは必須');
  for (const e of ['a', 'a@', '@b.jp', 'a b@c.jp', 'a@b', 'a@@b.jp', '<x>@b.jp']) ok(validateLead({ name: 'n', email: e }).errors.email, '入力: 不正なメール ' + e);
  eq(validateLead({ name: 'n', email: 'a@b.jp', phone: '079-123-4567' }).ok, true, '入力: 電話(ハイフン)');
  eq(validateLead({ name: 'n', email: 'ａ＠b.jp', phone: '０７９１２３４５６７' }).values.phone, '0791234567', '入力: 全角は半角にそろえる');
  ok(validateLead({ name: 'n', email: 'a@b.jp', phone: '12' }).errors.phone, '入力: 短い電話は不可');
  ok(validateLead({ name: 'n', email: 'a@b.jp', phone: 'abc12345678' }).errors.phone, '入力: 文字入りの電話は不可');
  eq(validateLead({ name: 'n'.repeat(300), email: 'a@b.jp', message: 'm'.repeat(900) }).values.message.length, 500, '入力: ひとことは500字まで');

  /* ---------- ページ(HTTP) ---------- */
  {
    const ctx = await boot();
    const r404 = await ctx.req('/r/short');
    eq(r404.status, 404, '不正な形のトークンは404');
    for (const bad of ['/r/AbCdEfGh1', '/r/AbCdEfGh123', '/r/AbCdEfGh1_', '/r/..%2f..%2fetc', '/r/', '/r/AbCdEfGh12/xx']) eq((await ctx.req(bad)).status, 404, '404: ' + bad);
    eq((await ctx.req('/r/ZzzzzzzzZz')).status, 404, '存在しないトークンは404');
    eq((await ctx.req('/r/AbCdEfGh12/request', { method: 'POST', headers: URLENC, body: '' })).status, 400, 'POST /request: 署名なしは400');
    eq((await ctx.req('/r/short/request', { method: 'POST', headers: URLENC, body: '' })).status, 404, 'POST: 不正トークンは404');
    eq(sqls(ctx.fp, /UPDATE stoc_master\.webdock_pages SET view_count/).length, 0, '404では閲覧を数えない');
    const nf = await ctx.req('/r/short');
    eq(nf.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive', '404にも noindex ヘッダ');

    const r = await ctx.req('/r/AbCdEfGh12');
    eq(r.status, 200, 'ページ: 200');
    const html = await r.text();
    eq(r.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive', 'X-Robots-Tag');
    ok(/<meta name="robots" content="noindex,nofollow,noarchive">/.test(html), 'meta robots noindex');
    ok(/script-src 'nonce-/.test(r.headers.get('content-security-policy')) && /default-src 'none'/.test(r.headers.get('content-security-policy')), 'CSP: 第三者の読み込みを許さない');
    eq(r.headers.get('cache-control'), 'no-store', 'キャッシュしない');
    ok(!/<script[^>]+src=/i.test(html) && !/https?:\/\/(?!webdock)/.test(html.replace(/<script[\s\S]*?<\/script>/g, '')), '外部のスクリプト・URLなし');
    ok(html.includes('株式会社サンプル製作所 御中'), '宛名');
    ok(html.includes('example-seisakusho.co.jp') && html.includes('2026年10月26日'), '対象サイトと確認日');
    ok(html.includes('御社サイト(example-seisakusho.co.jp)を確認したところ、サイト全体が暗号化'), '主な指摘の一文');
    ok(html.includes('セキュリティ用ヘッダー設定') && !html.includes('HTTPSへの自動転送'), 'その他の確認項目(主な指摘に対応する項目は除く)');
    ok(html.includes('問題が見つからなかった項目: <strong>2件</strong>'), 'ok件数');
    ok(!html.includes('CMS') , 'unknownは出さない');
    ok(html.includes('点検の範囲') && html.includes('侵入') , '点検の範囲');
    ok(html.includes('name="name"') && html.includes('name="email"') && html.includes('name="phone"') && html.includes('name="message"') && html.includes('name="website"'), 'フォーム欄とハニーポット');
    ok(/name="ft" value="\d+\.[0-9a-f]{32}"/.test(html) && /name="vt" value="0\.[0-9a-f]{24}"|name="vt" value="900\.[0-9a-f]{24}"/.test(html), '署名つきの隠し欄');
    ok(html.includes('/r/AbCdEfGh12/optout'), '配信不要のリンク');
    ok(!/[-]\s*(被害|攻撃を受け|脆弱)/.test(html), '怖い言葉を使わない');
    eq(sqls(ctx.fp, /^UPDATE stoc_master\.webdock_pages SET view_count = view_count \+ 1, first_viewed_at = COALESCE\(first_viewed_at, NOW\(\)\), last_viewed_at = NOW\(\)/).length, 1, '閲覧: view_count/first/last を更新');
    const vIns = sqls(ctx.fp, /^INSERT INTO stoc_sales\.store_report_views/);
    eq(vIns.length, 1, '閲覧: STOCの store_report_views に1行');
    eq(vIns[0].sql, 'INSERT INTO stoc_sales.store_report_views (report_id, store_id, ip_address, user_agent, referer) VALUES (?,?,?,?,?)', '閲覧: StoreReportController と同じ列');
    eq([vIns[0].params[0], vIns[0].params[1], vIns[0].params[2]], [5, 4567, '203.0.113.9'], '閲覧: 報告ID・店・IP');
    ok(vIns[0].params[3].includes('Chrome'), '閲覧: UAを記録');
    eq(sqls(ctx.fp, /^INSERT INTO stoc_sales\.store_reports \(store_id, token, title, cta_text\)/).length, 1, '閲覧: STOCのレポート行がなければ作る');
    ok(/^[0-9a-f]{64}$/.test(sqls(ctx.fp, /^INSERT INTO stoc_sales\.store_reports/)[0].params[1]), 'STOC側のレポートトークンは長い乱数');
    ok(sqls(ctx.fp, /^UPDATE stoc_sales\.store_reports SET view_count = view_count \+ 1, last_viewed_at = NOW\(\) WHERE id = \?/).length === 1, '閲覧: store_reports の view_count');
    ok(attr(html, 'vt').startsWith('900.'), '閲覧: 記録した行のIDが署名つきで入る');

    // 機械・プレビュー・HEADは数えない
    const before = sqls(ctx.fp, /view_count = view_count \+ 1/).length;
    await ctx.req('/r/AbCdEfGh12', { headers: { 'User-Agent': 'Googlebot/2.1' } });
    await ctx.req('/r/AbCdEfGh12', { headers: { 'User-Agent': 'Microsoft Office Preview' } });
    await ctx.req('/r/AbCdEfGh12', { method: 'HEAD' });
    eq(sqls(ctx.fp, /view_count = view_count \+ 1/).length, before, 'bot/プレビュー/HEADは閲覧に数えない');
    eq(sqls(ctx.fp, /bot_view_count = bot_view_count \+ 1/).length, 3, 'botは bot_view_count に');
    eq(sqls(ctx.fp, /^INSERT INTO stoc_sales\.store_report_views/).length, 1, 'botはSTOCへ書かない');

    // 申込
    const ftv = attr(html, 'ft'), vtv = attr(html, 'vt');
    const submit = (o = {}) => ctx.req('/r/AbCdEfGh12/request', { method: 'POST', headers: URLENC, body: form({ name: '山田 太郎', email: 'yamada@example.co.jp', phone: '079-123-4567', message: '見積りも相談したいです', ft: ftv, vt: vtv, website: '', ...o }) });
    // ハニーポット
    ctx.fp.log.length = 0;
    const hp = await submit({ website: 'http://spam.example' });
    eq(hp.status, 303, 'ハニーポット: 成功したように見せる');
    eq(ctx.fp.log.filter((l) => !/^SELECT/.test(l.sql || '')).length, 0, 'ハニーポット: 何も書かない');
    eq(ctx.notifyLog.length, 0, 'ハニーポット: 通知しない');
    // 改ざん
    const tamper = await submit({ ft: ftv.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')) });
    eq(tamper.status, 400, '改ざんされた署名は400');
    ok((await tamper.text()).includes('確認用の情報が正しくありません'), '改ざん: 日本語のエラー');
    eq(sqls(ctx.fp, /report_inquiries/).length, 0, '改ざん: 書かない');
    // 期限切れ
    ctx.nowRef.t += 25 * 3600e3;
    const exp = await submit();
    eq(exp.status, 400, '1日を過ぎた署名は400');
    ok((await exp.text()).includes('時間が経ちました'), '期限切れ: 案内');
    eq(sqls(ctx.fp, /report_inquiries/).length, 0, '期限切れ: 書かない');
    ctx.nowRef.t -= 25 * 3600e3;
    // 入力不備
    const inv = await submit({ email: 'bad' });
    eq(inv.status, 400, '入力不備は400');
    const invHtml = await inv.text();
    ok(invHtml.includes('メールアドレスの形式をご確認ください') && invHtml.includes('value="山田 太郎"'), '入力不備: 文言と入力の保持');
    eq(sqls(ctx.fp, /report_inquiries/).length, 0, '入力不備: 書かない');
    // 成功
    const okRes = await submit();
    eq(okRes.status, 303, '申込: 303');
    eq(okRes.headers.get('location'), '/r/AbCdEfGh12/thanks', '申込: お礼のページへ');
    const th = await ctx.req('/r/AbCdEfGh12/thanks');
    eq(th.status, 200, 'お礼ページ');
    ok((await th.text()).includes('お申し込みを受け付けました'), 'お礼の文言');
    const log = ctx.fp.log;
    ok(sqls(ctx.fp, /^UPDATE stoc_master\.webdock_pages SET lead_at = NOW\(\)/).length === 1, '申込: lead_at を記録');
    const leadContact = JSON.parse(sqls(ctx.fp, /SET lead_at = NOW\(\)/)[0].params[0]);
    eq(leadContact, { name: '山田 太郎', email: 'yamada@example.co.jp', phone: '079-123-4567', message: '見積りも相談したいです' }, '申込: 内容を控える');
    const ri = sqls(ctx.fp, /^INSERT INTO stoc_sales\.report_inquiries/);
    eq(ri.length, 1, '申込: report_inquiries に1行');
    eq(ri[0].sql, 'INSERT INTO stoc_sales.report_inquiries (store_id,report_id,name,phone,preferred_time,inquiry_type,ip_address,email) VALUES (?,?,?,?,?,?,?,?)', '申込: ReportInquiryController と同じ列');
    eq(ri[0].params, [4567, 5, '山田 太郎', '0791234567', '【WEBドック】簡易レポート希望', 'consultation', '203.0.113.9', 'yamada@example.co.jp'], '申込: 値(電話は数字のみ・WEBドックの印)');
    const cta = sqls(ctx.fp, /^UPDATE stoc_sales\.store_report_views SET reached_cta = 1, cta_clicked = 1, cta_action = 'consultation'/);
    eq(cta.length, 1, '申込: 閲覧行のCTAを更新');
    eq(cta[0].params, [900, 4567], '申込: 開いたときの閲覧行');
    const sl = sqls(ctx.fp, /^INSERT INTO stoc_sales\.sales_logs/);
    eq(sl.length, 1, '申込: sales_logs に履歴メモ');
    eq(sl[0].sql, 'INSERT INTO stoc_sales.sales_logs (store_id,user_id,legacy_rep_name,status,call_result,memo) VALUES (?,?,?,?,?,?)', '申込: 履歴の列');
    eq(sl[0].params.slice(0, 5), [4567, null, 'WEBドック', '未対応', null], '申込: 履歴(架電結果は付けない)');
    ok(sl[0].params[5].startsWith('【WEBドック】') && sl[0].params[5].includes('yamada@example.co.jp') && sl[0].params[5].includes('見積りも相談したいです') && sl[0].params[5].includes('example-seisakusho.co.jp'), '申込: 履歴メモの内容');
    const ops = log.filter((l) => ['begin', 'commit', 'rollback'].includes(l.op)).map((l) => l.op);
    eq(ops, ['begin', 'commit'], '申込: STOCへの書き込みは1トランザクション');
    ok(sqls(ctx.fp, /^UPDATE stoc_master\.webdock_pages SET lead_stoc_at = NOW\(\)/).length === 1, '申込: STOC登録済みの印');
    eq(ctx.notifyLog.length, 1, '申込: 通知1件');
    ok(ctx.notifyLog[0].stocOk === true && ctx.notifyLog[0].pageUrl === 'https://webdock.test/r/AbCdEfGh12' && ctx.notifyLog[0].email === 'yamada@example.co.jp', '申込: 通知の内容');
    // 連打
    ctx.store.get = async () => PAGE({ lead_at: new Date(ctx.nowRef.t - 60000), lead_stoc_at: new Date(ctx.nowRef.t - 60000) });
    ctx.fp.log.length = 0;
    await submit();
    eq(sqls(ctx.fp, /report_inquiries/).length, 0, '連打: 10分以内は重ねて登録しない');
    eq(ctx.notifyLog.length, 1, '連打: 通知も重ねない');
    ctx.server.close();
  }

  // STOCへ書けないとき(権限不足): 申込は受け付け、内容を控え、通知にその旨を載せる
  {
    const denied = Object.assign(new Error('INSERT command denied to user for table report_inquiries'), { code: 'ER_TABLEACCESS_DENIED_ERROR', errno: 1142 });
    const ctx = await boot({ handlers: [[/^INSERT INTO stoc_sales\.report_inquiries/, () => { throw denied; }]] });
    const html = await (await ctx.req('/r/AbCdEfGh12')).text();
    const res = await ctx.req('/r/AbCdEfGh12/request', { method: 'POST', headers: URLENC, body: form({ name: 'A', email: 'a@b.jp', ft: attr(html, 'ft'), vt: attr(html, 'vt') }) });
    eq(res.status, 303, '権限不足でも申込は受け付ける');
    ok(ctx.fp.log.some((l) => l.op === 'rollback'), '権限不足: ロールバック');
    eq(sqls(ctx.fp, /SET lead_stoc_at = NOW\(\)/).length, 0, '権限不足: STOC登録済みの印を付けない');
    ok(sqls(ctx.fp, /SET lead_at = NOW\(\)/).length === 1, '権限不足: lead_at と内容は残る');
    eq(ctx.notifyLog[0].stocOk, false, '権限不足: 通知に「登録できなかった」');
    ctx.server.close();
  }

  // 画面の操作(スクロール・タップ)の通知
  {
    const ctx = await boot();
    const html = await (await ctx.req('/r/AbCdEfGh12')).text();
    const vtv = attr(html, 'vt');
    ctx.fp.log.length = 0;
    eq((await ctx.req('/r/AbCdEfGh12/seen', { method: 'POST', headers: URLENC, body: form({ vt: vtv, s: '80', d: '12' }) })).status, 204, '操作の通知: 204');
    ok(sqls(ctx.fp, /^UPDATE stoc_master\.webdock_pages SET human_at = COALESCE\(human_at, NOW\(\)\)/).length === 1, '操作: human_at');
    const u = sqls(ctx.fp, /^UPDATE stoc_sales\.store_report_views SET last_activity_at = NOW\(\)/);
    eq(u.length, 1, '操作: STOCの last_activity_at を更新(人の印)');
    eq(u[0].params, [12, 80, 900, 4567], '操作: 滞在秒・スクロール%・行ID・店');
    ctx.fp.log.length = 0;
    eq((await ctx.req('/r/AbCdEfGh12/seen', { method: 'POST', headers: URLENC, body: form({ vt: vtv.replace(/^900/, '901'), s: '80', d: '1' }) })).status, 400, '操作: 行IDの書き換えは400');
    eq((await ctx.req('/r/AbCdEfGh12/seen', { method: 'POST', headers: URLENC, body: form({ s: '80' }) })).status, 400, '操作: 署名なしは400');
    eq(ctx.fp.log.length, 0 + ctx.fp.log.filter((l) => /webdock_pages WHERE token/.test(l.sql || '')).length, '操作: 不正なら書かない');
    eq((await ctx.req('/r/AbCdEfGh12/seen', { method: 'POST', headers: URLENC, body: form({ vt: vtv, s: '99999', d: '99999' }) })).status, 204, '操作: 大きすぎる値');
    const u2 = sqls(ctx.fp, /^UPDATE stoc_sales\.store_report_views SET last_activity_at/)[0];
    eq([u2.params[0], u2.params[1]], [3600, 100], '操作: 上限に丸める');
    ctx.server.close();
  }

  // 配信不要
  {
    const ctx = await boot();
    const g1 = await ctx.req('/r/AbCdEfGh12/optout');
    eq(g1.status, 200, '配信不要: 確認ページ');
    const oh = await g1.text();
    ok(oh.includes('今後の案内を停止する') && /name="ft" value=/.test(oh), '配信不要: 確認フォーム');
    eq(sqls(ctx.fp, /view_count/).length, 0, '配信不要の確認ページは閲覧に数えない');
    eq((await ctx.req('/r/AbCdEfGh12/optout', { method: 'POST', headers: URLENC, body: form({ ft: 'x' }) })).status, 400, '配信不要: 署名なしは400');
    eq(sqls(ctx.fp, /opt_out_at/).length, 0, '配信不要: 署名なしは書かない');
    ctx.fp.log.length = 0;
    const done = await ctx.req('/r/AbCdEfGh12/optout', { method: 'POST', headers: URLENC, body: form({ ft: attr(oh, 'ft') }) });
    eq(done.status, 200, '配信不要: 完了');
    ok((await done.text()).includes('今後のご案内を停止しました'), '配信不要: 完了の文言');
    ok(sqls(ctx.fp, /^UPDATE stoc_master\.webdock_pages SET opt_out_at = NOW\(\)/).length === 1, '配信不要: opt_out_at を記録');
    const cl = sqls(ctx.fp, /^INSERT INTO stoc_sales\.sales_logs/);
    eq(cl.length, 1, '配信不要: STOCに履歴を1件');
    eq(cl[0].params.slice(0, 5), [4567, null, 'WEBドック', '未対応', 'クレーム'], '配信不要: call_result=クレーム(問い合わせ営業・AIダイアラーから外れる)');
    ok(cl[0].params[5].includes('今後の案内は不要'), '配信不要: メモ');
    // すでに停止済みなら重ねて記録しない
    ctx.store.get = async () => PAGE({ opt_out_at: new Date() });
    ctx.fp.log.length = 0;
    await ctx.req('/r/AbCdEfGh12/optout', { method: 'POST', headers: URLENC, body: form({ ft: attr(oh, 'ft') }) });
    eq(sqls(ctx.fp, /sales_logs/).length, 0, '配信不要: 二重に記録しない');
    ok((await (await ctx.req('/r/AbCdEfGh12/optout')).text()).includes('すでに停止のお申し出を受け付けています'), '配信不要: 済みの表示');
    ctx.server.close();
  }

  // 表示のエスケープ
  {
    const evil = PAGE({ company_name: '<script>alert(1)</script>"株式会社', domain: 'a.example"><img src=x onerror=alert(2)>', finding_sentence: '<b>確認</b>したところ、&amp;',
      findings_json: JSON.stringify([{ key: 'headers', title: '<i>T</i>', status: 'warn', summary: '<script>x</script>', remedy: 'site' }]) });
    const ctx = await boot({ pages: { AbCdEfGh12: evil } });
    const html = await (await ctx.req('/r/AbCdEfGh12')).text();
    ok(!html.includes('<script>alert(1)') && html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'エスケープ: 会社名');
    ok(!html.includes('<img src=x') && html.includes('&lt;img src=x onerror=alert(2)&gt;'), 'エスケープ: ドメイン');
    ok(!html.includes('<b>確認</b>') && html.includes('&lt;b&gt;確認&lt;/b&gt;'), 'エスケープ: 一文');
    ok(!html.includes('<i>T</i>') && !html.includes('<script>x</script>'), 'エスケープ: 項目');
    const scripts = html.match(/<script[\s\S]*?<\/script>/g) || [];
    ok(scripts.length === 1 && /^<script nonce="[A-Za-z0-9+/=]+">/.test(scripts[0]), 'スクリプトはnonce付きの1つだけ');
    // 壊れた findings_json でも落ちない
    ctx.store.get = async () => PAGE({ findings_json: '{broken' });
    eq((await ctx.req('/r/AbCdEfGh12')).status, 200, '壊れた項目データでも表示');
    ctx.server.close();
  }

  // 軽いレート制限
  {
    const ctx = await boot({ limits: { getMax: 3 } });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await ctx.req('/r/AbCdEfGh12', { headers: { 'x-test-ip': '198.51.100.50' } })).status);
    eq(codes, [200, 200, 200, 429, 429], 'レート制限: IPごとに超えたら429');
    eq((await ctx.req('/r/AbCdEfGh12', { headers: { 'x-test-ip': '198.51.100.51' } })).status, 200, 'レート制限: 別のIPは影響しない');
    ctx.server.close();
  }

  /* ---------- 管理画面の一覧 ---------- */
  {
    const PASS = 'correct-horse-battery';
    const app = express();
    const listCalls = [];
    registerAdminWarehouse(app, {
      password: PASS, allowIps: '203.0.113.10', secret: 'test-secret', jobs: { start: () => ({ ok: true, id: 1 }), get: () => null, list: () => [], running: () => null },
      uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'up-')), exportDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ex-')), queryStats: async () => ({ total: 0, rows: [], sizeAvailable: true }),
      listPages: async (q) => { listCalls.push(q); return { rows: [{ id: 1, token: 'AbCdEfGh12', company_name: '<b>株式会社A</b>', domain: 'a.co.jp', stoc_store_id: 5, stoc_batch_code: 'sender_x', created_at: new Date('2026-10-26T01:00:00Z'), last_viewed_at: new Date('2026-10-26T02:00:00Z'), view_count: 3, bot_view_count: 2, human_at: new Date('2026-10-26T02:00:05Z'), lead_at: new Date('2026-10-26T02:01:00Z'), lead_stoc_at: null, opt_out_at: null }], counts: { total: 9, viewed: 4, human: 3, leads: 1, optout: 0 } }; },
    });
    const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const rq = (p, o = {}) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { redirect: 'manual', ...o, headers: { 'X-Real-IP': '203.0.113.10', ...(o.headers || {}) } });
    const B = '/admin/warehouse';
    eq((await rq(B + '/pages')).status, 302, '一覧: 未ログインはログインへ');
    eq((await rq(B + '/pages', { headers: { 'X-Real-IP': '198.51.100.9' } })).status, 404, '一覧: 許可外IPは404');
    const lg = await rq(B + '/login', { method: 'POST', headers: URLENC, body: form({ password: PASS }) });
    const cookie = (lg.headers.get('set-cookie') || '').split(';')[0];
    const pg = await rq(B + '/pages?filter=lead', { headers: { cookie } });
    eq(pg.status, 200, '一覧: ログイン後は200');
    const ph = await pg.text();
    ok(ph.includes('&lt;b&gt;株式会社A&lt;/b&gt;') && !ph.includes('<b>株式会社A</b>'), '一覧: 会社名はエスケープ');
    ok(ph.includes('a.co.jp') && ph.includes('未登録(メール通知を確認)') && ph.includes('(機械 2)') && ph.includes('/r/AbCdEfGh12') , '一覧: 閲覧・申込・STOC連携の状態・URL');
    ok(!/href="[^"]*\/r\/AbCdEfGh12/.test(ph), '一覧: URLはリンクにしない(管理画面から開いて閲覧に数えないため)');
    ok(ph.includes('作成 <strong>9</strong>件'), '一覧: 件数');
    eq(listCalls[0], { filter: 'lead', limit: 200 }, '一覧: フィルタを渡す');
    eq((await rq(B + '/pages?filter=%27%3Bdrop', { headers: { cookie } })).status, 200, '一覧: 不正なフィルタは all 扱い');
    eq(listCalls[1].filter, 'all', '一覧: 不正なフィルタ → all');
    ok((await (await rq(B + '/', { headers: { cookie } })).text()).includes('>専用ページ</a>'), '一覧: ナビに「専用ページ」');
    const ex = await (await rq(B + '/export', { headers: { cookie } })).text();
    ok(ex.includes('name="with_page"') && ex.includes('御社専用ページのURLを入れる'), '取り出し画面: チェックボックス');
    server.close();
  }

  // 管理画面の一覧: 読み込み失敗時
  {
    const app = express();
    registerAdminWarehouse(app, { password: 'correct-horse-battery', allowIps: '203.0.113.10', secret: 's', jobs: { start: () => ({ ok: true, id: 1 }), get: () => null, list: () => [], running: () => null }, uploadDir: os.tmpdir(), exportDir: os.tmpdir(), queryStats: async () => ({ total: 0, rows: [], sizeAvailable: true }), listPages: async () => { throw new Error("Table doesn't exist"); } });
    const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const rq = (p, o = {}) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { redirect: 'manual', ...o, headers: { 'X-Real-IP': '203.0.113.10', ...(o.headers || {}) } });
    const lg = await rq('/admin/warehouse/login', { method: 'POST', headers: URLENC, body: form({ password: 'correct-horse-battery' }) });
    const r = await rq('/admin/warehouse/pages', { headers: { cookie: (lg.headers.get('set-cookie') || '').split(';')[0] } });
    ok(r.status === 200 && (await r.text()).includes('warehouse_migrate_006.sql'), '一覧: 読めなければ移行006を案内');
    server.close();
  }

  // ページ作成・一覧のSQL
  {
    const fp = fakePool();
    const st = P.createPageStore(fp, { env: ENV });
    const rowsIn = [{ shopId: 1001, stocStoreId: 1, batchCode: 'sender_x', domain: 'a.co.jp', company: 'A社', findingKey: 'cms', sentence: '文', findings: [{ key: 'cms', title: 'T', status: 'warn', summary: 'S', remedy: 'site', evidence: '<x>', why: 'w' }], audience: 'お客様' }];
    const toks = await st.create(rowsIn);
    ok(toks.length === 1 && C.isToken(toks[0]) && rowsIn[0].token === toks[0], '作成: トークンを返す');
    const ins = fp.log.find((l) => /^INSERT INTO stoc_master\.webdock_pages/.test(l.sql));
    eq(ins.sql, 'INSERT INTO stoc_master.webdock_pages (token,shop_id,stoc_store_id,stoc_batch_code,domain,company_name,finding_key,finding_sentence,findings_json,audience) VALUES ?', '作成: 列');
    eq(JSON.parse(ins.params[0][0][8]), [{ key: 'cms', title: 'T', status: 'warn', summary: 'S', remedy: 'site' }], '作成: findings_json は要約だけ(証拠・HTMLを持たない)');
    // トークン重複は作り直す
    let n = 0;
    const dupPool = fakePool({ handlers: [[/^INSERT INTO stoc_master\.webdock_pages/, () => { if (n++ < 2) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY', errno: 1062 }); return [{ affectedRows: 1 }]; }]] });
    const t2 = await P.createPageStore(dupPool, { env: ENV }).create([{ domain: 'a', company: 'A' }]);
    ok(t2.length === 1 && n === 3, '作成: トークン重複は作り直す(3回目で成功)');
    n = -10;
    let de = null;
    try { await P.createPageStore(dupPool, { env: ENV }).create([{ domain: 'a', company: 'A' }]); } catch (e) { de = e; }
    ok(de && de.code === 'ER_DUP_ENTRY', '作成: 3回続けて重複なら諦める');
    await st.remove(['a', 'b']);
    ok(fp.log.some((l) => /^DELETE FROM stoc_master\.webdock_pages WHERE token IN \(\?\)/.test(l.sql)), '削除');
    const lp = fakePool({ handlers: [[/FROM stoc_master\.webdock_pages ORDER|FROM stoc_master\.webdock_pages WHERE lead_at/, () => [[]]], [/COUNT\(\*\) AS total/, () => [[{ total: 2, viewed: '1', human: null, leads: 0, optout: 0 }]]]] });
    const r = await P.createPageStore(lp, { env: ENV }).listRecent({ filter: 'lead', limit: 9999 });
    ok(lp.log[0].sql.includes('WHERE lead_at IS NOT NULL') && lp.log[0].sql.includes('LIMIT 500'), '一覧SQL: フィルタと上限');
    eq(r.counts, { total: 2, viewed: 1, human: 0, leads: 0, optout: 0 }, '一覧: 件数');
    const inj = fakePool({ handlers: [[/COUNT\(\*\) AS total/, () => [[{ total: 0 }]]]] });
    await P.createPageStore(inj, { env: ENV }).listRecent({ filter: "x'; DROP TABLE y;--", limit: 'abc' });
    ok(!/DROP/.test(inj.log[0].sql) && /LIMIT 200/.test(inj.log[0].sql), '一覧SQL: 不正なフィルタ・上限は無視');
  }

  console.log(`pages: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
