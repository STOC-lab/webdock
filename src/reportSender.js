'use strict';
// 顧客レポートの「作成元」設定(templates/report-senders.json)と、画面入力の検証
const fs = require('fs');
const path = require('path');

const SENDERS_FILE = path.join(__dirname, '..', 'templates', 'report-senders.json');
const PERSON_MAX = 40;
const MAIL_MAX = 100;

/** 作成元の設定を読む。読み込み失敗・形式不正は空扱い(「なし」のみ)で落とさない */
function loadSenders(file) {
  const out = {};
  try {
    const j = JSON.parse(fs.readFileSync(file || SENDERS_FILE, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return out;
    for (const k of Object.keys(j)) {
      const v = j[k];
      if (!v || typeof v !== 'object' || typeof v.company !== 'string' || !v.company.trim()) continue;
      out[k] = {
        label: typeof v.label === 'string' && v.label.trim() ? v.label.trim() : v.company.trim(),
        company: v.company.trim(),
        tel: typeof v.tel === 'string' ? v.tel.trim() : '',
      };
    }
  } catch { /* 空扱い */ }
  return out;
}

/** 担当者名は「山田 太郎」→ 苗字だけ(フッター用) */
function surnameOf(name) { return String(name || '').trim().split(/\s+/)[0]; }

/**
 * 画面入力(from / person / mail)を検証して返す。
 * 戻り値: { from: 有効なキーまたは''、person, mail, sender: 有効なときだけ { company, tel, person, surname, mail } }
 */
function resolveSender(senders, q) {
  q = q || {};
  const key = typeof q.from === 'string' ? q.from : '';
  const valid = key !== '' && Object.prototype.hasOwnProperty.call(senders, key);
  const person = String(q.person == null ? '' : q.person).replace(/[\r\n\t]+/g, ' ').trim().slice(0, PERSON_MAX);
  let mail = String(q.mail == null ? '' : q.mail).trim();
  if (mail.length > MAIL_MAX || !/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(mail)) mail = '';
  const res = { from: valid ? key : '', person, mail, sender: null };
  if (valid) {
    const s = senders[key];
    res.sender = { company: s.company, tel: s.tel, person, surname: surnameOf(person), mail };
  }
  return res;
}

module.exports = { loadSenders, resolveSender, surnameOf, SENDERS_FILE, PERSON_MAX, MAIL_MAX };
