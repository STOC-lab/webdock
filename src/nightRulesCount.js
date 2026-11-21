'use strict';

/**
 * 夜間フォーム探しの「業種ルールを通る残り」を、裏で60分に1回だけ数えて保存する。
 * 画面を開いたときには数えない(約68万行をJSでルール判定するため。画面は get() で保存済みの結果を読むだけ)。
 *   - 数え方は fetchPrioritized と同じ: 同じクエリ(優先+夜間)を id の大きい順に PAGE 件ずつ読み、isNoPhone とルールで判定
 *   - ページごとに待ちを入れて、Webの処理(イベントループ)を長く止めない
 *   - 同時に1つだけ。失敗したら10分後に再試行。結果は adminStats の保存先(キー nightRules)にも保存し、再起動後も使う
 */

const HOUR_MS = 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const TICK_MS = 60 * 1000;
const PAGE = 5000;
const KEY = 'nightRules';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const validate = (v) => v !== null && typeof v === 'object' && ['passing', 'excluded', 'scanned'].every((k) => isNum(v[k]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 全件を読んでルール判定した件数。{ passing(通る), excluded(ルールで外れる), scanned(電話ありの全数) }
 * buildQuery({ cursor, limit }) → { sql, params }。check は compileRules の結果(null ならルールなし)。
 */
async function scanRules({ pool, buildQuery, check, isNoPhone, pageSize = PAGE, pageDelayMs = 50, timeoutMs = 120000 }) {
  let cursor = null, passing = 0, excluded = 0;
  for (;;) {
    const { sql, params } = buildQuery({ cursor, limit: pageSize });
    const [rows] = await pool.query({ sql, values: params, timeout: timeoutMs });
    for (const r of rows) {
      cursor = { id: r.id };
      if (isNoPhone(r.phone)) continue;
      if (check && check(r)) excluded++; else passing++;
    }
    if (rows.length < pageSize) break;
    await sleep(pageDelayMs); // 次のページの前に、Webの他の処理に順番を譲る
  }
  return { passing, excluded, scanned: passing + excluded };
}

function createRulesCounter({ getPool, store = null, scan, now = () => Date.now(), intervalMs = HOUR_MS, retryMs = RETRY_MS, tickMs = TICK_MS, onError = () => {} }) {
  let value = null, at = null, error = null, running = false, lastAttempt = 0, timer = null;

  async function load() {
    if (!store) return;
    try {
      const saved = await store.readAll();
      const s = saved && saved[KEY];
      if (s && !value && Number.isFinite(s.at) && s.at > 0 && validate(s.value)) { value = s.value; at = s.at; }
    } catch (e) { onError(e); }
  }

  /** 実行中でなければ数え始める。戻り値の done は終わり待ち用 */
  function refresh() {
    if (running) return { started: false, done: null };
    running = true;
    lastAttempt = now();
    const done = (async () => {
      try {
        const t0 = now();
        const v = { ...(await scan(getPool())), ms: now() - t0 };
        value = v; at = now(); error = null;
        if (store) { try { await store.write(KEY, v, at); } catch (e) { onError(e); } }
      } catch (e) {
        error = String((e && e.message) || e);
        lastAttempt = now(); // 再試行の10分は「失敗した時刻」から数える(時間のかかった集計が失敗しても、すぐ全件を数え直さない)
        onError(e);
      } finally { running = false; }
    })();
    return { started: true, done };
  }

  function due() {
    if (running) return false;
    if (error && now() - lastAttempt < retryMs) return false;
    return !at || now() - at >= intervalMs;
  }

  return {
    refresh,
    due,
    get: () => ({ value, at, error, running, intervalMin: Math.round(intervalMs / 60000) }),
    async start() {
      if (timer) return;
      await load();
      const tick = () => { if (due()) refresh(); };
      timer = setInterval(tick, tickMs);
      if (timer.unref) timer.unref();
      tick();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

module.exports = { createRulesCounter, scanRules, validate, KEY, PAGE };
