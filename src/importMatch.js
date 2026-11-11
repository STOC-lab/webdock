'use strict';
/**
 * 倉庫の取り込み: CIDがない行を、既存の店と電話番号で照合する。
 *   照合の順番: CID で一致 → (CIDなしの行だけ)電話番号で一致 → 新規
 *
 * このファイルは「どの店と同じか」を決める部分だけ(書き込みはしない)。DBへの読み取りは store(下の makeDbStore)に任せるので、
 * テストでは store を差し替えられる。--dry-run も本番の取り込みも同じ classifyBatch を通るので、同じ件数になる。
 *
 * 電話番号の照合の決まり:
 *   - 数字だけにそろえ、「,」「/」「、」で分けた番号のどれか1つでも一致すれば候補にする
 *   - 0120/0800/0570、空欄、6桁未満の番号、都道府県が決まらない行は照合しない
 *   - 同じ都道府県の既存の店から探す
 *   - 候補が1件 → 同じ店 / 複数 → 屋号が似ている店(normShopName + nameLike)が1件だけならその店 / 決まらなければ保留(新しく追加しない)
 *   - 同じ取り込みの中で先に新規追加した店とも照合する(overlay)
 * 既存の店の更新は「空欄だけ補う」(上書きしない)。URLだけは下の decideUrl の決まりに従う。
 */
const { siteHostOf } = require('./siteHost');
const { PHONE_MIN_DIGITS, isFreeDial, normShopName, nameLike } = require('./stocMatch');

const PHONE_SPLIT = /[,/、]/;
// 全角数字 → 半角(sql/warehouse_migrate_011.sql の生成列と同じ変換)
const FULL_DIGITS = { '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9' };
const keyDigits = (v) => String(v === null || v === undefined ? '' : v).replace(/[０-９]/g, (c) => FULL_DIGITS[c]).replace(/[^0-9]/g, '');

/**
 * 電話欄の「1つ目・2つ目の番号」(数字だけ)。sql/warehouse_migrate_011.sql の phone_key1 / phone_key2 と同じ値。
 * 3つ目以降は索引にない。空・数字がない場合は null。
 */
function phoneKeys(phone) {
  const parts = String(phone === null || phone === undefined ? '' : phone).split(PHONE_SPLIT);
  const k = (i) => (i < parts.length ? keyDigits(parts[i]) || null : null);
  return [k(0), k(1)];
}

/** 照合に使う番号(全部の番号から、6桁未満とフリーダイヤル・ナビダイヤルを除く。重複なし) */
function lookupNumbers(phone) {
  const out = [];
  for (const p of String(phone === null || phone === undefined ? '' : phone).split(PHONE_SPLIT)) {
    const d = keyDigits(p);
    if (d.length >= PHONE_MIN_DIGITS && !isFreeDial(d) && !out.includes(d)) out.push(d);
  }
  return out;
}

const blank = (v) => v === null || v === undefined || v === '';

/* ---------- URL ---------- */
const urlScheme = (u) => { const t = String(u === null || u === undefined ? '' : u).trim().toLowerCase(); return t.startsWith('http://') ? 'http' : t.startsWith('https://') ? 'https' : ''; };

/**
 * 電話番号で一致した既存の店の website_url の扱い。
 *   既存が空 → 取り込む値で補う('fill')  /  取り込む値が空 → そのまま('none')
 *   同じサイト(siteHostOf が同じ)で既存が http・取り込みが https → 置き換え('upgrade')
 *   同じサイトでそれ以外 → 既存を残す('none')
 *   別のサイト → 既存を残して数える('differ')
 * (CIDで一致したときの pickWebsiteUrl は「ホストが違っても http→https は置き換える」で、別の決まり。そちらは変えない)
 */
function decideUrl(existing, incoming) {
  if (blank(incoming)) return 'none';
  if (blank(existing)) return 'fill';
  const he = siteHostOf(existing);
  const hi = siteHostOf(incoming);
  if (he && hi) {
    if (he !== hi) return 'differ';
    return urlScheme(existing) === 'http' && urlScheme(incoming) === 'https' ? 'upgrade' : 'none';
  }
  return String(existing).trim() === String(incoming).trim() ? 'none' : 'differ'; // ホスト名を取り出せない値は、文字が違えば別とみなす
}

/* ---------- 空欄を補う ---------- */
// website_url は decideUrl で別に扱う。prefecture は同じ県で探しているので既存が必ずある
const FILL_COLS = ['phone', 'category', 'category_main', 'postal', 'address_raw', 'address', 'gbp_registered', 'business_status', 'gmap_url', 'place_id', 'rating', 'review_count', 'photo_count', 'lat', 'lng'];

/**
 * 既存の店(state)に取り込む行(rec)の値を補う内容を決める。上書きはしない。
 * 戻り: { set: { 列: 値 }, url: 'fill'|'upgrade'|'differ'|'none' }(URLが変わるなら set.website_url にも入る)
 */
function planFill(state, rec) {
  const set = {};
  for (const c of FILL_COLS) if (blank(state[c]) && !blank(rec[c])) set[c] = rec[c];
  const url = decideUrl(state.website_url, rec.website_url);
  if (url === 'fill' || url === 'upgrade') set.website_url = rec.website_url;
  return { set, url };
}

/* ---------- 候補から1件を決める ---------- */
/** cands: [{ name, ... }](重複なし)。戻り: { kind: 'match', cand } | { kind: 'held', count } | { kind: 'none' } */
function pickCandidate(cands, name) {
  if (!cands.length) return { kind: 'none' };
  if (cands.length === 1) return { kind: 'match', cand: cands[0] };
  const n = normShopName(name);
  const like = cands.filter((c) => nameLike(n, normShopName(c.name)));
  if (like.length === 1) return { kind: 'match', cand: like[0] };
  return { kind: 'held', count: cands.length };
}

/* ---------- 取り込みの集計 ---------- */
const newStats = () => ({
  rows: 0, skipped: 0,
  cid: 0,        // CIDで一致
  exact: 0,      // CIDなしで、電話+屋号が同じ(従来の fallback_key)で一致
  phone: 0,      // 電話番号で一致
  phoneUrlFilled: 0, phoneUrlDiffered: 0,
  held: 0,       // 複数一致で保留
  inserted: 0,   // 新規
  history: 0,
});
const addStats = (a, b) => { for (const k of Object.keys(a)) a[k] += b[k] || 0; return a; };
/** 既存の店に当たった件数(import_runs.updated と今までの「更新」) */
const updatedOf = (s) => s.cid + s.exact + s.phone;

/** 日本語の1行表示 */
function formatStats(s) {
  return `CIDで一致${s.cid} 電話で一致${s.phone}(URL補完${s.phoneUrlFilled}/URL相違${s.phoneUrlDiffered}) 電話+屋号同一${s.exact} 複数一致で保留${s.held} 新規${s.inserted} スキップ${s.skipped}`;
}

/* ---------- 1バッチの照合 ---------- */

function makeContext({ phoneEnabled, keepOverlay }) {
  return {
    phoneEnabled,
    keepOverlay, // true=オーバーレイを取り込みの最後まで持つ(--dry-run。書かないので先に足した店をDBから引けない)
    overlayCids: new Set(),
    overlayFbs: new Set(),
    overlayByPref: new Map(), // 都道府県 → [{ rec, keys: [k1, k2] }]
    state: new Map(),         // 既存の店ID → 補った後の値(同じ店に2回当たったとき、2回目は1回目の結果を見る)
    heldSamples: [],
  };
}

/**
 * recs(name のある行)を、既存の店のどれと同じかに振り分ける。DBへは書かない(store は読み取りだけ)。
 * store: {
 *   existingCids(cids) -> Set<string>, existingFallbacks(keys) -> Set<string>,
 *   phoneCandidates(prefs, numbers) -> [{ id, name, prefecture, phone_key1, phone_key2, website_url, ...空欄を補う列 }]
 * }
 * 戻り: { legacy: 従来のupsertに渡す行(CIDあり・新規・電話+屋号同一), fills: [{ id, set, state }](DBの既存の店を補う),
 *         stats }  ※オーバーレイ(同じ取り込みで先に新規にする行)への補完は、その行(rec)に直接書き込む。
 */
async function classifyBatch(recs, store, ctx, sourceName) {
  const stats = newStats();
  const cidList = [...new Set(recs.filter((r) => r.cid).map((r) => r.cid))];
  const fbList = [...new Set(recs.filter((r) => !r.cid).map((r) => r.fallback_key))];
  const dbCids = cidList.length ? await store.existingCids(cidList) : new Set();
  const dbFbs = fbList.length ? await store.existingFallbacks(fbList) : new Set();

  // 電話の候補を、このバッチで必要な分だけ先にまとめて引く
  let dbRows = [];
  if (ctx.phoneEnabled) {
    const prefs = new Set(), nums = new Set();
    for (const r of recs) {
      if (r.cid || !r.prefecture || dbFbs.has(r.fallback_key)) continue;
      const ns = lookupNumbers(r.phone);
      if (!ns.length) continue;
      prefs.add(r.prefecture);
      for (const n of ns) nums.add(n);
    }
    if (nums.size) dbRows = await store.phoneCandidates([...prefs], [...nums]);
  }
  const dbIndex = new Map(); // `${県}|${番号}` → [行](重複なし)
  for (const row of dbRows) {
    const st = ctx.state.get(String(row.id));
    const cur = st || row;
    for (const k of new Set([row.phone_key1, row.phone_key2].filter((x) => x))) {
      const key = row.prefecture + '|' + k;
      const l = dbIndex.get(key);
      if (l) { if (!l.some((x) => String(x.id) === String(row.id))) l.push(cur); } else dbIndex.set(key, [cur]);
    }
  }

  const legacy = [];
  const fills = new Map(); // id → { id, set(まとめ), state }
  const addOverlay = (rec) => {
    if (rec.cid) ctx.overlayCids.add(rec.cid); else ctx.overlayFbs.add(rec.fallback_key);
    if (ctx.phoneEnabled && rec.prefecture) {
      const keys = phoneKeys(rec.phone);
      if (keys[0] || keys[1]) {
        const l = ctx.overlayByPref.get(rec.prefecture);
        const e = { rec, keys };
        if (l) l.push(e); else ctx.overlayByPref.set(rec.prefecture, [e]);
      }
    }
  };

  for (const r of recs) {
    if (r.cid) {
      if (dbCids.has(r.cid) || ctx.overlayCids.has(r.cid)) stats.cid++;
      else { stats.inserted++; addOverlay(r); }
      legacy.push(r);
      continue;
    }
    // CIDなし: まず従来の「電話+屋号が同じ」(fallback_key)
    if (dbFbs.has(r.fallback_key) || ctx.overlayFbs.has(r.fallback_key)) { stats.exact++; legacy.push(r); continue; }
    // 電話番号
    const nums = ctx.phoneEnabled && r.prefecture ? lookupNumbers(r.phone) : [];
    let cands = [];
    if (nums.length) {
      for (const n of nums) for (const x of dbIndex.get(r.prefecture + '|' + n) || []) if (!cands.some((c) => c.id !== undefined && String(c.id) === String(x.id))) cands.push(x);
      for (const e of ctx.overlayByPref.get(r.prefecture) || []) {
        if (e.keys.some((k) => k && nums.includes(k)) && !cands.some((c) => c.rec === e.rec)) cands.push({ rec: e.rec, name: e.rec.name, website_url: e.rec.website_url });
      }
    }
    const pick = pickCandidate(cands, r.name);
    if (pick.kind === 'held') {
      stats.held++;
      if (ctx.heldSamples.length < 50) ctx.heldSamples.push({ file: sourceName || '', name: r.name, phone: r.phone, prefecture: r.prefecture, count: pick.count });
      continue;
    }
    if (pick.kind === 'none') { stats.inserted++; addOverlay(r); legacy.push(r); continue; }
    // 一致: 空欄を補う
    stats.phone++;
    const c = pick.cand;
    if (c.rec) { // 同じ取り込みで先に新規にした行へ(その行はこのあと upsert される)
      const { set, url } = planFill(c.rec, r);
      Object.assign(c.rec, set);
      if (url === 'fill' || url === 'upgrade') stats.phoneUrlFilled++; else if (url === 'differ') stats.phoneUrlDiffered++;
    } else {
      const { set, url } = planFill(c, r);
      if (url === 'fill' || url === 'upgrade') stats.phoneUrlFilled++; else if (url === 'differ') stats.phoneUrlDiffered++;
      const next = { ...c, ...set };
      ctx.state.set(String(c.id), next);
      // 同じバッチで同じ店に複数回当たったときの候補にも反映
      for (const l of dbIndex.values()) for (let i = 0; i < l.length; i++) if (String(l[i].id) === String(c.id)) l[i] = next;
      const f = fills.get(String(c.id));
      if (f) { Object.assign(f.set, set); f.state = next; } else fills.set(String(c.id), { id: c.id, before: c, set: { ...set }, state: next });
    }
  }
  if (!ctx.keepOverlay) { ctx.overlayCids.clear(); ctx.overlayFbs.clear(); ctx.overlayByPref.clear(); }
  return { legacy, fills: [...fills.values()], stats };
}

/* ---------- DB から読む store ---------- */
const PHONE_COLS = ['id', 'name', 'prefecture', 'phone_key1', 'phone_key2', 'website_url', ...FILL_COLS.filter((c) => c !== 'prefecture')];

/** 電話番号の照合用の列・索引があるか(sql/warehouse_migrate_011.sql 適用済みか) */
async function phoneIndexReady(pool) {
  try {
    const [c] = await pool.query(
      "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'stoc_master' AND TABLE_NAME = 'shops' AND COLUMN_NAME IN ('phone_key1','phone_key2')");
    if (Number(c[0].n) !== 2) return false;
    const [i] = await pool.query(
      "SELECT COUNT(DISTINCT INDEX_NAME) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = 'stoc_master' AND TABLE_NAME = 'shops' AND INDEX_NAME IN ('idx_pref_phone1','idx_pref_phone2')");
    return Number(i[0].n) === 2;
  } catch { return false; }
}

function makeDbStore(pool, { hasHistory = false } = {}) {
  const histCol = hasHistory ? ', EXISTS(SELECT 1 FROM stoc_master.shop_metrics_history h WHERE h.shop_id = stoc_master.shops.id) AS has_hist' : '';
  const keySet = (rows, col) => new Set(rows.map((x) => String(x[col])));
  return {
    async existingCids(cids) { const [r] = await pool.query('SELECT cid FROM stoc_master.shops WHERE cid IN (?)', [cids]); return keySet(r, 'cid'); },
    async existingFallbacks(keys) { const [r] = await pool.query('SELECT fallback_key FROM stoc_master.shops WHERE fallback_key IN (?)', [keys]); return keySet(r, 'fallback_key'); },
    async phoneCandidates(prefs, numbers) {
      const out = new Map();
      for (const col of ['phone_key1', 'phone_key2']) {
        const [rows] = await pool.query(`SELECT ${PHONE_COLS.join(', ')}${histCol} FROM stoc_master.shops WHERE prefecture IN (?) AND ${col} IN (?)`, [prefs, numbers]);
        for (const x of rows) out.set(String(x.id), x);
      }
      return [...out.values()];
    },
  };
}

module.exports = {
  phoneKeys, lookupNumbers, decideUrl, planFill, pickCandidate, classifyBatch, makeContext, newStats, addStats, updatedOf, formatStats,
  phoneIndexReady, makeDbStore, FILL_COLS, keyDigits,
};
