'use strict';
/**
 * B2B送信の入力元「送信成功済みの店(営業管理)」(cli/batch-scan.js --source stoc-sent)。
 * STOC営業管理(stoc_sales.stores)のうち、問い合わせフォームの送信に成功したことがある店(inquiry_form_result='成功')を、業種を問わず選ぶ。
 * 送信ツールで実際に送れたフォームなので、倉庫からの取り出しと違ってフォーム探しが要らず、営業管理に登録済み(取り込み不要)。
 * 送信先URLの決め方は営業管理 InquiryExportController::resolveInquiryUrls と同じ:
 *   手入力URL → 送信成功URL → 有効な候補URL(成功回数の多い順・試行回数の少ない順) → ウェブサイトURL
 * 外すもの(件数は まとめ.txt に出る): クレーム登録 / 営業管理で失注・契約 / 最終送信から日が浅い / (batch-scan側で)送信済み・除外ドメイン・チェーン。
 * ※ 営業管理の stores / store_contact_channels / contact_channel_candidates に画像認証(captcha)の列は無いので、画像認証の除外はここでは行わない
 *   (送信ツールが画像認証で止まった店は inquiry_form_result が成功にならないため)。
 */
const { siteHostOf } = require('./siteHost');
const S = require('./stocBatch');
const EX = require('./exclusions');

const SOURCE = 'stoc-sent';
const DEFAULT_MIN_DAYS = 14;
const STATUS_EXCLUDED = ['失注', '契約'];
const REASON = {
  recent: '最終送信から日が浅い',
  chain: 'チェーン・共通ドメイン(営業管理)',
  status: '営業管理で失注・契約',
};

function likeEsc(c) { return '%' + String(c).replace(/[\\%_]/g, '\\$&') + '%'; }
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);

/**
 * 選ぶSQL。戻り: { sql, params }。
 * a: { prefecture(配列 or カンマ区切り。空なら全国), categoryLike, excludeCategoryLike }
 * クレームは件数を数えるため除外せず is_claim 列で返す(JS側で除外)。失注・契約・日の浅さもJS側(件数を数えるため)。
 */
function buildSelectQuery(a = {}, { db = S.stocDbName(), storeFlags = false } = {}) {
  const where = ["s.inquiry_form_result = '成功'", "s.website_url IS NOT NULL AND s.website_url <> ''"];
  const params = [];
  const prefs = list(a.prefecture);
  if (prefs.length) { where.push('s.prefecture IN (?)'); params.push(prefs); }
  const cats = list(a.categoryLike);
  if (cats.length) { where.push('(' + cats.map(() => 's.category LIKE ?').join(' OR ') + ')'); for (const c of cats) params.push(likeEsc(c)); }
  const ex = list(a.excludeCategoryLike);
  if (ex.length) {
    // 「病院」だけは特例: 動物病院(ペット向け)は残す = 病院を含み、かつ動物病院を含まない業種だけを外す
    const parts = [];
    const ps = [];
    for (const c of ex) {
      if (c === '病院') { parts.push('NOT (s.category LIKE ? AND s.category NOT LIKE ?)'); ps.push(likeEsc('病院'), likeEsc('動物病院')); } else { parts.push('s.category NOT LIKE ?'); ps.push(likeEsc(c)); }
    }
    where.push('(s.category IS NULL OR (' + parts.join(' AND ') + '))');
    params.push(...ps);
  }
  const claim = [`EXISTS (SELECT 1 FROM ${db}.sales_logs clm WHERE clm.store_id = s.id AND clm.deleted_at IS NULL AND clm.call_result = 'クレーム')`];
  if (storeFlags) claim.push(`EXISTS (SELECT 1 FROM ${db}.store_flags f WHERE f.store_id = s.id AND f.flag = 'クレーム' AND f.cleared_at IS NULL)`);
  const sql = `SELECT s.id, s.name, s.website_url, s.prefecture, s.category, s.phone, s.phone_mobile, s.phone_free, s.address, s.status, s.inquiry_form_sent_at,
(${claim.join(' OR ')}) AS is_claim
FROM ${db}.stores s WHERE ${where.join(' AND ')}
ORDER BY s.inquiry_form_sent_at IS NULL, s.inquiry_form_sent_at ASC, s.id ASC`;
  return { sql, params };
}

/** 送信先URLを引く SQL(営業管理と同じ並び)。戻り: { channels:{sql,params}, candidates:{sql,params} } */
function buildResolveQueries(ids, db = S.stocDbName()) {
  return {
    channels: { sql: `SELECT store_id, manual_inquiry_url, confirmed_inquiry_url FROM ${db}.store_contact_channels WHERE store_id IN (?)`, params: [ids] },
    candidates: {
      sql: `SELECT store_id, value FROM ${db}.contact_channel_candidates WHERE store_id IN (?) AND channel_type = 'inquiry_url' AND is_active = 1 ORDER BY store_id, success_count DESC, try_count ASC, id ASC`,
      params: [ids],
    },
  };
}

/**
 * 送信先URLの決定(純粋関数)。優先: manual → confirmed → 候補の先頭(並び順の最良) → ウェブサイトURL。
 * channels: Map(storeId → {manual_inquiry_url, confirmed_inquiry_url}) / candidates: Map(storeId → 並び順の先頭の value)
 */
function pickInquiryUrl(websiteUrl, channel, candidate) {
  const t = (v) => String(v === undefined || v === null ? '' : v).trim();
  const ch = channel || {};
  return t(ch.manual_inquiry_url) || t(ch.confirmed_inquiry_url) || t(candidate) || t(websiteUrl);
}

const isNoTable = (e) => !!e && (e.errno === 1146 || e.code === 'ER_NO_SUCH_TABLE');

/** 店舗ID群の送信先URLを引く。戻り: Map(id → URL)。表がない環境(1146)はウェブサイトURLにフォールバック */
async function resolveFormUrls(pool, stores, db = S.stocDbName()) {
  const out = new Map();
  const ids = stores.map((s) => Number(s.id));
  const channels = new Map();
  const candidates = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const q = buildResolveQueries(chunk, db);
    try {
      const [rows] = await pool.query(q.channels.sql, q.channels.params);
      for (const r of rows) channels.set(Number(r.store_id), r);
    } catch (e) { if (!isNoTable(e)) throw e; }
    try {
      const [rows] = await pool.query(q.candidates.sql, q.candidates.params);
      for (const r of rows) {
        const sid = Number(r.store_id);
        if (!candidates.has(sid) && String(r.value === null || r.value === undefined ? '' : r.value).trim() !== '') candidates.set(sid, r.value); // 並び順の先頭だけ採用
      }
    } catch (e) { if (!isNoTable(e)) throw e; }
  }
  for (const s of stores) out.set(Number(s.id), pickInquiryUrl(s.website_url, channels.get(Number(s.id)), candidates.get(Number(s.id))));
  return out;
}

/** ウェブサイトのホスト名ごとの店数を数え、CHAIN_MIN 店以上が使うホスト名の集合を返す(純粋関数) */
function chainHostsOf(urls, min = EX.CHAIN_MIN) {
  const cnt = new Map();
  for (const u of urls) {
    const h = siteHostOf(u);
    if (h) cnt.set(h, (cnt.get(h) || 0) + 1);
  }
  return new Set([...cnt].filter(([, n]) => n >= min).map(([h]) => h));
}

/** 営業管理の全店のウェブサイトURLからチェーン・共通ドメインを数える(全都道府県。50万行ほどを1回読む) */
async function loadStocChainHosts(pool, db = S.stocDbName()) {
  const [rows] = await pool.query(`SELECT website_url FROM ${db}.stores WHERE website_url IS NOT NULL AND website_url <> ''`);
  return chainHostsOf(rows.map((r) => r.website_url));
}

/**
 * 行(SQL結果)から、クレーム・失注/契約・最終送信から日が浅い店を外す。理由の判定順は この順。
 * 戻り: { rows, counts }(件数0の理由は含めない)
 */
function filterStoreRows(rows, { minDays = DEFAULT_MIN_DAYS, now = new Date() } = {}) {
  const counts = {};
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  const kept = [];
  const limitMs = Number(minDays) > 0 ? Number(minDays) * 86400e3 : 0;
  for (const r of rows) {
    if (Number(r.is_claim) === 1 || r.is_claim === true) { bump(EX.REASON.claim); continue; }
    if (STATUS_EXCLUDED.includes(r.status)) { bump(REASON.status); continue; }
    if (limitMs && r.inquiry_form_sent_at) {
      const t = new Date(r.inquiry_form_sent_at).getTime();
      if (Number.isFinite(t) && now.getTime() - t < limitMs) { bump(REASON.recent); continue; }
    }
    kept.push(r);
  }
  return { rows: kept, counts };
}

/** SQL行 + 送信先URL → batch-scan の行(倉庫版と同じ形) */
function toScanRow(r, formUrl) {
  return {
    store_id: String(r.id), name: r.name || '', url: r.website_url || '', prefecture: r.prefecture || '', category: r.category || '',
    formUrl: formUrl || r.website_url || '', captcha: '', noSales: '', phone: S.contactPhone(r), address: r.address || '', stocStoreId: String(r.id),
  };
}

/**
 * 営業管理から読む。claim は checkClaimAccess の結果({ storeFlags })。
 * 戻り: { rows(batch-scan行), counts(ここで外した理由別の件数), chain:{hosts:Set}, total(SQLで選んだ件数) }
 */
async function loadStocSentRows(pool, a, { storeFlags = false, now = new Date(), db = S.stocDbName() } = {}) {
  const q = buildSelectQuery(a, { db, storeFlags });
  const [rows] = await pool.query(q.sql, q.params);
  const f = filterStoreRows(rows, { minDays: a.minDaysSinceSent === undefined ? DEFAULT_MIN_DAYS : a.minDaysSinceSent, now });
  const urls = await resolveFormUrls(pool, f.rows, db);
  const hosts = await loadStocChainHosts(pool, db);
  return { rows: f.rows.map((r) => toScanRow(r, urls.get(Number(r.id)))), counts: f.counts, chain: { hosts }, total: rows.length };
}

module.exports = {
  SOURCE, DEFAULT_MIN_DAYS, STATUS_EXCLUDED, REASON, buildSelectQuery, buildResolveQueries, pickInquiryUrl, resolveFormUrls, chainHostsOf,
  loadStocChainHosts, filterStoreRows, toScanRow, loadStocSentRows,
};
