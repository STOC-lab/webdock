'use strict';
/**
 * PHPの版の判定表と、X-Powered-By からの版の読み取り(純粋関数。通信なし)。
 *
 * 【更新するときはこの表だけ直す】
 * 確認日: 2026-10-29
 * PHP2Shell(CVE-2026-109618 / CVE-2026-109619)は 2026-10-21 に公表、悪用が確認されている。
 * CVE-2026-109618 は 2026-10-26 に CISA KEV 入り。
 * 公式の修正版: 8.5.12 / 8.4.27 / 8.3.36 / 8.2.35。
 * 8.1 / 8.0 / 7.4 は公式の修正版なし(サポート終了。限定的なバックポートや提供元パッケージのみ)。7.3以前(5.x含む)も修正なし。
 */
const CHECKED_AT = '2026-10-29';
const CVES = ['CVE-2026-109618', 'CVE-2026-109619'];
const DISCLOSED_JA = '2026年10月21日';

// 公式の修正版(ブランチ → 修正された最初のパッチ番号)
const FIXED_PATCH = { '8.2': 35, '8.3': 36, '8.4': 27, '8.5': 12 };
// この版以下は公式の修正が提供されない(サポート終了)。[major, minor]
const EOL_MAX = [8, 1];

/** X-Powered-By の値から最初の PHP/X.Y.Z を読む。読めなければ null */
function parsePhpVersion(headerValue) {
  const m = String(headerValue === undefined || headerValue === null ? '' : headerValue).match(/PHP\/(\d+)\.(\d+)\.(\d+)/i);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), text: `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` };
}

/**
 * 版の分類。戻り: 'eol'(サポート終了) | 'unpatched'(修正前) | 'ok'(修正済み・将来の版を含む)。fixed は修正された最初の版の文字列
 */
function classifyPhp(v) {
  if (v.major < EOL_MAX[0] || (v.major === EOL_MAX[0] && v.minor <= EOL_MAX[1])) return { kind: 'eol', fixed: '' };
  const fp = v.major === 8 ? FIXED_PATCH[`${v.major}.${v.minor}`] : undefined;
  if (fp === undefined) return { kind: 'ok', fixed: '' }; // 表にない新しい版(8.6以降など)は修正済みとみなす
  const fixed = `${v.major}.${v.minor}.${fp}`;
  return { kind: v.patch < fp ? 'unpatched' : 'ok', fixed };
}

module.exports = { CHECKED_AT, CVES, DISCLOSED_JA, FIXED_PATCH, EOL_MAX, parsePhpVersion, classifyPhp };
