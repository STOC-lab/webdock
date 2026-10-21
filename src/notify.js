'use strict';

/**
 * 新規申込(見込み客)の通知。
 * SMTP(env設定時)で営業担当へメール送信。未設定時はログ出力のみ。
 */

const SERVICE_NAME = process.env.SERVICE_NAME || 'WEBドック';

async function notifyLead(lead) {
  // 対応会社ごとに通知先を分ける。未設定時は共通の LEAD_NOTIFY_TO にフォールバック。
  const fallback = process.env.LEAD_NOTIFY_TO || 'kit@stoc.co.jp';
  const to = lead.assignedCompany === 'TOC'
    ? (process.env.TOC_NOTIFY_TO || fallback)
    : (process.env.STOC_NOTIFY_TO || fallback);
  const companyLabel = lead.assignedCompany === 'TOC' ? 'TOC(近県・訪問)' : 'STOC(全国・オンライン)';
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
    lead.assignedCompany === 'TOC'
      ? '→ TOCにて訪問・UTM/PC PATROL等のご提案を。早めの架電をおすすめします。'
      : '→ STOCにてZoom商談・MEO対策付きサイトのご提案を。早めの架電をおすすめします。',
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

module.exports = { notifyLead };
