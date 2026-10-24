'use strict';

/** 都道府県と、対応会社(TOC/STOC)の振り分け。 */

const PREFECTURES = [
  '北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県',
  '茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県',
  '新潟県','富山県','石川県','福井県','山梨県','長野県',
  '岐阜県','静岡県','愛知県','三重県',
  '滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県',
  '鳥取県','島根県','岡山県','広島県','山口県',
  '徳島県','香川県','愛媛県','高知県',
  '福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県',
];

// TOC(近県・訪問対応)の都道府県。env TOC_PREFECTURES で変更可(カンマ区切り)。
// 振り分け(2026-10-24 社内方針: TOCはUTM、STOCはWEB)
//   兵庫・岡山 → STOCV(STOCが訪問、UTM・PC PATROL中心)
//   大阪       → TOC(UTM)
//   それ以外   → STOC(全国・オンライン、WEB)
// env で変更可: STOC_VISIT_PREFECTURES / TOC_PREFECTURES(カンマ区切り)
function listEnv(name, def) {
  const raw = process.env[name];
  if (raw) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return def;
}
function stocVisitPrefectures() { return listEnv('STOC_VISIT_PREFECTURES', ['兵庫県', '岡山県']); }
function tocPrefectures() { return listEnv('TOC_PREFECTURES', ['大阪府']); }

/**
 * 都道府県から対応区分を決める。
 * 戻り値: { company:'STOCV'|'TOC'|'STOC', prefecture }
 *   company は振り分けの区分コード(通知先・提案文の切り替えに使う)。会社としては STOCV も STOC。
 */
function routeByPrefecture(prefecture) {
  if (stocVisitPrefectures().includes(prefecture)) return { company: 'STOCV', prefecture };
  if (tocPrefectures().includes(prefecture)) return { company: 'TOC', prefecture };
  return { company: 'STOC', prefecture };
}

const COMPANY_INFO = {
  STOCV: {
    name: '株式会社エストック',
    short: 'STOC',
    label: 'STOC(兵庫・岡山・訪問)',
    channel: '訪問',
    offer: '社内ネットワーク・PCの点検(PC PATROL)やUTM(Check Point)の設置を中心とした、現地でのセキュリティ対策',
    tel: process.env.STOC_TEL || '0120-830-046',
  },
  TOC: {
    name: '株式会社ティ・オー・シー',
    short: 'TOC',
    label: 'TOC(大阪・UTM)',
    channel: '訪問',
    offer: 'UTM(Check Point)の設置を中心とした、社内ネットワークのセキュリティ対策',
    tel: process.env.TOC_TEL || '0120-830-046',
  },
  STOC: {
    name: '株式会社エストック',
    short: 'STOC',
    label: 'STOC(全国・オンライン)',
    channel: 'オンライン(Zoom)',
    offer: '診断で見つかった弱点を踏まえた、MEO対策付きのホームページ制作・リニューアル',
    tel: process.env.STOC_TEL || '0120-830-046',
  },
};

module.exports = { PREFECTURES, routeByPrefecture, tocPrefectures, stocVisitPrefectures, COMPANY_INFO };
