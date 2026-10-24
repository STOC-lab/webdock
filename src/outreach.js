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

function loadTemplates(dir) {
  const d = dir || path.join(__dirname, '..', 'templates');
  const j = (f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
  const t = (f) => fs.readFileSync(path.join(d, f), 'utf8');
  return {
    findings: j('findings.json'),
    config: j('outreach-config.json'),
    west: t('outreach-west.txt'),
    east: t('outreach-east.txt'),
  };
}

module.exports = { JUDGE, pickFinding, shouldSend, regionOf, fillTemplate, loadTemplates };
