'use strict';
// 「業種ルールを通る残り」の裏集計(src/nightRulesCount.js)のテスト(DB不要)
const { createRulesCounter, scanRules, validate } = require('../src/nightRulesCount');
let pass = 0, fail = 0;
const eq = (a, b, m) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.log('  x ' + m + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); } };

(async () => {
  // ページ送り(id の大きい順の cursor)・電話なし/ルール外の数え分け・ページ間の待ち
  const all = [];
  for (let i = 12; i >= 1; i--) all.push({ id: i, phone: i % 4 === 0 ? '' : '078', name: i % 3 === 0 ? '市役所' : 'x' });
  const cursors = [];
  const pool = { async query({ values }) { cursors.push(values[0]); const cur = values[0]; const rows = all.filter((r) => cur === null || r.id < cur).slice(0, 5); return [rows]; } };
  const check = (r) => (r.name === '市役所' ? { keyword: '市役所' } : null);
  const res = await scanRules({ pool, pageSize: 5, pageDelayMs: 0, isNoPhone: (p) => !p, check,
    buildQuery: ({ cursor, limit }) => ({ sql: 'q', params: [cursor ? cursor.id : null, limit] }) });
  // 電話あり: id 1,2,3,5,6,7,9,10,11 → 市役所(3の倍数)=3,6,9 の3件が外れる
  eq(res, { passing: 6, excluded: 3, scanned: 9 }, '件数');
  eq(cursors, [null, 8, 3], 'cursor でページ送り');

  // 60分に1回: 間隔内は始めない / 過ぎたら始める / 同時に1つ / 失敗は10分後
  let t = 1000000, calls = 0, fails = false;
  const rc = createRulesCounter({ getPool: () => ({}), scan: async () => { calls++; if (fails) throw new Error('boom'); return { passing: 1, excluded: 2, scanned: 3 }; }, now: () => t, onError: () => {} });
  eq(rc.get().value, null, '最初は結果なし(画面は「集計中」)');
  eq(rc.due(), true, '初回は集計する');
  const r1 = rc.refresh(); eq(rc.refresh().started, false, '同時に1つだけ'); await r1.done;
  eq([calls, rc.get().value.passing, rc.get().at], [1, 1, 1000000], '結果と時刻');
  t += 59 * 60000; eq(rc.due(), false, '59分後はまだ');
  t += 2 * 60000; eq(rc.due(), true, '61分後は集計する');
  fails = true; await rc.refresh().done;
  eq([!!rc.get().error, rc.get().value.passing], [true, 1], '失敗しても前回の結果を残す');
  t += 5 * 60000; eq(rc.due(), false, '失敗後10分は再試行しない');
  t += 6 * 60000; eq(rc.due(), true, '失敗後10分たてば再試行');

  // 時間のかかった集計が失敗したとき: 10分は「失敗した時刻」から数える(開始時刻からではない)
  let t2 = 5000000;
  const slow = createRulesCounter({ getPool: () => ({}), scan: async () => { t2 += 15 * 60000; throw new Error('timeout'); }, now: () => t2, onError: () => {} });
  await slow.refresh().done;
  eq(slow.get().running, false, '失敗後は実行中ではない');
  t2 += 60000; eq(slow.due(), false, '15分かかって失敗した直後(1分後)は再試行しない');
  t2 += 10 * 60000; eq(slow.due(), true, '失敗から10分たてば再試行');

  // 画面の「○分に1回」は実際の間隔(ADMIN_RULES_COUNT_MINUTES)に合わせる
  eq(createRulesCounter({ getPool: () => ({}), scan: async () => ({}), intervalMs: 30 * 60000 }).get().intervalMin, 30, '集計間隔(分)を画面に渡す');

  // start() を同時に2回呼んでもタイマーは1つ(stop() で全部止まる)
  { let scans = 0; const st = { async readAll() { await new Promise((r) => setTimeout(r, 20)); return {}; }, async write() { return true; } };
    const d = createRulesCounter({ getPool: () => ({}), store: st, scan: async () => { scans++; return { passing: 1, excluded: 0, scanned: 1 }; }, tickMs: 1e9 });
    await Promise.all([d.start(), d.start()]); await new Promise((r) => setTimeout(r, 10)); d.stop();
    eq(scans, 1, 'start() の二重呼び出しでも集計は1回'); }

  // 保存・再起動後の読み込み
  const rows = {};
  const store = { async readAll() { return rows; }, async write(k, v, at) { rows[k] = { value: v, at }; return true; } };
  t = 5000000; fails = false;
  const a = createRulesCounter({ getPool: () => ({}), store, scan: async () => ({ passing: 7, excluded: 1, scanned: 8 }), now: () => t, tickMs: 1e9 });
  await a.refresh().done;
  const b = createRulesCounter({ getPool: () => ({}), store, scan: async () => { throw new Error('呼ばれない'); }, now: () => t + 1000, tickMs: 1e9 });
  await b.start(); b.stop();
  eq([b.get().value.passing, b.get().at], [7, 5000000], '再起動後は保存済みを読む(すぐ再集計しない)');
  eq([validate({ passing: 1, excluded: 2, scanned: 3 }), validate({ passing: 'x' }), validate(null)], [true, false, false], '検証');

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
