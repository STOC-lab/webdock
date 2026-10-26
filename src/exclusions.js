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
 * 行(url, stocStoreId を持つ)から除外対象を外す。理由の判定順: 送信済み → 配信不要の申し出 → 除外ドメイン指定 → チェーン。
 * ctx: { resendSet?:Set<number>, optOutSet?:Set<number>(専用ページで「今後の案内は不要」), excludeList?:string[], chainHosts?:Set<string> }
 * 戻り: { rows, counts:{理由:件数} }(件数0の理由は含めない)
 */
function applyPreScanExclusions(rows, ctx = {}) {
  const counts = {};
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  const kept = [];
  for (const r of rows) {
    const sid = /^\d+$/.test(String(r.stocStoreId || '')) ? Number(r.stocStoreId) : 0;
    if (ctx.resendSet && sid && ctx.resendSet.has(sid)) { bump(REASON.resend); continue; }
    if (ctx.optOutSet && sid && ctx.optOutSet.has(sid)) { bump(REASON.optout); continue; }
    const host = siteHostOf(r.url);
    if (host && ctx.excludeList && matchesExcludeList(host, ctx.excludeList)) { bump(REASON.listed); continue; }
    if (host && ctx.chainHosts && ctx.chainHosts.has(host)) { bump(REASON.chain); continue; }
    kept.push(r);
  }
  return { rows: kept, counts };
}

module.exports = {
  CHAIN_MIN, REASON, MEO_WRONG_LABEL, DEFAULT_LIST_FILE, parseExcludeDomains, loadExcludeDomains, matchesExcludeList,
  resendQuery, loadResendSet, loadChainHosts, applyPreScanExclusions,
};
