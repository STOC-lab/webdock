'use strict';
/**
 * B2B送信の「診断前の除外」(倉庫から選んだ会社を、診断する前に外す)。
 *  1. WEBドック送信済み・送信予定(approach_label='MEO文面で送信(誤)' の明細は除く) … STOC営業管理の inquiry_export_items に、source='webdock_b2b' のバッチで入っている店(send_status を問わない)
 *  2. 除外ドメイン指定 … rules/b2b_exclude_domains.txt のドメイン(サブドメインも)
 *  3. チェーン・共通ドメイン … 同じサイトのホスト名を使う店が倉庫に CHAIN_MIN 件以上ある(全都道府県の合計)
 * 外した件数は理由ごとに数え、まとめ.txt に出す。
 */
const fs = require('fs');
const path = require('path');
const { siteHostOf } = require('./siteHost');

const CHAIN_MIN = 3;
const REASON = {
  resend: 'WEBドック送信済み・送信予定',
  listed: '除外ドメイン指定',
  chain: 'チェーン・共通ドメイン',
  claim: 'クレーム登録で除外',
  optout: '専用ページで配信不要の申し出',
  // 倉庫から直接送るとき(--direct)
  whResend: '倉庫の送信履歴で送信済み(日数以内)',
  whOptOut: '倉庫の専用ページで配信停止',
  matchedLost: '営業管理と一致した店が失注・契約',
  matchedClaim: '営業管理と一致した店がクレーム',
  matchedResend: '営業管理と一致した店がWEBドック送信済み・送信予定',
  matchedOptOut: '営業管理と一致した店が配信不要の申し出',
  freedial: 'フリーダイヤルのみ一致(要確認・送らない)',
  // 営業管理経由の送信: 倉庫から直接送った店・倉庫で配信停止した店を外す(二重送信の防止)
  whResendStoc: '倉庫から直接送信済み(日数以内)',
  whOptOutStoc: '倉庫の専用ページで配信停止',
};
// 誤って旧MEO文面で送ってしまった明細に運用者がSQLで付けるラベル。この明細はWEBドック送信済みに数えない(後でWEBドック文面を送れる)
const MEO_WRONG_LABEL = 'MEO文面で送信(誤)';
const DEFAULT_LIST_FILE = path.join(__dirname, '..', 'rules', 'b2b_exclude_domains.txt');

/* ---------- 除外ドメイン一覧 ---------- */

/** 1行1ドメイン。# 以降はコメント。URL・www.・大文字・末尾の「/」やパスがあっても整える。重複は除く */
function parseExcludeDomains(text) {
  const out = [];
  for (const raw of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const h = siteHostOf(line.split(/\s+/)[0]);
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}

function loadExcludeDomains(file = DEFAULT_LIST_FILE) {
  if (!fs.existsSync(file)) return [];
  return parseExcludeDomains(fs.readFileSync(file, 'utf8'));
}

/** host が一覧のドメインと同じ、または .<ドメイン> で終わる(サブドメイン)なら true */
function matchesExcludeList(host, list) {
  if (!host) return false;
  const h = String(host).toLowerCase().replace(/^www\./, '');
  return (list || []).some((d) => h === d || h.endsWith('.' + d));
}

/* ---------- DB から読む ---------- */

function resendQuery(db) {
  // approach_label が MEO_WRONG_LABEL の明細は除外対象から外す(?には MEO_WRONG_LABEL を渡す)
  return `SELECT DISTINCT i.store_id AS store_id FROM ${db}.inquiry_export_items i
JOIN ${db}.inquiry_export_batches b ON b.id = i.batch_id
WHERE JSON_UNQUOTE(JSON_EXTRACT(b.filter_json, '$.source')) = 'webdock_b2b' AND i.store_id IS NOT NULL
AND (i.approach_label IS NULL OR i.approach_label <> ?)`;
}

/** 送信済み・送信予定の店(STOC営業管理の店舗ID)の集合。読めなければ例外(二重送信を防ぐため、黙ってスキップしない) */
async function loadResendSet(pool, db) {
  let rows;
  try { [rows] = await pool.query(resendQuery(db), [MEO_WRONG_LABEL]); } catch (e) {
    throw Object.assign(new Error(`送信済みの店を除外するため ${db}.inquiry_export_items / inquiry_export_batches を読む必要がありますが、読めませんでした(${e.message})。\n二重送信を防ぐため処理を中止しました。`), { stocCheck: true });
  }
  return new Set(rows.map((r) => Number(r.store_id)).filter((n) => n > 0));
}

/**
 * 候補のホスト名のうち、倉庫で CHAIN_MIN 件以上の店が使っているものの集合。
 * site_host 列がない(sql/warehouse_migrate_005.sql 未適用)ときは警告して空の集合(この除外はスキップ)。
 * 戻り: { hosts:Set, available:boolean, unfilled:boolean }
 */
async function loadChainHosts(pool, candidateHosts, { columnExists, warn = (m) => console.error(m) } = {}) {
  const res = { hosts: new Set(), available: false, unfilled: false };
  if (!(await columnExists(pool, 'shops', 'site_host'))) {
    warn('警告: shops.site_host 列がないため「チェーン・共通ドメイン」の除外ができません。先に sql/warehouse_migrate_005.sql を適用し、node cli/warehouse-sitehost.js を実行してください。');
    return res;
  }
  res.available = true;
  const list = [...new Set(candidateHosts.filter(Boolean))];
  for (let i = 0; i < list.length; i += 1000) {
    const [rows] = await pool.query('SELECT site_host AS h, COUNT(*) AS n FROM stoc_master.shops WHERE site_host IN (?) GROUP BY site_host HAVING COUNT(*) >= ?', [list.slice(i, i + 1000), CHAIN_MIN]);
    for (const r of rows) res.hosts.add(String(r.h));
  }
  try {
    const [u] = await pool.query("SELECT 1 AS x FROM stoc_master.shops WHERE site_host IS NULL AND website_url IS NOT NULL AND website_url <> '' LIMIT 1");
    if (u.length) {
      res.unfilled = true;
      warn('警告: shops.site_host が未設定の店があります。件数が少なく数えられ、チェーン判定が甘くなります。node cli/warehouse-sitehost.js を実行してください。');
    }
  } catch { /* 確認できなくても続ける */ }
  return res;
}

/* ---------- 適用 ---------- */

/**
 * 行(url, stocStoreId, store_id を持つ)から除外対象を外す。理由の判定順:
 *   [倉庫から直接] 倉庫の送信履歴 → 倉庫の配信停止(どちらも倉庫の店ID store_id で見る)
 *   → 送信済み → 配信不要の申し出(営業管理の店ID) → [営業管理経由] 倉庫から直接送信済み → 倉庫で配信停止(営業管理の店IDに引き直した集合) → 除外ドメイン指定 → チェーン。
 * ctx: { chainReason?:string(チェーンの理由の表示名。省略時 REASON.chain), resendSet?:Set<number>, optOutSet?:Set<number>(専用ページで「今後の案内は不要」), excludeList?:string[], chainHosts?:Set<string>,
 *        whResendShopSet?, whOptOutShopSet?:Set<number>(倉庫の店ID), whResendStocSet?, whOptOutStocSet?:Set<number>(営業管理の店ID。PR-3) }
 * 戻り: { rows, counts:{理由:件数} }(件数0の理由は含めない)
 */
function applyPreScanExclusions(rows, ctx = {}) {
  const counts = {};
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  const kept = [];
  for (const r of rows) {
    const shopId = /^\d+$/.test(String(r.store_id || '')) ? Number(r.store_id) : 0;
    if (ctx.whResendShopSet && shopId && ctx.whResendShopSet.has(shopId)) { bump(REASON.whResend); continue; }
    if (ctx.whOptOutShopSet && shopId && ctx.whOptOutShopSet.has(shopId)) { bump(REASON.whOptOut); continue; }
    const sid = /^\d+$/.test(String(r.stocStoreId || '')) ? Number(r.stocStoreId) : 0;
    if (ctx.resendSet && sid && ctx.resendSet.has(sid)) { bump(REASON.resend); continue; }
    if (ctx.optOutSet && sid && ctx.optOutSet.has(sid)) { bump(REASON.optout); continue; }
    if (ctx.whResendStocSet && sid && ctx.whResendStocSet.has(sid)) { bump(REASON.whResendStoc); continue; }
    if (ctx.whOptOutStocSet && sid && ctx.whOptOutStocSet.has(sid)) { bump(REASON.whOptOutStoc); continue; }
    const host = siteHostOf(r.url);
    if (host && ctx.excludeList && matchesExcludeList(host, ctx.excludeList)) { bump(REASON.listed); continue; }
    if (host && ctx.chainHosts && ctx.chainHosts.has(host)) { bump(ctx.chainReason || REASON.chain); continue; }
    kept.push(r);
  }
  return { rows: kept, counts };
}

/* ---------- 倉庫から直接送るとき: 営業管理の店との照合による除外(営業管理は読むだけ) ---------- */

/**
 * 営業管理(STOC)でクレームの履歴がある店(営業管理の店ID)の集合。売上ログの「クレーム」と、店のフラグ「クレーム」(解除されていないもの)。
 * 読めなければ例外(クレームの店へ送らないため、黙ってスキップしない)。storeFlags=false は store_flags のない旧版の営業管理。
 */
async function loadClaimIdSet(pool, db, ids, { storeFlags = false } = {}) {
  const set = new Set();
  const uniq = [...new Set((ids || []).map(Number).filter((n) => n > 0))];
  const queries = [`SELECT DISTINCT store_id FROM ${db}.sales_logs WHERE store_id IN (?) AND deleted_at IS NULL AND call_result = 'クレーム'`];
  if (storeFlags) queries.push(`SELECT DISTINCT store_id FROM ${db}.store_flags WHERE store_id IN (?) AND flag = 'クレーム' AND cleared_at IS NULL`);
  try {
    for (let i = 0; i < uniq.length; i += 1000) {
      for (const sql of queries) {
        const [rows] = await pool.query(sql, [uniq.slice(i, i + 1000)]);
        for (const r of rows) set.add(Number(r.store_id));
      }
    }
  } catch (e) {
    throw Object.assign(new Error(`営業管理(${db})のクレーム履歴を読めませんでした(${e.message})。\nクレームの店へ送らないため処理を中止しました。`), { stocCheck: true });
  }
  return set;
}

/**
 * 倉庫の行ごとに、営業管理の店と照合する(src/stocMatch.js の matchShop。索引は { withIds: true } で作ったもの)。
 * 手がかりは 電話(固定・携帯)→ 店名+住所、それに倉庫の行がすでに持つ営業管理の店ID(stocStoreId)。
 * 戻り: Map(行 → { kind: 'registered' | 'review' | null, by, ids: 一致した店ID(昇順), freeIds, free })
 */
function matchAll(rows, index) {
  const SM = require('./stocMatch');
  const out = new Map();
  for (const r of rows) {
    const m = SM.matchShop(index, { name: r.name, address_raw: r.address, phone: r.phone });
    const linked = /^\d+$/.test(String(r.stocStoreId || '')) ? Number(r.stocStoreId) : 0;
    const ids = new Set(m.ids);
    if (linked) ids.add(linked);
    out.set(r, ids.size
      ? { kind: 'registered', by: m.kind === 'registered' ? m.by : 'link', ids: [...ids].sort((a, b) => a - b), freeIds: m.freeIds, free: m.free }
      : m);
  }
  return out;
}

/**
 * 照合の結果で外す。理由の判定順: 失注・契約 → クレーム → WEBドック送信済み・送信予定 → 配信不要の申し出。
 * フリーダイヤル・ナビダイヤルだけで一致した店(kind: 'review')は要確認として送らない(review に集める)。
 * ctx: { status: Map(営業管理の店ID → ステータス), claimSet, resendSet, optOutSet }(どれも営業管理の店IDの集合)
 * 戻り: { rows, counts:{理由:件数}, review:[{ row, free, freeIds }], matchedByShop: Map(倉庫の店ID文字列 → 一致した営業管理の店ID(先頭)) }
 */
function applyMatchExclusions(rows, matches, ctx = {}) {
  const counts = {};
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  const kept = [];
  const review = [];
  const matchedByShop = new Map();
  const has = (set, ids) => !!set && ids.some((id) => set.has(id));
  for (const r of rows) {
    const m = matches.get(r) || { kind: null, ids: [] };
    if (m.kind === 'review') { review.push({ row: r, free: m.free, freeIds: m.freeIds }); bump(REASON.freedial); continue; }
    if (m.kind === 'registered' && m.ids.length) {
      if (ctx.status && m.ids.some((id) => ['失注', '契約'].includes(ctx.status.get(id)))) { bump(REASON.matchedLost); continue; }
      if (has(ctx.claimSet, m.ids)) { bump(REASON.matchedClaim); continue; }
      if (has(ctx.resendSet, m.ids)) { bump(REASON.matchedResend); continue; }
      if (has(ctx.optOutSet, m.ids)) { bump(REASON.matchedOptOut); continue; }
      matchedByShop.set(String(r.store_id), m.ids[0]);
    }
    kept.push(r);
  }
  return { rows: kept, counts, review, matchedByShop };
}

module.exports = {
  CHAIN_MIN, REASON, MEO_WRONG_LABEL, DEFAULT_LIST_FILE, parseExcludeDomains, loadExcludeDomains, matchesExcludeList,
  resendQuery, loadResendSet, loadChainHosts, applyPreScanExclusions, loadClaimIdSet, matchAll, applyMatchExclusions,
};
