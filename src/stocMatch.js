'use strict';
/**
 * 倉庫の店と STOC営業管理(stoc_sales.stores)の店の照合。DBへの書き込みはしない。
 *  - 電話番号の総当たり照合: 代表・携帯・フリーダイヤル・その他の4列を区別せず1つの索引に入れる(数字だけで比較・6桁未満は照合しない)
 *      固定・携帯で一致 → 登録済み / フリーダイヤル・ナビダイヤル(0120/0800/0570)だけで一致 → 要確認(チェーン・本部の共通番号のことがある)
 *  - 店名+住所の照合: 店名(空白・記号・法人格を除き、完全一致か4文字以上の包含)と、建物名を除く住所が一致(市区町村までの住所は使わない)
 *
 * もとは cli/warehouse-promote.js にあった(取り出しCSVの「登録済み」判定)。warehouse-promote は今もここから同じ関数を使い、結果は変わらない。
 * 倉庫から直接送るときの除外(一致したSTOCの店がクレーム・失注・契約か)には「どの店と一致したか」が要るので、
 * 索引を { withIds: true } で作ると、店IDも持つ(STOCの全店を読むので、必要なときだけ付ける。既定は従来どおり件数だけ)。
 */

const PHONE_MIN_DIGITS = 6;
/** ハイフン・空白・全角を除いた数字だけ(全角数字は半角にそろえる) */
const phoneDigits = (v) => String(v === null || v === undefined ? '' : v).normalize('NFKC').replace(/\D/g, '');
/** フリーダイヤル(0120/0800)とナビダイヤル(0570)か。チェーン・本部の共通番号のことがあるので別扱いにする(050 は普通の番号) */
const isFreeDial = (d) => /^(0120|0800|0570)/.test(d);
/** 倉庫の phone 欄は「,」「/」「、」で複数入っていることがある */
const phoneNumbersOf = (v) => String(v === null || v === undefined ? '' : v).split(/[,/、]/).map(phoneDigits).filter((d) => d.length >= PHONE_MIN_DIGITS);

/* ---------- 電話番号の索引 ---------- */

/**
 * STOC営業管理の電話の索引(正規化した数字 → { n: その番号を持つ店数, last[, ids] })。
 * 代表・携帯・フリーダイヤル・その他の4列を区別せず1つの索引に入れる(列が違っても同じ番号なら一致)。
 * rows は id 昇順で、同じ店が続けて来る前提(同じ店が同じ番号を2列に持っていても1店と数える)。
 * withIds=true なら ids(その番号を持つ店のID。重複なし・昇順)も持つ。
 */
function buildPhoneIndex(rows, { withIds = false } = {}) {
  const idx = new Map();
  for (const s of rows) {
    for (const c of ['phone', 'phone_mobile', 'phone_free', 'phone_other']) {
      const d = phoneDigits(s[c]);
      if (d.length < PHONE_MIN_DIGITS) continue;
      const e = idx.get(d);
      if (!e) idx.set(d, withIds ? { n: 1, last: s.id, ids: [s.id] } : { n: 1, last: s.id });
      else if (e.last !== s.id) { e.n++; e.last = s.id; if (withIds) e.ids.push(s.id); }
    }
  }
  return idx;
}

/** 索引 b を a に足す(id 範囲で区切って読んだページをまとめる。ページの境目で同じ店が分かれることはない) */
function mergePhoneIndex(a, b) {
  for (const [k, v] of b) {
    const e = a.get(k);
    if (!e) a.set(k, v);
    else { e.n += v.n; e.last = v.last; if (e.ids && v.ids) e.ids.push(...v.ids); }
  }
  return a;
}

/**
 * 倉庫の電話1件を索引と照合する。戻り: { kind: 'registered' | 'review' | null, free?: [{ number, stores }] }
 *   registered: 固定・携帯(0120/0800以外)の番号がSTOCのどれかの列と一致 → 登録済みとみなす
 *   review: 一致したのがフリーダイヤルだけ → 登録済みとみなさない(要確認)。free に番号と STOC の店数を付ける
 */
function matchPhone(index, phone) {
  const free = [];
  for (const d of phoneNumbersOf(phone)) {
    const e = index.get(d);
    if (!e) continue;
    if (!isFreeDial(d)) return { kind: 'registered' };
    free.push({ number: d, stores: e.n });
  }
  return free.length ? { kind: 'review', free } : { kind: null };
}

/**
 * matchPhone と同じ判定で、一致した店IDも返す(索引は withIds で作ったもの)。
 * 戻り: { kind, ids: 固定・携帯で一致した店ID(昇順), freeIds: フリーダイヤル等だけで一致した店ID(昇順), free }
 * matchPhone と違い、最初の一致で止めずに倉庫の全番号を見る(複数のSTOCの店と一致することがあるため)。
 */
function matchPhoneIds(index, phone) {
  const ids = new Set();
  const freeIds = new Set();
  const free = [];
  for (const d of phoneNumbersOf(phone)) {
    const e = index.get(d);
    if (!e) continue;
    if (!e.ids) throw new Error('電話の索引に店IDがありません(buildPhoneIndex / loadStocIndex を withIds で作ってください)');
    if (!isFreeDial(d)) for (const id of e.ids) ids.add(id);
    else { free.push({ number: d, stores: e.n }); for (const id of e.ids) freeIds.add(id); }
  }
  const sort = (s) => [...s].sort((x, y) => x - y);
  if (ids.size) return { kind: 'registered', ids: sort(ids), freeIds: sort(freeIds), free };
  return free.length ? { kind: 'review', ids: [], freeIds: sort(freeIds), free } : { kind: null, ids: [], freeIds: [], free: [] };
}

/* ---------- 店名+住所の照合(電話が一致しないときの登録済み判定) ---------- */

/** 店名: 全角・半角をそろえ、空白・記号・法人格を除く */
const normShopName = (s) => String(s === null || s === undefined ? '' : s).normalize('NFKC').toLowerCase()
  .replace(/株式会社|有限会社|合同会社|一般社団法人|医療法人|\(株\)|\(有\)/g, '')
  .replace(/[\s　\-‐-―−ー－・･.,、。()（）[\]【】「」'"]/g, '');
/** 住所: 全角・半角をそろえ、最初の空白から後ろ(建物名)を捨て、丁目・番地・号・各種ハイフンを「-」にそろえる */
const normShopAddr = (s) => String(s === null || s === undefined ? '' : s).normalize('NFKC').toLowerCase()
  .replace(/[\s　]+.*$/, '').replace(/[\-‐-―−ーー丁目番地号]/g, '-').replace(/-+/g, '-').replace(/-$/, '');
/** 住所が短い(市区町村までで、番地の数字がない・短すぎる)ものは判定に使わない */
const addrUsable = (a) => a.length >= 8 && /[0-9]/.test(a);
/** 店名が完全一致、または4文字以上で一方がもう一方を含む */
const nameLike = (a, b) => !!a && !!b && (a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))));

/**
 * STOCの店を「正規化した住所 → 正規化した店名の配列」の索引に足す。
 * withIds=true なら配列の要素は { n: 正規化した店名, id }(どちらの形でも matchNameAddr は使える)。
 */
function addNameAddrIndex(idx, rows, { withIds = false } = {}) {
  for (const s of rows) {
    const a = normShopAddr(s.address);
    const n = normShopName(s.name);
    if (!n || !addrUsable(a)) continue;
    const v = withIds ? { n, id: s.id } : n;
    const l = idx.get(a);
    if (l) l.push(v); else idx.set(a, [v]);
  }
  return idx;
}

const entryName = (x) => (typeof x === 'string' ? x : x.n);

/** 倉庫の店名・住所が、STOCの既存の店と一致するか(住所が短いものは常に false) */
function matchNameAddr(idx, name, address) {
  const a = normShopAddr(address);
  if (!addrUsable(a)) return false;
  const l = idx.get(a);
  if (!l) return false;
  const n = normShopName(name);
  return l.some((x) => nameLike(n, entryName(x)));
}

/** matchNameAddr と同じ判定で、一致した店ID(昇順・重複なし)を返す。索引は withIds で作ったもの。一致しなければ [] */
function matchNameAddrIds(idx, name, address) {
  const a = normShopAddr(address);
  if (!addrUsable(a)) return [];
  const l = idx.get(a);
  if (!l) return [];
  const n = normShopName(name);
  const ids = new Set();
  for (const x of l) {
    if (typeof x === 'string') throw new Error('店名+住所の索引に店IDがありません(addNameAddrIndex / loadStocIndex を withIds で作ってください)');
    if (nameLike(n, x.n)) ids.add(x.id);
  }
  return [...ids].sort((p, q) => p - q);
}

/* ---------- まとめて照合 ---------- */

/**
 * 倉庫の店1件を STOC の索引(withIds で作ったもの)と照合する。判定の順は取り出しCSVと同じ(電話 → 店名+住所)。
 * 戻り: { kind: 'registered' | 'review' | null, by: 'phone' | 'nameaddr' | null, ids: 一致した店ID, freeIds, free }
 *   registered(by=phone): 固定・携帯がSTOCの店と一致
 *   registered(by=nameaddr): 電話は固定・携帯で一致しないが、店名+住所がSTOCの店と一致
 *   review: フリーダイヤル等だけで一致し、店名+住所も一致しない(freeIds にその番号を持つ店)
 */
function matchShop(index, shop) {
  const s = shop || {};
  const m = matchPhoneIds(index.phone, s.phone);
  if (m.kind === 'registered') return { kind: 'registered', by: 'phone', ids: m.ids, freeIds: m.freeIds, free: m.free };
  const na = matchNameAddrIds(index.addr, s.name, s.address_raw || s.address);
  if (na.length) return { kind: 'registered', by: 'nameaddr', ids: na, freeIds: m.freeIds, free: m.free };
  if (m.kind === 'review') return { kind: 'review', by: 'phone', ids: [], freeIds: m.freeIds, free: m.free };
  return { kind: null, by: null, ids: [], freeIds: [], free: [] };
}

/* ---------- STOCから読む ---------- */

/**
 * 営業管理(merged_into が空の店だけ)の電話索引と店名+住所の索引を作る。id 範囲で読む。
 * 戻り: { phone, addr }。withIds=true なら索引に店IDを持ち、status(店ID → 営業管理のステータス)も返す。
 */
async function loadStocIndex(pool, db = require('./stocBatch').stocDbName(), { withIds = false, pageSize = 100000 } = {}) {
  const PG = pageSize;
  const phone = new Map();
  const addr = new Map();
  const status = withIds ? new Map() : null;
  const cols = withIds ? 'id, name, address, phone, phone_mobile, phone_free, phone_other, status' : 'id, name, address, phone, phone_mobile, phone_free, phone_other';
  let last = 0;
  for (;;) {
    const [rows] = await pool.query(
      `SELECT ${cols} FROM ${db}.stores WHERE merged_into IS NULL AND id > ? ORDER BY id LIMIT ?`, [last, PG]);
    if (!rows || !rows.length) break;
    mergePhoneIndex(phone, buildPhoneIndex(rows, { withIds }));
    addNameAddrIndex(addr, rows, { withIds });
    if (status) for (const r of rows) status.set(Number(r.id), r.status === undefined ? null : r.status);
    last = rows[rows.length - 1].id;
    if (rows.length < PG) break;
  }
  return withIds ? { phone, addr, status } : { phone, addr };
}
const loadStocPhoneIndex = async (pool, db) => (await loadStocIndex(pool, db)).phone;

module.exports = {
  PHONE_MIN_DIGITS, phoneDigits, isFreeDial, phoneNumbersOf, buildPhoneIndex, mergePhoneIndex, matchPhone, matchPhoneIds,
  normShopName, normShopAddr, addrUsable, nameLike, addNameAddrIndex, matchNameAddr, matchNameAddrIds, matchShop, loadStocIndex, loadStocPhoneIndex,
};
