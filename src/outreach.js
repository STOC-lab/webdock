'use strict';
/** 問い合わせ営業用: 診断結果から「指摘1点」を選び、文面を組み立てる補助関数 */
const fs = require('fs');
const path = require('path');

const JUDGE = { ok: 'A', warn: 'C', bad: 'D', unknown: '—' };

function pickFinding(results) {
  const st = {};
  for (const r of results || []) st[r.key] = r.status;
  if (st.https_redirect === 'bad' || st.cert === 'bad') return 'https';
  if (st.mail === 'bad' || st.mail === 'warn') return 'dmarc';
  if (st.cms === 'warn' || st.js_libs === 'warn') return 'old_parts';
  if (st.headers === 'bad') return 'headers';
  if (st.mixed === 'bad') return 'mixed';
  return null;
}

// 「保護されていない通信」と「なりすましメール」は経営者に伝わりやすく本人が確かめられるので、総合判定(A以外)に関係なく送る。
// それ以外の指摘は総合C以下のときだけ送る。
const STRONG_FINDINGS = new Set(['https', 'dmarc']);
function shouldSend(grade, findingType) {
  if (!findingType || grade === 'A' || grade === '—' || !grade) return false;
  if (STRONG_FINDINGS.has(findingType)) return true;
  return ['C', 'D', 'E'].includes(grade);
}

const WEST = new Set(['滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県']
  .map((p) => p.replace(/[県府]$/, '')));

function regionOf(prefecture) {
  const s = String(prefecture || '').trim().replace(/[県府]$/, '');
  return WEST.has(s) ? 'west' : 'east';
}

function fillTemplate(text, vars) {
  const v = vars || {};
  const val = (k) => (v[k] === undefined || v[k] === null ? '' : String(v[k]));
  const lines = String(text).split(/\r?\n/).filter((line) => {
    const m = line.trim().match(/^\{([^{}]+)\}$/);
    return !(m && val(m[1]) === '');
  });
  return lines.join('\n')
    .replace(/\{([^{}]+)\}/g, (_, k) => val(k))
    .replace(/\n{3,}/g, '\n\n');
}

/* ---------- B2B(建設・製造)向け ---------- */

const INDUSTRY_RES = [
  ['整備', /整備|車検/],
  ['製造', /製造|加工|製作所|鉄工|金属|機械|工場|部品|プラスチック|樹脂|印刷|メーカー|食品|水産加工/],
  ['建設', /建設|建築|工務店|工事|住宅|リフォーム|塗装|板金施工|内装|解体|土木|設備|電気|空調|給水|造園|エクステリア|左官|足場/],
];
const VIEWER = { 建設: '協力会社様・発注者様・求職者様', 製造: '取引先様・調達ご担当者様・求職者様', 整備: 'お客様・取引先様・求職者様', その他: '取引先様・求職者様' };

/** 業種(複数あれば先頭=主業種)から 建設/製造/整備/その他 に分類する。整備 → 製造 → 建設 の順に判定 */
function classifyIndustry(category) {
  const main = String(category || '').split(/[、,，]/)[0].trim();
  for (const [name, re] of INDUSTRY_RES) if (re.test(main)) return name;
  return 'その他';
}
const viewerOf = (industry) => VIEWER[industry] || VIEWER.その他;

/** 診断日を「2026年10月25日」(日本時間)の形にする */
function jstDateJa(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(d || new Date()).map((x) => [x.type, x.value]));
  return `${p.year}年${Number(p.month)}月${Number(p.day)}日`;
}

/** 証明書の残り日数(checks.js の evidence「(残りN日)」から読む)。読めなければ null */
function certDaysLeft(r) {
  const m = String((r && r.evidence) || '').match(/残り(-?\d+)日/);
  return m ? Number(m[1]) : null;
}

/**
 * B2B初回メッセージ用の指摘を1つ選ぶ(上から順、最初に当てはまったもの)。返すのは findings-b2b.json のキー。
 * cookies / ext_scripts / mail は初回には使わない(レポートとCSVの項目列だけに残す)。
 */
function pickFindingB2b(results) {
  const by = {};
  for (const r of results || []) by[r.key] = r;
  const st = (k) => (by[k] ? by[k].status : null);
  const badWarn = (k) => st(k) === 'bad' || st(k) === 'warn';
  // mixed は本文の href="http://" も数えるため、warn(3件以下)は外部リンクの可能性が高い。bad のみ採用
  if (st('mixed') === 'bad') return 'mixed';
  if (badWarn('https_redirect')) return 'https_redirect';
  if (badWarn('cert')) {
    const left = certDaysLeft(by.cert);
    if (left !== null && left < 0) return 'cert_expired';
    if (left !== null && left <= 30 && st('cert') === 'warn') return 'cert_expiring';
  }
  if (badWarn('js_libs')) return 'js_libs';
  if (badWarn('cms')) return 'cms';
  if (badWarn('headers')) return 'headers';
  if (badWarn('tls_version')) return 'tls_version';
  return null;
}

/**
 * B2B用の文面一式を作る(純粋関数)。
 * opts: { name, category, domain, results, scannedAt(Date), seq(件名の巡回用の番号), subjectNo(1-3で固定), maxChars(0=無効) }
 * 戻り値: { industry, findingType, send, reason, subject, body, shortBody, length, use }
 */
function buildB2bMessage(templates, opts) {
  const o = opts || {};
  const industry = classifyIndustry(o.category);
  const type = pickFindingB2b(o.results);
  const out = { industry, findingType: type || '', send: false, reason: '', subject: '', body: '', shortBody: '', length: '', use: '', 指摘: '', 困ること: '' };
  const f = type ? (templates.findingsB2b || {})[type] : null;
  if (!f) { out.reason = '初回に使える指摘なし'; return out; }
  out.指摘 = f['指摘']; out.困ること = f['困ること'];
  const vars = {
    ...(templates.config || {}), 電話番号: (templates.config || {}).電話, 会社名: o.name, ドメイン: o.domain,
    確認日: jstDateJa(o.scannedAt), 閲覧者: viewerOf(industry), 指摘: f['指摘'], 困ること: f['困ること'],
  };
  const subjects = templates.subjects || [];
  if (subjects.length) {
    const n = Number(o.subjectNo);
    const idx = n >= 1 && n <= subjects.length ? n - 1 : Math.abs(Math.floor(Number(o.seq) || 0)) % subjects.length;
    out.subject = fillTemplate(subjects[idx], vars);
  }
  out.body = fillTemplate(templates.b2b, vars);
  out.shortBody = fillTemplate(templates.b2bShort, vars);
  out.length = [...out.body].length;
  out.use = '標準';
  out.send = true;
  const max = Number(o.maxChars) || 0;
  if (max > 0 && out.length > max) {
    out.use = '短縮';
    if ([...out.shortBody].length > max) { out.send = false; out.reason = '文字数超過'; }
  }
  return out;
}

function loadTemplates(dir) {
  const d = dir || path.join(__dirname, '..', 'templates');
  const j = (f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
  const t = (f) => fs.readFileSync(path.join(d, f), 'utf8');
  const opt = (fn) => { try { return fn(); } catch { return undefined; } }; // B2B用ファイルがなくても west/east は動く
  return {
    findings: j('findings.json'),
    config: j('outreach-config.json'),
    west: t('outreach-west.txt'),
    east: t('outreach-east.txt'),
    findingsB2b: opt(() => j('findings-b2b.json')),
    b2b: opt(() => t('outreach-b2b.txt')),
    b2bShort: opt(() => t('outreach-b2b-short.txt')),
    subjects: opt(() => t('outreach-b2b-subjects.txt').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)),
  };
}

module.exports = { JUDGE, pickFinding, shouldSend, regionOf, fillTemplate, loadTemplates, classifyIndustry, pickFindingB2b, buildB2bMessage, jstDateJa, viewerOf };
