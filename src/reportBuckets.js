'use strict';
// お客様用「簡易レポート」の区分け・依頼文づくり(純粋関数。DB・通信なし)

const BUCKETS = {
  urgent:  { label: 'すぐにご確認いただきたい項目', lead: '訪問者への警告表示など、早めの確認をおすすめする項目です。', guide: '早めに状況をご確認いただくことをおすすめします。' },
  partial: { label: '部分的な修正で対応できる項目', lead: '設定の追加・変更など、サイト全体を作り直さなくても対応できる項目です。', guide: '設定の追加・変更で対応できる範囲です。制作会社様へご相談ください。' },
  renewal: { label: '今後のリニューアル時にまとめて対応すると効率的な項目', lead: 'プログラムやプラグインの更新を伴うため、次回の改修・リニューアルに合わせると効率的な項目です。', guide: '次回の改修・リニューアルに合わせて、まとめて対応すると効率的です。' },
  dns:     { label: 'メール・ドメイン設定(ホームページとは別の担当)', lead: 'ホームページ(Web)の改修では直りません。ドメイン・メールの管理ご担当者様向けの項目です。', guide: 'ドメイン・メールの管理会社(ご担当者様)へご相談ください。ホームページの改修では直りません。' },
};
const BUCKET_ORDER = ['urgent', 'partial', 'renewal', 'dns'];

// 区分の対応表(ここだけ直せば区分が変わる)。 key -> { bad: 区分, warn: 区分 }
const BUCKET_TABLE = {
  cert:           { bad: 'urgent',  warn: 'partial' },
  https_redirect: { bad: 'urgent',  warn: 'partial' },
  mixed:          { bad: 'urgent',  warn: 'renewal' },
  tls_version:    { bad: 'partial', warn: 'partial' },
  headers:        { bad: 'partial', warn: 'partial' },
  cookies:        { bad: 'partial', warn: 'partial' },
  cms:            { bad: 'partial', warn: 'partial' },
  ext_scripts:    { bad: 'partial', warn: 'partial' },
  js_libs:        { bad: 'renewal', warn: 'renewal' },
  mail:           { bad: 'dns',     warn: 'dns' },
};

/** 1項目の区分を返す。ok・unknown(・未知の状態)は null */
function bucketOf(item) {
  if (!item || (item.status !== 'bad' && item.status !== 'warn')) return null;
  const row = BUCKET_TABLE[item.key];
  if (row) return row[item.status];
  return item.remedy === 'dns' ? 'dns' : 'partial'; // 未登録のkeyは remedy で判断
}

/** 状態の表示語(強い言葉は避ける) */
function statusLabel(status) {
  return status === 'bad' ? '要対応' : status === 'warn' ? '要確認' : status === 'ok' ? '問題なし' : '判定不可';
}

/** 結果配列 → { urgent, partial, renewal, dns, okItems }。各区分内は bad→warn の順 */
function groupItems(results) {
  const out = { urgent: [], partial: [], renewal: [], dns: [], okItems: [] };
  (results || []).forEach((r) => {
    const b = bucketOf(r);
    if (b) out[b].push(r);
    else if (r && r.status === 'ok') out.okItems.push(r);
  });
  BUCKET_ORDER.forEach((b) => out[b].sort((x, y) => (x.status === y.status ? 0 : x.status === 'bad' ? -1 : 1)));
  return out;
}

/** checks.js の fix(自社向けの対処法)→ 制作会社宛ての丁寧な依頼文 */
function fixToRequest(fix) {
  let s = String(fix || '').trim();
  if (!s) return '';
  // 「制作会社に「○○」と依頼してください。」「…と伝え、△△を依頼してください。」
  const m = s.match(/^(?:制作会社|ドメイン管理会社)に「(.+?)」と(?:伝え、(.+?)を)?(?:依頼|お願い)してください。?$/);
  if (m) {
    const q = m[1];
    if (m[2]) return `${q}ことを確認しています。${m[2]}をお願いいたします。`;
    if (/してほしい$/.test(q)) return q.replace(/してほしい$/, 'していただけますでしょうか。');
    return `${q}。ご確認をお願いいたします。`;
  }
  s = s.replace(/^(制作会社|ドメイン管理会社)に(?!「)/, '').replace(/(制作会社|ドメイン管理会社)に(?=確認)/, '');
  s = s.replace(/依頼してください。?$/, 'お願いいたします。').replace(/してください。?$/, 'していただけますでしょうか。');
  if (!/[。]$/.test(s)) s += '。';
  return s;
}

/** 依頼文ブロックの本文(プレーンテキスト)。items が空なら '' */
function buildRequestText(items, kind, customer) {
  if (!items || !items.length) return '';
  const isDns = kind === 'dns';
  const lines = [];
  lines.push(isDns ? 'メール・ドメイン管理ご担当者様' : '制作会社様 / 保守ご担当者様');
  lines.push('');
  lines.push(isDns
    ? 'お世話になっております。弊社ドメイン・メールの設定について、簡易点検で以下の確認事項がございました。ご確認をお願いいたします。'
    : 'お世話になっております。弊社ホームページについて、簡易点検で以下の確認事項がございました。ご確認・ご対応のほど、お願いいたします。');
  lines.push('');
  items.forEach((it, i) => {
    lines.push(`${i + 1}. ${it.title}`);
    if (it.evidence) lines.push(`   確認した箇所: ${it.evidence}`);
    lines.push(`   ご依頼: ${fixToRequest(it.fix) || 'ご確認をお願いいたします。'}`);
  });
  lines.push('');
  lines.push('ご対応の可否と、概算の費用・期間をお知らせいただけますと幸いです。');
  if (customer) { lines.push(''); lines.push(String(customer)); }
  return lines.join('\n');
}

module.exports = { BUCKETS, BUCKET_ORDER, BUCKET_TABLE, bucketOf, statusLabel, groupItems, fixToRequest, buildRequestText };
