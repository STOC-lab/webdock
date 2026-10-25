'use strict';
/**
 * B2B送信用のグループ分け。送信ツールが「全社同一の本文」しか送れないため、
 * 各社の指摘(1社1つ)ごとにグループ化し、グループごとに固定の本文・件名・宛先CSVを作る。純粋関数中心(ファイル書き出し以外)。
 */
const fs = require('fs');
const path = require('path');
const { fillTemplate, jstDateJa } = require('./outreach');

/** 優先順(pickFindingB2b と同じ)。グループキー: 証明書は cert_expired / cert_soon の2つ */
const GROUP_ORDER = ['no_https', 'mixed', 'https_redirect', 'cert_expired', 'cert_soon', 'js_libs', 'cms', 'headers', 'tls_version'];
/** グループキー → findings-b2b.json のキー */
const FINDING_KEY = { cert_soon: 'cert_expiring' };
const GROUP_LABEL = {
  no_https: 'https非対応', mixed: '混在コンテンツ', https_redirect: 'https未転送', cert_expired: '証明書期限切れ', cert_soon: '証明書期限間近',
  js_libs: '古いJSライブラリ', cms: 'CMS露出', headers: 'セキュリティヘッダー', tls_version: '古いTLS',
};
// 目視確認用CSVの列(人が送信前に見る)
const GROUP_CSV_COLUMNS = ['store_id', '会社名', 'ドメイン', '都道府県', '業種区分', 'URL', '問い合わせURL', '画像認証', '電話番号', '住所'];
// 送信ツール用CSVのヘッダー行。送信ツールは位置で読む(http で始まらない1行目は無視される)。
// 1=送信先URL 2=会社名[company] 3=空欄[name] 4=レポートURL(ドメイン)[param1] 5=業種[param2] 6=評価・口コミ(空欄)[param3] 7=STOCバッチコード 8=電話番号 9=住所
// 3列目の見出しは空欄のまま(STOC営業管理の書き出しと同じ)
const SENDER_CSV_HEADER = '送信先URL,会社名,,レポートURL,業種,評価・口コミ,STOCバッチコード,電話番号,住所';

/** CSVの「指摘種別」(findings-b2b のキー)→ グループキー */
function groupKeyOfFinding(type) {
  if (type === 'cert_expiring') return 'cert_soon';
  return GROUP_ORDER.includes(type) ? type : '';
}

/** 「2026年10月」(日本時間) */
function jstMonthJa(d) {
  return jstDateJa(d).replace(/日$/, '').replace(/(月)\d+$/, '$1');
}

/**
 * 診断結果の行(オブジェクトの配列)をグループに分ける。
 * 行: { store_id, 店名(→会社名), 都道府県, 業種区分, URL, 問い合わせURL, 画像認証, 指摘種別, 送信推奨 }
 * 戻り: { groups: [{key, rows}] (優先順・0件は含めない), excluded: { 理由: 件数 }, excludedTotal }
 */
function groupRows(rows) {
  const by = new Map(GROUP_ORDER.map((k) => [k, []]));
  const excluded = {};
  for (const r of rows) {
    const send = String(r['送信推奨'] || '');
    const key = groupKeyOfFinding(String(r['指摘種別'] || ''));
    if (send === 'はい' && key) {
      // 送信ツールで送れない行はグループに入れない
      if (!String(r['問い合わせURL'] || '').trim()) { excluded['送信先URLなし'] = (excluded['送信先URLなし'] || 0) + 1; continue; }
      if (String(r['画像認証'] || '').trim() === 'あり') { excluded['画像認証あり'] = (excluded['画像認証あり'] || 0) + 1; continue; }
      by.get(key).push(r); continue;
    }
    let reason = send.startsWith('送らない:') ? send.slice('送らない:'.length) : (send === 'いいえ' ? '送信推奨なし' : (send || '不明'));
    if (send === 'はい') reason = '指摘種別が不明';
    excluded[reason] = (excluded[reason] || 0) + 1;
  }
  return {
    groups: GROUP_ORDER.filter((k) => by.get(k).length).map((k) => ({ key: k, rows: by.get(k) })),
    excluded,
    excludedTotal: Object.values(excluded).reduce((a, b) => a + b, 0),
  };
}

/** 差し込みタグの既定(送信ツールの記法に合わせて outreach-config.json の「差し込みタグ」か --merge-tags で変える) */
const DEFAULT_MERGE_TAGS = { 会社名: '[company]', ドメイン: '[param1]' };

/** URL → ドメイン(ホスト名。先頭の www. は除く)。解釈できなければ空 */
function domainOfUrl(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s).hostname.toLowerCase().replace(/^www\./, '');
  } catch { return ''; }
}

/** グループの固定本文(標準・短縮)を作る。本文中の {差込:X} は送信ツール用の差し込みタグ文字列に置き換わる(会社ごとの値は入れない) */
function renderGroupBodies(templates, key, scannedAt, mergeTags) {
  const f = (templates.findingsB2b || {})[FINDING_KEY[key] || key];
  if (!f) throw new Error(`findings-b2b.json に ${FINDING_KEY[key] || key} がありません`);
  const cfg = templates.config || {};
  const tags = { ...DEFAULT_MERGE_TAGS, ...(cfg.差し込みタグ || {}), ...(mergeTags || {}) };
  const vars = { ...cfg };
  // fillTemplate は1回の置換なので、タグ文字列中の { } は再展開されない
  for (const [k, v] of Object.entries(tags)) vars['差込:' + k] = v;
  Object.assign(vars, { 電話番号: cfg.電話, 確認月: jstMonthJa(scannedAt), 指摘: f['指摘'], 困ること: f['困ること'] });
  return {
    body: fillTemplate(templates.b2bGroup, vars),
    shortBody: fillTemplate(templates.b2bGroupShort, vars),
    subjects: (templates.groupSubjects || []).map((s) => fillTemplate(s, vars)),
  };
}

const csvField = (v) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
/** 日本時間の YYYYMMDD */
function jstYmd(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}`;
}
/** STOCバッチコード: WD-<キー(_は-)>-<YYYYMMDD>(例 WD-CERT-EXPIRED-20261025) */
function batchCode(key, scannedAt) {
  return `WD-${String(key).toUpperCase().replace(/_/g, '-')}-${jstYmd(scannedAt)}`;
}
/** 送信ツール用の1行(9列・位置固定) */
function senderRow(r, code) {
  return [r['問い合わせURL'], r['店名'], '', domainOfUrl(r['URL']), r['業種'] || r['業種区分'] || '', '', code, r['電話番号'] || '', r['住所'] || ''];
}
const len = (s) => [...s].length;

/**
 * <dir> にグループ別ファイルとまとめ.txtを書く。戻り値: { files: [名前], summary: [{key,label,count,len,shortLen}], excluded, excludedTotal }
 * 既存の group_*.csv / group_*.txt / まとめ.txt は先に消す(件数違いの古いファイルが残らないように)。
 */
function writeGroupFiles(dir, rows, templates, scannedAt, mergeTags) {
  fs.mkdirSync(dir, { recursive: true });
  for (const n of fs.readdirSync(dir)) if (/^group_[a-z_]+_.+\.(csv|txt)$/.test(n) || n === 'まとめ.txt') fs.unlinkSync(path.join(dir, n));
  const g = groupRows(rows);
  const files = [];
  const summary = [];
  const put = (name, text) => { fs.writeFileSync(path.join(dir, name), text); files.push(name); };
  for (const { key, rows: rs } of g.groups) {
    const b = renderGroupBodies(templates, key, scannedAt, mergeTags);
    const code = batchCode(key, scannedAt);
    // 送信ツール用(9列・位置固定)
    put(`group_${key}_${rs.length}件.csv`, '﻿' + SENDER_CSV_HEADER + '\r\n'
      + rs.map((r) => senderRow(r, code).map(csvField).join(',') + '\r\n').join(''));
    // 送信前の目視確認用
    put(`group_${key}_${rs.length}件_確認用.csv`, '﻿' + GROUP_CSV_COLUMNS.join(',') + '\r\n'
      + rs.map((r) => ({ ...r, 会社名: r['店名'], ドメイン: domainOfUrl(r['URL']) })).map((r) => GROUP_CSV_COLUMNS.map((c) => csvField(r[c])).join(',') + '\r\n').join(''));
    put(`group_${key}_本文.txt`, b.body + '\n');
    put(`group_${key}_本文_短縮.txt`, b.shortBody + '\n');
    put(`group_${key}_件名.txt`, b.subjects.map((s, i) => `${i + 1}. ${s}`).join('\n') + '\n');
    summary.push({ key, label: GROUP_LABEL[key], count: rs.length, len: len(b.body), shortLen: len(b.shortBody) });
  }
  const lines = ['【B2B送信グループ まとめ】', '', 'グループ(優先順) / 件数 / 標準本文の文字数 / 短縮本文の文字数'];
  for (const s of summary) lines.push(`${s.key}(${s.label}) / ${s.count}社 / ${s.len}文字 / ${s.shortLen}文字`);
  if (!summary.length) lines.push('(送信推奨のグループはありません)');
  lines.push('', `送信対象 合計: ${summary.reduce((a, s) => a + s.count, 0)}社`);
  lines.push(`送らない: ${g.excludedTotal}社`);
  for (const [reason, n] of Object.entries(g.excluded).sort((a, b) => b[1] - a[1])) lines.push(`  ・${reason}: ${n}社`);
  lines.push('', '宛先CSVは送信ツール用の9列(送信先URL,会社名,空欄,ドメイン,業種,空欄,バッチコード,電話番号,住所)。「_確認用.csv」は人が見る用です。');
  lines.push('送信先URLなし・画像認証ありの会社はグループに入れていません(送信ツールで送れないため)。');
  lines.push('1グループ=1回の送信。本文はグループごとに違います。最初の100社は送る前に人が確認してください。');
  put('まとめ.txt', lines.join('\n') + '\n');
  return { files, summary, excluded: g.excluded, excludedTotal: g.excludedTotal };
}

module.exports = { SENDER_CSV_HEADER, batchCode, GROUP_ORDER, GROUP_LABEL, GROUP_CSV_COLUMNS, FINDING_KEY, groupKeyOfFinding, jstMonthJa, DEFAULT_MERGE_TAGS, domainOfUrl, groupRows, renderGroupBodies, writeGroupFiles };
