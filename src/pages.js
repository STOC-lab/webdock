'use strict';
/**
 * 御社専用ページのデータ層。
 *  - 倉庫DB(stoc_master.webdock_pages): ページ本体・閲覧回数・申込時刻
 *  - STOC営業管理(stoc_sales)への書き込み: MEOレポートのページと同じ表に書くので、STOCの画面に同じように出る
 *      store_reports      レポート本体(店ごとに1行。トークンはSTOC側の長いもので、お客様には出さない)
 *      store_report_views 閲覧(ReportViewApiController と同じ列)。見込み客一覧・優先架電の「人が読んだ」判定がこれを見る
 *      report_inquiries   「相談」の申込 = 見込み客一覧(/report-leads)の「相談・受取希望」(ReportInquiryController と同じ列)
 *      sales_logs         店舗の履歴メモ(申込の内容・配信不要)。配信不要は call_result='クレーム'(CallVocabulary::CLAIM。問い合わせ営業・AIダイアラーから外れる)
 *  接続は倉庫と同じ WH_DB_* の資格情報。プールは引数で受ける(テストでは偽物を渡す)。
 */
const crypto = require('crypto');
const S = require('./stocBatch');
const { newToken } = require('./pageCore');

const WH = 'stoc_master.webdock_pages';
const MARK = '【WEBドック】';
const LEAD_DUP_MS = 10 * 60 * 1000; // 同じページからの申込をこの間隔内に重ねて押したら1件にする

// 書き込む列(権限の確認・GRANT・実際のSQLで同じものを使う)
const VIEW_UPDATE_COLS = ['last_activity_at', 'view_duration_seconds', 'max_scroll_percentage', 'reached_cta', 'cta_clicked', 'cta_action', 'cta_action_at'];
const INQUIRY_COLS = ['store_id', 'report_id', 'name', 'phone', 'preferred_time', 'inquiry_type', 'ip_address', 'email'];
const LOG_COLS = ['store_id', 'user_id', 'legacy_rep_name', 'status', 'call_result', 'memo'];

function grantStatements(env = process.env, db = S.stocDbName(env)) {
  const user = env.WH_DB_USER || 'stoc_wh';
  const host = env.WH_DB_HOST;
  const h = !host || host === '127.0.0.1' || host === '::1' ? 'localhost' : host;
  const to = `'${user}'@'${h}'`;
  return [
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${WH} TO ${to};`,
    `GRANT SELECT, INSERT ON ${db}.store_reports TO ${to};`,
    `GRANT UPDATE (view_count, last_viewed_at) ON ${db}.store_reports TO ${to};`,
    `GRANT SELECT, INSERT ON ${db}.store_report_views TO ${to};`,
    `GRANT UPDATE (${VIEW_UPDATE_COLS.join(', ')}) ON ${db}.store_report_views TO ${to};`,
    `GRANT INSERT ON ${db}.report_inquiries TO ${to};`,
    `GRANT INSERT ON ${db}.sales_logs TO ${to};`,
    `GRANT SELECT ON ${db}.stores TO ${to};`,
  ];
}

function pagePermissionMessage(cause, env = process.env, db = S.stocDbName(env)) {
  return `御社専用ページの記録と、STOC営業管理(${db})の見込み客・閲覧への書き込みに必要な権限が、倉庫DBユーザーにありません(${cause})。\n`
    + '専用ページの閲覧・申込がSTOCに届かないまま送ってしまわないよう、処理を中止しました。root で次を実行してください:\n'
    + grantStatements(env, db).join('\n');
}
function pageTableMessage(cause) {
  return `専用ページの表 stoc_master.webdock_pages を使えません(${cause})。\n先に sql/warehouse_migrate_006.sql を適用してください(mysql < sql/warehouse_migrate_006.sql)。`;
}

/**
 * 権限の事前確認。何も書かずに、0行を対象にした文で権限だけ検査する(診断を始める前・サーバー起動時に呼ぶ)。
 * 足りなければ例外(pageCheck: true。メッセージに GRANT を並べる)。
 */
async function checkPageAccess(pool, { env = process.env } = {}) {
  const db = S.stocDbName(env);
  const probes = [
    `SELECT id, token, stoc_store_id FROM ${WH} WHERE 1 = 0`,
    `INSERT INTO ${WH} (token, domain, company_name) SELECT 'probe', 'probe', 'probe' FROM DUAL WHERE 1 = 0`,
    `UPDATE ${WH} SET view_count = view_count WHERE 1 = 0`,
    `DELETE FROM ${WH} WHERE 1 = 0`,
    `SELECT id, store_id FROM ${db}.store_reports WHERE 1 = 0`,
    `INSERT INTO ${db}.store_reports (store_id, token, title, cta_text) SELECT 0, 'probe', 'probe', 'probe' FROM DUAL WHERE 1 = 0`,
    `UPDATE ${db}.store_reports SET view_count = view_count, last_viewed_at = last_viewed_at WHERE 1 = 0`,
    `SELECT id, store_id FROM ${db}.store_report_views WHERE 1 = 0`,
    `INSERT INTO ${db}.store_report_views (report_id, store_id, ip_address, user_agent, referer) SELECT 0, 0, NULL, NULL, NULL FROM DUAL WHERE 1 = 0`,
    `UPDATE ${db}.store_report_views SET ${VIEW_UPDATE_COLS.map((c) => `${c} = ${c}`).join(', ')} WHERE 1 = 0`,
    `INSERT INTO ${db}.report_inquiries (${INQUIRY_COLS.join(', ')}) SELECT 0, 0, NULL, '', NULL, 'consultation', NULL, NULL FROM DUAL WHERE 1 = 0`,
    `INSERT INTO ${db}.sales_logs (${LOG_COLS.join(', ')}) SELECT 0, NULL, NULL, '未対応', NULL, NULL FROM DUAL WHERE 1 = 0`,
    `SELECT id, status FROM ${db}.stores WHERE 1 = 0`,
  ];
  for (const sql of probes) {
    try { await pool.query(sql); } catch (e) {
      if (S.isPermissionError(e)) throw Object.assign(new Error(pagePermissionMessage(e.message, env, db)), { pageCheck: true });
      if (e && (e.errno === 1146 || e.code === 'ER_NO_SUCH_TABLE') && sql.includes(WH)) throw Object.assign(new Error(pageTableMessage(e.message)), { pageCheck: true });
      throw Object.assign(new Error(`専用ページの書き込み先の確認に失敗しました: ${e.message}\n(${sql.slice(0, 80)}…)`), { pageCheck: true });
    }
  }
}

const jstDate = (d) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(d || new Date()).map((x) => [x.type, x.value]));
  return `${p.year}年${p.month}月${p.day}日`;
};

/** 診断結果(results)から、ページに出す項目だけを取り出す(HTML・証拠文字列は持たない) */
function summarizeFindings(results) {
  const clip = (s, n) => [...String(s === undefined || s === null ? '' : s)].slice(0, n).join('');
  return (Array.isArray(results) ? results : []).filter((r) => r && r.key).map((r) => ({
    key: clip(r.key, 30), title: clip(r.title, 60), status: ['ok', 'warn', 'bad', 'unknown'].includes(r.status) ? r.status : 'unknown',
    summary: clip(r.summary, 200), remedy: clip(r.remedy, 10),
  }));
}

function parseFindings(json) {
  try {
    const a = JSON.parse(json || '[]');
    return Array.isArray(a) ? a.filter((x) => x && typeof x === 'object') : [];
  } catch { return []; }
}

function createPageStore(pool, { env = process.env, now = () => new Date(), log = (m) => console.error(m) } = {}) {
  const db = S.stocDbName(env);

  /* ---------- ページの作成・取得 ---------- */

  /**
   * rows: [{ shopId, stocStoreId, batchCode, domain, company, findingKey, sentence, findings(results配列), audience }]
   * 各 row に token を入れて返す。トークンの重複(ほぼ起きない)は作り直して最大3回試す。
   */
  async function create(rows) {
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      for (let attempt = 0; ; attempt++) {
        for (const r of chunk) r.token = newToken();
        const values = chunk.map((r) => [r.token, r.shopId === undefined || r.shopId === '' ? null : r.shopId, r.stocStoreId || null, r.batchCode || null, r.domain, r.company,
          r.findingKey || null, r.sentence || null, JSON.stringify(summarizeFindings(r.findings)), r.audience || null]);
        try {
          await pool.query(`INSERT INTO ${WH} (token,shop_id,stoc_store_id,stoc_batch_code,domain,company_name,finding_key,finding_sentence,findings_json,audience) VALUES ?`, [values]);
          break;
        } catch (e) {
          if (e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062) && attempt < 2) continue;
          if (S.isPermissionError(e)) throw Object.assign(new Error(pagePermissionMessage(e.message, env, db)), { pageCheck: true });
          if (e && (e.errno === 1146 || e.code === 'ER_NO_SUCH_TABLE')) throw Object.assign(new Error(pageTableMessage(e.message)), { pageCheck: true });
          throw e;
        }
      }
    }
    return rows.map((r) => r.token);
  }

  async function remove(tokens) {
    const list = (tokens || []).filter(Boolean);
    for (let i = 0; i < list.length; i += 500) await pool.query(`DELETE FROM ${WH} WHERE token IN (?)`, [list.slice(i, i + 500)]);
  }

  async function get(token) {
    const [rows] = await pool.query(`SELECT * FROM ${WH} WHERE token = ? LIMIT 1`, [token]);
    return rows && rows[0] ? rows[0] : null;
  }

  /* ---------- STOC営業管理側 ---------- */

  /** 店のレポート(store_reports)の id。なければ作る。STOC側の token は長いランダム値で、お客様には出さない。
   *  STOCの ensureReport は店ごとに既存の行を使い回すため、のちにMEOのレポートとしても使われる。題名・ボタン文はSTOCと同じにしておく */
  async function ensureReport(q, page) {
    const [found] = await q.query(`SELECT id FROM ${db}.store_reports WHERE store_id = ? ORDER BY id LIMIT 1`, [page.stoc_store_id]);
    if (found && found[0]) return Number(found[0].id);
    const [ins] = await q.query(`INSERT INTO ${db}.store_reports (store_id, token, title, cta_text) VALUES (?,?,?,?)`,
      [page.stoc_store_id, crypto.randomBytes(32).toString('hex'), `${page.company_name} 様 MEO診断レポート`, '無料相談フォームはこちら']);
    return Number(ins.insertId);
  }

  const clip = (s, n) => [...String(s === undefined || s === null ? '' : s)].slice(0, n).join('');

  /**
   * 閲覧を1件記録する(人と思われるアクセスのみ)。戻り: { viewId } (STOC側に書けなければ viewId: 0)
   * bot / HEAD は bot_view_count だけ増やし、STOCには書かない。
   */
  async function recordView(page, { uaClass, ip, ua, referer }) {
    if (uaClass === 'bot') {
      await pool.query(`UPDATE ${WH} SET bot_view_count = bot_view_count + 1, last_ua_class = 'bot' WHERE id = ?`, [page.id]);
      return { viewId: 0 };
    }
    await pool.query(`UPDATE ${WH} SET view_count = view_count + 1, first_viewed_at = COALESCE(first_viewed_at, NOW()), last_viewed_at = NOW(), last_ua_class = 'human' WHERE id = ?`, [page.id]);
    if (!page.stoc_store_id) return { viewId: 0 };
    try {
      const reportId = await ensureReport(pool, page);
      const [ins] = await pool.query(`INSERT INTO ${db}.store_report_views (report_id, store_id, ip_address, user_agent, referer) VALUES (?,?,?,?,?)`,
        [reportId, page.stoc_store_id, ip || null, clip(ua, 500), clip(referer, 1000)]);
      await pool.query(`UPDATE ${db}.store_reports SET view_count = view_count + 1, last_viewed_at = NOW() WHERE id = ?`, [reportId]);
      return { viewId: Number(ins.insertId) || 0 };
    } catch (e) {
      log(`[pages] STOCへの閲覧の記録に失敗: ${S.isPermissionError(e) ? pagePermissionMessage(e.message, env, db) : e.message}`);
      return { viewId: 0 };
    }
  }

  /** 画面の操作が届いた(スクロール・タップなど)。メールの自動巡回と見分けるための「人」の印 */
  async function recordActivity(page, viewId, { scroll = 0, seconds = 0 } = {}) {
    await pool.query(`UPDATE ${WH} SET human_at = COALESCE(human_at, NOW()) WHERE id = ?`, [page.id]);
    if (!viewId || !page.stoc_store_id) return;
    try {
      await pool.query(`UPDATE ${db}.store_report_views SET last_activity_at = NOW(),
        view_duration_seconds = GREATEST(COALESCE(view_duration_seconds, 0), ?), max_scroll_percentage = GREATEST(COALESCE(max_scroll_percentage, 0), ?)
        WHERE id = ? AND store_id = ?`, [Math.max(0, Math.min(Math.floor(seconds) || 0, 3600)), Math.max(0, Math.min(Math.floor(scroll) || 0, 100)), viewId, page.stoc_store_id]);
    } catch (e) { log(`[pages] STOCへの操作の記録に失敗: ${e.message}`); }
  }

  /**
   * 「詳しい簡易レポートを希望する」。倉庫に申込の内容を控え、STOCの見込み客(report_inquiries)・閲覧のCTA・履歴メモを1トランザクションで書く。
   * 戻り: { duplicate, stoc: true|false, error? }。STOCへ書けなくても例外にせず stoc:false で返す(通知メールで取りこぼさないため)。
   */
  async function submitLead(page, form, { ip, ua, viewId = 0 } = {}) {
    if (page.lead_at && now().getTime() - new Date(page.lead_at).getTime() < LEAD_DUP_MS) return { duplicate: true, stoc: !!page.lead_stoc_at };
    const contact = { name: form.name, email: form.email, phone: form.phone || '', message: form.message || '' };
    await pool.query(`UPDATE ${WH} SET lead_at = NOW(), lead_stoc_at = NULL, lead_contact = ? WHERE id = ?`, [JSON.stringify(contact), page.id]);
    if (!page.stoc_store_id) return { duplicate: false, stoc: false, error: '営業管理の店舗IDがありません' };
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const reportId = await ensureReport(conn, page);
      await conn.query(`INSERT INTO ${db}.report_inquiries (${INQUIRY_COLS.join(',')}) VALUES (?,?,?,?,?,?,?,?)`,
        [page.stoc_store_id, reportId, clip(form.name, 100) || null, String(form.phone || '').replace(/[^0-9]/g, ''), `${MARK}簡易レポート希望`, 'consultation', ip || null, form.email || null]);
      // 閲覧のCTA(ボタンを押した)。開いたときの閲覧行があればそれを更新、なければ新しい行
      if (viewId) {
        await conn.query(`UPDATE ${db}.store_report_views SET reached_cta = 1, cta_clicked = 1, cta_action = 'consultation', cta_action_at = NOW(), last_activity_at = NOW() WHERE id = ? AND store_id = ?`, [viewId, page.stoc_store_id]);
      } else {
        await conn.query(`INSERT INTO ${db}.store_report_views (report_id, store_id, ip_address, user_agent, reached_cta, cta_clicked, cta_action, cta_action_at, last_activity_at) VALUES (?,?,?,?,1,1,'consultation',NOW(),NOW())`,
          [reportId, page.stoc_store_id, ip || null, clip(ua, 500)]);
      }
      const [st] = await conn.query(`SELECT status FROM ${db}.stores WHERE id = ? LIMIT 1`, [page.stoc_store_id]);
      const status = (st && st[0] && st[0].status) || '未対応';
      const memo = [`${MARK}御社専用ページから「詳しい簡易レポートを希望する」`, `担当者: ${form.name}`, `メール: ${form.email}`, `電話: ${form.phone || '(未入力)'}`,
        `ひとこと: ${form.message || '(なし)'}`, `対象サイト: ${page.domain}`, `バッチ: ${page.stoc_batch_code || '-'}`].join(' / ');
      await conn.query(`INSERT INTO ${db}.sales_logs (${LOG_COLS.join(',')}) VALUES (?,?,?,?,?,?)`, [page.stoc_store_id, null, 'WEBドック', status, null, memo]);
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch { /* 元のエラーを優先 */ }
      const msg = S.isPermissionError(e) ? pagePermissionMessage(e.message, env, db) : e.message;
      log(`[pages] STOCの見込み客への登録に失敗(申込の内容は webdock_pages.lead_contact と通知メールに残ります): ${msg}`);
      return { duplicate: false, stoc: false, error: msg };
    } finally { if (conn.release) conn.release(); }
    await pool.query(`UPDATE ${WH} SET lead_stoc_at = NOW() WHERE id = ?`, [page.id]);
    return { duplicate: false, stoc: true };
  }

  /**
   * 「今後の案内は不要」。倉庫に opt_out_at を記録し(batch-scan が以後この店を診断前に外す)、
   * STOCには call_result='クレーム' の履歴を1件残す(問い合わせ営業・AIダイアラーから外れる。CallVocabulary::CLAIM)。
   */
  async function optOut(page, { ip } = {}) {
    if (page.opt_out_at) return { already: true, stoc: true };
    await pool.query(`UPDATE ${WH} SET opt_out_at = NOW() WHERE id = ?`, [page.id]);
    if (!page.stoc_store_id) return { already: false, stoc: false };
    try {
      const [st] = await pool.query(`SELECT status FROM ${db}.stores WHERE id = ? LIMIT 1`, [page.stoc_store_id]);
      const status = (st && st[0] && st[0].status) || '未対応';
      await pool.query(`INSERT INTO ${db}.sales_logs (${LOG_COLS.join(',')}) VALUES (?,?,?,?,?,?)`,
        [page.stoc_store_id, null, 'WEBドック', status, 'クレーム', `${MARK}御社専用ページから「今後の案内は不要」(${page.domain} / バッチ ${page.stoc_batch_code || '-'} / IP ${ip || '-'})`]);
      return { already: false, stoc: true };
    } catch (e) {
      log(`[pages] STOCへの配信不要の記録に失敗(webdock_pages.opt_out_at には記録済み): ${S.isPermissionError(e) ? pagePermissionMessage(e.message, env, db) : e.message}`);
      return { already: false, stoc: false, error: e.message };
    }
  }

  /* ---------- 管理画面用 ---------- */

  const FILTERS = { all: '', viewed: 'WHERE view_count > 0', human: 'WHERE human_at IS NOT NULL', lead: 'WHERE lead_at IS NOT NULL', optout: 'WHERE opt_out_at IS NOT NULL' };
  async function listRecent({ filter = 'all', limit = 200 } = {}) {
    const where = FILTERS[filter] !== undefined ? FILTERS[filter] : '';
    const lim = Math.max(1, Math.min(Number(limit) || 200, 500));
    const [rows] = await pool.query(`SELECT id, token, company_name, domain, stoc_store_id, stoc_batch_code, created_at, first_viewed_at, last_viewed_at, view_count, bot_view_count,
      human_at, lead_at, lead_stoc_at, opt_out_at FROM ${WH} ${where} ORDER BY COALESCE(lead_at, last_viewed_at, created_at) DESC, id DESC LIMIT ${lim}`);
    const [[c]] = await pool.query(`SELECT COUNT(*) AS total, SUM(view_count > 0) AS viewed, SUM(human_at IS NOT NULL) AS human, SUM(lead_at IS NOT NULL) AS leads, SUM(opt_out_at IS NOT NULL) AS optout FROM ${WH}`);
    return {
      rows, counts: { total: Number(c.total) || 0, viewed: Number(c.viewed) || 0, human: Number(c.human) || 0, leads: Number(c.leads) || 0, optout: Number(c.optout) || 0 },
    };
  }

  return { create, remove, get, recordView, recordActivity, submitLead, optOut, listRecent, ensureReport, db };
}

/** opt_out_at のある店(STOC営業管理の店舗ID)の集合。表がない(移行006未適用)ときは空 */
async function loadOptOutSet(pool) {
  try {
    const [rows] = await pool.query(`SELECT DISTINCT stoc_store_id FROM ${WH} WHERE opt_out_at IS NOT NULL AND stoc_store_id IS NOT NULL`);
    return new Set(rows.map((r) => Number(r.stoc_store_id)).filter((n) => n > 0));
  } catch (e) {
    if (e && (e.errno === 1146 || e.code === 'ER_NO_SUCH_TABLE')) return new Set();
    throw Object.assign(new Error(`配信不要の申し出を除外するため ${WH} を読む必要がありますが、読めませんでした(${e.message})。\n二重送信・配信不要の送信を防ぐため処理を中止しました。`), { stocCheck: true });
  }
}

module.exports = {
  WH, MARK, LEAD_DUP_MS, VIEW_UPDATE_COLS, INQUIRY_COLS, LOG_COLS, grantStatements, pagePermissionMessage, pageTableMessage, checkPageAccess,
  summarizeFindings, parseFindings, jstDate, createPageStore, loadOptOutSet,
};
