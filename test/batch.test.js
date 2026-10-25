'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pickFinding, shouldSend, regionOf, fillTemplate, loadTemplates } = require('../src/outreach');
const { runBatch, parseInput, csvField, parseDelimited } = require('../cli/batch-scan');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  ✗ ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const mk = (o) => Object.keys({ cert: 1, https_redirect: 1, tls_version: 1, headers: 1, cookies: 1, mixed: 1, cms: 1, js_libs: 1, ext_scripts: 1, mail: 1 })
  .map((k) => ({ key: k, status: (o && o[k]) || 'ok' }));

(async () => {
  // pickFinding
  eq(pickFinding(mk()), null, 'all ok -> null');
  eq(pickFinding(mk({ cert: 'bad', mail: 'bad' })), 'https', 'cert bad beats dmarc');
  eq(pickFinding(mk({ https_redirect: 'bad' })), 'https', 'redirect bad');
  eq(pickFinding(mk({ https_redirect: 'warn' })), null, 'redirect warn alone -> null');
  eq(pickFinding(mk({ mail: 'warn', cms: 'warn' })), 'dmarc', 'dmarc beats old_parts');
  eq(pickFinding(mk({ js_libs: 'warn', headers: 'bad' })), 'old_parts', 'old_parts beats headers');
  eq(pickFinding(mk({ headers: 'bad', mixed: 'bad' })), 'headers', 'headers beats mixed');
  eq(pickFinding(mk({ mixed: 'bad' })), 'mixed', 'mixed');
  eq(pickFinding(mk({ headers: 'warn', mixed: 'warn' })), null, 'warn headers/mixed -> null');
  // shouldSend
  eq(shouldSend('C', 'https'), true, 'C send');
  eq(shouldSend('E', 'mixed'), true, 'E send');
  eq(shouldSend('B', 'https'), true, 'B https yes (strong finding)');
  eq(shouldSend('B', 'dmarc'), true, 'B dmarc yes (strong finding)');
  eq(shouldSend('B', 'headers'), false, 'B headers no');
  eq(shouldSend('A', 'dmarc'), false, 'A no');
  eq(shouldSend('D', null), false, 'null finding no');
  eq(shouldSend('—', 'https'), false, 'dash no');
  // regionOf
  eq(regionOf('兵庫県'), 'west', '兵庫県');
  eq(regionOf('東京都'), 'east', '東京都');
  eq(regionOf('大阪'), 'west', '大阪');
  eq(regionOf('京都'), 'west', '京都');
  eq(regionOf(''), 'east', 'empty');
  // fillTemplate
  const filled = fillTemplate('A {x}\n\n{実績}\nB\n\n\n\nC', { x: '1', 実績: '' });
  eq(filled, 'A 1\n\nB\n\nC', 'empty lone placeholder removed, newlines collapsed');
  eq(fillTemplate('{実績}\nB', { 実績: '実績あり' }), '実績あり\nB', 'filled lone placeholder kept');
  // CSV quoting
  eq(csvField('a,"b"\nc'), '"a,""b""\nc"', 'csv quoting');
  eq(parseDelimited('a,"x,""y""\nz"\r\n', ',')[0], ['a', 'x,"y"\nz'], 'csv roundtrip');
  // TSV with NULL
  const rows = parseInput('id\tname\twebsite_url\tprefecture\tcategory\n1\t店A\tNULL\t兵庫県\tNULL\n2\t店B\texample.com\t\t美容\n');
  eq(rows[0], { store_id: '1', name: '店A', url: '', prefecture: '兵庫県', category: '', phone: '', address: '', stocStoreId: '' }, 'tsv NULL row');
  eq(rows[1].url, 'example.com', 'tsv row2 url');

  // runBatch
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-test-'));
  try {
    const templates = loadTemplates();
    const badResults = mk({ cert: 'bad' });
    let calls = 0;
    const scan = async () => { calls++; return { results: badResults, counts: {}, score: 40, grade: 'D' }; };
    const out = path.join(dir, 'r.csv');
    const list = [
      { store_id: '1', name: '甲,"社"', url: 'https://www.same.jp/', prefecture: '兵庫県', category: '' },
      { store_id: '2', name: '乙', url: 'same.jp', prefecture: '東京都', category: '' },
      { store_id: '3', name: '丙', url: '', prefecture: '', category: '' },
    ];
    const log = () => {};
    await runBatch({ rows: list, scan, out, templates, concurrency: 2, log });
    eq(calls, 1, 'dedupe: scan called once for same domain');
    const raw = fs.readFileSync(out, 'utf8');
    eq(raw.charCodeAt(0), 0xFEFF, 'BOM');
    const t = parseDelimited(raw, ',');
    eq(t.length, 4, 'header + 3 rows');
    eq(t[0].length, 25, '25 columns');
    const byId = Object.fromEntries(t.slice(1).map((r) => [r[0], r]));
    eq(byId['1'][21], 'はい', 'send yes');
    eq(byId['1'][22].includes('甲,"社" ご担当者様'), true, 'body has name');
    eq(byId['1'][5], 'same.jp', 'domain strips www');
    eq(byId['3'][23], 'URLなし', 'missing url error');
    eq(byId['3'][21], 'いいえ', 'missing url no send');
    eq(fs.readFileSync(out + '.jsonl', 'utf8').trim().split('\n').length, 3, 'jsonl lines');

    // resume
    calls = 0;
    await runBatch({
      rows: [...list, { store_id: '4', name: '丁', url: 'https://new.jp', prefecture: '', category: '' }],
      scan, out, templates, resume: true, log,
    });
    eq(calls, 1, 'resume: only new store scanned');
    const t2 = parseDelimited(fs.readFileSync(out, 'utf8'), ',');
    eq(t2.length, 5, 'resume appended one row, no second header');
    eq(fs.readFileSync(out + '.jsonl', 'utf8').trim().split('\n').length, 4, 'jsonl appended');

    // error row
    const out2 = path.join(dir, 'e.csv');
    const boom = async () => { throw new Error('secret internal'); };
    await runBatch({ rows: [{ store_id: '9', name: 'E', url: 'e.jp', prefecture: '', category: '' }], scan: boom, out: out2, templates, log });
    let e = parseDelimited(fs.readFileSync(out2, 'utf8'), ',')[1];
    eq(e[23], '診断できませんでした', 'non-userSafe error masked');
    eq(e[21], 'いいえ', 'error no send');
    eq(e[6], '', 'error grade empty');
    const safe = async () => { throw Object.assign(new Error('タイムアウトしました。'), { userSafe: true }); };
    await runBatch({ rows: [{ store_id: '9', name: 'E', url: 'e.jp', prefecture: '', category: '' }], scan: safe, out: out2, templates, log });
    e = parseDelimited(fs.readFileSync(out2, 'utf8'), ',')[1];
    eq(e[23], 'タイムアウトしました。', 'userSafe error shown');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
