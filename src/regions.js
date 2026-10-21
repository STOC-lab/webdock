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
function tocPrefectures() {
  const raw = process.env.TOC_PREFECTURES;
  if (raw) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return ['兵庫県', '岡山県', '大阪府'];
}

/**
 * 都道府県から対応会社を決める。
 * 戻り値: { company:'TOC'|'STOC', prefecture }
 */
function routeByPrefecture(prefecture) {
  const toc = tocPrefectures();
  const company = toc.includes(prefecture) ? 'TOC' : 'STOC';
  return { company, prefecture };
}

const COMPANY_INFO = {
  TOC: {
    name: '株式会社ティ・オー・シー',
    short: 'TOC',
    channel: '訪問',
    offer: '社内ネットワーク・PCの点検(PC PATROL)やUTM(Check Point)の設置を含めた、現地でのセキュリティ対策',
    tel: process.env.TOC_TEL || '0120-830-046',
  },
  STOC: {
    name: '株式会社エストック',
    short: 'STOC',
    channel: 'オンライン(Zoom)',
    offer: '診断で見つかった弱点を踏まえた、MEO対策付きのホームページ制作・リニューアル',
    tel: process.env.STOC_TEL || '0120-830-046',
  },
};

module.exports = { PREFECTURES, routeByPrefecture, tocPrefectures, COMPANY_INFO };
