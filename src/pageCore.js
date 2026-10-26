'use strict';
/**
 * 御社専用ページ(/r/<token>)の純粋な部品。DB・通信なし。
 *  - トークン(URLに入る合言葉): 10文字の英数字(0-9A-Za-z)。乱数から偏りなく作る(62^10 ≒ 2^59.5)
 *  - フォームの署名: HMAC(秘密, 用途 + トークン + 時刻)。1日を過ぎたものは無効
 *  - 閲覧の署名: 画面を開いたときに記録した行のID(STOC側の閲覧行)を、ページに埋めて操作の通知で返してもらうための署名
 *  - アクセス元の種類(bot / human)の判定
 */
const crypto = require('crypto');

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const TOKEN_LEN = 10;
const TOKEN_RE = /^[0-9A-Za-z]{10}$/;
const FORM_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FORM_FUTURE_MS = 5 * 60 * 1000; // 時計のずれの許容
const DEFAULT_BASE_URL = 'https://webdock.stoc-plus.site';

/** 10文字の英数字。256 を 62 で割った余りの偏りが出ないよう、248 以上のバイトは捨てる */
function newToken(randomBytes = crypto.randomBytes) {
  let out = '';
  while (out.length < TOKEN_LEN) {
    for (const b of randomBytes(16)) {
      if (b >= 248) continue;
      out += ALPHABET[b % 62];
      if (out.length === TOKEN_LEN) break;
    }
  }
  return out;
}

const isToken = (s) => typeof s === 'string' && TOKEN_RE.test(s);

/** ページのURL。PUBLIC_BASE_URL(末尾の / は除く)、なければ https://webdock.stoc-plus.site */
function baseUrl(env = process.env) {
  const b = String(env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  return b || DEFAULT_BASE_URL;
}
function pageUrl(token, env = process.env) { return `${baseUrl(env)}/r/${token}`; }

/* ---------- 署名 ---------- */

const hmac = (secret, msg, len) => crypto.createHmac('sha256', String(secret)).update(msg).digest('hex').slice(0, len);
function safeHexEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** フォームの確認用の値 "<時刻ms>.<署名32桁>"。purpose: 'request'(申込) / 'optout'(配信不要) */
function makeFormToken(secret, purpose, token, now = Date.now()) {
  return `${now}.${hmac(secret, `wdform:${purpose}:${token}:${now}`, 32)}`;
}
/** 戻り: { ok:true } か { ok:false, reason:'format'|'sig'|'expired'|'future' } */
function verifyFormToken(secret, purpose, token, value, now = Date.now()) {
  const m = /^(\d{10,16})\.([0-9a-f]{32})$/.exec(String(value || ''));
  if (!m) return { ok: false, reason: 'format' };
  const ts = Number(m[1]);
  if (!safeHexEqual(hmac(secret, `wdform:${purpose}:${token}:${ts}`, 32), m[2])) return { ok: false, reason: 'sig' };
  if (now - ts > FORM_MAX_AGE_MS) return { ok: false, reason: 'expired' };
  if (ts - now > FORM_FUTURE_MS) return { ok: false, reason: 'future' };
  return { ok: true };
}

/** 閲覧行ID(STOCの store_report_views.id。記録できなかったときは 0)の署名つきの値 "<id>.<署名24桁>" */
function makeViewToken(secret, token, viewId) {
  const id = Number(viewId) > 0 ? Math.floor(Number(viewId)) : 0;
  return `${id}.${hmac(secret, `wdview:${token}:${id}`, 24)}`;
}
/** 戻り: 行ID(0は「STOC側の行なし」)、不正なら null */
function verifyViewToken(secret, token, value) {
  const m = /^(\d{1,12})\.([0-9a-f]{24})$/.exec(String(value || ''));
  if (!m) return null;
  return safeHexEqual(hmac(secret, `wdview:${token}:${Number(m[1])}`, 24), m[2]) ? Number(m[1]) : null;
}

/* ---------- アクセス元の種類 ---------- */

// STOC営業管理の ReportViewClass::BOT_UA と同じ考え方(機械・プレビュー・メール内の自動巡回)
const BOT_UA = /bot|crawl|spider|iframely|wordpress|curl|wget|python|headless|preview|slurp|facebookexternalhit|go-http|java\/|okhttp|scanner|monitor|^$/i;
/** 'bot'(数えない) / 'human'。HEADも数えない(メールの自動確認が使う) */
function classifyUa(ua, method = 'GET') {
  if (String(method).toUpperCase() === 'HEAD') return 'bot';
  return BOT_UA.test(String(ua || '').trim()) ? 'bot' : 'human';
}

module.exports = {
  ALPHABET, TOKEN_RE, TOKEN_LEN, FORM_MAX_AGE_MS, FORM_FUTURE_MS, DEFAULT_BASE_URL, BOT_UA,
  newToken, isToken, baseUrl, pageUrl, makeFormToken, verifyFormToken, makeViewToken, verifyViewToken, classifyUa,
};
