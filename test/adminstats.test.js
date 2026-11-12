'use strict';
// 管理画面の集計の裏実行・保存(src/adminStats.js)のテスト(DB不要)
const { createStatsRefresher, makeSnapshotStore, validators } = require('../src/adminStats');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);
const tick = () => new Promise((r) => setImmediate(r));

function memStore() {
  const rows = {};
  return { rows, async readAll() { return JSON.parse(JSON.stringify(rows)); }, async write(k, v, at) { rows[k] = { value: JSON.parse(JSON.stringify(v)), at }; return true; } };
}

(async () => {
  // ---- 同時に1つだけ ----
  {
    let calls = 0, release;
    const gate = new Promise((r) => { release = r; });
    const rf = createStatsRefresher({ jobs: { a: async () => { calls++; await gate; return { n: 1 }; } }, store: null });
    const r1 = rf.refreshAll();
    const r2 = rf.refreshAll();
    eq([r1.started, r2.started], [true, false], '実行中は新しく始めない');
    ok(rf.isRunning() && rf.get('a').running, '実行中の表示');
    release();
    await r1.done;
    eq(calls, 1, '集計は1回だけ');
    eq(rf.get('a').value, { n: 1 }, '結果を保存');
    ok(!rf.isRunning(), '終わったら実行中でない');
    eq(rf.refreshAll().started, true, '終わったら次を始められる');
  }

  // ---- 画面側の読み取りはジョブを走らせない / 結果なしは null ----
  {
    let calls = 0;
    const rf = createStatsRefresher({ jobs: { a: async () => { calls++; return 1; } }, store: null });
    eq(rf.get('a'), { value: null, at: null, error: null, running: false }, '結果がなければ value=null');
    rf.get('a'); rf.get('a');
    eq(calls, 0, 'get は集計を走らせない');
  }

  // ---- 失敗しても前回の結果を残す・次のジョブは続ける ----
  {
    let n = 0; const errs = [];
    const rf = createStatsRefresher({ jobs: { a: async () => { n++; if (n === 2) throw new Error('boom'); return { n }; }, b: async () => 'b' }, store: null, now: () => 1000, onError: (k, e) => errs.push(k + ':' + e.message) });
    await rf.refreshAll().done;
    await rf.refreshAll().done;
    const a = rf.get('a');
    eq([a.value, a.at, !!a.error], [{ n: 1 }, 1000, true], '失敗しても前回の結果と時刻が残り、error が付く');
    eq(rf.get('b').value, 'b', '1つ失敗しても残りは実行');
    eq(errs, ['a:boom'], 'onError に通知');
    await rf.refreshAll().done;
    eq([rf.get('a').value, rf.get('a').error], [{ n: 3 }, null], '成功すれば error が消える');
  }

  // ---- 保存と再起動後の読み込み ----
  {
    const store = memStore();
    let t = 5000;
    const rf = createStatsRefresher({ jobs: { a: async () => ({ x: 1 }) }, store, now: () => t });
    await rf.refreshAll().done;
    eq(store.rows.a, { value: { x: 1 }, at: 5000 }, '表に保存');
    let called = 0;
    const rf2 = createStatsRefresher({ jobs: { a: async () => { called++; return { x: 2 }; } }, store, now: () => t });
    await rf2.load();
    eq([rf2.get('a').value, rf2.get('a').at], [{ x: 1 }, 5000], '再起動後は保存済みの結果をすぐ読める');
    eq(called, 0, '読み込みだけでは集計しない');
  }

  // ---- 間隔: 昼5分 / 夜間の時間帯10分、間隔内なら始めない ----
  {
    let t = new Date(2026, 10, 12, 14, 0, 0).getTime(); // 昼(14時)
    let calls = 0;
    const sched = { start: 22, end: 6, enabled: true, from: null };
    const rf = createStatsRefresher({ jobs: { a: async () => { calls++; return 1; } }, store: null, getSchedule: async () => sched, now: () => t });
    await rf.tick(); while (rf.isRunning()) await tick(); // 最初の集計(tick が始める)
    eq(calls, 1, '最初は集計');
    t += 4 * 60000; await rf.tick(); await tick();
    eq(calls, 1, '昼: 4分後はまだ');
    t += 61000; await rf.tick(); await rf.get('a'); while (rf.isRunning()) await tick();
    eq(calls, 2, '昼: 5分たったら集計');
    // 夜間
    t = new Date(2026, 10, 12, 23, 0, 0).getTime();
    await rf.tick(); while (rf.isRunning()) await tick();
    eq(calls, 3, '夜に入って間隔超過なら集計');
    t += 6 * 60000; await rf.tick(); await tick();
    eq(calls, 3, '夜間: 6分後はまだ(10分おき)');
    t += 5 * 60000; await rf.tick(); while (rf.isRunning()) await tick();
    eq(calls, 4, '夜間: 10分たったら集計');
  }

  // ---- 再起動直後に保存結果が新しければ、すぐには集計しない ----
  {
    const store = memStore(); store.rows.a = { value: 7, at: 100000 };
    let calls = 0;
    const rf = createStatsRefresher({ jobs: { a: async () => { calls++; return 8; } }, store, now: () => 100000 + 60000 });
    await rf.load(); await rf.tick(); await tick();
    eq([calls, rf.get('a').value], [0, 7], '新しい保存結果があれば再起動しても重い集計を始めない');
  }

  // ---- 設定が読めないときは昼の間隔 ----
  {
    let calls = 0, t = 1000000;
    const rf = createStatsRefresher({ jobs: { a: async () => { calls++; return 1; } }, store: null, getSchedule: async () => { throw new Error('db down'); }, now: () => t });
    await rf.refreshAll().done; t += 5 * 60000 + 1; await rf.tick(); while (rf.isRunning()) await tick();
    eq(calls, 2, '設定が読めなくても昼の間隔で動く');
  }

  // ---- 再起動直後: 最初の集計が終わる前でも、保存済みの前回の結果を表示できる ----
  {
    const saved = { total: 5, rows: [{ prefecture: '兵庫県', total: 5, web: 1, linked: 1, form: 0 }] };
    const store = memStore(); store.rows.status = { value: saved, at: 111000 };
    let release; const gate = new Promise((r) => { release = r; });
    const rf = createStatsRefresher({ jobs: { status: async () => { await gate; return { ...saved, total: 6 }; } }, store, validate: validators, now: () => 111000 + 10 * 60000 });
    await rf.start(); // 保存済みの読み込みが終わってから返る
    await rf.whenLoaded();
    const g = rf.get('status');
    eq([g.value, g.at, g.running], [saved, 111000, true], '再起動直後: 集計が終わる前でも前回の結果が読める(空にならない)・裏で再集計中');
    release(); while (rf.isRunning()) await tick();
    eq(rf.get('status').value.total, 6, '集計が終わったら新しい結果に変わる');
    rf.stop();
  }

  // ---- 保存済みの読み込みが応答しなくても、集計は始まる ----
  {
    let calls = 0;
    const hang = { readAll: () => new Promise(() => {}), write: async () => true };
    const rf = createStatsRefresher({ jobs: { a: async () => { calls++; return 1; } }, store: hang, loadTimeoutMs: 20 });
    await rf.start();
    while (rf.isRunning()) await tick();
    eq([calls, rf.get('a').value], [1, 1], '読み込みが固まっても start は戻り、集計が動く');
    rf.stop();
  }

  // ---- 保存が固まっても、実行中のままにならず、後続の集計も続く ----
  {
    const errs = [];
    const hangWrite = { readAll: async () => ({}), write: () => new Promise(() => {}) };
    const rf = createStatsRefresher({ jobs: { a: async () => 1, b: async () => 2 }, store: hangWrite, writeTimeoutMs: 20, onError: (k) => errs.push(k) });
    await rf.refreshAll().done;
    eq([rf.get('a').value, rf.get('b').value, rf.isRunning()], [1, 2, false], '保存が固まっても結果は表示でき、後続の集計も実行され、実行中のままにならない');
    eq(errs, ['a', 'b'], '保存の失敗を記録する');
    eq(rf.refreshAll().started, true, '次の集計も始められる');
    await rf.get('a');
  }
  // ---- 集計が長引いている間は、次を始めない(元の処理を打ち切らない) ----
  {
    let release, calls = 0; const gate = new Promise((r) => { release = r; });
    const rf = createStatsRefresher({ jobs: { a: async () => { calls++; await gate; return 1; } }, store: null });
    const r1 = rf.refreshAll();
    await new Promise((r) => setTimeout(r, 30));
    eq([rf.refreshAll().started, rf.isRunning(), calls], [false, true, 1], '長引いても実行中のまま・重複して始めない');
    release(); await r1.done;
    eq(rf.isRunning(), false, '終わったら解除');
  }
  // ---- 読み込みが遅れ、先に初回の集計が失敗した場合でも、保存済みの結果を復元する ----
  {
    let releaseRead; const readGate = new Promise((r) => { releaseRead = r; });
    const st = { value: 3, at: 5000 };
    const store = { readAll: async () => { await readGate; return { a: st }; }, write: async () => true };
    const rf = createStatsRefresher({ jobs: { a: async () => { throw new Error('fail'); } }, store, loadTimeoutMs: 20, onError: () => {} });
    await rf.start(); // 読み込みは待ちの上限で先へ進む
    while (rf.isRunning()) await tick();
    eq([rf.get('a').value, !!rf.get('a').error], [null, true], '先に集計が失敗: 値なし・失敗の情報あり');
    releaseRead(); await rf.whenLoaded();
    const g = rf.get('a');
    eq([g.value, g.at, !!g.error], [3, 5000, true], '遅れて読めた保存済みの結果を復元し、失敗の情報も残す');
    rf.stop();
  }

  // ---- 壊れた保存値は読み込まない(画面が例外にならない) ----
  {
    const good = { since: '2026-11-08 22:00:00', totals: { found: 1, none: 0, needs: 0, err: 0, tonight: 0, remaining: 2 }, rows: [], reasons: [] };
    ok(validators.night(good), '夜間: 正しい形は通る');
    ok(!validators.night({}), '夜間: {} は不正');
    ok(!validators.night({ ...good, since: 5 }), '夜間: since が文字列でない');
    ok(!validators.night({ ...good, totals: { found: 1 } }), '夜間: totals の欠け');
    ok(!validators.night({ ...good, reasons: [{ note: 1, n: 1 }] }), '夜間: reasons の形');
    ok(!validators.night(null) && !validators.night([]), '夜間: null・配列は不正');
    const st = { total: 1, rows: [{ prefecture: 'A', total: 1, web: 0, linked: 0, form: 0 }] };
    ok(validators.status(st), '状況: 正しい形は通る');
    ok(!validators.status({ total: 1 }) && !validators.status({ total: '1', rows: [] }) && !validators.status({ total: 1, rows: [{ prefecture: 'A' }] }), '状況: 不正な形');
    const store = memStore(); store.rows.night = { value: {}, at: 1000 }; store.rows.status = { value: st, at: 0 };
    const errs = [];
    const rf = createStatsRefresher({ jobs: { night: async () => good, status: async () => st }, store, validate: validators, onError: (k) => errs.push(k) });
    await rf.load();
    eq([rf.get('night').value, rf.get('status').value], [null, null], '壊れた保存値・時刻なしは読み込まない');
    eq(errs.sort(), ['night', 'status'], '読み飛ばしを記録する');
  }

  // ---- 保存先(DB)の読み書き ----
  {
    const queries = [];
    const pool = { async query(q) { const sql = q.sql, p = q.values; queries.push([sql, p, q.timeout]); if (/SELECT/.test(sql)) return [[{ k: 'a', value_json: '{"x":1}', computed_ms: '123' }, { k: 'bad', value_json: '{oops', computed_ms: '1' }]]; return [{}]; } };
    const st = makeSnapshotStore(pool);
    eq(await st.readAll(), { a: { value: { x: 1 }, at: 123 } }, '読み込み: 壊れた行は読み飛ばす');
    eq(await st.write('a', { y: 2 }, 456), true, '書き込み');
    ok(/ON DUPLICATE KEY UPDATE/.test(queries[1][0]) && queries[1][1][0] === 'a' && queries[1][1][1] === '{"y":2}' && queries[1][1][2] === 456, '何度書いても1行(upsert)');
    ok(queries[0][2] > 0 && queries[1][2] > 0, '読み書きともDB側のタイムアウトを付ける');
    const missing = { async query() { const e = new Error("Table doesn't exist"); e.errno = 1146; throw e; } };
    const st2 = makeSnapshotStore(missing);
    eq([await st2.readAll(), await st2.write('a', 1, 1)], [null, false], '表が無いときは何もしない(エラーにしない)');
    const broken = { async query() { const e = new Error('lost'); e.errno = 2013; throw e; } };
    let threw = false; try { await makeSnapshotStore(broken).readAll(); } catch { threw = true; }
    ok(threw, 'その他のエラーは投げる(呼び出し側が記録する)');
  }

  console.log(`adminstats: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
