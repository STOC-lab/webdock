'use strict';
/**
 * 「WEB入れ替え候補」: 点数が中くらいで、ブログ・お知らせ/Googleマップをよく更新している小さなお店を倉庫から探す。
 *  - 検索条件の読み取りと検証(parseQuery)
 *  - 検索SQLの組み立て(buildSearch)。都道府県 → 索引(prefecture, wd_score)から絞る
 *  - 一覧CSV(UTF-8・BOM付き)と、営業管理取り込み用CSV(Shift_JIS・11列。warehouse-promote と同じ)
 * 倉庫には読み取り(と、取り込み用CSVで「出力済み」にするときの promoted_at 更新)しかしない。
 */

const wh = require('./warehouse');
const { PREFECTURES } = require('./regions');
const { CHAIN_MIN } = require('./exclusions');

const PAGE_SIZE = 100;
const EXPORT_MAX = 20000;
const H = 'stoc_master.shop_metrics_history';

const DEFAULTS = {
  pref: ['兵庫県'], minScore: 40, maxScore: 75,
  useBlog: true, blogPosts: 3, blogDays: 60,
  useGmap: true, photo: 100, review: 30, inc: 3,
  mode: 'or', excludeChains: true, notInStoc: false, page: 1,
};

const toList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
const flag = (v) => ['1', 'on', 'true'].includes(String(Array.isArray(v) ? v[v.length - 1] : v || '').trim().toLowerCase());

/**
 * フォーム(GET/POST)の内容 → 検索条件。q=1 がなければ(初めて開いたとき)すべて既定値。
 * q=1 のときは、チェックボックスは付いていれば ON、なければ OFF。戻り: { opts } または { error }
 */
function parseQuery(src) {
  const q = src || {};
  const submitted = flag(q.q);
  const o = { ...DEFAULTS, pref: [...DEFAULTS.pref] };
  const prefs = toList(q.pref).filter((p, i, a) => a.indexOf(p) === i);
  if (prefs.length) o.pref = prefs;
  if (o.pref.some((p) => !PREFECTURES.includes(p))) return { error: '都道府県の指定が正しくありません。' };
  const num = (key, field, min, max, label) => {
    const v = q[key];
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const n = Number(String(Array.isArray(v) ? v[v.length - 1] : v).trim());
    if (!Number.isInteger(n) || n < min || n > max) return `${label}は${min}以上${max}以下の整数で入力してください。`;
    o[field] = n;
    return null;
  };
  for (const [key, field, min, max, label] of [
    ['min_score', 'minScore', 0, 100, '点数の下限'], ['max_score', 'maxScore', 0, 100, '点数の上限'],
    ['blog_posts', 'blogPosts', 1, 1000, 'ブログの投稿数'], ['blog_days', 'blogDays', 1, 3650, 'ブログの最新投稿の日数'],
    ['photo', 'photo', 0, 1000000, '写真数'], ['review', 'review', 0, 1000000, '口コミ数'], ['inc', 'inc', 1, 100000, '口コミの増加数'],
    ['page', 'page', 1, 100000, 'ページ'],
  ]) { const e = num(key, field, min, max, label); if (e) return { error: e }; }
  if (o.minScore > o.maxScore) return { error: '点数の下限は上限以下にしてください。' };
  o.mode = String(Array.isArray(q.mode) ? q.mode[q.mode.length - 1] : q.mode || 'or') === 'and' ? 'and' : 'or';
  if (submitted) {
    o.useBlog = flag(q.use_blog);
    o.useGmap = flag(q.use_gmap);
    o.excludeChains = flag(q.exclude_chains);
    o.notInStoc = flag(q.not_in_stoc);
  } else if (q.not_in_stoc !== undefined) o.notInStoc = flag(q.not_in_stoc);
  o.submitted = submitted;
  return { opts: o };
}

/** 検索条件 → フォームの値(hidden や URL に載せる。parseQuery で元に戻る) */
function serialize(o, extra = {}) {
  const r = { q: '1', pref: o.pref, min_score: o.minScore, max_score: o.maxScore, blog_posts: o.blogPosts, blog_days: o.blogDays, photo: o.photo, review: o.review, inc: o.inc, mode: o.mode };
  if (o.useBlog) r.use_blog = '1';
  if (o.useGmap) r.use_gmap = '1';
  if (o.excludeChains) r.exclude_chains = '1';
  if (o.notInStoc) r.not_in_stoc = '1';
  return { ...r, ...extra };
}
function toQueryString(o, extra = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(serialize(o, extra))) for (const x of toList(v)) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(x)}`);
  return parts.join('&');
}

/**
 * 検索SQL。caps: { hasHistory, hasSiteHost }
 * 戻り: { where, params, incExpr(列に出す式 or null), cols }
 * 口コミの増え方: 履歴は「値が変わったときだけ」入るので、30日前以前の最後の行(なければ最初の行)の値を基準にし、今の値との差を見る。
 *   履歴の最初の行が28日以上前にあるときだけ使う(観測期間が足りないときは増加では判定しない)。
 */
function buildSearch(o, caps = {}) {
  const where = ['s.prefecture IN (?)', 's.wd_score BETWEEN ? AND ?', "(s.business_status IS NULL OR (s.business_status NOT LIKE '%閉業%' AND s.business_status NOT LIKE '%閉店%'))"];
  const params = [o.pref, o.minScore, o.maxScore];
  let incExpr = null;
  let growth = null;
  const gparams = [];
  if (caps.hasHistory) {
    const ref = `COALESCE((SELECT h.review_count FROM ${H} h WHERE h.shop_id = s.id AND h.captured_at <= NOW() - INTERVAL 30 DAY ORDER BY h.captured_at DESC LIMIT 1), (SELECT h.review_count FROM ${H} h WHERE h.shop_id = s.id ORDER BY h.captured_at ASC LIMIT 1))`;
    const span = `EXISTS (SELECT 1 FROM ${H} h WHERE h.shop_id = s.id AND h.captured_at <= NOW() - INTERVAL 28 DAY)`;
    incExpr = `(CASE WHEN ${span} THEN s.review_count - ${ref} END)`;
    growth = `(${span} AND s.review_count - ${ref} >= ?)`;
    gparams.push(o.inc);
  }
  if (o.excludeChains) {
    where.push("(s.size_class IS NULL OR s.size_class <> 'large')");
    if (caps.hasSiteHost) { where.push('(s.site_host IS NULL OR (SELECT COUNT(*) FROM stoc_master.shops c WHERE c.site_host = s.site_host) < ?)'); params.push(CHAIN_MIN); }
  }
  if (o.notInStoc) where.push('s.stoc_store_id IS NULL');
  const act = [];
  if (o.useBlog) { act.push({ sql: '(s.blog_posts_90d >= ? OR s.blog_latest_at >= NOW() - INTERVAL ? DAY)', params: [o.blogPosts, o.blogDays] }); }
  if (o.useGmap) {
    act.push({
      sql: '(s.photo_count >= ? OR s.review_count >= ?' + (growth ? ' OR ' + growth : '') + ')',
      params: [o.photo, o.review, ...gparams],
    });
  }
  if (act.length) {
    where.push('(' + act.map((a) => a.sql).join(o.mode === 'and' ? ' AND ' : ' OR ') + ')');
    for (const a of act) params.push(...a.params);
  }
  return { where, params, incExpr };
}

const COLS = 's.id, s.name, s.category, s.category_main, s.postal, s.address, s.address_raw, s.prefecture, s.phone, s.rating, s.review_count, s.gbp_registered, s.website_url, s.gmap_url, s.photo_count, s.wd_score, s.wd_grade, s.blog_latest_at, s.blog_posts_90d, s.blog_source, s.stoc_store_id';

function countSql(o, caps) {
  const b = buildSearch(o, caps);
  return { sql: `SELECT COUNT(*) AS n FROM stoc_master.shops s WHERE ${b.where.join(' AND ')}`, params: b.params };
}
function pageSql(o, caps, limit, offset) {
  const b = buildSearch(o, caps);
  return {
    sql: `SELECT ${COLS}${b.incExpr ? ', ' + b.incExpr + ' AS review_inc' : ''} FROM stoc_master.shops s WHERE ${b.where.join(' AND ')}
ORDER BY s.blog_latest_at IS NULL, s.blog_latest_at DESC, s.id LIMIT ? OFFSET ?`,
    params: [...b.params, limit, offset],
  };
}
/** 全件書き出し用(id順のキーセット方式。営業管理未登録だけにする場合は onlyNotInStoc) */
function exportSql(o, caps, afterId, limit, onlyNotInStoc = false) {
  const b = buildSearch(o, caps);
  const w = [...b.where, 's.id > ?'];
  const params = [...b.params, afterId];
  if (onlyNotInStoc) w.push('s.stoc_store_id IS NULL');
  return { sql: `SELECT ${COLS}${b.incExpr ? ', ' + b.incExpr + ' AS review_inc' : ''} FROM stoc_master.shops s WHERE ${w.join(' AND ')} ORDER BY s.id LIMIT ?`, params: [...params, limit] };
}

/* ---------- CSV ---------- */

const LIST_HEADERS = ['店名', '業種', '市区町村/住所', '点数', '判定', 'ブログ最新日', 'ブログ90日件数', 'ブログ取得元', '写真数', '口コミ数', '口コミ増加(30日)', 'URL', '営業管理登録'];
const csvField = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csvLine = (vals) => vals.map(csvField).join(',') + '\r\n';
function dateJa(d) {
  if (!d) return '';
  const x = new Date(d);
  if (Number.isNaN(+x)) return '';
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
function listRow(r) {
  return [r.name, r.category_main || wh.categoryMain(r.category || '') || '', r.address || r.address_raw || '', r.wd_score ?? '', r.wd_grade ?? '',
    dateJa(r.blog_latest_at), r.blog_posts_90d ?? '', r.blog_source ?? '', r.photo_count ?? '', r.review_count ?? '',
    r.review_inc === null || r.review_inc === undefined ? '' : r.review_inc, r.website_url || '', r.stoc_store_id ? '登録あり' : '未登録'];
}
const listCsvHeader = () => '﻿' + csvLine(LIST_HEADERS);
const listCsvRow = (r) => csvLine(listRow(r));

/* ---------- 検索の実行(DB) ---------- */

async function detectCaps(pool) {
  return {
    hasScore: await wh.columnExists(pool, 'shops', 'wd_score'),
    hasHistory: await wh.tableExists(pool, 'shop_metrics_history'),
    hasSiteHost: await wh.columnExists(pool, 'shops', 'site_host'),
  };
}

function createStore(pool) {
  let capsCache = null;
  const caps = async () => {
    if (capsCache && Date.now() - capsCache.at < 60000) return capsCache.v;
    const v = await detectCaps(pool);
    capsCache = { at: Date.now(), v };
    return v;
  };
  return {
    caps,
    async search(o, page) {
      const c = await caps();
      if (!c.hasScore) return { caps: c, total: 0, rows: [] };
      const cs = countSql(o, c);
      const [[t]] = await pool.query({ sql: cs.sql, timeout: 120000 }, cs.params);
      const ps = pageSql(o, c, PAGE_SIZE, (page - 1) * PAGE_SIZE);
      const [rows] = await pool.query({ sql: ps.sql, timeout: 120000 }, ps.params);
      return { caps: c, total: Number(t.n), rows };
    },
    /** 全件(上限 EXPORT_MAX)を onRows(rows) に順に渡す */
    async each(o, onRows, { onlyNotInStoc = false } = {}) {
      const c = await caps();
      if (!c.hasScore) return 0;
      let after = 0, n = 0;
      while (n < EXPORT_MAX) {
        const q = exportSql(o, c, after, Math.min(1000, EXPORT_MAX - n), onlyNotInStoc);
        const [rows] = await pool.query({ sql: q.sql, timeout: 120000 }, q.params);
        if (!rows.length) break;
        await onRows(rows);
        n += rows.length;
        after = rows[rows.length - 1].id;
      }
      return n;
    },
    async mark(ids) {
      for (let i = 0; i < ids.length; i += 1000) await pool.query('UPDATE stoc_master.shops SET promoted_at = NOW() WHERE id IN (?)', [ids.slice(i, i + 1000)]);
    },
  };
}

module.exports = {
  DEFAULTS, PAGE_SIZE, EXPORT_MAX, LIST_HEADERS, parseQuery, serialize, toQueryString, buildSearch, countSql, pageSql, exportSql,
  listCsvHeader, listCsvRow, listRow, createStore, detectCaps, dateJa,
};
