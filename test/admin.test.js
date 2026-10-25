'use strict';
// 倉庫の管理画面のテスト(DB不要)。偽の作業実行係・偽の件数取得を差し込んで確認する。
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const { registerAdminWarehouse, buildPromoteArgs, buildB2bScanArgs, sanitizeFileName, extractZip, clientIp } = require('../src/adminWarehouse');
const { createJobRunner } = require('../src/adminJobs');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);

const BASE = '/admin/warehouse';
const PASS = 'correct-horse-battery';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'admtest-'));

// 偽の作業実行係
function fakeJobs() {
  const started = [];
  let busy = false;
  return {
    started,
    setBusy(b) { busy = b; },
    start(spec) {
      if (busy) return { ok: false, runningId: 1, message: '別の作業が実行中です。' };
      started.push(spec);
      return { ok: true, id: started.length };
    },
    get: (id) => (Number(id) <= started.length ? { id: Number(id), title: started[id - 1].title, status: 'success', startedAt: Date.now(), endedAt: Date.now(), exitCode: 0, meta: started[id - 1].meta || {}, log: ['ok'], lineCount: 1 } : null),
    list: () => [],
    running: () => null,
  };
}

async function boot(opts = {}) {
  const app = express();
  const jobs = fakeJobs();
  const uploadDir = fs.mkdtempSync(path.join(tmp, 'up-'));
  const exportDir = fs.mkdtempSync(path.join(tmp, 'ex-'));
  let statsCalls = 0;
  const r = registerAdminWarehouse(app, {
    password: PASS, allowIps: '203.0.113.10', secret: 'test-secret', jobs, uploadDir, exportDir,
    queryStats: async () => { statsCalls++; return { total: 3, rows: [{ prefecture: '兵庫県', total: 3, web: 2, linked: 1, form: 1, sizeChecked: 0, small: 0, large: 0 }], sizeAvailable: true }; },
    ...opts,
  });
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const port = server.address().port;
  const ctx = { server, jobs, uploadDir, exportDir, r, calls: () => statsCalls };
  ctx.req = (p, o = {}) => fetch(`http://127.0.0.1:${port}${p}`, {
    redirect: 'manual', ...o, headers: { 'X-Real-IP': '203.0.113.10', ...(o.headers || {}) },
  });
  return ctx;
}
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
const form = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) (Array.isArray(v) ? v : [v]).forEach((x) => p.append(k, x)); return p.toString(); };
const URLENC = { 'Content-Type': 'application/x-www-form-urlencoded' };

async function login(ctx, ip) {
  const res = await ctx.req(BASE + '/login', { method: 'POST', headers: { ...URLENC, ...(ip ? { 'X-Real-IP': ip } : {}) }, body: form({ password: PASS }) });
  return { res, cookie: cookieOf(res) };
}
async function csrfOf(ctx, cookie) {
  const html = await (await ctx.req(BASE + '/export', { headers: { cookie } })).text();
  const m = /name="_csrf" value="([0-9a-f]+)"/.exec(html);
  return m && m[1];
}

// 最小のZIPを手で作る(圧縮なし)。zip-slip の名前もそのまま入れられる
function makeZip(entries) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, data] of entries) {
    const nb = Buffer.from(name, 'utf8'); const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nb.length, 28); cd.writeUInt32LE(off, 42);
    locals.push(lh, nb, data); centrals.push(cd, nb);
    off += 30 + nb.length + data.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

function multipart(fields, files) {
  const b = 'XBOUNDARYX';
  const parts = [];
  for (const [k, v] of fields) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const [name, data] of files) parts.push(Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`, 'utf8'), data, Buffer.from('\r\n')]));
  parts.push(Buffer.from(`--${b}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'Content-Type': 'multipart/form-data; boundary=' + b } };
}

(async () => {
  // ---- 純粋関数 ----
  eq(sanitizeFileName('gmp_兵庫県_20261024.csv'), 'gmp_兵庫県_20261024.csv', '日本語名は残す');
  eq(sanitizeFileName('../x.csv'), null, '..は不可');
  eq(sanitizeFileName('a/b.csv'), null, '区切り不可');
  eq(sanitizeFileName('a\\b.csv'), null, '円記号不可');
  eq(sanitizeFileName('a.exe'), null, '拡張子');
  eq(sanitizeFileName('.hidden.csv'), null, '隠しファイル不可');

  const exportDir = '/x/exports';
  const NOW = new Date(2026, 9, 25, 10, 15, 0);
  const meo = buildPromoteArgs({ pref: ['東京都', '大阪府'], preset: 'meo', form_found: '1', size: 'none', limit: '3000' }, { mode: 'make', exportDir, now: NOW });
  eq(meo.args, ['cli/warehouse-promote.js', '--prefecture', '東京都,大阪府', '--form-found', '--limit', '3000', '--out', '/x/exports/meo_20261025-101500.csv', '--mark'], 'MEO用 make');
  const b2b = buildPromoteArgs({ pref: '兵庫県', preset: 'b2b', main_category: '', size: 'exclude_large', form_found: '1' }, { mode: 'make', exportDir, now: NOW });
  eq(b2b.args.slice(0, 7), ['cli/warehouse-promote.js', '--prefecture', '兵庫県', '--main-category', '製造,加工,建設,工事,工務店,板金,鉄工,製作所,塗装,設備,機械,金属,工場,整備', '--no-rules', '--form-found'], '工場用の先頭');
  eq(b2b.args.slice(7), ['--exclude-large', '--limit', '5000', '--out', '/x/exports/kojo_20261025-101500.csv', '--mark'], '工場用の後ろ');
  const rep = buildPromoteArgs({ pref: ['兵庫県'], preset: 'b2b', main_category: '製造、建設 工事', size: 'small_only' }, { mode: 'report', exportDir, now: NOW });
  eq(rep.args, ['cli/warehouse-promote.js', '--prefecture', '兵庫県', '--main-category', '製造,建設,工事', '--no-rules', '--small-only', '--limit', '5000', '--report-only'], '件数確認は--outも--markもなし');
  ok(buildPromoteArgs({ pref: [], preset: 'meo' }, { mode: 'report', exportDir, now: NOW }).error, '県なしはエラー');
  ok(buildPromoteArgs({ pref: ['存在県'] }, { mode: 'report', exportDir, now: NOW }).error, '不正な県');
  ok(buildPromoteArgs({ pref: ['東京都'], limit: '-1' }, { mode: 'report', exportDir, now: NOW }).error, '不正な上限');
  ok(buildPromoteArgs({ pref: ['東京都'], limit: '5;rm' }, { mode: 'report', exportDir, now: NOW }).error, '上限に文字列');

  // 診断して文面も作る(batch-scan へ渡す引数)
  const sc = buildB2bScanArgs({ pref: ['兵庫県', '大阪府'], main_category: '製造、建設', size: 'exclude_large', form_found: '1', limit: '2000' }, { exportDir, now: NOW });
  eq(sc.args, ['cli/batch-scan.js', '--source', 'warehouse', '--template', 'b2b', '--prefecture', '兵庫県,大阪府', '--main-category', '製造,建設', '--form-found', '--exclude-large', '--limit', '2000', '--concurrency', '5', '--out', '/x/exports/b2b_scan_20261025-101500.csv', '--single-out', '/x/exports/b2b_20261025-101500'], '診断引数');
  eq(sc.singleDir, 'b2b_20261025-101500', '診断: 出力フォルダ名');
  ok(!sc.args.includes('--group-out') && !sc.args.includes('--dry-run-stoc'), '診断: group-out なし・STOC登録は既定で行う');
  ok(!sc.args.includes('--mark'), '診断に--markなし');
  ok(/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}\.csv$/.test(sc.exportFile), '診断CSV名はダウンロード可能な名前');
  ok(buildB2bScanArgs({ pref: [] }, { exportDir, now: NOW }).error, '診断: 県なし');
  ok(buildB2bScanArgs({ pref: ['東京都'], limit: '1;x' }, { exportDir, now: NOW }).error, '診断: 不正な上限');
  ok(buildB2bScanArgs({ pref: ['東京都'] }, { exportDir, now: NOW }).args.includes('製造,加工,建設,工事,工務店,板金,鉄工,製作所,塗装,設備,機械,金属,工場,整備'), '診断: 既定の業種');

  // IPの判定: 外から直接つないだ相手のヘッダは信用しない
  const fakeReq = (peer, h) => ({ socket: { remoteAddress: peer }, headers: h });
  eq(clientIp(fakeReq('198.51.100.7', { 'x-forwarded-for': '203.0.113.10', 'x-real-ip': '203.0.113.10' })), '198.51.100.7', '非loopbackの偽ヘッダは無視');
  eq(clientIp(fakeReq('::ffff:198.51.100.7', { 'x-real-ip': '203.0.113.10' })), '198.51.100.7', 'IPv4射影も正規化して無視');
  eq(clientIp(fakeReq('::ffff:127.0.0.1', { 'x-real-ip': '203.0.113.10' })), '203.0.113.10', 'loopbackならX-Real-IP');
  eq(clientIp(fakeReq('127.0.0.1', { 'x-forwarded-for': '1.1.1.1, 203.0.113.10' })), '203.0.113.10', 'XFFは最後(nginxが付けた分)');

  // ZIP
  const zdir = fs.mkdtempSync(path.join(tmp, 'z-'));
  const zp = path.join(zdir, 'a.zip');
  fs.writeFileSync(zp, makeZip([['sub/gmp_兵庫県_1.csv', Buffer.from('a')], ['readme.txt', Buffer.from('b')], ['gmp_大阪_1.csv', Buffer.from('c')], ['other/gmp_兵庫県_1.csv', Buffer.from('d')]]));
  const outDir = fs.mkdtempSync(path.join(tmp, 'zo-'));
  const ex = extractZip(zp, outDir);
  eq(ex.saved.sort(), ['gmp_兵庫県_1.csv', 'gmp_兵庫県_1_2.csv', 'gmp_大阪_1.csv'].sort(), 'zip: csvだけ・平らに・重複は連番');
  eq(ex.skipped, 1, 'zip: csv以外は除外');
  for (const bad of ['../evil.csv', '/etc/evil.csv', 'a/../../evil.csv', 'C:/evil.csv', '..\\evil.csv']) {
    fs.writeFileSync(zp, makeZip([[bad, Buffer.from('x')]]));
    let msg = null; try { extractZip(zp, fs.mkdtempSync(path.join(tmp, 'zs-'))); } catch (e) { msg = e.message; }
    ok(msg, 'zip-slip拒否: ' + bad);
  }
  ok(!fs.existsSync(path.join(zdir, 'evil.csv')) && !fs.existsSync(path.join(tmp, 'evil.csv')), 'zip-slip: 外にファイルが出ていない');
  fs.writeFileSync(zp, makeZip([['gmp_a.csv', Buffer.alloc(100)]]));
  let big = null; try { extractZip(zp, fs.mkdtempSync(path.join(tmp, 'zb-')), { maxEntry: 10 }); } catch (e) { big = e.message; }
  ok(big, 'zip: サイズ上限');

  // 作業実行係(本物): 同時に1つだけ・ログ取得
  const runner = createJobRunner();
  const j1 = runner.start({ title: 'a', args: ['-e', 'console.log("hello");console.error("err");setTimeout(()=>{},400)'] });
  const j2 = runner.start({ title: 'b', args: ['-e', '1'] });
  ok(j1.ok, '1つ目は開始'); eq(j2.ok, false, '実行中は2つ目を断る');
  await new Promise((r) => setTimeout(r, 900));
  const s1 = runner.get(j1.id);
  eq(s1.status, 'success', '終了したら成功'); ok(s1.log.includes('hello') && s1.log.includes('err'), 'stdout/stderr両方を記録');
  const j3 = runner.start({ title: 'c', args: ['-e', 'process.exit(3)'] });
  await new Promise((r) => setTimeout(r, 500));
  eq(runner.get(j3.id).status, 'failed', '失敗の記録'); eq(runner.get(j3.id).exitCode, 3, '終了コード');
  for (let i = 0; i < 25; i++) { runner.start({ title: 'n' + i, args: ['-e', '1'] }); await new Promise((r) => setTimeout(r, 60)); }
  ok(runner.list().length <= 20, '履歴は20件まで');

  // ---- 画面(HTTP) ----
  // 合言葉なし/許可IPなし → 404
  {
    const app = express();
    registerAdminWarehouse(app, { password: '', allowIps: '203.0.113.10', jobs: fakeJobs() });
    const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    const res = await fetch(`http://127.0.0.1:${s.address().port}${BASE}/login`, { headers: { 'X-Real-IP': '203.0.113.10' } });
    eq(res.status, 404, '合言葉なしは404');
    s.close();
    const app2 = express();
    registerAdminWarehouse(app2, { password: PASS, allowIps: '', jobs: fakeJobs() });
    const s2 = await new Promise((r) => { const x = app2.listen(0, '127.0.0.1', () => r(x)); });
    const res2 = await fetch(`http://127.0.0.1:${s2.address().port}${BASE}/login`, { headers: { 'X-Real-IP': '203.0.113.10' } });
    eq(res2.status, 404, 'ADMIN_ALLOW_IPSなしは404');
    s2.close();
  }

  const ctx = await boot();
  try {
    // IP制限(ログインより前)
    eq((await ctx.req(BASE + '/login', { headers: { 'X-Real-IP': '198.51.100.9' } })).status, 404, '許可外IPは404(ログイン画面も)');
    eq((await ctx.req(BASE + '/login', { method: 'POST', headers: { ...URLENC, 'X-Real-IP': '198.51.100.9' }, body: form({ password: PASS }) })).status, 404, '許可外IPはログインPOSTも404');
    eq((await ctx.req(BASE + '/login', { headers: { 'X-Real-IP': '::ffff:203.0.113.10' } })).status, 200, 'IPv4射影表記も許可');
    eq((await ctx.req('/admin/other')).status, 404, '/admin配下のその他は404');

    // ログイン
    eq((await ctx.req(BASE + '/')).status, 302, '未ログインはログインへ');
    const bad = await ctx.req(BASE + '/login', { method: 'POST', headers: URLENC, body: form({ password: 'nope' }) });
    eq(bad.status, 401, '失敗は401');
    const { res: okRes, cookie } = await login(ctx);
    eq(okRes.status, 303, '成功は303');
    const sc = okRes.headers.get('set-cookie');
    ok(/HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && /Max-Age=43200/.test(sc), 'クッキー属性');
    ok(!/Secure/.test(sc), 'httpではSecureなし');
    eq((await ctx.req(BASE + '/', { headers: { cookie } })).status, 200, 'ログイン後に状況が見える');
    eq((await ctx.req(BASE + '/', { headers: { cookie: cookie.slice(0, -3) + 'abc' } })).status, 302, '改ざんクッキーは無効');
    // 期限切れ(署名が正しくても期限が過ぎたら無効)
    const old = cookie.replace(/=(\d+)\./, '=1000000000000.');
    eq((await ctx.req(BASE + '/', { headers: { cookie: old } })).status, 302, '期限切れ/改ざん');

    // 状況のキャッシュ
    await ctx.req(BASE + '/', { headers: { cookie } });
    eq(ctx.calls(), 1, '件数は60秒キャッシュ');

    // CSRF
    const csrf = await csrfOf(ctx, cookie);
    ok(csrf && csrf.length === 32, 'CSRFトークンがフォームにある');
    const body = { pref: '兵庫県', preset: 'meo', size: 'none', action: 'report' };
    eq((await ctx.req(BASE + '/export', { method: 'POST', headers: { ...URLENC, cookie }, body: form(body) })).status, 403, 'CSRFなしは拒否');
    eq((await ctx.req(BASE + '/export', { method: 'POST', headers: { ...URLENC, cookie }, body: form({ ...body, _csrf: 'f'.repeat(32) }) })).status, 403, 'CSRF不一致は拒否');
    eq(ctx.jobs.started.length, 0, '拒否時は作業を始めない');
    const okPost = await ctx.req(BASE + '/export', { method: 'POST', headers: { ...URLENC, cookie }, body: form({ ...body, _csrf: csrf }) });
    eq(okPost.status, 303, 'CSRF正しければ作業開始'); eq(okPost.headers.get('location'), BASE + '/jobs/1', 'ジョブ画面へ');
    eq(ctx.jobs.started[0].args, ['cli/warehouse-promote.js', '--prefecture', '兵庫県', '--limit', '5000', '--report-only'], '件数確認の引数');
    ok(!ctx.jobs.started[0].args.includes('--mark'), '件数確認に--markなし');
    const make = await ctx.req(BASE + '/export', { method: 'POST', headers: { ...URLENC, cookie }, body: form({ pref: ['兵庫県'], preset: 'b2b', size: 'exclude_large', action: 'make', form_found: '1', _csrf: csrf }) });
    eq(make.status, 303, 'CSV作成開始');
    const a = ctx.jobs.started[1].args;
    ok(a.includes('--mark') && a.includes('--out') && a.includes('--exclude-large') && a.includes('--no-rules') && !a.includes('--report-only'), 'CSV作成の引数');
    ok(a[a.indexOf('--out') + 1].startsWith(ctx.exportDir + path.sep), '出力先は設定フォルダ');
    // つなぐ
    eq((await ctx.req(BASE + '/link', { method: 'POST', headers: { ...URLENC, cookie }, body: form({}) })).status, 403, 'つなぐもCSRF必須');
    await ctx.req(BASE + '/link', { method: 'POST', headers: { ...URLENC, cookie }, body: form({ _csrf: csrf }) });
    eq(ctx.jobs.started[2].args, ['cli/warehouse-import.js', '--link-only', '--carry-forms'], 'つなぐの引数');
    // 実行中は断る
    ctx.jobs.setBusy(true);
    const busy = await ctx.req(BASE + '/link', { method: 'POST', headers: { ...URLENC, cookie }, body: form({ _csrf: csrf }) });
    eq(busy.status, 409, '実行中は409'); ok((await busy.text()).includes('別の作業が実行中'), '実行中メッセージ');
    ctx.jobs.setBusy(false);
    // ログアウトもCSRF必須
    eq((await ctx.req(BASE + '/logout', { method: 'POST', headers: { ...URLENC, cookie }, body: form({}) })).status, 403, 'ログアウトもCSRF');

    // ジョブ画面/JSON
    eq((await ctx.req(BASE + '/jobs/1', { headers: { cookie } })).status, 200, 'ジョブ画面');
    const jj = await (await ctx.req(BASE + '/jobs/2/json', { headers: { cookie } })).json();
    eq(jj.status, 'success', 'ジョブJSON');
    eq((await ctx.req(BASE + '/jobs/99/json', { headers: { cookie } })).status, 404, '無いジョブ');

    // ダウンロード
    fs.writeFileSync(path.join(ctx.exportDir, 'meo_20261025-101500.csv'), Buffer.from([0x95, 0xba]));
    fs.writeFileSync(path.join(ctx.exportDir, 'secret.txt'), 'x');
    fs.writeFileSync(path.join(tmp, 'outside.csv'), 'x');
    const dl = await ctx.req(BASE + '/exports/meo_20261025-101500.csv', { headers: { cookie } });
    eq(dl.status, 200, 'ダウンロード可');
    eq(dl.headers.get('content-type'), 'text/csv; charset=Shift_JIS', 'content-type');
    ok(/^attachment; filename="meo_20261025-101500.csv"$/.test(dl.headers.get('content-disposition')), 'attachment');
    eq(Buffer.from(await dl.arrayBuffer()).length, 2, '中身');
    for (const bad of ['..%2Foutside.csv', '%2e%2e%2foutside.csv', 'secret.txt', 'a%5Cb.csv', '%00.csv']) {
      const r = await ctx.req(BASE + '/exports/' + bad, { headers: { cookie } });
      eq(r.status, 404, 'ダウンロード拒否: ' + bad);
    }
    eq((await ctx.req(BASE + '/exports/meo_20261025-101500.csv')).status, 302, '未ログインはダウンロード不可');
    ok((await (await ctx.req(BASE + '/export', { headers: { cookie } })).text()).includes('meo_20261025-101500.csv'), '一覧に出る');

    // グループ別ファイル(診断して文面も作る)
    const scanPost = await ctx.req(BASE + '/export', { method: 'POST', headers: { ...URLENC, cookie }, body: form({ pref: ['兵庫県'], preset: 'b2b', action: 'scan', _csrf: csrf }) });
    eq(scanPost.status, 303, '診断開始');
    const scanSpec = ctx.jobs.started[ctx.jobs.started.length - 1];
    const scanJobId = ctx.jobs.started.length;
    const gdName = scanSpec.meta.singleDir;
    scanSpec.meta.groupDir = gdName; // 旧形式のグループファイルも同じフォルダにあるものとして画面表示を確認する
    ok(/^b2b_\d{8}-\d{6}$/.test(gdName) && scanSpec.args.includes('--single-out') && scanSpec.args.includes('--out'), '診断: --single-out と --out');
    ok(scanSpec.args[scanSpec.args.indexOf('--single-out') + 1] === path.join(ctx.exportDir, gdName), '診断: group-out は設定フォルダ内');
    const gd = path.join(ctx.exportDir, gdName);
    fs.mkdirSync(gd);
    fs.writeFileSync(path.join(gd, 'group_mixed_2件.csv'), '\uFEFFstore_id\r\n1\r\n');
    fs.writeFileSync(path.join(gd, 'group_mixed_2件_確認用.csv'), '\uFEFFstore_id\r\n1\r\n');
    fs.writeFileSync(path.join(gd, 'group_mixed_本文.txt'), 'ご担当者様 <テスト>\n本文です\n');
    fs.writeFileSync(path.join(gd, 'group_mixed_本文_短縮.txt'), '短縮');
    fs.writeFileSync(path.join(gd, 'group_mixed_件名.txt'), '1. 件名');
    fs.writeFileSync(path.join(gd, 'まとめ.txt'), 'まとめ');
    // 単一本文
    const CODE = 'sender_20261026_010203_ab12';
    fs.writeFileSync(path.join(gd, `send_${CODE}.csv`), '\uFEFF送信先URL\r\n');
    fs.writeFileSync(path.join(gd, 'send_DRYRUN.csv'), 'x');
    fs.writeFileSync(path.join(gd, 'send_WD-MIXED-20261025.csv'), 'x');
    fs.writeFileSync(path.join(gd, 'send_sender_20261026_010203_AB12.csv'), 'x');
    fs.writeFileSync(path.join(gd, '確認用.csv'), '\uFEFFstore_id\r\n');
    fs.writeFileSync(path.join(gd, '本文.txt'), '[company]\n<単一本文>\n');
    fs.writeFileSync(path.join(gd, 'result.json'), JSON.stringify({ dryRun: false, count: 7, batches: [{ code: CODE, count: 7, file: `send_${CODE}.csv` }, { code: 'WD-MIXED-20261025', count: 1 }, { code: 'sender_x', count: 1 }] }));
    fs.writeFileSync(path.join(gd, 'secret.txt'), 'x');
    fs.writeFileSync(path.join(gd, 'group_Bad_1件.csv'), 'x');
    fs.writeFileSync(path.join(ctx.exportDir, 'outside.txt'), 'x');
    const jp = await (await ctx.req(BASE + '/jobs/' + scanJobId, { headers: { cookie } })).text();
    ok(jp.includes('group_mixed_2件.csv') && jp.includes('group_mixed_2件_確認用.csv') && jp.includes('readonly') && jp.includes('コピー') && jp.includes('ご担当者様 &lt;テスト&gt;'), 'ジョブ画面: グループ・textarea・コピー・エスケープ');
    ok(!jp.includes('secret.txt') && !jp.includes('group_Bad'), 'ジョブ画面: 不正名は出さない');
    ok(jp.includes(CODE) && jp.includes(`send_${CODE}.csv`) && jp.includes('確認用.csv') && jp.includes('&lt;単一本文&gt;') && jp.includes('id="singlebody"') && jp.includes('登録したバッチコード'), 'ジョブ画面: 単一本文・STOCバッチコード・コピー');
    ok(!jp.includes('WD-MIXED') && !jp.includes('AB12') && !jp.includes('send_DRYRUN.csv'), 'ジョブ画面: 不正・未記載のバッチは出さない');
    ok((await (await ctx.req(BASE + '/export', { headers: { cookie } })).text()).includes(gdName), '取り出し画面: グループフォルダ一覧');
    const gu = (d, f) => BASE + '/exports/' + d + '/' + encodeURIComponent(f);
    const g1 = await ctx.req(gu(gdName, 'group_mixed_本文.txt'), { headers: { cookie } });
    eq(g1.status, 200, 'グループ本文DL');
    eq(g1.headers.get('content-type'), 'text/plain; charset=UTF-8', 'txtはtext/plain UTF-8');
    ok(/^attachment; /.test(g1.headers.get('content-disposition')), 'txtはattachment');
    eq((await ctx.req(gu(gdName, 'group_mixed_2件.csv'), { headers: { cookie } })).headers.get('content-type'), 'text/csv; charset=UTF-8', 'csvはUTF-8');
    eq((await ctx.req(gu(gdName, 'group_mixed_2件_確認用.csv'), { headers: { cookie } })).headers.get('content-type'), 'text/csv; charset=UTF-8', '確認用csvもDLできる');
    eq((await ctx.req(gu(gdName, 'まとめ.txt'), { headers: { cookie } })).status, 200, 'まとめDL');
    const s1 = await ctx.req(gu(gdName, `send_${CODE}.csv`), { headers: { cookie } });
    eq([s1.status, s1.headers.get('content-type')], [200, 'text/csv; charset=UTF-8'], '送信CSVのDL');
    eq((await ctx.req(gu(gdName, '確認用.csv'), { headers: { cookie } })).status, 200, '確認用DL');
    eq((await ctx.req(gu(gdName, '本文.txt'), { headers: { cookie } })).status, 200, '単一本文DL');
    eq((await ctx.req(gu(gdName, 'send_DRYRUN.csv'), { headers: { cookie } })).status, 200, 'DRYRUN送信CSVのDL');
    for (const bad of ['send_WD-MIXED-20261025.csv', 'send_sender_20261026_010203_AB12.csv', 'send_sender_20261026_010203_ab12.txt', 'send_.csv', 'send_DRYRUN-100.csv']) {
      eq((await ctx.req(gu(gdName, bad), { headers: { cookie } })).status, 404, '送信CSV名の厳格化: ' + bad);
    }
    for (const [d, f] of [[gdName, 'secret.txt'], [gdName, 'group_Bad_1件.csv'], [gdName, '..%2Foutside.txt'], [gdName, '%2e%2e%2foutside.txt'], [gdName, 'group_mixed_本文.txt%00'],
      ['..', 'outside.txt'], ['b2b_20261025', 'まとめ.txt'], ['b2b_20990101-000000', 'まとめ.txt'], ['%2e%2e', 'まとめ.txt'], [gdName, 'group_mixed_本文.csv']]) {
      const r = await ctx.req(BASE + '/exports/' + d + '/' + (f.includes('%') ? f : encodeURIComponent(f)), { headers: { cookie } });
      eq(r.status, 404, 'グループDL拒否: ' + d + '/' + f);
    }
    // シンボリックリンクは拒否
    try {
      fs.symlinkSync(path.join(ctx.exportDir, 'outside.txt'), path.join(gd, 'group_cms_件名.txt'));
      eq((await ctx.req(gu(gdName, 'group_cms_件名.txt'), { headers: { cookie } })).status, 404, 'シンボリックリンクは拒否');
    } catch (e) { if (e.code !== 'EPERM') throw e; }
    eq((await ctx.req(gu(gdName, 'group_mixed_本文.txt'))).status, 302, '未ログインはグループDL不可');

    // アップロード
    const goodCsv = Buffer.from('屋号,業種\nA,B\n');
    let mp = multipart([['_csrf', csrf]], [['gmp_兵庫県_20261024.csv', goodCsv]]);
    let up = await ctx.req(BASE + '/import', { method: 'POST', headers: { cookie, ...mp.headers }, body: mp.body });
    eq(up.status, 303, 'CSVアップロード成功');
    const imp = ctx.jobs.started[ctx.jobs.started.length - 1];
    eq([imp.args[0], imp.args[1], imp.args[3], imp.args[4]], ['cli/warehouse-import.js', '--root', '--pattern', 'gmp_*.csv'], '取り込みの引数');
    ok(!imp.args.includes('--dry-run'), 'ドライランなし');
    const dir = imp.args[2];
    ok(dir.startsWith(ctx.uploadDir + path.sep) && /\/\d{8}-\d{6}$/.test(dir), '保存先は日時フォルダ');
    ok(fs.existsSync(path.join(dir, 'gmp_兵庫県_20261024.csv')), '日本語名で保存');
    // ドライラン + 名前に ../ を入れても外へ出ない
    mp = multipart([['_csrf', csrf], ['dry_run', '1']], [['../../evil/gmp_x.csv', goodCsv]]);
    up = await ctx.req(BASE + '/import', { method: 'POST', headers: { cookie, ...mp.headers }, body: mp.body });
    eq(up.status, 303, 'パス付き名は基本名だけ使う');
    const imp2 = ctx.jobs.started[ctx.jobs.started.length - 1];
    ok(imp2.args.includes('--dry-run'), 'ドライラン指定');
    ok(fs.existsSync(path.join(imp2.args[2], 'gmp_x.csv')) && !fs.existsSync(path.join(ctx.uploadDir, '..', 'evil')), '外に出ない');
    // CSRFなしのアップロード
    const before = fs.readdirSync(ctx.uploadDir).length;
    mp = multipart([['_csrf', 'bad']], [['gmp_a.csv', goodCsv]]);
    up = await ctx.req(BASE + '/import', { method: 'POST', headers: { cookie, ...mp.headers }, body: mp.body });
    eq(up.status, 403, 'アップロードもCSRF必須'); eq(fs.readdirSync(ctx.uploadDir).length, before, 'CSRF不正なら保存しない');
    // 拡張子違い・名前違い
    mp = multipart([['_csrf', csrf]], [['gmp_a.exe', goodCsv]]);
    up = await ctx.req(BASE + '/import', { method: 'POST', headers: { cookie, ...mp.headers }, body: mp.body });
    eq(up.status, 400, '.exeは拒否');
    mp = multipart([['_csrf', csrf]], [['nagasaki.csv', goodCsv]]);
    up = await ctx.req(BASE + '/import', { method: 'POST', headers: { cookie, ...mp.headers }, body: mp.body });
    eq(up.status, 400, 'gmp_以外のCSVは拒否');
    // ZIP
    const startedBefore = ctx.jobs.started.length;
    mp = multipart([['_csrf', csrf]], [['all.zip', makeZip([['x/gmp_a.csv', goodCsv], ['x/list.csv', goodCsv]])]]);
    up = await ctx.req(BASE + '/import', { method: 'POST', headers: { cookie, ...mp.headers }, body: mp.body });
    eq(up.status, 303, 'ZIPアップロード成功');
    const zdirUp = ctx.jobs.started[ctx.jobs.started.length - 1].args[2];
    eq(fs.readdirSync(zdirUp), ['gmp_a.csv'], 'ZIPはgmp_*.csvだけ展開しzip自体は消す');
    // zip-slip
    const dirsBefore = fs.readdirSync(ctx.uploadDir).length;
    mp = multipart([['_csrf', csrf]], [['evil.zip', makeZip([['../../evil.csv', goodCsv]])]]);
    up = await ctx.req(BASE + '/import', { method: 'POST', headers: { cookie, ...mp.headers }, body: mp.body });
    eq(up.status, 400, 'zip-slipは拒否');
    eq(ctx.jobs.started.length, startedBefore + 1, 'zip-slipでは作業を始めない');
    eq(fs.readdirSync(ctx.uploadDir).length, dirsBefore, 'zip-slipの残骸を消す');
    // 実行中のアップロードは断って片付け
    ctx.jobs.setBusy(true);
    const d2 = fs.readdirSync(ctx.uploadDir).length;
    mp = multipart([['_csrf', csrf]], [['gmp_b.csv', goodCsv]]);
    up = await ctx.req(BASE + '/import', { method: 'POST', headers: { cookie, ...mp.headers }, body: mp.body });
    eq(up.status, 409, '実行中のアップロードは409'); eq(fs.readdirSync(ctx.uploadDir).length, d2, '断ったら保存物を消す');
    ctx.jobs.setBusy(false);

    // ログイン回数制限(別IPで)
    const ip = '203.0.113.10';
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const r = await ctx.req(BASE + '/login', { method: 'POST', headers: URLENC, body: form({ password: 'x' + i }) });
      last = r.status;
    }
    eq(last, 429, '失敗が続くと429');
    const right = await ctx.req(BASE + '/login', { method: 'POST', headers: URLENC, body: form({ password: PASS }) });
    eq(right.status, 429, '制限中は正しい合言葉でも429');
    void ip;
  } finally {
    ctx.server.close();
  }

  // Secure: プロキシ越しのhttps(X-Forwarded-Proto)のとき
  {
    const app = express();
    app.set('trust proxy', 'loopback');
    registerAdminWarehouse(app, { password: PASS, allowIps: '203.0.113.10', secret: 's', jobs: fakeJobs(), uploadDir: tmp, exportDir: tmp });
    const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    const res = await fetch(`http://127.0.0.1:${s.address().port}${BASE}/login`, { method: 'POST', redirect: 'manual', headers: { ...URLENC, 'X-Real-IP': '203.0.113.10', 'X-Forwarded-Proto': 'https' }, body: form({ password: PASS }) });
    ok(/; Secure/.test(res.headers.get('set-cookie') || ''), 'https越しはSecure');
    s.close();
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`admin: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
