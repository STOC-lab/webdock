'use strict';
const w = require('../src/warehouse');
const { rowToCsv, HEADERS } = require('../cli/warehouse-promote');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}

const URL1 = 'https://www.google.co.jp/maps/place/data=!4m7!3m6!1s0x60008ee1405f85a7:0xe9a994bb6fdb93c5!8m2!3d35.6894807!4d139.6916863!2z!16s';
const URL2 = 'https://www.google.co.jp/maps/place/data=!4m7!3m6!1s0x60008f00e94887b7:0x11cbe625c422d660!8m2!3d35.6894807!4d139.6916863!2z!16s';

// decode
eq(w.decodeBuffer(Buffer.from([0x95, 0xba, 0x8c, 0xc9, 0x8c, 0xa7])), '兵庫県', 'decode SJIS');
eq(w.decodeBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('兵庫県')])), '兵庫県', 'decode UTF-8 BOM');
eq(w.decodeBuffer(Buffer.from('abc東京')), 'abc東京', 'decode UTF-8');

// delimiter / parse
eq(w.detectDelimiter('屋号\t業種\t住所'), '\t', 'tab');
eq(w.detectDelimiter('屋号,業種,住所'), ',', 'comma');
eq(w.parseDelimited('a,"b,1","c""d"\r\n"x\ny",z\n\n', ','), [['a', 'b,1', 'c"d'], ['x\ny', 'z']], 'parse quoted');
eq(w.parseDelimited('a\tb\t\tc', '\t'), [['a', 'b', '', 'c']], 'parse tab empty');

// header
const H11 = ['屋号', '業種', '郵便番号', '住所', '電話番号', '評価', '口コミ数', 'Googleマイビジネス登録有無', '登録URL', 'GMAP', '写真枚数'];
const m11 = w.mapHeader(H11);
eq([m11.name, m11.gmap_url, m11.photo_count, m11.cid], [0, 9, 10, undefined], 'map 11');
const m10 = w.mapHeader(H11.slice(0, 10));
eq([m10.gmap_url, m10.photo_count], [9, undefined], 'map 10');
const m16 = w.mapHeader(H11.concat([' Place ID ', 'CID', 'x', 'y', 'z']));
eq([m16.place_id, m16.cid], [11, 12], 'map 16');
eq(w.mapHeader(['屋号', 'place_id', 'Cid']).place_id, 1, 'alias place_id');

// cid
eq(w.extractCid(URL1), '0xe9a994bb6fdb93c5', 'cid1');
eq(w.extractCid(URL2), '0x11cbe625c422d660', 'cid2');
eq(w.extractCid(''), null, 'cid empty');
eq(w.extractCid('https://example.com'), null, 'cid none');
eq(w.normalizeCid('0xE9A994BB6FDB93C5'), '0xe9a994bb6fdb93c5', 'normalize hex');
eq(w.normalizeCid('17996222385353036741'), '0x' + BigInt('17996222385353036741').toString(16), 'normalize dec');
eq(w.normalizeCid('255'), '0xff', 'dec small');
eq(w.normalizeCid(''), null, 'normalize empty');
eq(w.normalizeCid('zzz'), null, 'normalize bad');

// address / prefecture / phone
eq(w.normalizeAddress('兵庫県神戸市中央区中山手通１丁目２７?１０ 4階'), '兵庫県神戸市中央区中山手通１丁目２７－１０ 4階', 'addr ？');
eq(w.normalizeAddress('どこ? 1?2'), 'どこ? 1－2', 'addr only between digits');
eq(w.prefectureOf('北海道札幌市', null), '北海道', 'pref hokkaido');
eq(w.prefectureOf('東京都港区', 'x'), '東京都', 'pref tokyo');
eq(w.prefectureOf('港区', '大阪府'), '大阪府', 'pref folder');
eq(w.prefectureOf('港区', 'misc'), null, 'pref none');
eq(w.PREFECTURES.length, 47, '47 prefs');
eq(w.normalizePhone('078-242-0124'), '0782420124', 'phone');

// toRecord
const row1 = ['slow style live bar 音の泉', 'カレー店', '650-0004', '兵庫県神戸市中央区中山手通１丁目２７?１０ 4階', '078-242-0124', '4.8', '15', '有り', '', URL1, '77'];
const row2 = ['trimmngsalon MERRY', 'トリミングサロン', '651-0097', '兵庫県神戸市中央区布引町２丁目４?１１ エムコート布引', '078-200-4556', '', '', '有り', '', URL2, '1'];
const r1 = w.toRecord(row1, m11, 'hyogo/a.tsv', 'hyogo');
eq([r1.cid, r1.name, r1.rating, r1.review_count, r1.photo_count, r1.website_url, r1.prefecture, r1.gbp_registered], ['0xe9a994bb6fdb93c5', 'slow style live bar 音の泉', 4.8, 15, 77, null, '兵庫県', '有り'], 'record1');
eq([r1.address_raw, r1.address], ['兵庫県神戸市中央区中山手通１丁目２７?１０ 4階', '兵庫県神戸市中央区中山手通１丁目２７－１０ 4階'], 'record1 addr');
const r2 = w.toRecord(row2, m11, 'hyogo/a.tsv', 'hyogo');
eq([r2.cid, r2.rating, r2.review_count, r2.photo_count, r2.phone], ['0x11cbe625c422d660', null, null, 1, '078-200-4556'], 'record2');
const r10 = w.toRecord(row1.slice(0, 10), m10, 's', 'f');
eq([r10.photo_count, r10.cid], [null, '0xe9a994bb6fdb93c5'], 'record 10col');
const r16 = w.toRecord(row1.concat(['ChIJabc', '17996222385353036741']), m16, 's', 'f');
eq([r16.place_id, r16.cid], ['ChIJabc', '0x' + BigInt('17996222385353036741').toString(16)], 'record 16col cid column wins');
const rn = w.toRecord(['  x  ', '', '', '', '', 'abc', '1,234'].concat(['', '', '']), m11, 's', 'f');
eq([rn.name, rn.category, rn.rating, rn.review_count, rn.cid], ['x', null, null, 1234, null], 'record trims/nulls');

// lat/lng
const mll = w.mapHeader(['屋号', ' 緯度 ', 'LNG']);
eq([mll.lat, mll.lng], [1, 2], 'latlng aliases jp/en');
eq([w.mapHeader(['Latitude', 'Longitude']).lat, w.mapHeader(['Latitude', 'Longitude']).lng], [0, 1], 'latlng alias long');
eq([w.mapHeader(['lat', 'lon']).lng, w.mapHeader(['lat', 'long']).lng], [1, 1], 'lng alias lon/long');
const llRec = (a, b) => { const r = w.toRecord(['x', a, b], mll, 's', 'f'); return [r.lat, r.lng]; };
eq(llRec('34.6913', '135.183'), [34.6913, 135.183], 'latlng valid');
eq(llRec('', ''), [null, null], 'latlng empty');
eq(llRec('abc', '135'), [null, null], 'latlng unparsable');
eq(llRec('50', '135'), [null, null], 'latlng lat out of bounds');
eq(llRec('34', '100'), [null, null], 'latlng lng out of bounds');
eq(llRec('35.6894807', '139.6916863'), [null, null], 'latlng bogus point');
eq(llRec('35.689481', '139.691686'), [null, null], 'latlng bogus rounded');
eq(llRec('35.6894807', '139.7'), [35.6894807, 139.7], 'latlng near-bogus kept');
eq([r1.lat, r1.lng], [null, null], 'no lat/lng from GMAP url');

// fallbackKey
const fk = w.fallbackKey({ phone: '078-242-0124', name: 'A' });
eq(fk, w.fallbackKey({ phone: '0782420124', name: 'A' }), 'fallback phone-format independent');
eq(/^[0-9a-f]{40}$/.test(fk), true, 'fallback sha1');
eq(fk === w.fallbackKey({ phone: '0782420124', name: 'B' }), false, 'fallback name matters');

// Shift_JIS encoder
const s = '屋号,住所 兵庫県ｱ①～\r\n';
eq(new TextDecoder('shift_jis').decode(w.encodeShiftJis(s)), s, 'sjis round trip');
eq(w.encodeShiftJis('兵庫県').toString('hex'), '95ba8cc98ca7', 'sjis bytes');
eq(new TextDecoder('shift_jis').decode(w.encodeShiftJis('A😀B')), 'A?B', 'emoji -> ?');

// promote csv line
eq(HEADERS.length, 11, '11 headers');
eq(rowToCsv({ name: 'a,b', category: 'c', postal: null, address_raw: 'x"y', phone: null, rating: '4.8', review_count: 15, gbp_registered: '有り', website_url: null, gmap_url: URL1, photo_count: null }),
  `"a,b",c,,"x""y",,4.8,15,有り,,${URL1},\r\n`, 'promote row');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
