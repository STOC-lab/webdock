'use strict';
/**
 * 営業管理経由の送信ファイル(src/outreachSingle.js の buildSingleFiles)の比較用出力テスト。DB・ネット不要(偽のSTOC・偽のページ)。
 * 倉庫から直接送る方式を足しても、営業管理経由(兵庫・岡山・四国向けなど)の出力が1文字も変わらないことを確かめる。
 *
 *   比較:   node test/golden.test.js
 *   作り直し: UPDATE_GOLDEN=1 node test/golden.test.js   (営業管理経由の出力を意図して変えたときだけ)
 *
 * 文面は test/fixtures/single_stoc_golden/templates/(templates/ の写し)を使うので、templates/ を編集してもこのテストは壊れない。
 * 比較するもの: 出力ファイル一式(send_*.csv・確認用.csv・本文.txt・まとめ.txt・result.json)と、
 *   STOCへの登録(register)・専用ページの作成(pages.create)・店の問い合わせ(fetchStores)に渡した値(calls.json)。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const O = require('../src/outreachSingle');
const { loadTemplates } = require('../src/outreach');

const FIX = path.join(__dirname, 'fixtures', 'single_stoc_golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const T = loadTemplates(path.join(FIX, 'templates'));
const NOW = new Date('2026-11-10T01:02:03Z'); // 日本時間 2026-11-10 10:02:03
const ENV = { PUBLIC_BASE_URL: 'https://webdock.example.test' };

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  x ' + msg); } };

/* ---------- 入力(診断結果の行と、STOCの店) ---------- */

const rec = (id, key, o = {}) => ({
  store_id: String(5000 + id), stoc_store_id: String(id), 店名: `倉庫名${id}`, URL: `https://www.k${id}.co.jp/`, 業種: '金属加工業', 業種区分: '製造',
  問い合わせURL: `https://www.k${id}.co.jp/contact/`, 画像認証: 'なし', 営業お断り: '', 指摘種別: key, 送信推奨: 'はい', PHP版: '', ...o,
});
const ROWS = [
  rec(1, 'no_https'),
  rec(2, 'cert_expiring', { 業種: '建設会社', 業種区分: '建設' }),
  rec(3, 'mixed', { stoc_store_id: '' }), // 営業管理に未登録
  rec(4, 'cms', { 問い合わせURL: '' }),
  rec(5, 'cms', { 画像認証: 'あり' }),
  rec(6, 'cms', { 営業お断り: 'あり' }),
  rec(7, '', { 送信推奨: '送らない:初回に使える指摘なし' }),
  rec(8, 'js_libs', { 問い合わせURL: 'https://www.k1.co.jp/contact/' }), // 送信先URL重複
  rec(9, 'headers', { 送信推奨: 'いいえ' }),
  rec(10, 'php_eol', { PHP版: '7.4.33' }),
  rec(11, 'php_unpatched', { PHP版: '' }), // 版が読めない
  rec(12, 'tls_version'), // 契約
  rec(13, 'headers'), // 失注
  rec(14, 'js_libs', { 業種: '自動車整備工場', 業種区分: '' }),
  rec(15, 'https_redirect', { 店名: '倉庫名, "引用"付き' }),
  rec(16, 'cms'), // STOC側に店がない
];
const store = (id, o = {}) => ({
  id, name: `株式会社テスト${id}`, status: '未対応', phone: `079-000-${String(id).padStart(4, '0')}`, phone_mobile: '', phone_free: '', address: `兵庫県姫路市北条${id}-1`,
  prefecture: '兵庫県', category: '製造', website_url: `https://www.k${id}.co.jp/`, gbp_url: `https://maps.example/${id}`, gbp_rating: null, gbp_review_count: null, score: 30 + id, ...o,
});
const STORES = () => new Map([
  [1, store(1, { gbp_rating: '4.2', gbp_review_count: 15 })],
  [2, store(2, { phone: '', phone_mobile: '090-1111-2222', gbp_rating: '3.0' })],
  [10, store(10, { gbp_review_count: 3 })],
  [11, store(11)],
  [12, store(12, { status: '契約' })],
  [13, store(13, { status: '失注' })],
  [14, store(14, { name: '有限会社 整備14', address: '岡山県岡山市北区1-2-3 ビル5F' })],
  [15, store(15, { name: '株式会社, "引用"付き', phone: '', phone_mobile: '', phone_free: '0120-000-015' })],
]);
const RESULTS = new Map(ROWS.map((r) => [r.store_id, [
  { key: 'https', title: 'HTTPSへの自動転送', status: 'bad', summary: `要約${r.store_id}`, remedy: '要対策', evidence: '<b>捨てる</b>' },
  { key: 'php', title: 'PHPの版', status: 'warn', summary: 'PHP', remedy: '要確認', noScore: true },
]]));

/* ---------- 実行(乱数は固定) ---------- */

async function runCase(name, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `golden-${name}-`));
  const calls = { fetchStores: [], register: [], pagesCreate: [] };
  const realRandom = Math.random;
  let seq = 0;
  Math.random = () => ((0x1a2b + 0x111 * seq++) % 0x10000) / 0x10000; // バッチコードの末尾4桁を固定
  try {
    let tok = 0;
    const pages = opts.withPage && !opts.dryRun ? {
      async create(rows) { calls.pagesCreate.push(JSON.parse(JSON.stringify(rows))); return rows.map(() => `Tok${String(++tok).padStart(7, '0')}`); },
      async remove() { throw new Error('呼ばれない'); },
    } : undefined;
    await O.buildSingleFiles({
      rows: ROWS.map((r) => ({ ...r })), outDir: dir, templates: T, now: NOW, dryRun: !!opts.dryRun, withPage: !!opts.withPage, pages,
      resultsByStore: opts.withPage ? RESULTS : undefined, env: ENV, userId: 7, memoDate: '2026-11-10',
      filter: { prefecture: '兵庫県', main_category: '製造,建設', exclude_large: true, small_only: false, form_found: true, limit: 0 },
      preExcluded: { 'クレーム登録で除外': 2, 'WEBドック送信済み・送信予定': 3 },
      stoc: {
        fetchStores: async (ids) => { calls.fetchStores.push(ids); return STORES(); },
        register: async (o) => { calls.register.push(JSON.parse(JSON.stringify(o))); return { code: o.code }; },
      },
    });
    const files = {};
    for (const n of fs.readdirSync(dir).sort()) files[n] = fs.readFileSync(path.join(dir, n), 'utf8');
    files['calls.json'] = JSON.stringify(calls, null, 2) + '\n';
    return files;
  } finally {
    Math.random = realRandom;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function compare(name, files) {
  const dir = path.join(FIX, name);
  if (UPDATE) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t);
    console.log(`  比較用出力を作り直しました: ${path.relative(process.cwd(), dir)}(${Object.keys(files).length}ファイル)`);
    pass++;
    return;
  }
  if (!fs.existsSync(dir)) { fail++; console.log(`  x ${name}: 比較用出力がありません(UPDATE_GOLDEN=1 で作成)`); return; }
  const want = fs.readdirSync(dir).sort();
  ok(JSON.stringify(Object.keys(files).sort()) === JSON.stringify(want), `${name}: ファイル一覧 got=${JSON.stringify(Object.keys(files).sort())} want=${JSON.stringify(want)}`);
  for (const n of want) {
    const exp = fs.readFileSync(path.join(dir, n), 'utf8');
    const got = files[n];
    if (got === exp) { pass++; continue; }
    fail++;
    const a = String(got || '').split('\n'), b = exp.split('\n');
    const i = a.findIndex((l, k) => l !== b[k]);
    const at = i < 0 ? Math.min(a.length, b.length) : i;
    console.log(`  x ${name}/${n}: ${at + 1}行目が違います\n      got:  ${JSON.stringify(a[at])}\n      want: ${JSON.stringify(b[at])}`);
  }
}

(async () => {
  compare('stoc', await runCase('stoc', {}));
  compare('stoc_page', await runCase('stoc_page', { withPage: true }));
  compare('stoc_dryrun', await runCase('stoc_dryrun', { dryRun: true }));
  console.log(`golden: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
