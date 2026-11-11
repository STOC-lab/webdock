'use strict';
/**
 * 夜間のフォーム探し用の共通部品(find-forms.js の --night から使う)。
 *  - 時間帯の設定(stoc_master.form_finder_settings。表が無ければ .env、それも無ければ 22時〜6時)
 *  - ホストの門番(stoc_master.form_host_visits): 同じホストを複数のプロセスが同時に訪問しない・10秒以上あける・
 *    7日以内に調べた結果は取得せず使い回す
 *  - エラーの種類分けと、一時的なエラーの再試行・404のときのトップ再試行
 * DB は pool(mysql2/promise)を渡す。テストでは store を差し替える。
 */

const DEFAULT_START = 22;
const DEFAULT_END = 6;
const SETTINGS_TABLE = 'stoc_master.form_finder_settings';
const HOSTS_TABLE = 'stoc_master.form_host_visits';

/* ---------- 時間帯 ---------- */
const parseHour = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
};

/** start〜end(時)の間か。start>end は日またぎ(22→6)。start===end は終日。end は含まない。 */
function inWindow(hour, start, end) {
  if (start === end) return true;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** 'YYYY-MM-DD HH:MM'(または T 区切り)をローカル時刻の Date に。不正なら null */
function parseFrom(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(String(v || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 設定(start, end, enabled, from)と現在時刻から、いま動いてよいか */
function isOpen(sched, now = new Date()) {
  if (!sched || sched.enabled === false) return false;
  const from = parseFrom(sched.from);
  if (from && now.getTime() < from.getTime()) return false;
  return inWindow(now.getHours(), sched.start, sched.end);
}

/** 画面用: 「今夜」の開始時刻(いまが時間帯の中ならその開始、外なら直近の開始) */
function windowStartOf(sched, now = new Date()) {
  const d = new Date(now.getTime());
  d.setMinutes(0, 0, 0);
  d.setHours(sched.start);
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1);
  return d;
}

function scheduleFromEnv(env = process.env) {
  const s = parseHour(env.FORM_NIGHT_START);
  const e = parseHour(env.FORM_NIGHT_END);
  return { start: s === null ? DEFAULT_START : s, end: e === null ? DEFAULT_END : e, enabled: true, from: null, source: s !== null || e !== null ? 'env' : 'default' };
}

function makeSettingsStore(pool) {
  return {
    /** 表が無いとき(errno 1146)は null */
    async read() {
      try {
        const [rows] = await pool.query(`SELECT k, v FROM ${SETTINGS_TABLE}`);
        const o = {};
        for (const r of rows) o[r.k] = r.v;
        return o;
      } catch (e) {
        if (e && e.errno === 1146) return null;
        throw e;
      }
    },
    async write(map) {
      for (const [k, v] of Object.entries(map)) {
        await pool.query(`INSERT INTO ${SETTINGS_TABLE} (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)`, [k, v === null ? '' : String(v)]);
      }
    },
  };
}

function scheduleFromRows(rows, env) {
  const fb = scheduleFromEnv(env);
  if (!rows) return fb;
  const s = parseHour(rows.night_start);
  const e = parseHour(rows.night_end);
  const has = s !== null || e !== null || rows.night_enabled !== undefined || rows.night_from !== undefined;
  if (!has) return fb;
  return {
    start: s === null ? fb.start : s,
    end: e === null ? fb.end : e,
    enabled: rows.night_enabled === undefined ? true : String(rows.night_enabled) !== '0',
    from: rows.night_from ? String(rows.night_from) : null,
    source: 'db',
  };
}

/** 設定の読み取り係。30秒ごとに読み直し、同期で isOpenNow() を返せる(DBが読めないときは最後の値を使う) */
function createScheduleReader({ store, env = process.env, ttlMs = 30000, now = () => new Date(), onError = () => {} }) {
  let cur = scheduleFromEnv(env);
  let at = 0;
  let timer = null;
  async function refresh() {
    try { cur = scheduleFromRows(await store.read(), env); } catch (e) { onError(e); }
    at = Date.now();
    return cur;
  }
  return {
    refresh,
    async get() { if (Date.now() - at > ttlMs) await refresh(); return cur; },
    current: () => cur,
    isOpenNow: () => isOpen(cur, now()),
    start() { if (!timer) { timer = setInterval(refresh, ttlMs); if (timer.unref) timer.unref(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

/* ---------- エラーの種類 ---------- */
// 一時的: 間を置けば直るかもしれない / 永続的: 当分直らない(90日あける) / 404: トップを試す
const TRANSIENT_RE = /^HTTP (?:500|502|503|504|429|408)$|サイトへ接続できませんでした|サイトの応答がありませんでした|タイムアウト|制限時間|取得に失敗しました|調査に失敗しました/;
const PERMANENT_RE = /^HTTP (?:403|401|410)$|^ドメインが見つかりませんでした|^この宛先は診断できません|^IPアドレスの直接指定/;
function classifyError(note) {
  const s = String(note || '');
  if (/^HTTP 404$/.test(s)) return 'notfound';
  if (PERMANENT_RE.test(s)) return 'permanent';
  if (TRANSIENT_RE.test(s)) return 'transient';
  return 'other';
}

/** SQL: 永続的なエラー(再試行を90日あける)の form_note 条件。NULL でも真偽が決まるようにしてある */
const PERMANENT_NOTE_SQL = "(COALESCE(form_note, '') IN ('HTTP 403', 'HTTP 401', 'HTTP 410') OR COALESCE(form_note, '') LIKE 'ドメインが見つかりませんでした%' OR COALESCE(form_note, '') LIKE 'この宛先は診断できません%' OR COALESCE(form_note, '') LIKE 'IPアドレスの直接指定%')";

const rootUrlOf = (url) => { try { const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : 'http://' + url); return u.origin + '/'; } catch { return null; } };
const sameUrl = (a, b) => String(a).replace(/\/+$/, '') === String(b).replace(/\/+$/, '');

/* ---------- ホストの門番 ---------- */
const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

/** DBの実装。時刻の比較はすべてDB側(NOW)で行い、複数プロセス・複数台でも同じ時計を使う */
function makeDbHostStore(pool) {
  return {
    async peek(host, reuseMs) {
      const [rows] = await pool.query(
        `SELECT holder, GREATEST(TIMESTAMPDIFF(MICROSECOND, NOW(3), next_ok_at) / 1000, 0) AS wait_ms,
                IF(result_json IS NOT NULL AND result_at > NOW() - INTERVAL ? SECOND, result_json, NULL) AS fresh_json
           FROM ${HOSTS_TABLE} WHERE host = ?`, [Math.ceil(reuseMs / 1000), host]);
      if (!rows.length) return { busy: false, waitMs: 0, reuse: null };
      const r = rows[0];
      let reuse = null;
      if (r.fresh_json) { try { reuse = JSON.parse(r.fresh_json); } catch { reuse = null; } }
      const waitMs = Number(r.wait_ms) || 0;
      return { busy: r.holder !== null && waitMs > 0, waitMs, reuse };
    },
    async tryLock(host, holder, lockMs) {
      // 代入は左から順に評価される。holder を先に決め、next_ok_at は元の値で判定する(順序を変えないこと)
      await pool.query(
        `INSERT INTO ${HOSTS_TABLE} (host, holder, next_ok_at) VALUES (?, ?, NOW(3) + INTERVAL ? SECOND)
         ON DUPLICATE KEY UPDATE holder = IF(next_ok_at <= NOW(3), VALUES(holder), holder),
                                 next_ok_at = IF(next_ok_at <= NOW(3), VALUES(next_ok_at), next_ok_at)`,
        [host, holder, Math.ceil(lockMs / 1000)]);
      const [rows] = await pool.query(`SELECT holder FROM ${HOSTS_TABLE} WHERE host = ?`, [host]);
      return rows.length > 0 && rows[0].holder === holder;
    },
    async release(host, holder, gapMs, resultJson) {
      await pool.query(
        `UPDATE ${HOSTS_TABLE} SET holder = NULL, next_ok_at = NOW(3) + INTERVAL ? SECOND, last_visit_at = NOW(),
                result_json = IF(? IS NULL, result_json, ?), result_at = IF(? IS NULL, result_at, NOW())
          WHERE host = ? AND holder = ?`,
        [Math.ceil(gapMs / 1000), resultJson, resultJson, resultJson, host, holder]);
    },
  };
}

let tokenSeq = 0;
const newToken = () => `${process.pid}-${Date.now().toString(36)}-${++tokenSeq}-${Math.random().toString(36).slice(2, 8)}`;
const MAX_RESULT_JSON = 60000;

/**
 * 門番を作る。
 *  run(host, visit, url, {needSize}): visit(url) は1回の調査(結果オブジェクトを返す。例外は投げない)。
 *     使い回し(7日以内の結果)があればそれを返す / なければホストの順番待ち→調査→一時的エラーは2回まで再試行→404はトップで再試行。
 *     待ち切れなかったときは { deferred: true } を返す(呼び出し側は何も書かず、次の機会に回す)。
 *  exclusive(host, fn): 使い回し・再試行なしで、順番待ちと間隔だけ守って fn() を実行する(営業お断り判定用)。
 */
function createHostGate({ store, sleep = sleepDefault, gapMs = 10000, lockMs = 150000, reuseMs = 7 * 86400e3, maxWaitMs = 600000, retryDelays = [30000, 90000], pollMs = 5000, log = () => {} } = {}) {
  async function acquire(host, { reuse = true, needSize = false } = {}) {
    const holder = newToken();
    const t0 = Date.now();
    for (;;) {
      const p = await store.peek(host, reuseMs);
      if (reuse && !p.busy && p.reuse && (!needSize || p.reuse.size)) return { reuse: p.reuse };
      if (!p.busy && p.waitMs <= 0 && await store.tryLock(host, holder, lockMs)) return { holder };
      if (Date.now() - t0 > maxWaitMs) { const e = new Error('同じサイトの順番待ちが長すぎました'); e.deferred = true; throw e; }
      await sleep(Math.min(Math.max(p.waitMs, 500), pollMs) + Math.floor(Math.random() * 300));
    }
  }

  async function exclusive(host, fn) {
    const a = await acquire(host, { reuse: false });
    try { return await fn(); } finally { await store.release(host, a.holder, gapMs, null).catch(() => {}); }
  }

  async function run(host, visit, url, { needSize = false } = {}) {
    let curUrl = url;
    let transientTries = 0;
    let triedRoot = false;
    const rootUrl = rootUrlOf(url);
    try {
      for (;;) {
        const a = await acquire(host, { needSize });
        if (a.reuse) return { ...a.reuse, reused: true };
        let r;
        try { r = await visit(curUrl); } catch (e) { r = { status: 'error', note: '調査に失敗しました', emails: [], instagram: null, inquiryUrl: null, hasCaptcha: false, kind: 'none', checkedPages: 0 }; }
        const kind = r && r.status === 'error' ? classifyError(r.note) : null;
        let next = null;
        if (kind === 'transient' && transientTries < retryDelays.length) {
          next = { url: curUrl, delay: retryDelays[transientTries] };
          transientTries++;
        } else if (kind === 'notfound' && !triedRoot && rootUrl && !sameUrl(rootUrl, curUrl)) {
          triedRoot = true;
          next = { url: rootUrl, delay: 0 };
        }
        // 最終結果のうち、一時的なエラー以外だけを使い回し用に保存する
        let json = null;
        if (!next && kind !== 'transient') {
          try { const s = JSON.stringify(r); if (s.length <= MAX_RESULT_JSON) json = s; } catch { json = null; }
        }
        await store.release(host, a.holder, gapMs, json).catch((e) => log('門番の解放に失敗: ' + e.message));
        if (!next) return { ...r, retries: transientTries, rootRetried: triedRoot };
        log(`再試行 ${host}: ${r.note}${next.delay ? ` → ${Math.round(next.delay / 1000)}秒後` : ' → サイトのトップで'}`);
        if (next.delay) await sleep(next.delay);
        curUrl = next.url;
      }
    } catch (e) {
      if (e && e.deferred) return { deferred: true, status: 'error', note: e.message };
      throw e;
    }
  }

  return { run, exclusive, acquire };
}

/* ---------- 管理画面用の集計 ---------- */
/**
 * 県ごとの あり/なし/要確認/エラー、今夜の処理数、残り(URL・電話あり・未調査・統合済み除く)、エラー理由の内訳。
 * 残りは業種ルール適用前の件数(ルールはJSで判定するため)。
 */
async function queryNightStats(pool, sched, now = new Date()) {
  const since = windowStartOf(sched, now);
  const pad = (n) => String(n).padStart(2, '0');
  const sinceStr = `${since.getFullYear()}-${pad(since.getMonth() + 1)}-${pad(since.getDate())} ${pad(since.getHours())}:00:00`;
  const notMerged = '(stoc_store_id IS NULL OR NOT EXISTS (SELECT 1 FROM stoc_sales.stores st WHERE st.id = stoc_master.shops.stoc_store_id AND st.merged_into IS NOT NULL))';
  const hasPhone = "phone IS NOT NULL AND phone REGEXP '[0-9]'";
  const [byPref] = await pool.query({
    sql: `SELECT IFNULL(NULLIF(prefecture, ''), '(不明)') AS prefecture,
                 SUM(form_status = 'url_found') AS found, SUM(form_status = 'no_form') AS none,
                 SUM(form_status = 'needs_browser') AS needs, SUM(form_status = 'error') AS err,
                 SUM(form_checked_at >= ?) AS tonight,
                 SUM(website_url IS NOT NULL AND website_url <> '' AND ${hasPhone} AND form_status = 'unknown' AND form_checked_at IS NULL AND ${notMerged}) AS remaining
            FROM stoc_master.shops GROUP BY 1`, values: [sinceStr], timeout: 120000 });
  const [reasons] = await pool.query({
    sql: "SELECT IFNULL(NULLIF(form_note, ''), '(理由なし)') AS note, COUNT(*) AS n FROM stoc_master.shops WHERE form_status = 'error' GROUP BY 1 ORDER BY n DESC LIMIT 20", timeout: 120000 });
  const rows = byPref.map((r) => ({
    prefecture: r.prefecture, found: Number(r.found), none: Number(r.none), needs: Number(r.needs), err: Number(r.err),
    tonight: Number(r.tonight), remaining: Number(r.remaining),
  })).filter((r) => r.found + r.none + r.needs + r.err + r.remaining > 0).sort((a, b) => b.remaining - a.remaining || (b.found + b.none + b.needs + b.err) - (a.found + a.none + a.needs + a.err));
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  return {
    since: sinceStr,
    totals: { found: sum('found'), none: sum('none'), needs: sum('needs'), err: sum('err'), tonight: sum('tonight'), remaining: sum('remaining') },
    rows, reasons: reasons.map((r) => ({ note: r.note, n: Number(r.n) })),
  };
}

module.exports = {
  DEFAULT_START, DEFAULT_END, parseHour, inWindow, parseFrom, isOpen, windowStartOf, scheduleFromEnv, scheduleFromRows,
  makeSettingsStore, createScheduleReader, classifyError, PERMANENT_NOTE_SQL, rootUrlOf, makeDbHostStore, createHostGate, queryNightStats,
};
