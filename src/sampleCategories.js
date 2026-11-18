'use strict';
/**
 * 見本ページの業種グループ。人が用意した説明文だけを持つ(AIには書かせない)。
 * 効果をうたう表現は入れない(整骨院は柔道整復師法で広告できる内容が制限されている)。
 * 店の category_main / category にキーワードが含まれるかで、上から順に判定する。
 * 文の {name}(店名)・{area}(市区町村)・{category}(店の業種名 category_main)は表示のときに差し込む。
 */

const GROUPS = [
  {
    id: 'seitai',
    keywords: ['整骨', '接骨', '整体', '鍼灸', '鍼', 'はり', '灸', 'カイロ'],
    photoFolder: 'seitai',
    text: {
      catch: ['つらい身体に、', '安心して相談できる', '場所を。'],
      heroCap: ['施術イメージ', '身体の状態を確認しながら<br>丁寧に対応します'],
      lead: 'お悩みを丁寧に伺い、身体の状態に合わせて施術します。',
      about: '{name}は、{area}にある{category}です。地域の皆さまが安心して通えるよう、分かりやすい説明と丁寧な施術を心がけております。',
      features: [
        ['heart', '丁寧な対応', '一人ひとりの身体の状態に合わせ、ていねいに施術を行います。'],
        ['users', '幅広い世代に', 'お年寄りから働く世代まで、さまざまなお悩みのご相談をお受けします。'],
        ['pin', '地域密着', '{area}の皆さまに親しまれる{category}を目指しています。'],
      ],
      concerns: ['肩や首の張りが気になる方', '腰のつらさが気になる方', '背中の張りが気になる方', '膝や関節が気になる方', '身体の不調を放っておいている方'],
      treatments: [
        ['hand', '手技による施術', '身体の状態に合わせた手技でアプローチします。', '詳細な施術内容は院長様に確認のうえ掲載'],
        ['pulse', '状態に合わせた対応', 'お悩みを伺い、身体の状態に合わせた施術をご提案します。', '具体的なメニューは院長様に確認のうえ掲載'],
        ['heartpulse', '日常の不調のご相談', '日々の生活で気になる身体の不調をご相談ください。', '取扱いの範囲は院長様に確認のうえ掲載'],
      ],
      steps: [
        ['clipboard', '受付・問診', 'ご来院いただいたら、まずは問診票にご記入いただきます。気になる症状などを伺います。'],
        ['file', '身体の状態を確認', '問診票の内容をもとに、現在の身体の状態を確認いたします。'],
        ['hand', '施術', 'お身体の状態に合わせた施術を行います。ご不明点はお気軽にご質問ください。'],
        ['phone', 'アフターフォロー', '施術後の過ごし方や、日常での注意点などをお伝えします。'],
      ],
      cta: 'お身体のお悩み、<br>お気軽にご相談ください',
      ctaSub: '{name}は、地域の皆さまの毎日の生活を身体のケアでサポートします。まずはお電話でお問い合わせください。',
      footLead: '{area}で、地域の皆さまの健康をサポートする{category}です。',
    },
  },
  {
    id: 'massage',
    keywords: ['マッサージ', '指圧'],
    photoFolder: 'massage',
    fallbackPhotoFolder: 'seitai', // massage の写真が未アップロードなら seitai を使う
    textFrom: 'seitai', // 当面は seitai と同じ文
  },
];
for (const g of GROUPS) if (!g.text && g.textFrom) g.text = GROUPS.find((x) => x.id === g.textFrom).text;

// hero / room / reception は基本の3枚。あとの6枚(特徴カードの丸 f_*、施術案内カード t_*)は任意で、無ければ代用・アイコン表示にする
const PHOTO_SLOTS = ['hero', 'room', 'reception', 'f_explain', 'f_counsel', 'f_room', 't_back', 't_stretch', 't_head'];
const groupById = (id) => GROUPS.find((g) => g.id === id) || null;

/** 店の業種から業種グループを決める。当てはまらなければ null(見本を作らない) */
function groupFor(shop) {
  const hay = `${(shop && shop.category_main) || ''} ${(shop && shop.category) || ''}`;
  if (!hay.trim()) return null;
  return GROUPS.find((g) => g.keywords.some((k) => hay.includes(k))) || null;
}

/** 「○○にある整骨院です」に入れる業種名。店の category_main、なければ category の最初の語 */
function categoryLabel(shop) {
  const main = String((shop && shop.category_main) || '').trim();
  if (main) return main;
  return String((shop && shop.category) || '').split(/[,、，\/|]/)[0].trim();
}

const fill = (s, v) => String(s).replace(/\{(name|area|category)\}/g, (_, k) => v[k]);

module.exports = { GROUPS, PHOTO_SLOTS, groupById, groupFor, categoryLabel, fill };
