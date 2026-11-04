'use strict';
// 簡易レポート(src/reportBuckets.js・views/report.ejs・/sales/report)のテスト。DB・外部通信なし
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { spawn } = require('child_process');
const R = require('../src/reportBuckets');
const S = require('../src/reportSender');

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
const evil = '<script>alert("x")</script>株式会社';
const vm = {
  scan, company: evil, input: 'https://example.co.jp/?a="b"', g: g2, BUCKETS: R.BUCKETS, BUCKET_ORDER: R.BUCKET_ORDER, statusLabel: R.statusLabel,
  sender: null, from: '', person: '', mail: '', req: true, guideFor: R.guideFor, proposal: null, senderOptions: [{ key: 'stoc', label: 'STOC' }, { key: 'toc', label: 'TOC本社' }], dateJa: '2026年10月25日',
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
  ok(!html.includes('ティ・オー・シー</td>') && !html.includes('<th>作成</th>') && !html.includes('morisawa@') && !html.includes('山田'), 'from なしは作成行・担当者を出さない');
  ok(!html.includes('TEL 0120'), 'from なしは電話を出さない');
  ok(html.includes('本レポートをお届けした担当者'), 'フッターは汎用の問い合わせ文');

  // ---- 作成元の選択(設定・検証・描画) ----
  const senders = S.loadSenders();
  ok(senders.stoc && senders.toc, '設定ファイルから stoc / toc を読む');
  eq(S.loadSenders('/nonexistent/x.json'), {}, '設定読み込み失敗は空扱い');
  const bad = path.join(require('os').tmpdir(), 'report-senders-bad-' + process.pid + '.json');
  fs.writeFileSync(bad, '{壊れたJSON'); eq(S.loadSenders(bad), {}, '壊れた設定は空扱い'); fs.unlinkSync(bad);
  const render = (q, opts = {}) => new Promise((resolve, reject) => {
    const r = S.resolveSender(senders, q);
    const req = R.resolveReq(q, r.from);
    ejs.renderFile(path.join(__dirname, '..', 'views', 'report.ejs'), {
      ...vm, company: q.company || '', input: q.url || 'https://example.co.jp/',
      sender: r.sender, from: r.from, person: r.person, mail: r.mail,
      req, guideFor: R.guideFor, proposal: req ? null : R.buildProposal(opts.g || vm.g),
      siteRequest: req ? vm.siteRequest : '', dnsRequest: req ? vm.dnsRequest : '',
      ...(opts.g ? { g: opts.g } : {}),
      senderOptions: Object.keys(senders).map((k) => ({ key: k, label: senders[k].label })),
    }, (e, h) => (e ? reject(e) : resolve(h)));
  });
  const h1 = await render({ from: 'toc', person: '山田 太郎', mail: 'a@b.jp' });
  ok(h1.includes('<th>作成</th><td>株式会社ティ・オー・シー 本社 山田 太郎(TEL 0120-005-486)</td>'), '作成行(会社・担当者・電話)');
  ok(h1.includes('ご不明点は 株式会社ティ・オー・シー 本社 山田(TEL 0120-005-486／メール a@b.jp)まで。'), 'フッター(姓・電話・メール)');
  ok(!h1.includes('本レポートをお届けした担当者'), '汎用フッターは出ない');
  const h2 = await render({ from: 'stoc' });
  ok(h2.includes('<td>株式会社エストック(TEL 0120-830-046)</td>'), '担当者なしは担当者を省く');
  ok(h2.includes('ご不明点は 株式会社エストック(TEL 0120-830-046)まで。'), 'フッター: 担当者・メールを省く');
  ok(!h2.includes('／メール'), 'メールなしは「／メール」を省く');
  const h3 = await render({ from: 'evil', person: '山田', mail: 'a@b.jp' });
  ok(!h3.includes('<th>作成</th>') && !h3.includes('TEL 0120') && h3.includes('本レポートをお届けした担当者'), '不正な from は無視');
  const h3b = await render({ from: '__proto__', person: '山田' });
  ok(!h3b.includes('<th>作成</th>'), '__proto__ は無視');
  const h4 = await render({ from: 'toc', person: '<b>山田</b>', mail: 'x"><script>@b.jp' });
  ok(!h4.includes('<b>山田</b>') && h4.includes('&lt;b&gt;山田&lt;/b&gt;'), '担当者名エスケープ');
  ok(!h4.includes('<script>@b.jp') && !h4.includes('／メール'), '不正なメールは無視');
  eq(S.resolveSender(senders, { from: 'toc', person: 'あ'.repeat(60) }).person.length, 40, '担当者名は40文字まで');
  eq(S.resolveSender(senders, { from: 'toc', mail: 'a'.repeat(96) + '@b.jp' }).mail, '', 'メールは100文字まで');
  eq(S.resolveSender(senders, { from: 'toc', mail: 'abc' }).mail, '', 'メール形式チェック');
  const h5 = await render({ from: 'toc', person: '山田 太郎', mail: 'a@b.jp', url: 'https://example.co.jp/?a=1', company: '株式会社甲' });
  ok(/<select name="from">[\s\S]*<option value="toc" selected>TOC本社<\/option>/.test(h5), 'フォームが from を保持');
  ok(h5.includes('name="person" value="山田 太郎"') && h5.includes('name="mail" type="email" value="a@b.jp"'), 'フォームが person / mail を保持');
  ok(h5.includes('name="url" value="https://example.co.jp/?a=1"') && h5.includes('name="company" value="株式会社甲"'), 'フォームが url / company を保持');
  ok(/<option value="" selected>なし<\/option>/.test(await render({})) || !/<option value="[a-z]+" selected>/.test(await render({})), '初期値は「なし」');

  // ---- 作成元4種・総合点 ----
  eq(Object.keys(senders), ['stoc', 'toc', 'toc_kobe', 'toc_osaka'], '作成元は4つ・順序固定');
  const hs = await render({});
  const opts = [...hs.matchAll(/<option value="([a-z_]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => m[1] + ':' + m[2]);
  eq(opts.slice(0, 5), [':なし', 'stoc:STOC', 'toc:TOC本社', 'toc_kobe:TOC神戸', 'toc_osaka:TOC大阪'], '選択肢が順に並ぶ');
  ok((await render({ from: 'toc_kobe' })).includes('株式会社ティ・オー・シー 神戸(TEL 0120-840-730)'), 'toc_kobe の電話');
  ok((await render({ from: 'toc_osaka' })).includes('株式会社ティ・オー・シー 大阪(TEL 0120-005-486)'), 'toc_osaka の電話');
  ok((await render({ from: 'toc' })).includes('<td>株式会社ティ・オー・シー 本社(TEL 0120-005-486)</td>'), 'toc は本社');
  const renderScan = (extra) => new Promise((resolve, reject) => ejs.renderFile(path.join(__dirname, '..', 'views', 'report.ejs'), { ...vm, scan: { ...scan, ...extra } }, (e, h) => (e ? reject(e) : resolve(h))));
  const NOTE = '総合点は、外から確認できた項目の結果をもとにした目安です';
  const hs1 = await renderScan({ score: 62, grade: 'C' });
  ok(hs1.includes('<tr><th>総合点</th><td><strong>62点</strong> / 100点(判定 C)</td></tr>'), '総合点の行');
  ok(hs1.indexOf('<th>点検日</th>') < hs1.indexOf('<th>総合点</th>'), '総合点は点検日の次');
  ok(hs1.includes(NOTE), '総合点の注記');
  const hs2 = await renderScan({ score: 62 });
  ok(hs2.includes('<strong>62点</strong> / 100点</td>') && !hs2.includes('判定'), 'grade なしは判定を省く');
  const hs3 = await renderScan({ score: null, grade: '—' });
  ok(!hs3.includes('<th>総合点</th>') && !hs3.includes(NOTE), 'score null は行も注記も出さない');
  ok(!(await renderScan({})).includes('<th>総合点</th>'), 'score undefined は行を出さない');

  // ---- 確認依頼文の ON/OFF(直接営業モード) ----
  eq(R.resolveReq({}, ''), true, 'req初期値: 作成元なしはON');
  eq(R.resolveReq({}, 'stoc'), false, 'req初期値: 有効な作成元はOFF');
  eq(R.resolveReq({ req_set: '1' }, ''), false, 'req_set=1でreqなしはOFF');
  eq(R.resolveReq({ req_set: '1', req: '1' }, 'toc'), true, 'req_set=1&req=1はON');
  const hA = await render({});
  ok(hA.includes('制作会社様への確認依頼文') && hA.includes('メール・ドメイン管理ご担当者様への確認依頼文'), '初期(fromなし)は依頼文あり');
  ok(!hA.includes('対応のご提案'), '初期(fromなし)は提案なし');
  ok(hA.includes('ドメイン・メールの管理会社(ご担当者様)へご相談ください。'), 'ON時はdnsの目安が従来どおり');
  ok(/<input type="hidden" name="req_set" value="1"><input type="checkbox" name="req" value="1" checked>/.test(hA), 'ON時はチェック済み+hidden');
  const hB = await render({ from: 'stoc' });
  ok(!hB.includes('制作会社様への確認依頼文') && !hB.includes('確認依頼文</h2>'), 'from=stocは依頼文なし');
  ok(hB.includes('<h2 class="nobreak">対応のご提案</h2>'), 'from=stocは提案あり');
  ok(/name="req" value="1">/.test(hB) && !/name="req" value="1" checked/.test(hB), 'OFF時はチェックなし');
  ok(hB.includes('name="req_set" value="1"'), 'OFF時もhidden');
  const hC = await render({ req_set: '1', from: 'stoc' });
  ok(!hC.includes('制作会社様への確認依頼文') && hC.includes('対応のご提案'), 'req_set=1&reqなしはOFF');
  const hD = await render({ req_set: '1', req: '1', from: 'toc' });
  ok(hD.includes('制作会社様への確認依頼文') && !hD.includes('対応のご提案'), 'req_set=1&req=1&from=tocはON');
  ok(/name="req" value="1" checked/.test(hD), 'フォームがチェック状態を保持');
  // 文面(件数は g2: urgent1 / dns1 / renewal0 / partial0)
  ok(hB.includes('ホームページの改修では直りません。当社でもご相談を承ります。'), 'OFF時dnsの目安差し替え');
  ok(hB.includes('早めに状況をご確認いただくことをおすすめします。'), 'OFF時urgentの目安はそのまま');
  ok(!hB.includes('ドメイン・メールの管理会社(ご担当者様)へご相談ください'), 'OFF時dns旧文言なし');
  ok(hB.includes('今回の点検で見つかった項目には、次の2つの進め方があります。') && hB.includes('<h3>A. 部分修正</h3>') && hB.includes('(計1件)'), 'A あり');
  ok(hB.includes('<h3>B. ホームページの入れ替え</h3>') && hB.includes('<p>すべての項目を一度に解消します。古い'), 'renewal0はB冒頭が「すべての項目を」');
  ok(!hB.includes('(0件)も含めて'), 'renewal0の括弧書きなし');
  ok(hB.includes('<p>メール・ドメイン設定の項目(1件)も、ご希望があればあわせて対応いたします。</p>'), 'dns行あり');
  ok(hB.includes('<strong>お見積もりは無料</strong>'), 'お見積もり強調');
  const mk = (keys) => R.groupItems(keys.map((k) => ({ key: k[0], status: k[1], title: k[0], summary: 's', fix: '', remedy: k[0] === 'mail' ? 'dns' : 'site' })));
  const P1 = R.buildProposal(mk([['cert', 'bad'], ['cookies', 'warn'], ['js_libs', 'warn']]));
  ok(P1.b.text.startsWith('「リニューアル時にまとめて対応すると効率的な項目」(1件)も含めて、すべての項目を一度に解消します。'), 'renewalありのB文');
  ok(P1.a.text.includes('(計2件)') && P1.dns === null, 'A件数・dns0件の行は出さない');
  const P2 = R.buildProposal(mk([['js_libs', 'warn']]));
  eq(P2.a, null, 'urgent+partial=0はAなし');
  eq(P2.b.heading, 'ホームページの入れ替え', 'A無しはBの見出しから「B.」を外す');
  eq(P2.intro, '今回の点検で見つかった項目は、次の進め方で対応できます。', 'A無しの冒頭文');
  eq(R.buildProposal(mk([['cms', 'ok']])), null, '総数0は提案なし');
  const P3 = R.buildProposal(mk([['mail', 'bad']]));
  ok(P3.a === null && P3.b === null && P3.dns.includes('当社でも対応') && !P3.closing[0].includes('どちら'), 'メール・ドメインだけのときは入れ替えを勧めない');
  ok(!P2.closing[0].includes('どちら'), 'Aなしは「どちらが」と書かない');
  const hE = await render({ from: 'stoc' }, { g: R.groupItems([{ key: 'cms', title: 'CMS', status: 'ok', summary: 'ok' }]) });
  ok(!hE.includes('対応のご提案'), '総数0は描画にも提案なし');
  const hF = await render({ from: 'stoc' }, { g: R.groupItems([{ key: 'js_libs', title: 'JS', status: 'warn', summary: 's', evidence: '' }]) });
  ok(hF.includes('<h3>ホームページの入れ替え</h3>') && !hF.includes('A. 部分修正'), '描画: A無し');
  ok(hF.includes('次の進め方で対応できます。'), '描画: A無しの冒頭文');

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
