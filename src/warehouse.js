'use strict';
/** 倉庫(全国データ)取り込み用の純粋ヘルパー。DB・ファイル依存なし。 */
const crypto = require('crypto');

const PREFECTURES = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];

/* ---------- decode ---------- */
function decodeBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('shift_jis').decode(buf);
  }
}

/* ---------- delimiter / parse ---------- */
function detectDelimiter(headerLine) {
  const line = String(headerLine || '');
  const tabs = (line.match(/\t/g) || []).length;
  const commas = (line.match(/,/g) || []).length;
  return tabs >= commas && tabs > 0 ? '\t' : ',';
}

/** 引用符・埋め込み改行対応のパーサ。空行は捨てる。 */
function parseDelimited(text, delim) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  let i = 0;
  const n = text.length;
  let sawAny = false;
  const endRow = () => {
    row.push(field);
    field = '';
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
    sawAny = false;
  };
  while (i < n) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { inQ = true; sawAny = true; i++; continue; }
    if (c === delim) { row.push(field); field = ''; sawAny = true; i++; continue; }
    if (c === '\r') { i++; if (text[i] === '\n') i++; endRow(); continue; }
    if (c === '\n') { i++; endRow(); continue; }
    field += c; sawAny = true; i++;
  }
  if (field !== '' || row.length || sawAny) endRow();
  return rows;
}

/* ---------- header ---------- */
const HEADER_ALIASES = {
  name: ['屋号'],
  category: ['業種'],
  postal: ['郵便番号'],
  address: ['住所'],
  phone: ['電話番号'],
  rating: ['評価'],
  review_count: ['口コミ数'],
  gbp_registered: ['googleマイビジネス登録有無'],
  website_url: ['登録url'],
  gmap_url: ['gmap'],
  photo_count: ['写真枚数'],
  place_id: ['place id', 'place_id', 'placeid'],
  cid: ['cid'],
  lat: ['緯度', 'lat', 'latitude'],
  lng: ['経度', 'lng', 'lon', 'long', 'longitude'],
};
function mapHeader(cells) {
  const map = {};
  cells.forEach((c, i) => {
    const key = String(c || '').replace(/^﻿/, '').trim().toLowerCase();
    if (!key) return;
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(key) && map[field] === undefined) map[field] = i;
    }
  });
  return map;
}

/* ---------- field helpers ---------- */
function extractCid(gmapUrl) {
  const m = /!1s0x[0-9a-f]+:(0x[0-9a-f]+)/i.exec(String(gmapUrl || ''));
  return m ? m[1].toLowerCase() : null;
}

function normalizeCid(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) { try { return '0x' + BigInt(s).toString(16); } catch { return null; } }
  const m = /^(?:0x)?([0-9a-f]+)$/i.exec(s);
  return m ? '0x' + m[1].toLowerCase() : null;
}

function normalizeAddress(s) {
  return String(s == null ? '' : s).replace(/(?<=[0-9０-９])\?(?=[0-9０-９])/g, '－').trim();
}

function prefectureOf(address, folderName) {
  const a = String(address || '').trim();
  for (const p of PREFECTURES) if (a.startsWith(p)) return p;
  const f = String(folderName || '').trim();
  return PREFECTURES.includes(f) ? f : null;
}

function normalizePhone(s) {
  return String(s == null ? '' : s).replace(/\D/g, '');
}

function toNum(v, int) {
  const s = String(v == null ? '' : v).replace(/,/g, '').trim();
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const x = Number(s);
  return int ? Math.trunc(x) : x;
}

/** 緯度経度: 日本国内の範囲外・既知の偽固定点(35.6894807,139.6916863)・数値でないものはNULL。 */
function parseCoord(v, kind) {
  const x = toNum(v, false);
  if (x === null) return null;
  const [lo, hi] = kind === 'lat' ? [20, 46] : [122, 154];
  return x >= lo && x <= hi ? x : null;
}
function cleanLatLng(latV, lngV) {
  const lat = parseCoord(latV, 'lat');
  const lng = parseCoord(lngV, 'lng');
  if (lat === null || lng === null) return { lat: null, lng: null };
  if (lat.toFixed(6) === '35.689481' && lng.toFixed(6) === '139.691686') return { lat: null, lng: null };
  return { lat, lng };
}

function toRecord(cells, map, sourceFile, folderName) {
  const get = (f) => {
    const i = map[f];
    if (i === undefined || i >= cells.length) return null;
    const v = String(cells[i] == null ? '' : cells[i]).trim();
    return v === '' ? null : v;
  };
  const addressRaw = get('address');
  const address = addressRaw === null ? null : normalizeAddress(addressRaw);
  const gmap = get('gmap_url');
  let cid = map.cid !== undefined ? normalizeCid(get('cid')) : null;
  if (!cid) cid = extractCid(gmap);
  const phone = get('phone');
  const ll = cleanLatLng(get('lat'), get('lng'));
  return {
    cid,
    name: get('name'),
    category: get('category'),
    postal: get('postal'),
    address_raw: addressRaw,
    address,
    prefecture: prefectureOf(address, folderName),
    phone,
    rating: toNum(get('rating'), false),
    review_count: toNum(get('review_count'), true),
    gbp_registered: get('gbp_registered'),
    website_url: get('website_url'),
    gmap_url: gmap,
    photo_count: toNum(get('photo_count'), true),
    place_id: get('place_id'),
    lat: ll.lat,
    lng: ll.lng,
    source_file: sourceFile || null,
  };
}

function fallbackKey(rec) {
  return crypto.createHash('sha1').update(normalizePhone(rec.phone) + '|' + (rec.name || '')).digest('hex');
}

/* ---------- Shift_JIS encoder ---------- */
let SJIS_MAP = null;
function buildSjisMap() {
  const dec = new TextDecoder('shift_jis');
  const map = new Map();
  for (let b = 0x20; b < 0x7f; b++) map.set(String.fromCharCode(b), [b]);
  map.set('\t', [9]); map.set('\r', [13]); map.set('\n', [10]);
  for (let b = 0xa1; b <= 0xdf; b++) map.set(dec.decode(Uint8Array.of(b)), [b]);
  const leads = [];
  for (let l = 0x81; l <= 0x9f; l++) leads.push(l);
  for (let l = 0xe0; l <= 0xfc; l++) leads.push(l);
  for (const l of leads) {
    for (let t = 0x40; t <= 0xfc; t++) {
      if (t === 0x7f) continue;
      const s = dec.decode(Uint8Array.of(l, t));
      if (s.length >= 1 && !s.includes('�') && [...s].length === 1 && !map.has(s)) map.set(s, [l, t]);
    }
  }
  // 全角チルダ等の揺れ: 〜(U+301C)はデコード側にあり、～(U+FF5E)はCP932のみ。未登録なら同一視。
  if (!map.has('～') && map.has('〜')) map.set('～', map.get('〜'));
  if (!map.has('〜') && map.has('～')) map.set('〜', map.get('～'));
  if (!map.has('－')) map.set('－', map.get('−') || [0x81, 0x7c]);
  return map;
}
function encodeShiftJis(str) {
  if (!SJIS_MAP) SJIS_MAP = buildSjisMap();
  const out = [];
  for (const ch of String(str)) {
    const b = SJIS_MAP.get(ch);
    if (b) out.push(...b); else out.push(0x3f);
  }
  return Buffer.from(out);
}

module.exports = {
  PREFECTURES, decodeBuffer, detectDelimiter, parseDelimited, mapHeader, extractCid, normalizeCid,
  normalizeAddress, prefectureOf, normalizePhone, toRecord, cleanLatLng, fallbackKey, encodeShiftJis,
};
