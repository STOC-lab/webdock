'use strict';
// score-scan の syncStocPending(営業管理への自動写し)のテスト。DB不要(pool はモック)
const { syncStocPending } = require('../cli/score-scan');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);

(async () => {
  // prefecture なし
  let calls = [], logs = [];
  let pool = { query: async (sql, params) => { calls.push({ sql, params }); return [{ affectedRows: 3 }]; } };
  let n = await syncStocPending(pool, { db: 'stoc_sales', log: (m) => logs.push(m) });
  eq(n, 3, 'affectedRows を返す');
  ok(calls[0].sql.startsWith('UPDATE stoc_sales.stores st JOIN stoc_master.shops s ON s.stoc_store_id = st.id SET'), 'UPDATE ... JOIN');
  ok(calls[0].sql.includes('st.wd_scanned_at IS NULL OR st.wd_scanned_at <> s.wd_scanned_at'), '差分のみ');
  ok(!calls[0].sql.includes('prefecture'), 'prefectureなしは条件なし');
  eq(calls[0].params, [], 'paramsなし');
  eq(logs, ['[営業管理へ自動写し] 3件'], 'ログ');

  // prefecture あり
  calls = [];
  await syncStocPending(pool, { prefecture: ['兵庫県', '大阪府'], db: 'stoc_sales', log: () => {} });
  ok(calls[0].sql.endsWith('AND s.prefecture IN (?)'), 'prefecture条件');
  eq(calls[0].params, [['兵庫県', '大阪府']], 'prefectureパラメータ');

  // 0件はログなし
  logs = [];
  pool = { query: async () => [{ affectedRows: 0 }] };
  n = await syncStocPending(pool, { db: 'stoc_sales', log: (m) => logs.push(m) });
  eq([n, logs.length], [0, 0], '0件はログなし');

  // 例外はそのまま投げる(呼び出し側 main で握る)・不正なDB名は拒否
  pool = { query: async () => { throw new Error('boom'); } };
  let err = null;
  try { await syncStocPending(pool, { db: 'stoc_sales', log: () => {} }); } catch (e) { err = e; }
  eq(err && err.message, 'boom', '例外は呼び出し側へ');
  err = null;
  try { await syncStocPending({ query: async () => [{}] }, { db: 'x; DROP', log: () => {} }); } catch (e) { err = e; }
  ok(err, '不正なDB名は拒否');

  console.log(`scoresync: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
