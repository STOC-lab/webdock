'use strict';
// MEO順位(Googleマップでの表示順位)の調査。
// Google公式 Places API (New) の Text Search を「IDのみ」で使う(この区分は無料・無制限)。
// 他のフィールドを要求すると有料になるため、フィールドマスクは固定。変更しないこと。

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText'; // ホスト固定(places.googleapis.com)
const FIELD_MASK = 'places.id,nextPageToken'; // 絶対に変えない(増やすと課金対象のSKUになる)
const PAGE_SIZE = 20;
const MAX_PAGES = 3; // 最大60件
const PAGE_WAIT_MS = 2000; // 次ページ取得前の待ち
const TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NO_KEY_MESSAGE = 'MEO順位を調べるには、管理者がGoogleのAPIキーを設定してください';
const NOT_FOUND_MESSAGE = 'Googleマップで店舗を特定できませんでした';

const defaultDeps = () => ({
  fetch: (...a) => fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  apiKey: process.env.GOOGLE_PLACES_API_KEY || '',
  now: () => Date.now(),
});

const cache = new Map(); // key -> { at, value }
function cacheGet(key, deps) {
  const h = cache.get(key);
  if (!h) return undefined;
  if (deps.now() - h.at > CACHE_TTL_MS) { cache.delete(key); return undefined; }
  return h.value;
}
function cacheSet(key, value, deps) {
  cache.set(key, { at: deps.now(), value });
  if (cache.size > 2000) {
    for (const [k, v] of cache) if (deps.now() - v.at > CACHE_TTL_MS) cache.delete(k);
  }
}
function clearCache() { cache.clear(); }

/** Text Searchを1回呼ぶ。{ ids:[], next } を返す */
async function searchPage(textQuery, pageToken, deps) {
  const body = { textQuery, languageCode: 'ja', regionCode: 'JP', pageSize: PAGE_SIZE };
  if (pageToken) body.pageToken = pageToken;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await deps.fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': deps.apiKey, 'X-Goog-FieldMask': FIELD_MASK },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error('Googleの検索に失敗しました(HTTP ' + res.status + ')');
    const j = await res.json();
    return { ids: (j.places || []).map((p) => p.id).filter(Boolean), next: j.nextPageToken || null };
  } finally { clearTimeout(timer); }
}

/** 店名+住所で検索し、1件目のplace IDを返す(無ければ null) */
async function findPlaceId({ name, address }, deps = defaultDeps()) {
  const q = `${name || ''} ${address || ''}`.trim();
  if (!q) return null;
  const key = 'id|' + q;
  const c = cacheGet(key, deps);
  if (c !== undefined) return c;
  const { ids } = await searchPage(q, null, deps);
  const id = ids[0] || null;
  if (id) cacheSet(key, id, deps);
  return id;
}

/** keywordで検索し、placeIdが何番目か(1始まり)。60件以内に無ければ null */
async function rankFor({ placeId, keyword }, deps = defaultDeps()) {
  const key = 'rank|' + placeId + '|' + keyword;
  const c = cacheGet(key, deps);
  if (c !== undefined) return c;
  let token = null;
  let offset = 0;
  let rank = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await deps.sleep(PAGE_WAIT_MS);
    const { ids, next } = await searchPage(keyword, token, deps);
    const i = ids.indexOf(placeId);
    if (i >= 0) { rank = offset + i + 1; break; }
    offset += ids.length;
    if (!next) break;
    token = next;
  }
  cacheSet(key, rank, deps);
  return rank;
}

/** 店舗特定+各キーワードの順位。キー未設定は { noKey:true, error } */
async function checkRanks({ name, address, keywords }, deps = defaultDeps()) {
  if (!deps.apiKey) return { placeId: null, noKey: true, error: NO_KEY_MESSAGE };
  const placeId = await findPlaceId({ name, address }, deps);
  if (!placeId) return { placeId: null, error: NOT_FOUND_MESSAGE };
  const results = [];
  for (const keyword of (keywords || []).map((k) => String(k || '').trim()).filter(Boolean).slice(0, 3)) {
    const rank = await rankFor({ placeId, keyword }, deps);
    results.push({ keyword, rank, checkedAt: new Date(deps.now()).toISOString() });
  }
  return { placeId, results };
}

/** 住所と業種からキーワードを最大3つ作る */
function suggestKeywords({ address, category }) {
  const cat = String(category || '').split(/[、,，]/)[0].trim();
  const a = String(address || '').replace(/^〒?\s*\d{3}-?\d{4}\s*/, '').replace(/\s+/g, '');
  // 都道府県を除く(「京都府」「北海道」も考慮)
  const rest = a.replace(/^(?:北海道|東京都|京都府|大阪府|.{2,3}県)/, '');
  let city = '';
  // 政令市の区(例: 大阪府大阪市北区 → 大阪市)。市があれば市まで、無ければ区・町・村
  const m = rest.match(/^(.{1,6}?市)/) || rest.match(/^(?:.{1,5}?郡)?(.{1,5}?[区町村])/);
  if (m) city = m[1];
  if (!city || !cat) return [];
  const short = city.replace(/[市区町村]$/, '');
  const out = [`${city} ${cat}`, `${short} ${cat}`, `${city} ${cat} おすすめ`];
  return [...new Set(out)].slice(0, 3);
}

// ---- 連打防止(営業ユーザー単位。5秒以内の再実行は拒否)----
const lastRun = new Map();
const COOLDOWN_MS = 5000;
function tooSoon(userKey, now = Date.now()) {
  const last = lastRun.get(userKey);
  if (last !== undefined && now - last < COOLDOWN_MS) return true;
  lastRun.set(userKey, now);
  if (lastRun.size > 500) for (const [k, t] of lastRun) if (now - t > COOLDOWN_MS) lastRun.delete(k);
  return false;
}
function resetCooldown() { lastRun.clear(); }

module.exports = {
  ENDPOINT, FIELD_MASK, NO_KEY_MESSAGE, NOT_FOUND_MESSAGE, COOLDOWN_MS,
  findPlaceId, rankFor, checkRanks, suggestKeywords, tooSoon, resetCooldown, clearCache,
};
