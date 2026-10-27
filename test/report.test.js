'use strict';
// 簡易レポート(src/reportBuckets.js・views/report.ejs・/sales/report)のテスト。DB・外部通信なし
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { spawn } = require('child_process');
const R = require('../src/reportBuckets');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);

// ---- 区分 ----
const B = (key, status, remedy) => R.bucketOf({ key, status, remedy: remedy || (key === 'mail' ? 'dns' : 'site') });
const want = {
  cert: ['urgent', 'partial'], https_redirect: ['urgent', 'partial'], mixed: ['urgent', 'renewal'],
  tls_version: ['partial', 'partial'], headers: ['partial', 'partial'], cookies: ['partial', 'partial'],
  cms: ['partial', 'partial'], ext_scripts: ['partial', 'partial'], js_libs: ['renewal', 'renewal'], mail: ['dns', 'dns'],
};
Object.keys(want).forEach((k) => {
  eq(B(k, 'bad'), want[k][0], k + ' bad');
  eq(B(k, 'warn'), want[k][1], k + ' warn');
  eq(B(k, 'ok'), null, k + ' ok');
  eq(B(k, 'unknown'), null, k + ' unknown');
});
eq(B('new_key', 'warn', 'dns'), 'dns', '未知key+dns');
eq(B('new_key', 'bad', 'site'), 'partial', '未知key+site');
eq(R.statusLabel('bad'), '要対応', 'label bad');
eq(R.statusLabel('warn'), '要確認', 'label warn');

const g = R.groupItems([
  { key: 'headers', status: 'warn' }, { key: 'cert', status: 'bad' }, { key: 'cookies', status: 'bad' },
  { key: 'js_libs', status: 'unknown' }, { key: 'cms', status: 'ok' }, { key: 'mail', status: 'warn', remedy: 'dns' },
]);
eq(g.urgent.map((x) => x.key), ['cert'], 'group urgent');
eq(g.partial.map((x) => x.key), ['cookies', 'headers'], 'group partial bad先');
eq(g.dns.map((x) => x.key), ['mail'], 'group dns');
eq(g.okItems.map((x) => x.key), ['cms'], 'group ok');

// ---- fix → 依頼文 ----
eq(R.fixToRequest('制作会社に「http→httpsへの常時リダイレクトを設定してほしい」と依頼してください。'), 'http→httpsへの常時リダイレクトを設定していただけますでしょうか。', 'quote形');
eq(R.fixToRequest('制作会社に「SSL証明書が無効になっている」と伝え、再発行・自動更新の設定を依頼してください。'), 'SSL証明書が無効になっていることを確認しています。再発行・自動更新の設定をお願いいたします。', '伝え形');
eq(R.fixToRequest('自動更新が有効か制作会社に確認してください。'), '自動更新が有効か確認していただけますでしょうか。', '確認形');
eq(R.fixToRequest(''), '', '空');

// checks.js の fix 文言をすべて拾って検査(${...} は仮の語に置換)
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'checks.js'), 'utf8');
const fixes = [];
for (const m of src.matchAll(/fix:\s*(?:'([^']+)'|`([^`]+)`)/g)) fixes.push((m[1] || m[2]).replace(/\$\{[^}]*\}/g, 'サンプル'));
for (const m of src.matchAll(/'(?:SSL|ドメイン)[^']*'|dmarc \? '([^']+)' : '([^']+)'/g)) { if (m[1]) fixes.push(m[1], m[2]); }
ok(fixes.length >= 15, 'fix文言を十分に拾えた: ' + fixes.length);
fixes.forEach((f) => {
  const r = R.fixToRequest(f);
  ok(r.length > 5, '空でない: ' + f);
  ok(!/してください/.test(r), 'してください残り: ' + r);
  ok(!/制作会社に「|ドメイン管理会社に「|」と依頼/.test(r), '括弧残り: ' + r);
  ok(!/^(制作会社|ドメイン管理会社)に/.test(r), '先頭の宛先残り: ' + r);
  ok(/[。]$/.test(r), '句点で終わる: ' + r);
});

// ---- 依頼文ブロック ----
const items = [{ title: 'テスト', evidence: 'ev', fix: '制作会社に「Cookieを直してほしい」と依頼してください。' }, { title: '二つ目', fix: 'サーバー側でTLS1.2以上のみを有効にするよう依頼してください。' }];
const t = R.buildRequestText(items, 'site', '株式会社甲 御中');
ok(t.startsWith('制作会社様 / 保守ご担当者様'), '宛先');
ok(/1\. テスト[\s\S]*2\. 二つ目/.test(t), '番号');
ok(t.includes('ご対応の可否と、概算の費用・期間をお知らせいただけますと幸いです。'), '結び');
ok(R.buildRequestText(items, 'dns').startsWith('メール・ドメイン管理ご担当者様'), 'dns宛先');
eq(R.buildRequestText([], 'site'), '', '空');

// ---- 描画(エスケープ) ----
const scan = {
  domain: 'example.co.jp', url: 'https://example.co.jp/', scannedAt: new Date('2026-10-25T00:00:00Z'),
  results: [
    { key: 'cert', title: 'SSL証明書', status: 'bad', summary: '期限切れ', why: '警告が出ます', fix: '証明書を至急再発行し、自動更新を設定してください。', evidence: '<img src=x onerror=alert(1)>', remedy: 'site' },
    { key: 'mail', title: 'メール対策', status: 'warn', summary: '不足', why: 'w', fix: 'DMARCレコードを追加するよう依頼してください。', evidence: 'e', remedy: 'dns' },
    { key: 'cms', title: 'CMS', status: 'ok', summary: 'ok', evidence: '', remedy: 'site' },
  ],
};
const g2 = R.groupItems(scan.results);
const sender = { company: '株式会社エストック', name: '森澤 梓', tel: '0120-830-046', mail: 'morisawa@stoc.co.jp' };
const evil = '<script>alert("x")</script>株式会社';
const vm = {
  scan, company: evil, input: 'https://example.co.jp/?a="b"', g: g2, BUCKETS: R.BUCKETS, BUCKET_ORDER: R.BUCKET_ORDER, statusLabel: R.statusLabel,
  sender, surname: '森澤', dateJa: '2026年10月25日',
  siteRequest: R.buildRequestText(g2.urgent, 'site', evil + ' 御中'), dnsRequest: R.buildRequestText(g2.dns, 'dns'),
};
ejs.renderFile(path.join(__dirname, '..', 'views', 'report.ejs'), vm, async (err, html) => {
  if (err) { console.log('render error', err); process.exit(1); }
  ok(!html.includes('<script>alert("x")'), '会社名エスケープ');
  ok(html.includes('&lt;script&gt;alert(&#34;x&#34;)&lt;/script&gt;株式会社 御中'), '会社名宛名');
  ok(!html.includes('<img src=x'), '根拠エスケープ');
  ok(html.includes('Webサイト 簡易点検レポート'), 'タイトル');
  ok(html.includes('印刷・PDF保存'), '印刷ボタン');
  ok(html.includes('@media print') && html.includes('.no-print'), '印刷CSS');
  ok(/@page\s*\{\s*size:\s*210mm 297mm/.test(html), '@pageがA4寸法(210mm 297mm)');
  ok(html.includes('すぐにご確認いただきたい項目') && html.includes('メール・ドメイン設定'), '区分見出し');
  ok(html.includes('問題が見つからなかった項目'), 'ok一覧');
  ok(html.includes('0120-830-046') && html.includes('morisawa@stoc.co.jp') && html.includes('株式会社エストック 森澤'), 'フッター');

  // ---- ルートは合言葉が必要(本物のサーバーを一時起動。DBは使わない) ----
  const port = 39000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), SALES_PIN: 'testpin', DB_HOST: '', DB_USER: '', DB_NAME: '', DB_PASSWORD: '' }, stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    ok(up, 'サーバー起動');
    if (up) {
      const r1 = await fetch(`http://127.0.0.1:${port}/sales/report?url=example.com`);
      eq(r1.status, 401, '未認証は401');
      const body = await r1.text();
      ok(!body.includes('簡易点検レポート'), '未認証でレポートを出さない');
    }
  } finally { child.kill(); }
  console.log(`report.test: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
});
