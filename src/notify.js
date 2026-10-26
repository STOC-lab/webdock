'use strict';

/**
 * 新規申込(見込み客)の通知。
 * SMTP(env設定時)で営業担当へメール送信。未設定時はログ出力のみ。
 */

const SERVICE_NAME = process.env.SERVICE_NAME || 'WEBドック';

async function notifyLead(lead) {
  // 対応会社ごとに通知先を分ける。未設定時は共通の LEAD_NOTIFY_TO にフォールバック。
  const fallback = process.env.LEAD_NOTIFY_TO || 'kit@stoc.co.jp';
  // TOC宛ては TOC_NOTIFY_TO、STOC(訪問・全国)宛ては STOC_NOTIFY_TO
  const to = lead.assignedCompany === 'TOC'
    ? (process.env.TOC_NOTIFY_TO || fallback)
    : (process.env.STOC_NOTIFY_TO || fallback);
  const { COMPANY_INFO } = require('./regions');
  const companyLabel = (COMPANY_INFO[lead.assignedCompany] || {}).label || '-';
  const subject = `【${SERVICE_NAME}／${lead.assignedCompany || '-'}】新規診断申込: ${lead.company}(${lead.prefecture || '-'})`;
  const lines = [
    `${SERVICE_NAME}に新しい診断申込がありました。`,
    '',
    `対応区分 : ${companyLabel}`,
    `所在地   : ${lead.prefecture || '-'}`,
    `会社名   : ${lead.company}`,
    `担当者   : ${lead.contact_name}`,
    `メール   : ${lead.email}`,
    `電話     : ${lead.phone}`,
    `対象ドメイン: ${lead.domain || '-'}`,
    `総合評価 : ${lead.grade || '-'}(${lead.score != null ? lead.score + '点' : '-'})`,
    `診断ID   : ${lead.scanId}`,
    '',
    ({
      STOCV: '→ STOCにて訪問・UTM/PC PATROL中心のご提案を。早めの架電をおすすめします。',
      TOC: '→ TOCにて訪問・UTMのご提案を。早めの架電をおすすめします。',
      STOC: '→ STOCにてZoom商談・MEO対策付きサイトのご提案を。早めの架電をおすすめします。',
    })[lead.assignedCompany] || '早めの架電をおすすめします。',
  ];
  const text = lines.join('\n');

  if (!process.env.SMTP_HOST) {
    console.log('[notifyLead:dev]\n' + text);
    return;
  }
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || 'alert@stoc-plus.site',
    to,
    subject,
    text,
  });
}

/**
 * 御社専用ページ(/r/<token>)からの「詳しい簡易レポートを希望する」の通知。
 * SMTP未設定時はログ出力のみ。info: { company, domain, name, email, phone, message, pageUrl, stocStoreId, batchCode, stocOk, stocError }
 */
async function notifyPageLead(info) {
  const to = process.env.STOC_NOTIFY_TO || process.env.LEAD_NOTIFY_TO || 'kit@stoc.co.jp';
  const subject = `【${SERVICE_NAME}】専用ページから簡易レポート希望: ${info.company}(${info.domain})`;
  const text = [
    `${SERVICE_NAME}の御社専用ページから、詳しい簡易レポートの希望がありました。`,
    '',
    `会社名   : ${info.company}`,
    `対象サイト: ${info.domain}`,
    `担当者   : ${info.name}`,
    `メール   : ${info.email}`,
    `電話     : ${info.phone || '(未入力)'}`,
    `ひとこと : ${info.message || '(なし)'}`,
    `専用ページ: ${info.pageUrl}`,
    `STOCバッチ: ${info.batchCode || '-'} / 店舗ID: ${info.stocStoreId || '-'}`,
    `STOC見込み客: ${info.stocOk ? '登録しました(/report-leads の「相談・受取希望」)' : '登録できませんでした。この通知の内容を手で登録してください' + (info.stocError ? '(' + String(info.stocError).split('\n')[0] + ')' : '')}`,
    '',
    '→ メールで簡易レポートをお送りください。',
  ].join('\n');
  if (!process.env.SMTP_HOST) {
    console.log('[notifyPageLead:dev]\n' + text);
    return;
  }
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  await transporter.sendMail({ from: process.env.SMTP_FROM || 'alert@stoc-plus.site', to, subject, text });
}

module.exports = { notifyLead, notifyPageLead };
