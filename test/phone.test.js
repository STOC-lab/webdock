'use strict';
// 電話営業リスト(cli/phone-list.js)と管理画面の引数づくりのテスト。DB・ネット不要(偽の診断・偽の更新日判定を渡す)。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs, runPhoneList, preparePhoneRows, mainFindings, hitReasonsOf, gbpLabel, COLUMNS } = require('../cli/phone-list');
const { parseDelimited } = require('../cli/batch-scan');
const { buildPhoneListArgs } = require('../src/adminWarehouse');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);

const NOW = new Date('2026-10-27T03:00:00Z'); // 日本時間 2026-10-27
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phonetest-'));
const OUT = (n) => path.join(tmp, n);

// ---- parseArgs ----
{
  const a = parseArgs(['--prefecture', '兵庫県', '--out', 'x.csv']);
  eq([a.error, a.minScore, a.maxScore, a.days, a.limit, a.concurrency, a.resume, a.gbp], [undefined, 50, 70, 7, 3000, 5, false, false], '既定値(GBPは付けたときだけ)');
  eq(parseArgs(['--prefecture', '兵庫県', '--out', 'x.csv', '--gbp']).gbp, true, '--gbp');
  const b = parseArgs(['--prefecture', '兵庫県,大阪府', '--main-category', '製造,建設', '--exclude-large', '--min-score', '40', '--max-score', '60', '--days', '30', '--limit', '100', '--concurrency', '3', '--out', 'x.csv', '--resume']);
  eq([b.error, b.prefecture, b.mainCategory, b.excludeLarge, b.minScore, b.maxScore, b.days, b.limit, b.concurrency, b.resume], [undefined, '兵庫県,大阪府', '製造,建設', true, 40, 60, 30, 100, 3, true], '指定した値');
  ok(parseArgs(['--out', 'x.csv']).error, '--prefecture 必須');
  ok(parseArgs(['--prefecture', '兵庫県']).error, '--out 必須');
  ok(parseArgs(['--prefecture', 'ひょうご', '--out', 'x']).error, '都道府県の名前が不正');
  ok(parseArgs(['--prefecture', '兵庫県', '--out', 'x', '--min-score', '-1']).error, '点数は0以上');
  ok(parseArgs(['--prefecture', '兵庫県', '--out', 'x', '--max-score', '101']).error, '点数は100以下');
  ok(parseArgs(['--prefecture', '兵庫県', '--out', 'x', '--min-score', '5.5']).error, '点数は整数');
  ok(parseArgs(['--prefecture', '兵庫県', '--out', 'x', '--min-score', '80', '--max-score', '70']).error, 'min>max');
  eq(parseArgs(['--prefecture', '兵庫県', '--out', 'x', '--min-score', '70', '--max-score', '70']).error, undefined, 'min=max は可');
  ok(parseArgs(['--prefecture', '兵庫県', '--out', 'x', '--days', '0']).error, 'days 0 は不可');
  ok(parseArgs(['--prefecture', '兵庫県', '--out', 'x', '--days', '366']).error, 'days 366 は不可');
  eq(parseArgs(['--prefecture', '兵庫県', '--out', 'x', '--days', '365']).error, undefined, 'days 365 は可');
  ok(parseArgs(['--prefecture', '兵庫県', '--out', 'x', '--limit', 'abc']).error, 'limit 不正');
  ok(parseArgs(['--prefecture', '兵庫県', '--out', 'x', '--days']).error, '値の欠け');
  ok(parseArgs(['--prefecture', '兵庫県', '--out', 'x', '--exclude-large', '--small-only']).error, '規模の同時指定');
  ok(parseArgs(['--prefecture', '兵庫県', '--out', 'x', '--bogus']).error, '知らない指定');
}

// ---- preparePhoneRows / mainFindings ----
{
  const rows = [
    { store_id: '1', phone: '079-123-4567' }, { store_id: '2', phone: '0791234567' }, { store_id: '3', phone: '' },
    { store_id: '4', phone: '  ' }, { store_id: '5', phone: '０７９－９９９－０００１' }, { store_id: '6', phone: '079(999)0001' }, { store_id: '7', phone: '06-1111-2222' },
  ];
  const p = preparePhoneRows(rows, 0);
  eq(p.rows.map((r) => r.store_id), ['1', '5', '7'], '電話の重複(数字だけ・全角も)は最初の1件');
  eq([p.noPhone, p.dup], [2, 2], '件数');
  eq(preparePhoneRows(rows, 2).rows.map((r) => r.store_id), ['1', '5'], 'limit は整理のあと');
  const res = [{ status: 'ok', title: 'A' }, { status: 'warn', title: 'B' }, { status: 'bad', title: 'C' }, { status: 'unknown', title: 'D' }, { status: 'bad', title: 'E' }];
  eq(mainFindings(res), 'C・E', '主な指摘: bad を先に最大2つ');
  eq(mainFindings([{ status: 'warn', title: 'B' }, { status: 'bad', title: 'C' }, { status: 'warn', title: 'F' }]), 'C・B', 'bad のあとに warn');
  eq(mainFindings(null), '', 'results なし');
}

// ---- runPhoneList ----
const mk = (id, phone, url, extra = {}) => ({ store_id: String(id), name: '会社' + id, phone, url, address: '兵庫県姫路市' + id, prefecture: '兵庫県', category: '製造', ...extra });
const scoreOf = { a: 60, b: 30, c: 70, d: 50, e: 71, f: 49, g: 65, h: 55, k: 60 };
const R = [{ status: 'bad', title: 'ヘッダー未設定' }, { status: 'warn', title: 'Cookie' }];
const fakeScan = (log) => async (url) => {
  const h = new URL(url).hostname.split('.')[0];
  log.push(h);
  if (h === 'err') throw new Error('秘密の内部エラー');
  return { results: R, grade: 'C', score: scoreOf[h] };
};
const dates = { a: '2026-10-25', c: '2026-10-21', d: '2026-10-20', g: '2026-10-26' }; // 今日は 10-27: a=2日前 c=6日前 d=7日前 g=1日前(g は更新日が不明にもできる)
const fakeDetect = (log, over = {}) => async (url) => {
  const h = new URL(url).hostname.split('.')[0];
  log.push(h);
  if (h in over) return over[h];
  const d = dates[h];
  return d ? { date: new Date(d + 'T00:00:00+09:00'), source: h === 'a' ? 'rss' : h === 'c' ? 'news_page' : 'wordpress', url: `https://${h}.example.jp/post`, title: `記事${h}`, note: '' }
    : { date: null, source: null, url: '', title: '', note: '日付が見つからない' };
};
const readCsv = (f) => parseDelimited(fs.readFileSync(f, 'utf8'), ',');

(async () => {
  const rows = [
    mk(1, '079-111-0001', 'https://a.example.jp/'), // 60点・更新2日前 → 該当
    mk(2, '079-111-0002', 'https://b.example.jp/'), // 30点 → 範囲外
    mk(3, '079-111-0003', 'https://c.example.jp/'), // 70点・6日前 → 該当
    mk(4, '079-111-0004', 'https://d.example.jp/'), // 50点・7日前 → 該当(7日以内)
    mk(5, '079-111-0005', 'https://e.example.jp/'), // 71点 → 範囲外
    mk(6, '079-111-0006', 'https://f.example.jp/'), // 49点 → 範囲外
    mk(7, '', 'https://g.example.jp/'), // 電話なし → 除外
    mk(8, '0791110001', 'https://h.example.jp/'), // 1番と同じ電話 → 除外
    mk(9, '079-111-0009', 'https://err.example.jp/'), // 診断エラー
    mk(10, '079-111-0010', 'https://h.example.jp/'), // 55点・更新日なし → 不明
    mk(11, '079-111-0011', 'https://a.example.jp/inner'), // 1番と同じドメイン(キャッシュ)・別の電話 → 該当
  ];
  const logs = []; const scanLog = []; const detLog = [];
  const out = OUT('p1.csv');
  const st = await runPhoneList({ rows, scan: fakeScan(scanLog), detect: fakeDetect(detLog), out, minScore: 50, maxScore: 70, days: 7, concurrency: 3, now: () => NOW, log: (m) => logs.push(m) });
  ok(!detLog.includes('b') && !detLog.includes('e') && !detLog.includes('f') && !detLog.includes('err'), '範囲外・エラーでは detect を呼ばない: ' + detLog.join(','));
  eq(scanLog.filter((x) => x === 'a').length, 1, '同じドメインの診断は1回だけ');
  eq(detLog.filter((x) => x === 'a').length, 1, '同じドメインの更新日判定は1回だけ');
  ok(!scanLog.includes('g'), '電話が空の店は診断しない');
  ok(logs[0].includes('空の店を除外: 1件') && logs[0].includes('重複を除外: 1件'), '除外の件数ログ: ' + logs[0]);
  const t = readCsv(out);
  ok(fs.readFileSync(out, 'utf8').startsWith('﻿'), 'BOM付き');
  eq(t[0], COLUMNS, '列');
  eq(t[0], ['会社名', '電話番号', '住所', '都道府県', '業種', 'URL', '点数', '評価', '主な指摘', '最終更新日', '何日前', '更新の根拠', '記事URL', '記事タイトル', 'store_id', '診断日時',
    'GoogleマップURL', 'GBP最終投稿', 'GBP最終オーナー返信', '最新口コミ', 'GBPの表記', '該当理由'], '列の名前と順(GBPの列は既存列の後ろ)');
  eq(t.slice(1).map((r) => r[14]), ['1', '11', '3', '4'], '最終更新日の新しい順(同日は点数順)');
  const r1 = t[1];
  eq([r1[0], r1[1], r1[2], r1[3], r1[4], r1[5], r1[6], r1[7], r1[8]], ['会社1', '079-111-0001', '兵庫県姫路市1', '兵庫県', '製造', 'https://a.example.jp/', '60', 'C', 'ヘッダー未設定・Cookie'], '1行目の中身');
  eq([r1[9], r1[10], r1[11], r1[12], r1[13]], ['2026-10-25', '2', 'RSS', 'https://a.example.jp/post', '記事a'], '更新日・何日前・根拠・記事');
  eq([r1[16], r1[17], r1[18], r1[19], r1[20], r1[21]], ['', '', '', '', '', 'WEB'], 'GBPなしの行: GBP列は空・該当理由はWEB');
  ok(/^2026-10-27 12:00$/.test(r1[15]), '診断日時(日本時間): ' + r1[15]);
  eq([t[3][11], t[4][11]], ['お知らせページ', 'WordPress投稿'], '更新の根拠のラベル');
  eq([t[4][10]], ['7'], '7日前は含む');
  // 記録(jsonl)
  const recs = fs.readFileSync(out + '.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  eq(recs.length, 9, 'jsonl は診断した行すべて(電話なし・重複は入らない)');
  const keys = ['store_id', 'name', 'phone', 'url', 'domain', 'score', 'grade', 'inRange', 'latest', 'source', 'postUrl', 'postTitle', 'note', 'error', 'scannedAt'];
  ok(keys.every((k) => k in recs[0]), 'jsonl の項目');
  const by = Object.fromEntries(recs.map((r) => [r.store_id, r]));
  eq([by['2'].inRange, by['2'].latest], [false, ''], '範囲外は inRange=false');
  eq(by['9'].error, '診断できませんでした', '内部エラーの詳細は出さない');
  eq([by['10'].inRange, by['10'].latest, by['10'].note, by['10'].hit], [true, '', '日付が見つからない', false], '更新日不明');
  const last = logs[logs.length - 1], prev = logs[logs.length - 2];
  ok(/^完了: 診断 8件 \/ 50〜70点 5件 \/ 7日以内に更新 4件 → /.test(prev), '完了ログ: ' + prev);
  ok(/更新日が分からなかった: 1件/.test(last) && /エラー: 1件/.test(last), '不明・エラー件数ログ: ' + last);
  eq(st.hitCount, 4, '戻り値の該当件数');

  // 7日の境界: days=6 なら 7日前(d)は外れる
  const out2 = OUT('p2.csv');
  await runPhoneList({ rows, scan: fakeScan([]), detect: fakeDetect([]), out: out2, days: 6, now: () => NOW, log: () => {} });
  eq(readCsv(out2).slice(1).map((r) => r[14]), ['1', '11', '3'], 'days=6');

  // 点数の範囲を変える(min=max=30 なら b だけ)
  const out3 = OUT('p3.csv'); const d3 = [];
  await runPhoneList({ rows, scan: fakeScan([]), detect: fakeDetect(d3), out: out3, minScore: 30, maxScore: 30, days: 365, now: () => NOW, log: () => {} });
  eq(d3, ['b'], '範囲=30〜30 なら b だけ detect');

  // 進捗ログ(20件ごと)
  {
    const many = Array.from({ length: 45 }, (_, i) => mk(100 + i, '090-0000-' + String(1000 + i), `https://a${i}.example.jp/`));
    const lg = [];
    await runPhoneList({ rows: many, scan: async () => ({ results: [], grade: 'C', score: 60 }), detect: async () => ({ date: new Date('2026-10-26T00:00:00+09:00'), source: 'rss', url: '', title: '', note: '' }),
      out: OUT('p4.csv'), concurrency: 4, now: () => NOW, log: (m) => lg.push(m) });
    const prog = lg.filter((m) => /^\[\d+\/45\]/.test(m));
    eq(prog.length, 2, '20件ごとの進捗ログ');
    ok(/^\[20\/45\] 範囲内 \d+件 \/ 該当 \d+件 \/ エラー 0件 \/ 残り約\d+分$/.test(prog[0]), '進捗ログの形式: ' + prog[0]);
    eq(readCsv(OUT('p4.csv')).length, 46, '45件+見出し');
  }

  // limit
  {
    const lg = [];
    const o = OUT('p5.csv');
    await runPhoneList({ rows, scan: fakeScan([]), detect: fakeDetect([]), out: o, limit: 2, now: () => NOW, log: (m) => lg.push(m) });
    eq(fs.readFileSync(o + '.jsonl', 'utf8').trim().split('\n').length, 2, 'limit は電話整理のあと');
  }

  // 中断 → resume
  {
    const o = OUT('p6.csv');
    let n = 0;
    const s1 = [];
    await runPhoneList({ rows, scan: fakeScan(s1), detect: fakeDetect([]), out: o, concurrency: 1, isStopped: () => n++ >= 3, now: () => NOW, log: () => {} });
    const first = fs.readFileSync(o + '.jsonl', 'utf8').trim().split('\n').length;
    eq(first, 3, '途中で止まる');
    ok(fs.existsSync(o), '止まってもCSVは書く');
    const s2 = [];
    const lg = [];
    await runPhoneList({ rows, scan: fakeScan(s2), detect: fakeDetect([]), out: o, resume: true, now: () => NOW, log: (m) => lg.push(m) });
    eq(fs.readFileSync(o + '.jsonl', 'utf8').trim().split('\n').length, 9, 'resume で残りだけ追記');
    eq(s2.length > 0 && s2.every((h) => !s1.includes(h) || h === 'a' || h === 'h'), true, '済みは飛ばす');
    eq(readCsv(o).slice(1).map((r) => r[14]), ['1', '11', '3', '4'], 'resume後のCSVは全体から作る');
    // resume でないときは記録を作り直す
    await runPhoneList({ rows: rows.slice(0, 1), scan: fakeScan([]), detect: fakeDetect([]), out: o, now: () => NOW, log: () => {} });
    eq(fs.readFileSync(o + '.jsonl', 'utf8').trim().split('\n').length, 1, '--resume なしは作り直し');
  }

  // ---- GBP(偽の係を注入) ----
  {
    eq(hitReasonsOf({ latest: '2026-10-25', daysAgo: 2, gbp: null }, 7), ['WEB'], 'hitReasonsOf: WEBだけ');
    eq(hitReasonsOf({ latest: '', daysAgo: null, gbp: { post: { approxDays: 7 }, ownerReply: { approxDays: 8 }, review: { approxDays: 1 } } }, 7), ['GBP投稿'], 'hitReasonsOf: 7日は含む・返信8日は外す・口コミは使わない');
    eq(hitReasonsOf({ latest: '2026-10-01', daysAgo: 26, gbp: { post: { approxDays: 3 }, ownerReply: { approxDays: 2 } } }, 7), ['GBP投稿', 'オーナー返信'], 'hitReasonsOf: 2つ');
    eq(gbpLabel({ post: { raw: '2 週間前' }, ownerReply: { raw: '3 日前' }, review: { raw: '1 か月前' } }), '投稿2 週間前/返信3 日前/口コミ1 か月前', 'GBPの表記');
    eq(gbpLabel({ post: null, ownerReply: null, review: { raw: '昨日' } }), '口コミ昨日', 'GBPの表記(口コミだけ)');

    const part = (days, raw) => ({ date: new Date(NOW.getTime() - days * 86400e3), raw, approxDays: days, precision: 'day' });
    const g = (extra = {}) => ({ url: '', ok: true, blocked: false, post: null, ownerReply: null, review: null, note: '', debug: {}, ...extra });
    const gmap = {
      '1111111111': g({ post: part(14, '2 週間前'), review: part(3, '3 日前') }),                // WEB(a)は2日前 → WEB のみ(投稿は範囲外)
      '3333333333': g({ post: part(3, '3 日前'), ownerReply: part(1, '昨日'), review: part(40, '1 か月前') }), // c(WEB 6日前) + 投稿 + 返信
      '4444444444': g({ ownerReply: part(21, '3 週間前'), review: part(1, '昨日') }),         // d(WEB 7日前)。返信は範囲外・口コミは判定に使わない → WEB のみ
      '1010101010': g({ post: part(5, '5 日前') }),                                           // h(更新日なし) → GBP投稿だけで該当
      '9999999999': g({ review: part(0, 'たった今') }),                                       // 範囲内でも口コミだけなら該当しない
    };
    const calls = []; let closed = 0; let stopped = 0;
    const fakeGbp = {
      async check(row) { calls.push(row.cid); await new Promise((r) => setTimeout(r, 2)); return gmap[row.cid] || g({ note: '見つからない' }); },
      async close() { closed++; }, stop() { stopped++; },
    };
    const grows = [
      mk(1, '079-222-0001', 'https://a.example.jp/', { cid: '1111111111' }),   // 60点 WEB 2日前
      mk(2, '079-222-0002', 'https://b.example.jp/', { cid: '2222222222' }),   // 30点 範囲外 → GBPは読まない
      mk(3, '079-222-0003', 'https://c.example.jp/', { cid: '3333333333' }),   // 70点 WEB 6日前 + 投稿3日前 + 返信1日前
      mk(4, '079-222-0004', 'https://d.example.jp/', { cid: '4444444444' }),   // 50点 WEB 7日前
      mk(5, '079-222-0005', 'https://h.example.jp/', { cid: '1010101010' }),   // 55点 WEB日付なし + 投稿5日前
      mk(6, '079-222-0006', 'https://k.example.jp/', { cid: '9999999999' }),   // 60点 WEBなし・口コミだけ → 該当しない
      mk(7, '079-222-0007', 'https://err2.example.jp/'),                       // 識別子なし → GBPは読まない(err2 は診断エラー)
    ];
    const lg = [];
    const o = OUT('g1.csv');
    const st = await runPhoneList({ rows: grows, scan: fakeScan([]), detect: fakeDetect([]), out: o, gbp: fakeGbp, concurrency: 3, now: () => NOW, log: (m) => lg.push(m) });
    eq(calls.slice().sort(), ['1010101010', '1111111111', '3333333333', '4444444444', '9999999999'], 'GBPは範囲内で識別子のある行だけ読む');
    eq([closed, stopped], [1, 0], '終了時に close(中断でなければ stop しない)');
    const t = readCsv(o);
    eq(t[0].length, COLUMNS.length, '列数');
    eq(t.slice(1).map((r) => r[14]), ['3', '1', '5', '4'], '並び: 一番新しい活動日(返信1日前=10-26 / WEB10-25 / 投稿10-22 / WEB10-20)');
    const by = Object.fromEntries(t.slice(1).map((r) => [r[14], r]));
    eq([by['3'][16], by['3'][17], by['3'][18], by['3'][19], by['3'][20], by['3'][21]],
      ['https://www.google.com/maps?cid=3333333333&hl=ja', '2026-10-24', '2026-10-26', '2026-09-17', '投稿3 日前/返信昨日/口コミ1 か月前', 'WEB・GBP投稿・オーナー返信'], 'GBP列と該当理由(WEB・投稿・返信)');
    eq([by['1'][17], by['1'][19], by['1'][20], by['1'][21]], ['2026-10-13', '2026-10-24', '投稿2 週間前/口コミ3 日前', 'WEB'], '範囲外の投稿・口コミは参考列に出るが該当理由はWEBだけ');
    eq([by['4'][21], by['4'][18]], ['WEB', '2026-10-06'], '返信3週間前・口コミ昨日は判定に使わない');
    eq([by['5'][9], by['5'][17], by['5'][21]], ['', '2026-10-22', 'GBP投稿'], 'WEBが分からなくてもGBP投稿で該当');
    ok(!by['6'], '口コミだけ新しい会社は該当にしない');
    const gl = lg.find((m) => m.startsWith('GBP:'));
    eq(gl, 'GBP: 調べた 5件 / 投稿あり 3件 / 返信あり 2件 / 確認画面で中止: いいえ', 'GBPの完了ログ');
    eq([st.hitCount, st.gbp.withPost, st.gbp.withReply, st.gbp.blocked], [4, 3, 2, false], '戻り値');
    const recs = fs.readFileSync(o + '.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const r3 = recs.find((r) => r.store_id === '3');
    eq([r3.hitReason, r3.cid, r3.gbpUrl, r3.gbp.post, r3.gbp.ownerReply.raw, r3.gbp.checked, r3.latestActivity],
      ['WEB・GBP投稿・オーナー返信', '3333333333', 'https://www.google.com/maps?cid=3333333333&hl=ja', { date: '2026-10-24', raw: '3 日前', approxDays: 3, precision: 'day' }, '昨日', true, '2026-10-26'], 'jsonl の gbp・hitReason・識別子');
    eq(recs.find((r) => r.store_id === '2').gbp, null, '読んでいない行は gbp=null');
    eq(recs.filter((r) => r.store_id === '7')[0].gbpUrl, '', '識別子なしは gbpUrl が空');
  }

  // GBP: WEB側をGBPの待ちで止めない(GBPが遅くてもWEBの記録は先に書かれる)・--resume・中断・確認画面・Playwright未導入
  {
    const order = [];
    const slow = { async check(row) { await new Promise((r) => setTimeout(r, 60)); order.push('gbp' + row.store_id); return { ok: true, blocked: false, post: { date: new Date(NOW.getTime() - 86400e3), raw: '昨日', approxDays: 1, precision: 'day' }, note: '' }; }, async close() {} };
    const rowsG = [mk(1, '079-333-0001', 'https://a.example.jp/', { cid: '1111111111' }), mk(2, '079-333-0002', 'https://c.example.jp/', { cid: '3333333333' }), mk(3, '079-333-0003', 'https://d.example.jp/')];
    const o = OUT('g2.csv');
    let detDone = 0;
    await runPhoneList({ rows: rowsG, scan: fakeScan([]), detect: async (u) => { detDone++; order.push('web' + new URL(u).hostname.split('.')[0]); return { date: null, note: '' }; }, out: o, gbp: slow, concurrency: 3, now: () => NOW, log: () => {} });
    ok(order.indexOf('weba') < order.indexOf('gbp1') && order.indexOf('webc') < order.indexOf('gbp1'), 'WEBの判定はGBPを待たない: ' + order.join(','));
    eq(fs.readFileSync(o + '.jsonl', 'utf8').trim().split('\n').length, 3, '全行が記録される');
    // resume: 済みは飛ばし、GBPも読み直さない
    const calls = [];
    await runPhoneList({ rows: rowsG, scan: fakeScan([]), detect: fakeDetect([]), out: o, resume: true, gbp: { async check(r) { calls.push(r.cid); return { ok: true }; }, async close() {} }, now: () => NOW, log: () => {} });
    eq(calls, [], 'resume: 済みの行のGBPは読まない');
    eq(readCsv(o).length > 1, true, 'resume後もCSVを作る');
  }
  {
    // 確認画面で中止: 以降の行の note と、完了ログ
    const rowsB = [mk(1, '079-444-0001', 'https://a.example.jp/', { cid: '1111111111' }), mk(2, '079-444-0002', 'https://c.example.jp/', { cid: '3333333333' })];
    let n = 0;
    const blocker = { async check() { n++; return n === 1 ? { ok: false, blocked: true, note: 'Googleの確認画面が出たため中止' } : { ok: false, blocked: true, note: 'Googleの確認画面が出たため中止' }; }, async close() {} };
    const lg = []; const o = OUT('g3.csv');
    const st = await runPhoneList({ rows: rowsB, scan: fakeScan([]), detect: fakeDetect([]), out: o, gbp: blocker, concurrency: 1, now: () => NOW, log: (m) => lg.push(m) });
    ok(lg.some((m) => m === 'GBP: 調べた 0件 / 投稿あり 0件 / 返信あり 0件 / 確認画面で中止: はい(以降のGBPは調べていません)'), '確認画面で中止のログ: ' + lg.join(' | '));
    const recs = fs.readFileSync(o + '.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    eq(recs.map((r) => [r.gbp.blocked, r.gbp.note]), [[true, 'Googleの確認画面が出たため中止'], [true, 'Googleの確認画面が出たため中止']], '中止の note が記録される');
    eq(st.hitCount, 2, 'WEBの該当は影響を受けない');
  }
  {
    // 中断(aborted)した行は記録しない(resume でやり直せる)・例外でもブラウザは閉じる
    let closed = 0;
    const abortGbp = { async check() { return { aborted: true, ok: false }; }, async close() { closed++; } };
    const o = OUT('g4.csv');
    await runPhoneList({ rows: [mk(1, '079-555-0001', 'https://a.example.jp/', { cid: '1111111111' })], scan: fakeScan([]), detect: fakeDetect([]), out: o, gbp: abortGbp, now: () => NOW, log: () => {} });
    eq(fs.readFileSync(o + '.jsonl', 'utf8').trim(), '', '中断で読まなかった行は記録しない');
    eq(closed, 1, 'close された');
    let closed2 = 0;
    let threw = false;
    try {
      await runPhoneList({ rows: [mk(1, '079-555-0002', 'https://a.example.jp/', { cid: '1111111111' })], scan: fakeScan([]), detect: fakeDetect([]), out: OUT('g5.csv'), gbp: { async check() { return { ok: true }; }, async close() { closed2++; } },
        now: () => NOW, isStopped: () => { throw new Error('途中で例外'); }, log: () => {} });
    } catch { threw = true; }
    eq([threw, closed2], [true, 1], '途中で例外が出てもブラウザは閉じる');
  }
  {
    // Playwright が無い環境(gbp:true・既定の係): 通常の診断は影響を受けず、GBP列は空・ログに導入手順
    let has = true; try { require.resolve('playwright'); } catch { has = false; }
    if (!has) {
      const lg = []; const o = OUT('g6.csv');
      const st = await runPhoneList({ rows: [mk(1, '079-666-0001', 'https://a.example.jp/', { cid: '1111111111' })], scan: fakeScan([]), detect: fakeDetect([]), out: o, gbp: true, now: () => NOW, log: (m) => lg.push(m) });
      ok(lg.some((m) => m.includes('Playwrightが未導入のためGBPは調べていません(npm i playwright && npx playwright install --with-deps chromium)')), 'Playwright未導入のログ');
      eq([st.hitCount, readCsv(o)[1][21]], [1, 'WEB'], 'Playwright未導入でもWEBの判定は動く');
    }
  }

  // ---- buildPhoneListArgs ----
  {
    const exportDir = '/var/exports';
    const now = new Date(2026, 9, 27, 13, 5, 9);
    const x = buildPhoneListArgs({ pref: '兵庫県' }, { exportDir, now });
    eq(x.args, ['cli/phone-list.js', '--prefecture', '兵庫県', '--min-score', '50', '--max-score', '70', '--days', '7', '--limit', '3000', '--concurrency', '5', '--out', path.join(exportDir, 'phone_list_20261027-130509.csv')], '既定値(業種空=絞らない)');
    eq([x.exportFile, x.estimateHours, x.preset], ['phone_list_20261027-130509.csv', 2, 'phonelist'], 'ファイル名・時間の目安');
    const y = buildPhoneListArgs({ pref: ['兵庫県', '大阪府', '兵庫県'], main_category: '製造、建設 工務店', size: 'small_only', min_score: '40', max_score: '60', days: '14', limit: '500' }, { exportDir, now });
    eq(y.args.slice(0, 6), ['cli/phone-list.js', '--prefecture', '兵庫県,大阪府', '--main-category', '製造,建設,工務店', '--small-only'], '業種・規模');
    eq([y.minScore, y.maxScore, y.days, y.limit, y.estimateHours], [40, 60, 14, 500, 1], '指定値');
    ok(buildPhoneListArgs({ pref: ['東京都'], size: 'exclude_large' }, { exportDir, now }).args.includes('--exclude-large'), '大きい会社を除く');
    ok(!x.args.includes('--gbp') && x.gbp === false, 'GBPのチェック無しなら --gbp を付けない');
    const gg = buildPhoneListArgs({ pref: '兵庫県', gbp: '1' }, { exportDir, now });
    eq([gg.gbp, gg.args.includes('--gbp'), gg.args[gg.args.length - 2]], [true, true, '--out'], 'GBPのチェックあり: --gbp を付ける(--out の前)');
    eq(buildPhoneListArgs({ pref: '兵庫県', gbp: ['', '1'] }, { exportDir, now }).gbp, true, 'GBP: 配列でも読める');
    eq(buildPhoneListArgs({ pref: '兵庫県', gbp: '0' }, { exportDir, now }).gbp, false, 'GBP: 0 は無効');
    ok(buildPhoneListArgs({}, { exportDir, now }).error, '県なし');
    ok(buildPhoneListArgs({ pref: ['火星県'] }, { exportDir, now }).error, '県が不正');
    ok(buildPhoneListArgs({ pref: ['兵庫県'], min_score: '80', max_score: '70' }, { exportDir, now }).error, '下限>上限');
    ok(buildPhoneListArgs({ pref: ['兵庫県'], min_score: '-1' }, { exportDir, now }).error, '点数が負');
    ok(buildPhoneListArgs({ pref: ['兵庫県'], max_score: '101' }, { exportDir, now }).error, '点数が101');
    ok(buildPhoneListArgs({ pref: ['兵庫県'], min_score: '5.5' }, { exportDir, now }).error, '点数が小数');
    ok(buildPhoneListArgs({ pref: ['兵庫県'], days: '0' }, { exportDir, now }).error, '日数0');
    ok(buildPhoneListArgs({ pref: ['兵庫県'], days: '366' }, { exportDir, now }).error, '日数366');
    ok(buildPhoneListArgs({ pref: ['兵庫県'], limit: '1;x' }, { exportDir, now }).error, '上限が不正');
    ok(buildPhoneListArgs({ pref: ['兵庫県'], limit: '1000001' }, { exportDir, now }).error, '上限が大きすぎ');
    ok(buildPhoneListArgs({ pref: ['兵庫県'], main_category: 'あ'.repeat(21) }, { exportDir, now }).error, '業種が長すぎ');
    eq(buildPhoneListArgs({ pref: ['兵庫県'], min_score: ' ', max_score: '', days: '', limit: '' }, { exportDir, now }).args.includes('3000'), true, '空欄は既定値');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`phone: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
