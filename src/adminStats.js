'use strict';

/**
 * 管理画面の重い集計(「状況」の都道府県別件数・「夜間フォーム探し」の進み具合)を、
 * 画面を開いたときではなく、裏で数分おきにまとめて実行して保存しておく仕組み。
 *   - 集計は同時に1つだけ(実行中なら新しく始めない)
 *   - 間隔: 既定5分、夜間フォーム探しの時間帯は10分(DB を取り合わないため)
 *   - 保存先: stoc_master.admin_stats_snapshot(sql/warehouse_migrate_012.sql)。表が無ければプロセス内だけ
 *   - 画面は get() で保存済みの結果を読むだけ(DB は触らない)
 */

const night = require('./nightGuard');

const TABLE = 'stoc_master.admin_stats_snapshot';
const DAY_MS = 5 * 60 * 1000;
const NIGHT_MS = 10 * 60 * 1000;
const TICK_MS = 30 * 1000;
const DB_TIMEOUT_MS = 10 * 1000; // 保存・読み込みのクエリの上限(超えると接続が破棄され、次のクエリは新しい接続で動く)

/** 保存先(DB)。表が無い(errno 1146)ときは読み書きとも何もしない */
function makeSnapshotStore(pool) {
  return {
    /** { key: { value, at } }。表が無ければ null。壊れた行は読み飛ばす */
    async readAll() {
      let rows;
      try { [rows] = await pool.query({ sql: `SELECT k, value_json, computed_ms FROM ${TABLE}`, timeout: DB_TIMEOUT_MS }); } catch (e) {
        if (e && e.errno === 1146) return null;
        throw e;
      }
      const out = {};
      for (const r of rows) {
        try { out[r.k] = { value: JSON.parse(r.value_json), at: Number(r.computed_ms) }; } catch { /* 壊れた行は無視 */ }
      }
      return out;
    },
    /** 保存できたら true。表が無ければ false */
    async write(key, value, at) {
      try {
        await pool.query({ sql: `INSERT INTO ${TABLE} (k, value_json, computed_ms) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), computed_ms = VALUES(computed_ms)`, values: [key, JSON.stringify(value), at], timeout: DB_TIMEOUT_MS });
        return true;
      } catch (e) {
        if (e && e.errno === 1146) return false;
        throw e;
      }
    },
  };
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 保存値の形の検証(画面が例外にならないように。外れたものは読み込まずに捨てる) */
const validators = {
  status: (v) => isObj(v) && isNum(v.total) && Array.isArray(v.rows)
    && v.rows.every((r) => isObj(r) && typeof r.prefecture === 'string' && ['total', 'web', 'linked', 'form'].every((k) => isNum(r[k]))),
  night: (v) => isObj(v) && typeof v.since === 'string' && isObj(v.totals) && ['found', 'none', 'needs', 'err', 'tonight', 'remaining'].every((k) => isNum(v.totals[k]))
    && Array.isArray(v.rows) && v.rows.every((r) => isObj(r) && typeof r.prefecture === 'string' && ['found', 'none', 'needs', 'err', 'tonight', 'remaining'].every((k) => isNum(r[k])))
    && Array.isArray(v.reasons) && v.reasons.every((r) => isObj(r) && typeof r.note === 'string' && isNum(r.n)),
};

/**
 * @param {object} o
 * @param {Object<string, () => Promise<any>>} o.jobs   集計の名前 → 集計を実行する関数(順番に実行する)
 * @param {{readAll:Function, write:Function}|null} o.store 保存先(null ならプロセス内だけ)
 * @param {() => Promise<any>} o.getSchedule  夜間の設定(夜間かどうかの判定用)。失敗したら昼の間隔にする
 * @param {Object<string, (v:any) => boolean>} o.validate  集計の名前 → 保存値の検証。外れた保存値は読み込まない
 */
function createStatsRefresher({ jobs, store = null, getSchedule = async () => null, validate = {}, loadTimeoutMs = 5000, writeTimeoutMs = 10000, now = () => Date.now(), dayMs = DAY_MS, nightMs = NIGHT_MS, tickMs = TICK_MS, onError = () => {} }) {
  const snap = {}; // key → { value, at, error }
  let running = false;
  let current = null;
  let lastRunAt = 0;
  let timer = null;
  let loading = null;

  async function doLoad() {
    if (!store) return;
    let saved;
    try { saved = await store.readAll(); } catch (e) { onError('load', e); return; }
    for (const [k, v] of Object.entries(saved || {})) {
      if (!jobs[k] || (snap[k] && snap[k].value)) continue; // 有効な結果が既にあれば上書きしない(読み込みが遅れて、先に集計が済んだ場合)
      const good = Number.isFinite(v.at) && v.at > 0 && (!validate[k] || validate[k](v.value));
      if (good) snap[k] = { value: v.value, at: v.at, error: snap[k] ? snap[k].error : null }; // 先に集計が失敗していれば、その失敗の情報は残す
      else onError(k, new Error('保存された集計の形が正しくないため読み込みませんでした'));
    }
  }
  /** 保存済みの結果を読み込む(何度呼んでも読むのは1回) */
  /** 待ちの上限つき。上限を過ぎたら reject(元の処理は止まらないが、こちらは先へ進める) */
  function withTimeout(p, ms, what) {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(what + 'が' + Math.round(ms / 1000) + '秒以内に終わりませんでした')), ms); })]).finally(() => clearTimeout(t));
  }
  function load() { if (!loading) loading = doLoad(); return loading; }

  /** 実行中でなければ全部の集計を始める。戻り値の done は終わりを待つとき用(画面は待たない) */
  function refreshAll() {
    if (running) return { started: false, done: current };
    running = true;
    lastRunAt = now();
    current = (async () => {
      try {
        for (const [key, fn] of Object.entries(jobs)) {
          let value;
          // 集計は打ち切らない(元の処理が動いたまま次を始めると重複するため)。各クエリは 120秒の上限(timeout)で終わる
          try { value = await fn(); } catch (e) {
            onError(key, e);
            snap[key] = { value: snap[key] ? snap[key].value : null, at: snap[key] ? snap[key].at : null, error: String((e && e.message) || e) }; // 前回の結果は残す
            continue;
          }
          const at = now();
          snap[key] = { value, at, error: null };
          if (store) { try { await withTimeout(Promise.resolve().then(() => store.write(key, value, at)), writeTimeoutMs, '保存'); } catch (e) { onError(key, e); } } // 保存に失敗・停止しても、結果は表示し、後続の集計も続ける
        }
      } finally {
        running = false;
        current = null;
      }
    })();
    return { started: true, done: current };
  }

  async function intervalMs() {
    try {
      const sched = await getSchedule();
      return sched && night.isOpen(sched, new Date(now())) ? nightMs : dayMs;
    } catch { return dayMs; }
  }

  /** 前回の集計(または保存済みの結果)から間隔が過ぎていれば始める */
  async function tick() {
    if (running) return;
    const newest = Math.max(lastRunAt, ...Object.values(snap).map((s) => s.at || 0));
    if (!newest || now() - newest >= await intervalMs()) refreshAll();
  }

  return {
    load,
    /** 保存済みの結果の読み込みが終わるまで待つ(画面が再起動直後に空にならないように)。未開始なら待たない */
    whenLoaded: () => loading || Promise.resolve(),
    refreshAll,
    tick,
    /** 保存済みの結果を読むだけ(DBは触らない)。value が null なら、まだ結果がない */
    get(key) {
      const s = snap[key];
      return { value: s ? s.value : null, at: s ? s.at : null, error: s ? s.error : null, running };
    },
    isRunning: () => running,
    async start() {
      if (timer) return;
      // 保存済みの読み込みが応答しなくても、集計の起動は止めない(読み込みは待つ上限つき)
      await Promise.race([load(), new Promise((r) => setTimeout(r, loadTimeoutMs))]);
      timer = setInterval(() => { tick().catch((e) => onError('tick', e)); }, tickMs);
      if (timer.unref) timer.unref();
      tick().catch((e) => onError('tick', e));
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

module.exports = { createStatsRefresher, makeSnapshotStore, validators, TABLE, DAY_MS, NIGHT_MS };
