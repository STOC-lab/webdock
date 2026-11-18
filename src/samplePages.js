'use strict';
/**
 * 見本ページのデータ層と純粋な部品(DBは引数の pool 経由。テストでは偽物を渡す)。
 *  - 5桁コードの生成(重複は再試行)
 *  - 市区町村・営業時間の整形
 *  - 倉庫の店ID一覧から見本をまとめて作る / 一覧 / 編集 / 開封の記録
 * 店の事実(店名・住所・電話)は表示のたびに stoc_master.shops から読む。ここにコピーしない。
 */
const crypto = require('crypto');
const C = require('./sampleCategories');

const T = 'stoc_master.sample_pages';
const SHOPS = 'stoc_master.shops';
const STATUSES = ['draft', 'approved', 'deleted'];
const STATUS_LABEL = { draft: '見本', approved: '掲載OK', deleted: '削除' };
const DAYS = ['月', '火', '水', '木', '金', '土', '日'];
const CODE_RE = /^\d{5}$/;
const MAX_IDS = 3000;
const DEFAULT_BASE_URL = 'https://webdock.stoc-plus.site';

const isDup = (e) => !!e && (e.errno === 1062 || e.code === 'ER_DUP_ENTRY');

/** 見本のURLのもと。SAMPLE_BASE_URL(末尾の / は除く)。未設定なら webdock のURL */
function sampleBaseUrl(env = process.env) {
  const b = String((env && env.SAMPLE_BASE_URL) || '').trim().replace(/\/+$/, '');
  return b || DEFAULT_BASE_URL;
}
/** 見本のURL。既定は https://webdock.stoc-plus.site/s/12345。SAMPLE_BASE_URL(例 https://stoc.jp)を設定すると https://stoc.jp/12345 */
function sampleUrl(code, env = process.env) {
  const custom = String((env && env.SAMPLE_BASE_URL) || '').trim().replace(/\/+$/, '');
  return custom ? `${custom}/${code}` : `${DEFAULT_BASE_URL}/s/${code}`;
}

/** 10000〜99999 のランダムな5桁(文字列) */
function newCode(randomInt = crypto.randomInt) { return String(randomInt(10000, 100000)); }

/** 住所から市区町村を取り出す(都道府県は除く)。取れなければ都道府県 */
function areaOf(shop) {
  const addr = String((shop && shop.address) || '').replace(/^〒?\s*\d{3}-?\d{4}\s*/, '').trim();
  const pref = String((shop && shop.prefecture) || '').trim();
  let rest = addr;
  const m0 = /^(北海道|東京都|大阪府|京都府|.{2,3}県)/.exec(rest);
  if (m0) rest = rest.slice(m0[1].length);
  else if (pref && rest.startsWith(pref)) rest = rest.slice(pref.length);
  const m = /^(.+?郡.+?[町村]|.+?[市区町村])/.exec(rest);
  if (m) return m[1];
  return pref || '';
}

/* ---------- 営業時間 ---------- */

/** hours_json(文字列・配列どちらでも)を [[曜日, 時間]] にそろえる。使えない値は捨てる。空なら null */
function normalizeHours(v) {
  let a = v;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return null; } }
  if (!Array.isArray(a)) return null;
  const out = [];
  for (const e of a) {
    if (!Array.isArray(e) || e.length < 2) continue;
    const d = String(e[0]);
    const h = String(e[1]).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s*\/\s*/g, ' / ').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (DAYS.includes(d) && h && !out.some((x) => x[0] === d)) out.push([d, h]);
  }
  out.sort((x, y) => DAYS.indexOf(x[0]) - DAYS.indexOf(y[0]));
  return out.length ? out : null;
}
/** 管理画面の入力(hours_月 … hours_日。空欄は未掲載) → hours_json 用の配列。全部空なら null */
function hoursFromForm(body) {
  const b = body || {};
  return normalizeHours(DAYS.map((d) => [d, b['hours_' + d] === undefined ? '' : String(b['hours_' + d])]));
}
/** 同じ時間の曜日をまとめる: [['月・火・木・金', '8:00〜12:00 / 15:00〜19:15'], ...] */
function groupHours(hours) {
  const out = [];
  for (const [d, h] of hours) {
    const g = out.find((x) => x[1] === h);
    if (g) g[0].push(d); else out.push([[d], h]);
  }
  return out.map(([ds, h]) => [ds.join('・'), h]);
}
const isClosed = (h) => String(h).includes('休');

/* ---------- 表示用データ ---------- */

const jstDateJa = (d) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(d ? new Date(d) : new Date()).map((x) => [x.type, x.value]));
  return `${p.year}年${p.month}月${p.day}日`;
};

/** ページ(sample_pages の行)+ 店(shops の行)から、ビューに渡すデータを作る。事実はそのまま入れる。業種が合わなければ null */
function buildView(page, shop) {
  const group = C.groupById(page.group_id) || C.groupFor(shop);
  if (!group) return null;
  const name = String(shop.name || '').trim();
  const category = C.categoryLabel(shop) || group.id;
  const area = areaOf(shop);
  const f = (s) => C.fill(s, { name, area, category });
  const t = group.text;
  const phone = String(shop.phone || '').trim();
  const address = String(shop.address || '').trim();
  const hours = normalizeHours(page.hours_json);
  const groups = hours ? groupHours(hours) : [];
  return {
    name, area, category, initial: [...name][0] || '', phone, tel: phone.replace(/[^0-9+]/g, ''), address,
    postal: String(shop.postal || '').trim(),
    catchLines: t.catch, heroCap: t.heroCap, lead: t.lead, about: f(t.about),
    features: t.features.map(([i, h, b]) => [i, h, f(b)]),
    concerns: t.concerns, treatments: t.treatments, steps: t.steps,
    cta: t.cta, ctaSub: f(t.ctaSub), footLead: f(t.footLead),
    hours, openGroups: groups.filter((g) => !isClosed(g[1])), closedGroups: groups.filter((g) => isClosed(g[1])),
    mapOpen: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name} ${address}`)}`,
    mapEmbed: address ? `https://www.google.com/maps?q=${encodeURIComponent(address)}&output=embed` : '',
    sourceDate: jstDateJa(shop.last_seen_at || page.created_at),
    title: `【見本】${name}｜${area ? area + 'の' : ''}${category}`,
    groupId: group.id,
  };
}

/* ---------- 入力(店IDの一覧) ---------- */

/** 貼り付けの文字から店IDを取り出す(数字だけ・重複は除く)。{ ids, ignored } */
function parseIdList(text) {
  const ids = [], seen = new Set();
  let ignored = 0;
  for (const tok of String(text || '').split(/[\s,，、;；]+/)) {
    if (!tok) continue;
    if (!/^\d{1,15}$/.test(tok)) { ignored++; continue; }
    const n = String(Number(tok));
    if (!seen.has(n)) { seen.add(n); ids.push(n); }
  }
  return { ids, ignored };
}

const ID_HEADERS = ['倉庫ID', '倉庫id', 'shop_id', 'shopid', 'id', 'ID', '店舗ID'];
/**
 * CSV(parseDelimited の結果)から、元の行と店IDの対応を作る。
 * 見出しに「倉庫ID」などがあればその列。なければ先頭列が数字ならそれ。戻り: { header, rows:[{cells, id}], idCol } か { error }
 */
function readCsvRows(rows) {
  if (!rows.length) return { error: 'CSVが空です。' };
  const head = rows[0].map((s) => String(s).replace(/^﻿/, '').trim());
  let idCol = head.findIndex((h) => ID_HEADERS.includes(h));
  let header = head, body = rows.slice(1);
  if (idCol < 0) {
    if (/^\d{1,15}$/.test(head[0] || '')) { idCol = 0; header = head.map((_, i) => (i === 0 ? '倉庫ID' : `列${i + 1}`)); body = rows; }
    else return { error: 'CSVに「倉庫ID」の列が見つかりません(1行目に 倉庫ID という見出しを入れてください)。' };
  }
  return {
    header, idCol,
    rows: body.map((cells) => {
      const raw = String(cells[idCol] === undefined ? '' : cells[idCol]).trim();
      return { cells, id: /^\d{1,15}$/.test(raw) ? String(Number(raw)) : null };
    }),
  };
}

const csvCell = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csvLine = (cells) => cells.map(csvCell).join(',') + '\r\n';

/**
 * 入力のCSVの列に「見本コード」「見本URL」を足したCSV(UTF-8・BOM付き)。
 * 作れなかった行(業種が合わない・削除済みなど)は2列を空にする
 */
function buildResultCsv(parsed, byId, env = process.env) {
  let out = '﻿' + csvLine([...parsed.header, '見本コード', '見本URL']);
  for (const r of parsed.rows) {
    const s = r.id && byId.get(r.id);
    const ok = s && s.code && s.status !== 'deleted';
    const cells = r.cells.slice();
    while (cells.length < parsed.header.length) cells.push('');
    out += csvLine([...cells, ok ? s.code : '', ok ? sampleUrl(s.code, env) : '']);
  }
  return out;
}

/* ---------- DB ---------- */

function createStore(pool, { randomInt = crypto.randomInt } = {}) {
  const q = async (sql, params) => (await pool.query(sql, params))[0];
  const marks = (n) => Array.from({ length: n }, () => '?').join(',');

  /** 店(shops)を引く。戻り: Map(id文字列 → 行) */
  async function shopsByIds(ids) {
    const m = new Map();
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      const rows = await q(`SELECT id, name, category, category_main, postal, address, prefecture, phone, last_seen_at FROM ${SHOPS} WHERE id IN (${marks(part.length)})`, part);
      for (const r of rows) m.set(String(r.id), r);
    }
    return m;
  }
  async function existingByShop(ids) {
    const m = new Map();
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      const rows = await q(`SELECT id, code, shop_id, status FROM ${T} WHERE shop_id IN (${marks(part.length)}) ORDER BY id`, part);
      for (const r of rows) {
        const k = String(r.shop_id), cur = m.get(k);
        if (!cur || (cur.status === 'deleted' && r.status !== 'deleted')) m.set(k, r);
      }
    }
    return m;
  }

  /** 1店ぶんの行を作る。コードが重なったら引き直す(最大30回) */
  async function insertWithCode(shopId, groupId, label) {
    for (let i = 0; i < 30; i++) {
      const code = newCode(randomInt);
      try {
        const r = await q(`INSERT INTO ${T} (code, shop_id, group_id, batch_label) VALUES (?, ?, ?, ?)`, [code, shopId, groupId, label || null]);
        return { id: r.insertId, code };
      } catch (e) { if (!isDup(e)) throw e; }
    }
    throw new Error('見本コードを決められませんでした(重複が続きました)');
  }

  /**
   * 倉庫IDの一覧から見本を作る。同じ店の見本がすでにあれば作り直さず、既存のコードを使う。
   * 戻り: { byId: Map(店ID → {code,status,isNew}), created, existing, skipped:[{id,reason,name}] }
   * reason: 'notfound'(倉庫にない) / 'nogroup'(業種が合わない) / 'deleted'(削除済みの見本がある。断られた店なので作り直さない)
   */
  async function createForShops(ids, label) {
    if (ids.length > MAX_IDS) throw Object.assign(new Error(`一度に作れるのは${MAX_IDS}件までです。`), { userSafe: true });
    const shops = await shopsByIds(ids);
    const ex = await existingByShop(ids);
    const byId = new Map(), skipped = [];
    let created = 0, existing = 0;
    for (const id of ids) {
      const shop = shops.get(id);
      if (!shop) { skipped.push({ id, reason: 'notfound' }); continue; }
      const old = ex.get(id);
      if (old) {
        if (old.status === 'deleted') { skipped.push({ id, reason: 'deleted', name: shop.name }); byId.set(id, { code: old.code, status: 'deleted', isNew: false }); continue; }
        byId.set(id, { code: old.code, status: old.status, isNew: false });
        existing++;
        continue;
      }
      const group = C.groupFor(shop);
      if (!group) { skipped.push({ id, reason: 'nogroup', name: shop.name }); continue; }
      const r = await insertWithCode(id, group.id, label);
      byId.set(id, { code: r.code, status: 'draft', isNew: true });
      created++;
    }
    return { byId, created, existing, skipped };
  }

  /** 表示用: コードから見本と店を引く。無ければ null */
  async function getByCode(code) {
    const rows = await q(`SELECT p.id, p.code, p.shop_id, p.group_id, p.hours_json, p.status, p.created_at, s.name, s.category, s.category_main, s.postal, s.address, s.prefecture, s.phone, s.last_seen_at
      FROM ${T} p JOIN ${SHOPS} s ON s.id = p.shop_id WHERE p.code = ?`, [code]);
    if (!rows.length) return null;
    const r = rows[0];
    return {
      page: { id: r.id, code: r.code, shop_id: r.shop_id, group_id: r.group_id, hours_json: r.hours_json, status: r.status, created_at: r.created_at },
      shop: { name: r.name, category: r.category, category_main: r.category_main, postal: r.postal, address: r.address, prefecture: r.prefecture, phone: r.phone, last_seen_at: r.last_seen_at },
    };
  }

  /** 開かれた記録(ボットは呼ばない) */
  async function recordOpen(id) {
    await q(`UPDATE ${T} SET open_count = open_count + 1, first_opened_at = COALESCE(first_opened_at, NOW()), last_opened_at = NOW() WHERE id = ?`, [id]);
  }

  /** 一覧。f: { batch, status, q(店名・コード), stale(作成から30日・掲載OKでない), limit, offset } */
  async function list(f = {}) {
    const where = ['1=1'], params = [];
    if (f.batch) { where.push('p.batch_label = ?'); params.push(f.batch); }
    if (f.status && STATUSES.includes(f.status)) { where.push('p.status = ?'); params.push(f.status); }
    if (f.q) {
      if (CODE_RE.test(f.q)) { where.push('p.code = ?'); params.push(f.q); }
      else { where.push('s.name LIKE ?'); params.push('%' + String(f.q).replace(/[\\%_]/g, '\\$&') + '%'); }
    }
    if (f.stale) where.push("p.status <> 'approved' AND p.created_at < (NOW() - INTERVAL 30 DAY)");
    const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 500), offset = Math.max(Number(f.offset) || 0, 0);
    const [{ n }] = await q(`SELECT COUNT(*) AS n FROM ${T} p JOIN ${SHOPS} s ON s.id = p.shop_id WHERE ${where.join(' AND ')}`, params);
    const rows = await q(`SELECT p.id, p.code, p.shop_id, p.group_id, p.status, p.open_count, p.last_opened_at, p.batch_label, p.created_at, s.name, s.category_main, s.address, s.prefecture
      FROM ${T} p JOIN ${SHOPS} s ON s.id = p.shop_id WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT ${limit} OFFSET ${offset}`, params);
    return { total: Number(n), rows: rows.map((r) => ({ ...r, area: areaOf(r) })), limit, offset };
  }
  async function batchLabels() {
    return (await q(`SELECT DISTINCT batch_label FROM ${T} WHERE batch_label IS NOT NULL ORDER BY batch_label DESC LIMIT 200`)).map((r) => r.batch_label);
  }
  async function getById(id) {
    const rows = await q(`SELECT p.*, s.name, s.category_main, s.category, s.address, s.prefecture, s.phone FROM ${T} p JOIN ${SHOPS} s ON s.id = p.shop_id WHERE p.id = ?`, [id]);
    return rows[0] || null;
  }
  async function update(id, { hours, note, status }) {
    if (!STATUSES.includes(status)) throw Object.assign(new Error('状態が正しくありません。'), { userSafe: true });
    const n = String(note || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 500);
    await q(`UPDATE ${T} SET hours_json = ?, note = ?, status = ? WHERE id = ?`, [hours ? JSON.stringify(hours) : null, n || null, status, id]);
  }

  return { createForShops, getByCode, recordOpen, list, batchLabels, getById, update, shopsByIds };
}

module.exports = {
  T, STATUSES, STATUS_LABEL, DAYS, CODE_RE, MAX_IDS, isDup, sampleBaseUrl, sampleUrl, newCode, areaOf,
  normalizeHours, hoursFromForm, groupHours, isClosed, buildView, parseIdList, readCsvRows, buildResultCsv, csvLine, createStore,
};
