'use strict';

/**
 * 倉庫の管理画面(/admin/warehouse)
 *   取り込み(ファイルを上げる)・取り出し(CSVを作る)・営業管理とつなぐ・状況の確認を、
 *   ブラウザだけでできるようにする。VPSでコマンドを打つ代わりの画面。
 *
 *   使い方: registerAdminWarehouse(app, deps)
 *     deps.jobs       作業実行係(src/adminJobs.js の createJobRunner)
 *     deps.queryStats 倉庫の件数を返す関数(テスト用に差し替え可能)
 *     deps.listPages  専用ページの一覧を返す関数 async ({filter, limit}) => ({rows, counts})(テスト用に差し替え可能。既定は stoc_master.webdock_pages)
 *     deps.uploadDir / deps.exportDir / deps.password / deps.allowIps / deps.secret
 *
 *   WAREHOUSE_ADMIN_PASS が未設定なら、/admin 以下はすべて 404(機能ごと無効)。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const ejs = require('ejs');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { PREFECTURES } = require('./regions');
const { createJobRunner } = require('./adminJobs');

const BASE = '/admin/warehouse';
const COOKIE = 'wh_admin';
const SESSION_MS = 12 * 60 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const STATS_TTL_MS = 60 * 1000;
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
const MAX_UPLOAD_FILES = 200;
const MAX_ZIP_ENTRY_BYTES = 600 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 3 * 1024 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2000;
const IMPORT_PATTERN = 'gmp_*.csv';
const GMP_CSV = /^gmp_.+\.csv$/i;
const EXPORT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}\.csv$/;
// 「診断して文面も作る」のグループ別出力: <exportDir>/b2b_<YYYYMMDD-HHmmss>/ の中の決まった名前のファイルだけ扱う
const GROUP_DIR = /^b2b_\d{8}-\d{6}$/;
const GROUP_FILE = /^(?:group_[a-z_]+_(?:\d+件(?:_確認用)?\.csv|本文\.txt|本文_短縮\.txt|件名\.txt)|まとめ\.txt)$/;
// 単一本文方式のフォルダ内: send_<STOCバッチコード>.csv / 確認用.csv / 本文.txt / まとめ.txt / result.json (バッチコードは sender_YYYYmmdd_HHMMSS_xxxx か DRYRUN, DRYRUN-2…)
const SINGLE_FILE = /^(?:send_(?:sender_\d{8}_\d{6}_[0-9a-f]{4}|DRYRUN(?:-\d{1,2})?)\.csv|確認用\.csv|本文\.txt|まとめ\.txt|result\.json)$/;
const SENDER_CODE = /^(?:sender_\d{8}_\d{6}_[0-9a-f]{4}|DRYRUN(?:-\d{1,2})?)$/;
const GROUP_TEXT_MAX = 64 * 1024; // 画面に出す本文の上限
const DEFAULT_MAIN_CATEGORY = '製造,加工,建設,工事,工務店,板金,鉄工,製作所,塗装,設備,機械,金属,工場,整備';
const VIEWS = path.join(__dirname, '..', 'views', 'admin');

// ---- 小さな道具 ----
const pad = (n) => String(n).padStart(2, '0');
function stamp(d, sep = '-') { return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${sep}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; }
function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtSize(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return Math.ceil(n / 1024) + ' KB';
  return n + ' B';
}
function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
function safeEqual(a, b) { return crypto.timingSafeEqual(sha(a), sha(b)); }
function toList(v) { return v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]; }
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) { try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch { /* 壊れたクッキーは無視 */ } }
  });
  return out;
}
function normIp(ip) { return String(ip || '').trim().replace(/^::ffff:/i, ''); }
const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1';
/**
 * 接続してきた相手のIP。直接つないできた相手のヘッダ(X-Forwarded-For等)は信用しない。
 * 同じ機械(127.0.0.1)のnginxから来たときだけ、nginxが付けた X-Real-IP(なければ X-Forwarded-For の最後)を使う。
 */
function clientIp(req) {
  const peer = normIp(req.socket && req.socket.remoteAddress);
  if (!isLoopback(peer)) return peer;
  const real = normIp(req.headers['x-real-ip']);
  if (real) return real;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(normIp).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : peer;
}

// ---- ファイル名・ZIP ----

/** アップロードされたファイル名の検査。使えない名前なら null。日本語はそのまま残す。 */
function sanitizeFileName(raw) {
  const n = String(raw || '').normalize('NFC');
  if (!n || n.length > 150) return null;
  if (/[\/\\\u0000-\u001f\u007f]/.test(n)) return null; // フォルダ区切り・制御文字は不可
  if (n.startsWith('.') || n.includes('..')) return null;
  if (!/\.(csv|zip)$/i.test(n)) return null;
  return n;
}

/** 同じ名前があれば _2, _3 を付けて重ならない名前にする */
function uniqueName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 100000; i++) {
    const cand = `${base}_${i}${ext}`;
    if (!fs.existsSync(path.join(dir, cand))) return cand;
  }
  throw new Error('名前を決められません');
}

class UserError extends Error {
  constructor(message, status) { super(message); this.userSafe = true; this.status = status || 400; }
}

/** ZIPの中の名前が外へ出ようとしていないか(zip-slip)。怪しければ例外 */
function assertSafeEntryName(name) {
  const n = String(name).replace(/\\/g, '/');
  if (n.includes('\u0000') || n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..')) {
    throw new UserError('ZIPの中に危険なファイル名が含まれていたため、取り込みを中止しました。');
  }
}

/**
 * ZIPを安全に展開する。取り出すのは gmp_*.csv だけ。フォルダ構造は捨てて destDir 直下に置く
 * (ファイル名は自分で決めるので、ZIPの中身のパスで外へ書き出されることはない)。
 */
function extractZip(zipPath, destDir, limits = {}) {
  const maxEntry = limits.maxEntry || MAX_ZIP_ENTRY_BYTES;
  const maxTotal = limits.maxTotal || MAX_ZIP_TOTAL_BYTES;
  let zip;
  try { zip = new AdmZip(zipPath); } catch { throw new UserError('ZIPファイルを開けませんでした: ' + path.basename(zipPath)); }
  const entries = zip.getEntries();
  if (entries.length > MAX_ZIP_ENTRIES) throw new UserError('ZIPの中のファイル数が多すぎます(' + MAX_ZIP_ENTRIES + '件まで)。');
  // 先に全部の名前を検査してから書き出す
  for (const e of entries) {
    assertSafeEntryName(e.entryName);
    try { assertSafeEntryName(e.rawEntryName ? e.rawEntryName.toString('latin1') : e.entryName); } catch (err) { throw err; }
  }
  const saved = [];
  let total = 0, skipped = 0;
  for (const e of entries) {
    if (e.isDirectory) continue;
    const last = String(e.entryName).replace(/\\/g, '/').split('/').pop().replace(/[\u0000-\u001f\u007f�]/g, '_');
    if (!GMP_CSV.test(last)) { skipped++; continue; }
    const size = e.header.size;
    if (size > maxEntry) throw new UserError(`ZIPの中のファイルが大きすぎます: ${last}`);
    total += size;
    if (total > maxTotal) throw new UserError('ZIPを展開したときの合計サイズが大きすぎます。');
    const data = e.getData();
    if (data.length > maxEntry) throw new UserError(`ZIPの中のファイルが大きすぎます: ${last}`);
    const name = uniqueName(destDir, last);
    fs.writeFileSync(path.join(destDir, name), data, { flag: 'wx' });
    saved.push(name);
  }
  return { saved, skipped };
}

// ---- 取り出し(promote)の引数づくり ----

/** 取り出し画面のフォーム内容 → warehouse-promote.js に渡す引数の配列。入力が不正なら { error } */
function buildPromoteArgs(body, { mode, exportDir, now }) {
  const prefs = toList(body.pref).filter((p, i, a) => a.indexOf(p) === i);
  if (!prefs.length) return { error: '都道府県を1つ以上選んでください。' };
  if (prefs.some((p) => !PREFECTURES.includes(p))) return { error: '都道府県の指定が正しくありません。' };
  const preset = body.preset === 'b2b' ? 'b2b' : 'meo';
  const size = ['exclude_large', 'small_only', 'none'].includes(body.size) ? body.size : 'none';
  let limit = 5000;
  if (body.limit !== undefined && String(body.limit).trim() !== '') {
    limit = Number(String(body.limit).trim());
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000000) return { error: '上限件数は1以上の整数で入力してください。' };
  }
  const args = ['cli/warehouse-promote.js', '--prefecture', prefs.join(',')];
  if (preset === 'b2b') {
    const raw = String(body.main_category || '').trim() || DEFAULT_MAIN_CATEGORY;
    const cats = raw.split(/[,、，\s]+/).map((x) => x.trim()).filter(Boolean);
    if (!cats.length || cats.length > 60 || cats.some((c) => c.length > 20 || /[\u0000-\u001f]/.test(c))) {
      return { error: '業種キーワードの入力が正しくありません(カンマ区切り・1語20文字まで)。' };
    }
    args.push('--main-category', cats.join(','), '--no-rules');
  }
  if (body.form_found) args.push('--form-found');
  if (size === 'exclude_large') args.push('--exclude-large');
  else if (size === 'small_only') args.push('--small-only');
  args.push('--limit', String(limit));
  let exportFile = null;
  if (mode === 'report') {
    args.push('--report-only');
  } else {
    exportFile = `${preset === 'b2b' ? 'kojo' : 'meo'}_${stamp(now)}.csv`;
    args.push('--out', path.join(exportDir, exportFile), '--mark');
  }
  return { args, exportFile, preset };
}

/**
 * 「診断して文面も作る」: 取り出し画面(工場・建設用)の絞り込みを batch-scan.js(--source warehouse --template b2b)に渡す引数にする。
 * 結果は b2b_scan_<日時>.csv(UTF-8・BOM付き)。倉庫には「出力済み」の印を付けない。
 */
function buildB2bScanArgs(body, { exportDir, now }) {
  const prefs = toList(body.pref).filter((p, i, a) => a.indexOf(p) === i);
  if (!prefs.length) return { error: '都道府県を1つ以上選んでください。' };
  if (prefs.some((p) => !PREFECTURES.includes(p))) return { error: '都道府県の指定が正しくありません。' };
  const size = ['exclude_large', 'small_only', 'none'].includes(body.size) ? body.size : 'none';
  let limit = 5000;
  if (body.limit !== undefined && String(body.limit).trim() !== '') {
    limit = Number(String(body.limit).trim());
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000000) return { error: '上限件数は1以上の整数で入力してください。' };
  }
  const raw = String(body.main_category || '').trim() || DEFAULT_MAIN_CATEGORY;
  const cats = raw.split(/[,、，\s]+/).map((x) => x.trim()).filter(Boolean);
  if (!cats.length || cats.length > 60 || cats.some((c) => c.length > 20 || /[\u0000-\u001f]/.test(c))) {
    return { error: '業種キーワードの入力が正しくありません(カンマ区切り・1語20文字まで)。' };
  }
  const args = ['cli/batch-scan.js', '--source', 'warehouse', '--template', 'b2b', '--prefecture', prefs.join(','), '--main-category', cats.join(',')];
  const withPage = !!body.with_page;
  if (body.form_found) args.push('--form-found');
  if (size === 'exclude_large') args.push('--exclude-large');
  else if (size === 'small_only') args.push('--small-only');
  const exportFile = `b2b_scan_${stamp(now)}.csv`;
  const singleDir = `b2b_${stamp(now)}`;
  args.push('--limit', String(limit), '--concurrency', '5', '--out', path.join(exportDir, exportFile), '--single-out', path.join(exportDir, singleDir));
  if (withPage) args.push('--with-page');
  return { args, exportFile, singleDir, withPage, preset: 'b2b', estimateHours: Math.max(1, Math.round(limit / 2000)) };
}

// ---- 倉庫の件数(読み取り専用) ----
function createDefaultQueryStats() {
  let pool = null;
  return async function queryStats() {
    if (!pool) {
      pool = require('mysql2/promise').createPool({
        host: process.env.WH_DB_HOST || '127.0.0.1', port: Number(process.env.WH_DB_PORT || 3306),
        user: process.env.WH_DB_USER, password: process.env.WH_DB_PASS, charset: 'utf8mb4', connectionLimit: 2,
      });
    }
    const web = "SUM(website_url IS NOT NULL AND website_url <> '')";
    const base = `SELECT IFNULL(NULLIF(prefecture, ''), '(不明)') AS prefecture, COUNT(*) AS total, ${web} AS web, SUM(stoc_store_id IS NOT NULL) AS linked, SUM(form_status = 'url_found') AS form`;
    let rows, sizeAvailable = true;
    try {
      [rows] = await pool.query({ sql: `${base}, SUM(size_class IS NOT NULL) AS size_checked, SUM(size_class = 'small') AS small, SUM(size_class = 'large') AS large FROM stoc_master.shops GROUP BY 1`, timeout: 120000 });
    } catch (e) {
      if (e && e.errno === 1054) { // size_class 列がまだない(migrate_003 未適用)
        sizeAvailable = false;
        [rows] = await pool.query({ sql: `${base} FROM stoc_master.shops GROUP BY 1`, timeout: 120000 });
      } else throw e;
    }
    const list = rows.map((r) => ({
      prefecture: r.prefecture, total: Number(r.total), web: Number(r.web), linked: Number(r.linked), form: Number(r.form),
      sizeChecked: sizeAvailable ? Number(r.size_checked) : null, small: sizeAvailable ? Number(r.small) : null, large: sizeAvailable ? Number(r.large) : null,
    })).sort((a, b) => b.total - a.total);
    return { total: list.reduce((s, r) => s + r.total, 0), rows: list.slice(0, 47), sizeAvailable };
  };
}

// ---- 本体 ----
function registerAdminWarehouse(app, deps = {}) {
  const password = deps.password !== undefined ? deps.password : process.env.WAREHOUSE_ADMIN_PASS || '';
  const router = express.Router();
  const allowIps = (deps.allowIps !== undefined ? deps.allowIps : process.env.ADMIN_ALLOW_IPS || '')
    .split(',').map(normIp).filter(Boolean);
  if (!password || !allowIps.length) {
    // パスワードか許可IPのどちらかが未設定なら機能ごと無効(存在しないものとして404)
    app.use('/admin', (req, res) => res.status(404).type('text/plain').send('Not Found'));
    return { enabled: false };
  }
  const secret = deps.secret || process.env.WEBDOCK_SECRET || 'dev-insecure-secret-change-me';
  if (!deps.secret && !process.env.WEBDOCK_SECRET) console.warn('[admin] WEBDOCK_SECRET が未設定です。必ず設定してください。');
  if (password.length < 8) console.warn('[admin] WAREHOUSE_ADMIN_PASS が短すぎます(8文字以上を推奨)。');
  const key = crypto.createHmac('sha256', secret).update('admin-key:' + password).digest(); // パスワードを変えると全員ログアウト
  const uploadDir = path.resolve(deps.uploadDir || process.env.WAREHOUSE_UPLOAD_DIR || '/var/data/gmp/uploads');
  const exportDir = path.resolve(deps.exportDir || process.env.WAREHOUSE_EXPORT_DIR || path.join(__dirname, '..', 'data', 'exports'));
  const jobs = deps.jobs || createJobRunner();
  const queryStats = deps.queryStats || createDefaultQueryStats();
  let pagePool = null;
  const listPages = deps.listPages || (async (q) => {
    if (!pagePool) pagePool = require('./stocBatch').createStocPool();
    return require('./pages').createPageStore(pagePool).listRecent(q);
  });
  const now = deps.now || (() => new Date());

  // --- 署名つきセッション(有効期限を署名の中に入れる) ---
  const sign = (s) => crypto.createHmac('sha256', key).update(s).digest('hex');
  function makeSession() {
    const exp = Date.now() + SESSION_MS;
    const nonce = crypto.randomBytes(12).toString('hex');
    return `${exp}.${nonce}.${sign('session:' + exp + '.' + nonce)}`;
  }
  function sessionValue(req) {
    const v = parseCookies(req)[COOKIE];
    if (!v) return null;
    const m = /^(\d{10,16})\.([0-9a-f]{24})\.([0-9a-f]{64})$/.exec(v);
    if (!m) return null;
    if (Number(m[1]) < Date.now()) return null;
    const want = sign('session:' + m[1] + '.' + m[2]);
    return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[3])) ? v : null;
  }
  const csrfFor = (sess) => sign('csrf:' + sess).slice(0, 32);
  function csrfOk(req, token) {
    const sess = sessionValue(req);
    if (!sess || typeof token !== 'string' || !token) return false;
    return safeEqual(csrfFor(sess), token);
  }
  function cookieHeader(req, value, maxAge) {
    const secure = req.secure ? '; Secure' : '';
    return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Path=/admin${secure}`;
  }

  // --- ログイン失敗の回数制限(IPごと・メモリ上) ---
  const fails = new Map();
  function failsOf(ip) {
    const t = Date.now();
    const arr = (fails.get(ip) || []).filter((x) => t - x < LOGIN_WINDOW_MS);
    if (arr.length) fails.set(ip, arr); else fails.delete(ip);
    return arr;
  }

  // --- 画面の描画 ---
  async function page(req, res, view, data = {}, status = 200) {
    const sess = sessionValue(req);
    const html = await ejs.renderFile(path.join(VIEWS, view + '.ejs'), {
      BASE, fmtTime, fmtSize, authed: !!sess, csrf: sess ? csrfFor(sess) : '', error: null, notice: null, nav: '', ...data,
    });
    res.status(status).type('html').send(html);
  }
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // --- 件数の簡易キャッシュ(60秒) ---
  let statsCache = null;
  async function getStats() {
    const t = Date.now();
    if (statsCache && statsCache.value && t - statsCache.at < (statsCache.value.ok ? STATS_TTL_MS : 15000)) return statsCache.value; // 集計中(value=null)は下で待つ
    if (!statsCache || !statsCache.pending) {
      const pending = Promise.resolve().then(() => queryStats()).then(
        (v) => ({ ok: true, ...v, at: Date.now() }),
        (e) => { console.error('[admin] stats error:', e && e.message); return { ok: false, message: '倉庫の件数を読み込めませんでした。倉庫のデータベース接続(WH_DB_*)を確認してください。' }; },
      );
      statsCache = { at: 0, value: null, pending };
      pending.then((v) => { statsCache = { at: Date.now(), value: v }; });
    }
    return statsCache.pending ? statsCache.pending : statsCache.value;
  }

  function listExports() {
    try {
      return fs.readdirSync(exportDir).filter((n) => EXPORT_NAME.test(n)).map((n) => {
        const st = fs.statSync(path.join(exportDir, n));
        return { name: n, size: st.size, mtime: st.mtimeMs };
      }).filter((x) => x.size >= 0).sort((a, b) => b.mtime - a.mtime).slice(0, 30);
    } catch { return []; }
  }
  /** 診断グループの出力フォルダ(新しい順・10件まで)と、その中の検証済みファイル名 */
  function listGroupDirs() {
    try {
      return fs.readdirSync(exportDir).filter((n) => GROUP_DIR.test(n)).sort().reverse().slice(0, 10).map((n) => {
        const g = readGroupDir(n);
        return g ? { name: n, files: g.names.sort().map((f) => ({ name: f, url: `${BASE}/exports/${n}/${encodeURIComponent(f)}` })) } : null;
      }).filter(Boolean);
    } catch { return []; }
  }
  const exportExists = (name) => {
    if (!name || !EXPORT_NAME.test(name)) return false;
    try { return fs.statSync(path.join(exportDir, name)).isFile(); } catch { return false; }
  };

  /** グループ出力フォルダの中身(検証済みの名前だけ)。フォルダ名が不正・無ければ null */
  function readGroupDir(dirName) {
    if (!dirName || !GROUP_DIR.test(dirName)) return null;
    const dir = path.join(exportDir, dirName);
    try {
      if (path.dirname(dir) !== exportDir || !fs.lstatSync(dir).isDirectory()) return null;
      return { dir, names: fs.readdirSync(dir).filter((n) => (GROUP_FILE.test(n) || SINGLE_FILE.test(n)) && fs.lstatSync(path.join(dir, n)).isFile()) };
    } catch { return null; }
  }
  const readText = (dir, name) => {
    try {
      const full = path.join(dir, name);
      const st = fs.lstatSync(full);
      return st.isFile() && st.size <= GROUP_TEXT_MAX ? fs.readFileSync(full, 'utf8') : '';
    } catch { return ''; }
  };
  /** 画面用: グループごとの { key, count, csv, body, short, subject, bodyText, shortText, subjectText } と まとめ */
  function groupView(dirName) {
    const g = readGroupDir(dirName);
    if (!g) return null;
    const url = (n) => `${BASE}/exports/${dirName}/${encodeURIComponent(n)}`;
    const groups = [];
    for (const n of g.names) {
      const m = n.match(/^group_([a-z_]+)_(\d+)件\.csv$/);
      if (!m) continue;
      const key = m[1];
      const checkName = `group_${key}_${m[2]}件_確認用.csv`;
      const nm = { body: `group_${key}_本文.txt`, short: `group_${key}_本文_短縮.txt`, subject: `group_${key}_件名.txt` };
      const has = (x) => g.names.includes(x);
      groups.push({
        key, count: Number(m[2]), csv: { name: n, url: url(n) },
        check: g.names.includes(checkName) ? { name: checkName, url: url(checkName) } : null,
        body: has(nm.body) ? { name: nm.body, url: url(nm.body), text: readText(g.dir, nm.body) } : null,
        short: has(nm.short) ? { name: nm.short, url: url(nm.short), text: readText(g.dir, nm.short) } : null,
        subject: has(nm.subject) ? { name: nm.subject, url: url(nm.subject), text: readText(g.dir, nm.subject) } : null,
      });
    }
    return {
      dirName, groups,
      summary: g.names.includes('まとめ.txt') ? { name: 'まとめ.txt', url: url('まとめ.txt'), text: readText(g.dir, 'まとめ.txt') } : null,
    };
  }

  /** 単一本文の画面用: 本文・送信CSV(バッチごと)・確認用・まとめ・登録したSTOCバッチコード。result.json が無い/壊れていれば null */
  function singleView(dirName) {
    const g = readGroupDir(dirName);
    if (!g || !g.names.includes('result.json')) return null;
    let r;
    try { r = JSON.parse(readText(g.dir, 'result.json')); } catch { return null; }
    if (!r || !Array.isArray(r.batches)) return null;
    const url = (n) => `${BASE}/exports/${dirName}/${encodeURIComponent(n)}`;
    const batches = r.batches.filter((b) => b && SENDER_CODE.test(String(b.code)) && g.names.includes(`send_${b.code}.csv`))
      .map((b) => ({ code: b.code, count: Number(b.count) || 0, file: `send_${b.code}.csv`, url: url(`send_${b.code}.csv`) }));
    const link = (n) => (g.names.includes(n) ? { name: n, url: url(n) } : null);
    return {
      dirName, dryRun: !!r.dryRun, withPage: !!r.withPage, count: Number(r.count) || 0, batches,
      body: g.names.includes('本文.txt') ? { ...link('本文.txt'), text: readText(g.dir, '本文.txt') } : null,
      check: link('確認用.csv'),
      summary: g.names.includes('まとめ.txt') ? { ...link('まとめ.txt'), text: readText(g.dir, 'まとめ.txt') } : null,
    };
  }

  function startJob(req, res, spec, backTo, backView) {
    const r = jobs.start(spec);
    if (!r.ok) return page(req, res, backView, { nav: backTo, error: r.message, runningId: r.runningId, ...(spec.formData || {}) }, 409);
    return res.redirect(303, `${BASE}/jobs/${r.id}`);
  }

  // ===== 入り口の守り(IP制限 → 余計なヘッダ) =====
  router.use((req, res, next) => {
    if (!allowIps.includes(clientIp(req))) return res.status(404).type('text/plain').send('Not Found');
    res.set({ 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    next();
  });
  router.use(express.urlencoded({ extended: false }));

  // ===== ログイン・ログアウト =====
  router.get('/login', wrap(async (req, res) => {
    if (sessionValue(req)) return res.redirect(BASE);
    await page(req, res, 'login');
  }));
  router.post('/login', wrap(async (req, res) => {
    const ip = clientIp(req);
    if (failsOf(ip).length >= LOGIN_MAX_FAILS) {
      return page(req, res, 'login', { error: '失敗が続いたため、しばらくログインできません。15分ほど待ってからやり直してください。' }, 429);
    }
    const pass = String((req.body && req.body.password) || '');
    if (!safeEqual(pass, password)) {
      const arr = failsOf(ip); arr.push(Date.now()); fails.set(ip, arr);
      return page(req, res, 'login', { error: 'パスワードが違います。' }, 401);
    }
    fails.delete(ip);
    res.setHeader('Set-Cookie', cookieHeader(req, makeSession(), SESSION_MS / 1000));
    res.redirect(303, BASE);
  }));
  router.post('/logout', (req, res) => {
    if (!csrfOk(req, req.body && req.body._csrf)) return res.status(403).type('text/plain').send('確認用の情報が正しくありません。ページを開き直してください。');
    res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
    res.redirect(303, BASE + '/login');
  });

  // ===== ここから先はログイン必須 =====
  router.use((req, res, next) => {
    if (sessionValue(req)) return next();
    if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(BASE + '/login');
    return res.status(401).type('text/plain').send('ログインが必要です。');
  });
  // POSTは確認用の合言葉(CSRF)を必須にする。ファイルのアップロード(multipart)だけは受け取りの途中で自分で確認する
  router.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    if (/^multipart\/form-data/i.test(req.headers['content-type'] || '')) return next();
    if (!csrfOk(req, req.body && req.body._csrf)) return res.status(403).type('text/plain').send('確認用の情報が正しくありません。ページを開き直してやり直してください。');
    next();
  });

  // ===== 状況 =====
  router.get('/', wrap(async (req, res) => {
    const stats = await getStats();
    await page(req, res, 'dashboard', { nav: 'status', stats, jobs: jobs.list().slice(0, 10) });
  }));

  // ===== 取り込み(アップロード) =====
  router.get('/import', wrap((req, res) => page(req, res, 'import', { nav: 'import', maxFiles: MAX_UPLOAD_FILES, maxMb: MAX_UPLOAD_BYTES / 1024 / 1024 })));

  const storage = multer.diskStorage({
    destination(req, file, cb) {
      try {
        if (!req._upDir) {
          fs.mkdirSync(uploadDir, { recursive: true });
          const base = stamp(now());
          let dir = path.join(uploadDir, base);
          for (let i = 2; ; i++) {
            try { fs.mkdirSync(dir); break; } catch (e) { if (e.code !== 'EEXIST') throw e; dir = path.join(uploadDir, `${base}-${i}`); }
          }
          req._upDir = dir;
        }
        cb(null, req._upDir);
      } catch (e) { cb(e); }
    },
    filename(req, file, cb) {
      const clean = sanitizeFileName(file.originalname);
      if (!clean) return cb(new UserError('使えないファイル名です(.csv か .zip のみ。フォルダ区切りや特殊な文字は使えません): ' + String(file.originalname).slice(0, 80)));
      try { cb(null, uniqueName(req._upDir, clean)); } catch (e) { cb(e); }
    },
  });
  const upload = multer({
    storage,
    defParamCharset: 'utf8',
    limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_UPLOAD_FILES, fields: 20, parts: MAX_UPLOAD_FILES + 30 },
    fileFilter(req, file, cb) {
      // 確認用の情報(_csrf)はフォームの先頭にあるので、ファイルを保存する前に確かめられる
      if (!csrfOk(req, req.body && req.body._csrf)) return cb(new UserError('確認用の情報が正しくありません。ページを開き直してやり直してください。', 403));
      cb(null, true);
    },
  }).array('files', MAX_UPLOAD_FILES);

  const rmDir = (dir) => { if (dir && dir.startsWith(uploadDir + path.sep)) fs.rmSync(dir, { recursive: true, force: true }); };

  router.post('/import', (req, res, next) => {
    upload(req, res, (err) => {
      handleUpload(req, res, err).catch(next);
    });
  });
  async function handleUpload(req, res, err) {
    const fail = async (msg, status) => { rmDir(req._upDir); return page(req, res, 'import', { nav: 'import', error: msg, maxFiles: MAX_UPLOAD_FILES, maxMb: MAX_UPLOAD_BYTES / 1024 / 1024 }, status || 400); };
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return fail(`ファイルが大きすぎます(1ファイル ${MAX_UPLOAD_BYTES / 1024 / 1024}MBまで)。大きいときはZIPにまとめるか、分けてください。`);
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return fail(`ファイルが多すぎます(${MAX_UPLOAD_FILES}個まで)。ZIPにまとめてください。`);
      if (err.userSafe) return fail(err.message, err.status);
      console.error('[admin] upload error:', err.message);
      return fail('アップロードに失敗しました。もう一度お試しください。', 400);
    }
    if (!csrfOk(req, req.body && req.body._csrf)) return fail('確認用の情報が正しくありません。ページを開き直してやり直してください。', 403);
    const files = req.files || [];
    if (!files.length) return fail('ファイルを選んでください。');
    const dir = req._upDir;
    try {
      const notes = [];
      for (const f of files) {
        const full = path.join(dir, f.filename);
        if (/\.zip$/i.test(f.filename)) {
          const r = extractZip(full, dir);
          fs.rmSync(full, { force: true });
          notes.push(`${f.filename}: CSV ${r.saved.length}個を展開` + (r.skipped ? `(gmp_*.csv 以外 ${r.skipped}個は除外)` : ''));
        } else if (!GMP_CSV.test(f.filename)) {
          throw new UserError(`CSVのファイル名は gmp_ で始めてください: ${f.filename}`);
        }
      }
      const csvCount = fs.readdirSync(dir).filter((n) => GMP_CSV.test(n)).length;
      if (!csvCount) throw new UserError('取り込める gmp_*.csv が見つかりませんでした。');
      const dry = !!req.body.dry_run;
      const args = ['cli/warehouse-import.js', '--root', dir, '--pattern', IMPORT_PATTERN];
      if (dry) args.push('--dry-run');
      const r = jobs.start({ title: `取り込み${dry ? '(確認のみ)' : ''}: ${path.basename(dir)}(${csvCount}ファイル)`, args, meta: { uploadDir: dir } });
      if (!r.ok) {
        rmDir(dir);
        return page(req, res, 'import', { nav: 'import', error: r.message, runningId: r.runningId, maxFiles: MAX_UPLOAD_FILES, maxMb: MAX_UPLOAD_BYTES / 1024 / 1024 }, 409);
      }
      return res.redirect(303, `${BASE}/jobs/${r.id}`);
    } catch (e) {
      if (e && e.userSafe) return fail(e.message, e.status);
      console.error('[admin] import error:', e && e.message);
      return fail('取り込みの準備に失敗しました。', 500);
    }
  }

  // ===== 取り出し(CSVを作る) =====
  const exportPage = (req, res, extra = {}, status = 200) => page(req, res, 'export', {
    nav: 'export', prefectures: PREFECTURES, defaultMain: DEFAULT_MAIN_CATEGORY, exports: listExports(), groupDirs: listGroupDirs(), form: {}, ...extra,
  }, status);
  router.get('/export', wrap((req, res) => exportPage(req, res)));
  router.post('/export', wrap(async (req, res) => {
    if (req.body.action === 'scan') {
      const sb = buildB2bScanArgs(req.body, { exportDir, now: now() });
      if (sb.error) return exportPage(req, res, { error: sb.error, form: req.body }, 400);
      const sr = jobs.start({ title: sb.withPage ? '診断して文面も作る(御社専用ページ付き)' : '診断して文面も作る', args: sb.args, meta: { exportFile: sb.exportFile, singleDir: sb.singleDir, withPage: sb.withPage } });
      if (!sr.ok) return exportPage(req, res, { error: sr.message, runningId: sr.runningId, form: req.body }, 409);
      return res.redirect(303, `${BASE}/jobs/${sr.id}`);
    }
    const mode = req.body.action === 'make' ? 'make' : 'report';
    const built = buildPromoteArgs(req.body, { mode, exportDir, now: now() });
    if (built.error) return exportPage(req, res, { error: built.error, form: req.body }, 400);
    const title = mode === 'report' ? '件数の確認' : (built.preset === 'b2b' ? '工場・建設用CSVを作る' : 'MEO用CSVを作る');
    const r = jobs.start({ title, args: built.args, meta: { exportFile: built.exportFile } });
    if (!r.ok) return exportPage(req, res, { error: r.message, runningId: r.runningId, form: req.body }, 409);
    res.redirect(303, `${BASE}/jobs/${r.id}`);
  }));

  // ===== 御社専用ページの一覧(閲覧・申込) =====
  router.get('/pages', wrap(async (req, res) => {
    const filter = ['all', 'viewed', 'human', 'lead', 'optout'].includes(req.query.filter) ? req.query.filter : 'all';
    let data = { rows: [], counts: null }, error = null;
    try { data = await listPages({ filter, limit: 200 }); } catch (e) {
      console.error('[admin] pages list error:', e && e.message);
      error = '専用ページの一覧を読み込めませんでした。sql/warehouse_migrate_006.sql を適用したか、倉庫のデータベース接続(WH_DB_*)を確認してください。';
    }
    const baseUrl = require('./pageCore').baseUrl();
    await page(req, res, 'pages', { nav: 'pages', error, filter, rows: data.rows, counts: data.counts, pageBase: baseUrl });
  }));

  // ===== 営業管理とつなぐ =====
  router.get('/link', wrap((req, res) => page(req, res, 'link', { nav: 'link' })));
  router.post('/link', wrap(async (req, res) => {
    const r = jobs.start({ title: '営業管理とつなぐ', args: ['cli/warehouse-import.js', '--link-only', '--carry-forms'] });
    if (!r.ok) return page(req, res, 'link', { nav: 'link', error: r.message, runningId: r.runningId }, 409);
    res.redirect(303, `${BASE}/jobs/${r.id}`);
  }));

  // ===== 作業の様子 =====
  function jobView(j) {
    const v = { ...j };
    v.downloadUrl = j.status === 'success' && j.meta && exportExists(j.meta.exportFile) ? `${BASE}/exports/${j.meta.exportFile}` : null;
    v.exportFile = j.meta ? j.meta.exportFile || null : null;
    v.groupDir = j.status === 'success' && j.meta && j.meta.groupDir && readGroupDir(j.meta.groupDir) ? j.meta.groupDir : null;
    v.singleDir = j.status === 'success' && j.meta && j.meta.singleDir && readGroupDir(j.meta.singleDir) ? j.meta.singleDir : null;
    return v;
  }
  router.get('/jobs/:id', wrap(async (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j) return page(req, res, 'dashboard', { nav: 'status', stats: await getStats(), jobs: jobs.list().slice(0, 10), error: 'その作業の記録が見つかりません(サーバーを再起動すると消えます)。' }, 404);
    const jv = jobView(j);
    await page(req, res, 'job', { nav: '', job: jv, groupView: jv.groupDir ? groupView(jv.groupDir) : null, singleView: jv.singleDir ? singleView(jv.singleDir) : null });
  }));
  router.get('/jobs/:id/json', (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j) return res.status(404).json({ error: 'not found' });
    res.json(jobView(j));
  });

  // ===== 書き出したCSVのダウンロード =====
  router.get('/exports/:file', (req, res) => {
    const name = req.params.file;
    if (!EXPORT_NAME.test(name)) return res.status(404).type('text/plain').send('Not Found');
    const full = path.join(exportDir, name);
    if (path.dirname(full) !== exportDir) return res.status(404).type('text/plain').send('Not Found');
    let st;
    try { st = fs.lstatSync(full); } catch { return res.status(404).type('text/plain').send('Not Found'); }
    if (!st.isFile()) return res.status(404).type('text/plain').send('Not Found');
    res.set({
      // 診断結果(b2b_scan_*)はUTF-8(BOM付き)、取り出しCSVはShift_JIS
      'Content-Type': name.startsWith('b2b_scan_') ? 'text/csv; charset=UTF-8' : 'text/csv; charset=Shift_JIS',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Content-Length': String(st.size),
    });
    fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
  });

  // グループ別の本文・宛先CSV: exports/b2b_<日時>/<決まった名前>
  router.get('/exports/:dir/:file', (req, res) => {
    const { dir: dirName, file: name } = req.params;
    const nf = () => res.status(404).type('text/plain').send('Not Found');
    if (!GROUP_DIR.test(dirName) || !(GROUP_FILE.test(name) || SINGLE_FILE.test(name))) return nf();
    const dir = path.join(exportDir, dirName);
    const full = path.join(dir, name);
    if (path.dirname(dir) !== exportDir || path.dirname(full) !== dir) return nf();
    let st;
    try { if (!fs.lstatSync(dir).isDirectory()) return nf(); st = fs.lstatSync(full); } catch { return nf(); }
    if (!st.isFile()) return nf();
    res.set({
      'Content-Type': name.endsWith('.csv') ? 'text/csv; charset=UTF-8' : name.endsWith('.json') ? 'application/json; charset=UTF-8' : 'text/plain; charset=UTF-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Content-Length': String(st.size),
    });
    fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
  });

  // ===== エラー処理(内部の詳細は画面に出さない) =====
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    console.error('[admin] error:', err && err.message);
    if (res.headersSent) return res.end();
    res.status(500).type('text/plain').send('エラーが発生しました。');
  });

  app.use('/admin', (req, res, next) => { if (!req.path.startsWith('/warehouse')) return res.status(404).type('text/plain').send('Not Found'); next(); });
  app.use(BASE, router);
  return { enabled: true, uploadDir, exportDir, jobs };
}

module.exports = { registerAdminWarehouse, clientIp, buildPromoteArgs, buildB2bScanArgs, sanitizeFileName, extractZip, assertSafeEntryName, EXPORT_NAME, GROUP_DIR, GROUP_FILE, SINGLE_FILE, DEFAULT_MAIN_CATEGORY, IMPORT_PATTERN };
