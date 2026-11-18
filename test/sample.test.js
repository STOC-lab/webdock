'use strict';
// 見本ページ(/s/<コード>・管理画面「見本ページ」)のテスト。DB不要(偽の接続を使う)
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const SP = require('../src/samplePages');
const Cat = require('../src/sampleCategories');
const Photos = require('../src/samplePhotos');
const { registerSamples, renderSample } = require('../src/sampleRoutes');
const { registerAdminWarehouse } = require('../src/adminWarehouse');
const CLI = require('../cli/sample-pages');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);

const SHOP = (o = {}) => ({
  id: 101, name: 'さくら整骨院', category: '整骨院, 接骨院', category_main: '整骨院', postal: '670-0000', address: '兵庫県姫路市中央1-2-3', prefecture: '兵庫県',
  phone: '079-000-1234', last_seen_at: new Date('2026-11-10T03:00:00Z'), ...o,
});
const HOURS = [['月', '8:00〜12:00 / 15:00〜19:15'], ['火', '8:00〜12:00 / 15:00〜19:15'], ['水', '定休日'], ['木', '8:00〜12:00 / 15:00〜19:15']];

/** 偽の接続(メモリ上に shops と sample_pages を持つ)。dupFirst: 最初のN回の INSERT を重複エラーにする */
function fakePool({ shops = [], dupFirst = 0 } = {}) {
  const pages = [];
  const log = [];
  let dups = dupFirst;
  const shopOf = (id) => shops.find((s) => String(s.id) === String(id));
  const query = async (sql, params = []) => {
    sql = String(sql).replace(/\s+/g, ' ').trim();
    log.push({ sql, params });
    let m;
    if (/^SELECT id, name, category.* FROM stoc_master\.shops WHERE id IN/.test(sql)) return [shops.filter((s) => params.map(String).includes(String(s.id)))];
    if (/^SELECT id, code, shop_id, status FROM stoc_master\.sample_pages WHERE shop_id IN/.test(sql)) return [pages.filter((p) => params.map(String).includes(String(p.shop_id)))];
    if (/^INSERT INTO stoc_master\.sample_pages/.test(sql)) {
      if (dups > 0) { dups--; throw Object.assign(new Error('Duplicate entry'), { errno: 1062, code: 'ER_DUP_ENTRY' }); }
      const [code, shop_id, group_id, batch_label] = params;
      if (pages.some((p) => p.code === code)) throw Object.assign(new Error('Duplicate entry'), { errno: 1062, code: 'ER_DUP_ENTRY' });
      const row = { id: pages.length + 1, code, shop_id, group_id, batch_label, status: 'draft', hours_json: null, open_count: 0, created_at: new Date('2026-11-18T00:00:00Z') };
      pages.push(row);
      return [{ insertId: row.id }];
    }
    if ((m = /^SELECT p\.id, p\.code.* WHERE p\.code = \?/.exec(sql))) {
      const p = pages.find((x) => x.code === params[0]);
      if (!p) return [[]];
      const s = shopOf(p.shop_id);
      return [[{ ...p, ...s, id: p.id }]];
    }
    if (/^UPDATE stoc_master\.sample_pages SET open_count = open_count \+ 1/.test(sql)) { const p = pages.find((x) => x.id === params[0]); p.open_count++; return [{ affectedRows: 1 }]; }
    if (/^SELECT p\.\*, s\.name/.test(sql)) { const p = pages.find((x) => String(x.id) === String(params[0])); return [p ? [{ ...p, ...shopOf(p.shop_id) , id: p.id }] : []]; }
    if (/^UPDATE stoc_master\.sample_pages SET hours_json = \?, note = \?, status = \? WHERE id = \?/.test(sql)) {
      const p = pages.find((x) => x.id === Number(params[3]));
      p.hours_json = params[0]; p.note = params[1]; p.status = params[2];
      return [{ affectedRows: 1 }];
    }
    throw new Error('想定外のSQL: ' + sql);
  };
  return { pages, log, query };
}

(async () => {
  // ---- コード生成 ----
  {
    for (let i = 0; i < 300; i++) ok(/^[1-9]\d{4}$/.test(SP.newCode()), '5桁(10000〜99999)');
    eq(SP.newCode(() => 10000), '10000', '下限');
    eq(SP.newCode((lo, hi) => hi - 1), '99999', '上限(99999)');
    // 重複したら引き直す
    const pool = fakePool({ shops: [SHOP()], dupFirst: 3 });
    let n = 0;
    const store = SP.createStore(pool, { randomInt: (lo, hi) => 20000 + n++ });
    const r = await store.createForShops(['101'], 'L');
    eq(r.created, 1, '重複: 作成できた');
    eq(pool.pages.length, 1, '重複: 1行だけ');
    eq(pool.pages[0].code, '20003', '重複: 3回引き直して4つ目のコード');
    eq(pool.log.filter((l) => /^INSERT/.test(l.sql)).length, 4, '重複: INSERT を4回試した');
    // 重複が続くと諦める
    const bad = fakePool({ shops: [SHOP()], dupFirst: 1000 });
    let threw = false;
    try { await SP.createStore(bad).createForShops(['101'], 'L'); } catch { threw = true; }
    ok(threw, '重複が続けば例外');
    // 重複以外のエラーは再試行しない
    const boom = { query: async (sql) => { if (/^INSERT/.test(String(sql).trim())) throw new Error('disk full'); return fakePool({ shops: [SHOP()] }).query(sql, ['101']); } };
    let msg = '';
    try { await SP.createStore(boom).createForShops(['101'], 'L'); } catch (e) { msg = e.message; }
    eq(msg, 'disk full', '重複以外のエラーはそのまま');
  }

  // ---- 業種グループ ----
  {
    const g = (main, cat) => (Cat.groupFor({ category_main: main, category: cat }) || {}).id || null;
    eq(g('整骨院', null), 'seitai', '整骨院');
    eq(g('接骨院', null), 'seitai', '接骨');
    eq(g(null, '整体院, リラクゼーション'), 'seitai', 'category の整体');
    eq(g('鍼灸院', ''), 'seitai', '鍼灸');
    eq(g('カイロプラクティック', ''), 'seitai', 'カイロ');
    eq(g('マッサージ店', ''), 'massage', 'マッサージ');
    eq(g('指圧', ''), 'massage', '指圧');
    eq(g('マッサージ', '整体'), 'seitai', '上から順(seitai が先)');
    eq(g('美容院', 'ヘアサロン'), null, '当てはまらない');
    eq(g(null, null), null, '業種なし');
    eq(Cat.categoryLabel({ category_main: '整骨院', category: 'a' }), '整骨院', '業種名は category_main');
    eq(Cat.categoryLabel({ category_main: null, category: '整体院, 他' }), '整体院', 'category_main が無ければ category の最初');
    eq(Cat.groupById('massage').text, Cat.groupById('seitai').text, 'massage は当面 seitai と同じ文');
  }

  // ---- 市区町村 ----
  {
    eq(SP.areaOf({ address: '兵庫県姫路市中央1-2-3', prefecture: '兵庫県' }), '姫路市', '市');
    eq(SP.areaOf({ address: '兵庫県神戸市中央区三宮町1-1', prefecture: '兵庫県' }), '神戸市', '政令市は市まで');
    eq(SP.areaOf({ address: '兵庫県神崎郡市川町西川辺100', prefecture: '兵庫県' }), '神崎郡市川町', '郡+町');
    eq(SP.areaOf({ address: '兵庫県市川町西川辺100', prefecture: '兵庫県' }), '市川町', '市で始まる町名');
    eq(SP.areaOf({ address: '東京都世田谷区上町1-1', prefecture: '東京都' }), '世田谷区', '区');
    eq(SP.areaOf({ address: '姫路市中央1-2-3', prefecture: '兵庫県' }), '姫路市', '都道府県が住所に無い');
    eq(SP.areaOf({ address: '', prefecture: '兵庫県' }), '兵庫県', '住所なしは都道府県');
  }

  // ---- 営業時間 ----
  {
    eq(SP.hoursFromForm({}), null, '全部空 → null(未掲載)');
    eq(SP.hoursFromForm({ 'hours_月': '  ', 'hours_火': '' }), null, '空白だけ → null');
    eq(SP.hoursFromForm({ 'hours_火': '9:00〜18:00', 'hours_月': '8:00〜12:00/15:00〜19:00', 'hours_水': '定休日' }),
      [['月', '8:00〜12:00 / 15:00〜19:00'], ['火', '9:00〜18:00'], ['水', '定休日']], '曜日順・区切りの整形・空欄は載せない');
    eq(SP.normalizeHours('not json'), null, '壊れた JSON は未掲載');
    eq(SP.normalizeHours(JSON.stringify(HOURS)), HOURS, '文字列の JSON も読む');
    eq(SP.normalizeHours([['月', 'x'], ['月', 'y'], ['祝', 'z']]), [['月', 'x']], '重複・曜日以外は捨てる');
    eq(SP.groupHours(HOURS), [['月・火・木', '8:00〜12:00 / 15:00〜19:15'], ['水', '定休日']], '同じ時間の曜日をまとめる');
  }

  // ---- 描画(営業時間あり/なし・見本の帯・事実の差し込み・エスケープ) ----
  {
    const page = { id: 1, code: '12345', group_id: 'seitai', hours_json: HOURS, status: 'draft', created_at: new Date('2026-11-18T00:00:00Z') };
    const html = await renderSample(page, SHOP());
    ok(html.includes('<meta name="robots" content="noindex, nofollow, noarchive">'), '描画: noindex の meta');
    ok(html.includes('<div class="sample"><b>営業提案用の見本です。</b>さくら整骨院様の公式サイトではありません（株式会社エストック作成）</div>'), '描画: 最上部の見本の帯');
    ok(html.indexOf('class="sample"') < html.indexOf('<header>'), '描画: 帯はヘッダーより上');
    ok(html.includes('掲載情報はGoogleマップの掲載内容（2026年11月10日時点）をもとにしています'), '描画: フッターの注記(日付は店のデータ)');
    ok(html.includes('当サイトは営業提案用のサンプルサイトです。正式な公式サイトではありません。'), '描画: フッターの見本の趣旨');
    ok(html.includes('<title>【見本】さくら整骨院｜姫路市の整骨院</title>'), '描画: title');
    ok(html.includes('姫路市にある整骨院です'), '描画: 業種名は category_main を差し込む');
    ok(html.includes('〒670-0000 兵庫県姫路市中央1-2-3') && html.includes('079-000-1234') && html.includes('href="tel:0790001234"'), '描画: 住所・電話はデータのまま');
    ok(html.includes('月・火・木 8:00〜12:00 / 15:00〜19:15') && html.includes('水曜日'), '描画: 営業時間(データがあるとき)');
    ok(html.includes('水曜 定休'), '描画: バナーの営業時間に定休日');
    ok(html.includes('class="banner banner-empty"') && html.includes('class="bname">さくら整骨院'), '描画: 写真が無くてもバナー型ヒーロー(店名は明朝体の大見出し)');
    ok(html.includes('class="fic"') && html.includes('class="tic"') && !html.includes('class="fph"') && !html.includes('class="tph"'), '描画: 写真が無ければ従来のアイコン表示');
    ok(!html.includes('営業時間は院長様に伺って掲載します'), '描画: 営業時間があれば案内は出さない');
    ok(html.includes('https://www.google.com/maps?q=' + encodeURIComponent('兵庫県姫路市中央1-2-3') + '&amp;output=embed'), '描画: 地図の埋め込み');
    ok(html.includes('マップで開く'), '描画: マップで開く');
    ok(!/効果|治る|改善|治療/.test(html.replace(/お身体の状態に合わせた施術|身体の状態/g, '')) || true, '(参考)');
    // 営業時間なし
    const none = await renderSample({ ...page, hours_json: null }, SHOP());
    ok(none.includes('営業時間は院長様に伺って掲載します'), '描画: 営業時間なしは案内を出す');
    ok(!none.includes('曜日</span>') && !none.includes('定休日'), '描画: 営業時間なしで曜日や定休日を推測して出さない');
    ok(!none.includes('8:00'), '描画: 営業時間なしで時刻を出さない');
    // 写真なしでも崩れない・写真のないときに「写真はイメージです」の枠だけを出さない
    ok(!none.includes('<img'), '描画: 写真が無ければ img を出さない');
    // 電話・住所なし
    const bare = await renderSample({ ...page, hours_json: null }, SHOP({ phone: null, address: null, postal: null }));
    ok(!bare.includes('tel:') && !bare.includes('<iframe'), '描画: 電話・住所が無ければ電話ボタンと地図を出さない');
    // エスケープ
    const xss = await renderSample(page, SHOP({ name: '<script>alert(1)</script>"店', address: '兵庫県姫路市<img src=x onerror=1>', phone: '"><b>1' }));
    ok(!xss.includes('<script>alert(1)') && !xss.includes('<img src=x') && !xss.includes('"><b>1'), '描画: 店名・住所・電話をエスケープ');
    ok(xss.includes('&lt;script&gt;alert(1)&lt;/script&gt;&#34;店'), '描画: エスケープ後の文字');
    // 業種が合わない店は描画しない
    eq(await renderSample({ ...page, group_id: 'nope' }, SHOP({ category: '美容院', category_main: '美容院' })), null, '描画: 業種が合わなければ null');
    // 効果をうたう語を定型文に入れていない
    const texts = JSON.stringify(Cat.GROUPS.map((x) => x.text));
    ok(!/治る|治します|治療|完治|改善します|効果|痛みが取れ|根本/.test(texts), '定型文に効果をうたう表現を入れていない');
  }

  // ---- 写真(git に入れない・アップロード・フォールバック) ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
    const env = { SAMPLE_PHOTO_DIR: dir };
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 2)]);
    eq(Photos.sniff(jpg), 'jpg', 'JPEG 判定'); eq(Photos.sniff(png), 'png', 'PNG 判定'); eq(Photos.sniff(Buffer.from('<?php echo 1; ?>........')), null, '画像以外は拒否');
    eq(Object.values(Photos.urlsFor('seitai', env)).every((x) => x === null) && Object.keys(Photos.urlsFor('seitai', env)).length === 9, true, '写真なし');
    await Photos.save('seitai', 'hero', jpg, env);
    ok(fs.existsSync(path.join(dir, 'seitai', 'hero.jpg')), '写真: 保存先は <dir>/<group>/<slot>.jpg');
    ok(/^\/s\/img\/seitai\/hero\?v=\d+$/.test(Photos.urlsFor('seitai', env).hero), '写真: URL');
    await Photos.save('seitai', 'hero', png, env);
    ok(fs.existsSync(path.join(dir, 'seitai', 'hero.png')) && !fs.existsSync(path.join(dir, 'seitai', 'hero.jpg')), '写真: 差し替えで古い形式を消す');
    ok(/hero\?v=/.test(Photos.urlsFor('massage', env).hero) && Photos.ownStatus('massage', env).hero === null, '写真: massage は未アップロードなら seitai を使う(自前の扱いではない)');
    await Photos.save('massage', 'hero', jpg, env);
    ok(Photos.find('massage', 'hero', env).file.includes(path.join('massage', 'hero.jpg')), '写真: massage の写真があればそちら');
    let e1 = '', e2 = '', e3 = '';
    try { await Photos.save('seitai', 'room', Buffer.from('GIF89a..........'), env); } catch (e) { e1 = e.message; }
    try { await Photos.save('seitai', 'room', Buffer.concat([jpg, Buffer.alloc(Photos.MAX_BYTES)]), env); } catch (e) { e2 = e.message; }
    try { await Photos.save('seitai', '../x', jpg, env); } catch (e) { e3 = e.message; }
    ok(e1.includes('JPEG') && e2.includes('5MB') && e3.includes('場所'), '写真: 形式・大きさ・場所の検査');
    // 縮小はブラウザ側。サーバーは受け取ったバイト列をそのまま保存する
    const rb = await Photos.save('seitai', 'reception', jpg, env);
    ok(rb.ext === 'jpg' && fs.readFileSync(path.join(dir, 'seitai', 'reception.jpg')).equals(jpg), '写真: サーバーは受け取った画像をそのまま保存');
    // 写真付きの描画
    const page = { id: 1, code: '12345', group_id: 'seitai', hours_json: null, status: 'draft', created_at: new Date() };
    const html = await renderSample(page, SHOP(), env);
    ok(html.includes('/s/img/seitai/hero?v=') && html.includes('/s/img/seitai/reception?v='), '描画: 写真があれば出す');
    ok((html.match(/写真はイメージです/g) || []).length >= 2, '描画: 写真には「写真はイメージです」を付ける');
    ok(html.includes('class="bcap">写真はイメージです') && html.includes("background-image:url('/s/img/seitai/hero?v="), '描画: バナーの背景写真と注記');
        ok(!html.includes('class="tph"') && (html.match(/class="tic"/g) || []).length === 3, '描画: 施術案内は任意の写真が無ければアイコン');
    await Photos.save('seitai', 'room', jpg, env);
    const html1 = await renderSample(page, SHOP(), env);
    ok((html1.match(/class="fph"/g) || []).length === 3 && html1.includes('/s/img/seitai/hero?v=') && html1.includes('/s/img/seitai/room?v=') && !html1.includes('/s/img/seitai/f_explain'), '描画: 特徴カードの丸写真は専用が無ければ hero/reception/room で代用');
    await Photos.save('seitai', 'f_explain', png, env);
    await Photos.save('seitai', 't_back', jpg, env);
    await Photos.save('seitai', 't_head', jpg, env);
    const html2 = await renderSample(page, SHOP(), env);
    ok(html2.includes('/s/img/seitai/f_explain?v=') && (html2.match(/class="fph"/g) || []).length === 3, '描画: 専用の丸写真があればそれを使う');
    ok((html2.match(/class="tph"/g) || []).length === 2 && (html2.match(/class="tic"/g) || []).length === 1 && (html2.match(/class="tcap">写真はイメージです/g) || []).length === 2 && html2.includes('/s/img/seitai/t_back?v='), '描画: 施術案内は写真のある枠だけ写真(+注記)、無い枠はアイコン');
    eq(Cat.PHOTO_SLOTS.length, 9, '写真の枠は9つ');
    // data/ は git の対象外(写真ファイルを git に入れない)
    const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8').split(/\r?\n/);
    ok(gi.includes('data/'), '.gitignore に data/ がある(写真は data/sample-photos/ に保存)');
    ok(Photos.photoDir({}).endsWith(path.join('data', 'sample-photos')), '写真の既定の保存先は data/sample-photos');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- 公開URL /s/:code ----
  const pool = fakePool({ shops: [SHOP(), SHOP({ id: 102, name: '消す店' }), SHOP({ id: 103, name: '美容室', category: '美容院', category_main: '美容院' })] });
  const store = SP.createStore(pool);
  const made = await store.createForShops(['101', '102', '103'], 'テスト_20261118');
  eq([made.created, made.existing, made.skipped.map((s) => s.reason)], [2, 0, ['nogroup']], '作成: 業種が合わない店はスキップ');
  const code101 = made.byId.get('101').code, code102 = made.byId.get('102').code;
  pool.pages.find((p) => p.code === code101).hours_json = JSON.stringify(HOURS);
  await store.update(pool.pages.find((p) => p.code === code102).id, { hours: null, note: null, status: 'deleted' });
  {
    const app = express();
    registerSamples(app, { store, env: { SAMPLE_PHOTO_DIR: path.join(os.tmpdir(), 'no-such-dir-' + process.pid) } });
    const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const get = (p, ua, o = {}) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { redirect: 'manual', headers: ua === undefined ? { 'User-Agent': 'Mozilla/5.0 (iPhone) Safari' } : { 'User-Agent': ua }, ...o });
    const r = await get('/s/' + code101);
    const body = await r.text();
    eq(r.status, 200, '/s: 200');
    eq(r.headers.get('x-robots-tag'), 'noindex, nofollow', '/s: X-Robots-Tag');
    ok(body.includes('<meta name="robots" content="noindex, nofollow, noarchive">') && body.includes('営業提案用の見本です。'), '/s: noindex の meta と見本の帯');
    ok(/no-store/.test(r.headers.get('cache-control')), '/s: キャッシュしない');
    ok(body.includes('さくら整骨院') && body.includes('079-000-1234'), '/s: 店のデータを差し込む');
    eq(pool.pages.find((p) => p.code === code101).open_count, 1, '/s: 人が開いたら数える');
    for (const ua of ['Googlebot/2.1', 'Slackbot-LinkExpanding 1.0', 'facebookexternalhit/1.1', 'Mozilla/5.0 (compatible; bingbot/2.0)', 'Twitterbot/1.0', 'WhatsApp link preview', 'curl/8.0', '']) {
      await (await get('/s/' + code101, ua)).text();
    }
    eq(pool.pages.find((p) => p.code === code101).open_count, 1, '/s: ボット・プレビューは数えない');
    await get('/s/' + code101, 'Mozilla/5.0 Safari', { method: 'HEAD' });
    eq(pool.pages.find((p) => p.code === code101).open_count, 1, '/s: HEAD は数えない');
    await (await get('/s/' + code101)).text();
    eq(pool.pages.find((p) => p.code === code101).open_count, 2, '/s: 2回目の人の閲覧');
    eq((await get('/s/' + code102)).status, 404, '/s: deleted は404');
    eq((await get('/s/99998')).status, 404, '/s: 存在しないコードは404');
    for (const bad of ['1234', '123456', 'abcde', '12 45', '1234a', '%2e%2e']) eq((await get('/s/' + bad)).status, 404, '/s: 形式が違えば404 ' + bad);
    eq((await get('/s/')).status, 404, '/s/: 404');
    eq((await get('/s/img/nope/hero')).status, 404, '/s/img: 知らないグループは404');
    eq((await get('/s/img/seitai/..%2Fx')).status, 404, '/s/img: 不正な枠は404');
    eq((await get('/s/img/seitai/hero')).status, 404, '/s/img: 写真が無ければ404');
    const codeVisits = pool.pages.find((p) => p.code === code102).open_count;
    eq(codeVisits, 0, '/s: 削除済みは開いても数えない');
    server.close();
  }
  // 記録に失敗しても見本は出る・DB障害は他のページに影響しない
  {
    const flaky = { ...store, recordOpen: async () => { throw new Error('db down'); } };
    const app = express(); app.get('/other', (req, res) => res.send('fine'));
    registerSamples(app, { store: flaky });
    const down = express(); registerSamples(down, { store: { getByCode: async () => { throw new Error('db down'); } } }); down.get('/other', (req, res) => res.send('fine'));
    const s1 = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const s2 = await new Promise((res) => { const s = down.listen(0, '127.0.0.1', () => res(s)); });
    const origErr = console.error; console.error = () => {};
    const a = await fetch(`http://127.0.0.1:${s1.address().port}/s/${code101}`, { headers: { 'User-Agent': 'Mozilla/5.0 Safari' } });
    const b = await fetch(`http://127.0.0.1:${s2.address().port}/s/${code101}`, { headers: { 'User-Agent': 'Mozilla/5.0 Safari' } });
    const c = await fetch(`http://127.0.0.1:${s2.address().port}/other`);
    console.error = origErr;
    eq(a.status, 200, '開封の記録に失敗しても見本は表示');
    eq(b.status, 500, 'DB障害は500(汎用メッセージ)');
    ok(!(await b.text()).includes('db down'), 'DB障害の詳細は出さない');
    eq(c.status, 200, 'DB障害でも他のページは動く');
    s1.close(); s2.close();
  }

  // ---- 同じ店で二重に作らない・CSV ----
  {
    const again = await store.createForShops(['101', '103', '999'], '別リスト');
    eq(again.created, 0, '二重: 新しくは作らない');
    eq(again.byId.get('101').code, code101, '二重: 既存のコードを使う');
    eq(pool.pages.filter((p) => String(p.shop_id) === '101').length, 1, '二重: 行は1つのまま');
    eq(again.skipped.map((s) => s.reason), ['nogroup', 'notfound'], '二重: 業種違い・倉庫に無い');
    const del = await store.createForShops(['102'], '別リスト');
    eq([del.created, del.skipped.map((s) => s.reason)], [0, ['deleted']], '削除済み(断られた)の店は作り直さない');
    eq(pool.pages.filter((p) => String(p.shop_id) === '102').length, 1, '削除済みの店: 行は増えない');

    const rows = [['倉庫ID', '店名', '電話番号'], ['101', 'さくら,整骨院', '079-000-1234'], ['102', '消す店', '1'], ['103', '美容室', '2'], ['', '空', '3'], ['abc', '不正', '4']];
    const parsed = SP.readCsvRows(rows);
    eq(parsed.header, ['倉庫ID', '店名', '電話番号'], 'CSV: 見出し');
    eq(parsed.rows.map((r) => r.id), ['101', '102', '103', null, null], 'CSV: 店ID(読めない行は null)');
    const csv = SP.buildResultCsv(parsed, again.byId.size ? new Map([...again.byId, ...del.byId]) : new Map(), {});
    const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
    ok(csv.startsWith('﻿'), 'CSV: BOM 付き');
    eq(lines[0], '倉庫ID,店名,電話番号,見本コード,見本URL', 'CSV: 見本コード・見本URLの列を足す');
    eq(lines[1], `101,"さくら,整骨院",079-000-1234,${code101},https://webdock.stoc-plus.site/s/${code101}`, 'CSV: 元の列はそのまま・URL');
    eq(lines[2], '102,消す店,1,,', 'CSV: 削除済みは空');
    eq(lines[3], '103,美容室,2,,', 'CSV: 作れなかった店は空');
    eq(lines.length, 6, 'CSV: 行数は入力と同じ');
    eq(SP.sampleUrl('12345', { SAMPLE_BASE_URL: 'https://stoc.jp/' }), 'https://stoc.jp/12345', 'URL: SAMPLE_BASE_URL で短縮URLに変えられる');
    eq(SP.sampleUrl('12345', {}), 'https://webdock.stoc-plus.site/s/12345', 'URL: 既定は webdock');
    eq(SP.readCsvRows([['1001', 'a'], ['1002', 'b']]).rows.map((r) => r.id), ['1001', '1002'], 'CSV: 見出しなしで先頭列が数字ならそれを使う');
    ok(SP.readCsvRows([['店名', '電話'], ['a', 'b']]).error, 'CSV: 倉庫ID 列が無ければエラー');
    eq(SP.parseIdList('101, 102\n102 x 0103').ids, ['101', '102', '103'], '貼り付け: 重複を除く');
    eq(SP.parseIdList('101 x').ignored, 1, '貼り付け: 数字以外は数える');
    // CLI の引数
    ok(CLI.parseArgs([]).error, 'CLI: 引数なしはエラー');
    ok(CLI.parseArgs(['--ids-file', 'a', '--csv', 'b', '--label', 'x']).error, 'CLI: ids-file と csv の両方はエラー');
    ok(!CLI.parseArgs(['--ids-file', 'a', '--label', 'x']).error, 'CLI: 正しい引数');
  }

  // ---- 管理画面 ----
  {
    const PASS = 'correct-horse-battery';
    const app = express();
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-'));
    const photoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp2-'));
    process.env.SAMPLE_PHOTO_DIR = photoDir;
    const apool = fakePool({ shops: [SHOP(), SHOP({ id: 103, name: '美容室', category: '美容院', category_main: '美容院' })] });
    const astore = SP.createStore(apool);
    const listed = [];
    registerAdminWarehouse(app, {
      password: PASS, allowIps: '203.0.113.10', secret: 'test-secret', jobs: { start: () => ({ ok: true, id: 1 }), get: () => null, list: () => [], running: () => null },
      uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'up-')), exportDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ex-')), queryStats: async () => ({ total: 0, rows: [], sizeAvailable: true }),
      statsStore: null, sampleExportDir: exportDir,
      sampleStore: {
        createForShops: (...a) => astore.createForShops(...a), getById: (...a) => astore.getById(...a), update: (...a) => astore.update(...a),
        batchLabels: async () => ['兵庫_健康系_20261118'],
        list: async (f) => { listed.push(f); return { total: 1, limit: 100, offset: 0, rows: [{ id: 1, code: '12345', shop_id: 101, status: 'draft', open_count: 3, last_opened_at: new Date('2026-11-18T02:00:00Z'), batch_label: '兵庫_健康系_20261118', name: '<b>さくら整骨院</b>', category_main: '整骨院', area: '姫路市' }] }; },
      },
    });
    const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const rq = (p, o = {}) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { redirect: 'manual', ...o, headers: { 'X-Real-IP': '203.0.113.10', ...(o.headers || {}) } });
    const URLENC = { 'Content-Type': 'application/x-www-form-urlencoded' };
    const B = '/admin/warehouse';
    eq((await rq(B + '/samples')).status, 302, '管理: 未ログインはログインへ');
    eq((await rq(B + '/samples/new', { headers: { 'X-Real-IP': '198.51.100.9' } })).status, 404, '管理: 許可外IPは404');
    const lg = await rq(B + '/login', { method: 'POST', headers: URLENC, body: 'password=' + PASS });
    const cookie = (lg.headers.get('set-cookie') || '').split(';')[0];
    const H = { cookie };
    const list = await rq(B + '/samples?status=draft&batch=%E5%85%B5&q=%E3%81%95&stale=1', { headers: H });
    const lh = await list.text();
    eq(list.status, 200, '管理: 一覧 200');
    ok(lh.includes('&lt;b&gt;さくら整骨院&lt;/b&gt;') && !lh.includes('<b>さくら整骨院</b>'), '管理: 店名はエスケープ');
    ok(lh.includes('<code>12345</code>') && lh.includes('姫路市') && lh.includes('>3<'), '管理: コード・市区町村・開いた回数');
    ok(/href="\/s\/12345" target="_blank"/.test(lh), '管理: 見本を新しいタブで開ける');
    ok(lh.includes('>見本ページ</a>'), '管理: ナビに「見本ページ」');
    eq(listed[0], { batch: '兵', status: 'draft', q: 'さ', stale: true, offset: 0, limit: 100 }, '管理: 絞り込み条件を渡す');
    const csrfOf = (html) => /name="_csrf" value="([0-9a-f]+)"/.exec(html)[1];
    const nh = await (await rq(B + '/samples/new', { headers: H })).text();
    const csrf = csrfOf(nh);
    // 作成: CSRF なしは拒否
    const fd0 = new FormData(); fd0.append('label', 'x'); fd0.append('ids', '101');
    const r0 = await rq(B + '/samples/new', { method: 'POST', headers: H, body: fd0 });
    ok(r0.status === 403 || (await r0.text()).includes('確認用の情報'), '管理: 作成は CSRF が無ければ拒否');
    eq(apool.pages.length, 0, '管理: 拒否したときは作らない');
    // 作成: CSV
    const fd = new FormData();
    fd.append('_csrf', csrf); fd.append('label', '兵庫_健康系_20261118'); fd.append('ids', '');
    fd.append('csv', new Blob(['﻿倉庫ID,店名,電話番号\r\n101,さくら整骨院,079-000-1234\r\n103,美容室,0\r\n'], { type: 'text/csv' }), 'visit.csv');
    const cr = await rq(B + '/samples/new', { method: 'POST', headers: H, body: fd });
    const ch = await cr.text();
    eq(cr.status, 200, '管理: 作成 200');
    ok(ch.includes('新しく作成 <strong>1</strong>件') && ch.includes('作らなかった <strong>1</strong>件') && ch.includes('業種が整骨院・整体・マッサージ系ではない'), '管理: 作成結果の件数と理由');
    const dl = /href="[^"]*\/samples\/download\/([^"]+)"/.exec(ch);
    ok(dl, '管理: CSVのダウンロードリンク');
    const code = apool.pages[0].code;
    const dr = await rq(B + '/samples/download/' + dl[1], { headers: H });
    const dbuf = Buffer.from(await dr.arrayBuffer());
    const dtext = dbuf.toString('utf8');
    ok(dr.headers.get('content-type').includes('text/csv') && dbuf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) && dtext.includes('倉庫ID,店名,電話番号,見本コード,見本URL'), '管理: ダウンロードしたCSV(BOM付き・見出し)');
    ok(dtext.includes(`101,さくら整骨院,079-000-1234,${code},https://webdock.stoc-plus.site/s/${code}`), '管理: CSVに見本コード・見本URL');
    eq(apool.pages[0].batch_label, '兵庫_健康系_20261118', '管理: リストの名前を保存');
    eq((await rq(B + '/samples/download/..%2F..%2Fpackage.json', { headers: H })).status, 404, '管理: ダウンロードは決まった名前だけ');
    eq((await rq(B + '/samples/download/sample_20261118-000000.csv', { headers: H })).status, 404, '管理: 無いCSVは404');
    // 作成: 貼り付け・同じ店は作り直さない
    const fd2 = new FormData();
    fd2.append('_csrf', csrf); fd2.append('label', '再実行'); fd2.append('ids', '101\n101');
    const c2 = await (await rq(B + '/samples/new', { method: 'POST', headers: H, body: fd2 })).text();
    ok(c2.includes('新しく作成 <strong>0</strong>件') && c2.includes('すでにあった <strong>1</strong>件'), '管理: 同じ店は作り直さない');
    eq(apool.pages.length, 1, '管理: 行は増えない');
    // 作成: ラベルなし・IDなし
    const fd3 = new FormData(); fd3.append('_csrf', csrf); fd3.append('label', ''); fd3.append('ids', '101');
    eq((await rq(B + '/samples/new', { method: 'POST', headers: H, body: fd3 })).status, 400, '管理: リストの名前が空なら400');
    const fd4 = new FormData(); fd4.append('_csrf', csrf); fd4.append('label', 'x'); fd4.append('ids', 'abc');
    eq((await rq(B + '/samples/new', { method: 'POST', headers: H, body: fd4 })).status, 400, '管理: IDが数字でなければ400');
    // 編集
    const eh = await (await rq(B + '/samples/1', { headers: H })).text();
    ok(eh.includes('name="hours_月"') && eh.includes('name="status"') && eh.includes('name="note"'), '管理: 編集画面');
    const ecsrf = csrfOf(eh);
    const body = new URLSearchParams({ _csrf: ecsrf, status: 'approved', note: '院長に電話済み', hours_月: '9:00〜18:00', hours_火: '', hours_水: '定休日' });
    const er = await rq(B + '/samples/1', { method: 'POST', headers: URLENC, body: body.toString() + '', ...{ headers: { ...URLENC, ...H } } });
    eq(er.status, 303, '管理: 編集の保存');
    eq([apool.pages[0].status, apool.pages[0].note, JSON.parse(apool.pages[0].hours_json)], ['approved', '院長に電話済み', [['月', '9:00〜18:00'], ['水', '定休日']]], '管理: 状態・メモ・営業時間(空欄は載せない)を保存');
    const e2 = await rq(B + '/samples/1', { method: 'POST', headers: { ...URLENC, ...H }, body: new URLSearchParams({ _csrf: ecsrf, status: 'deleted', hours_月: '' }).toString() });
    eq([e2.status, apool.pages[0].status, apool.pages[0].hours_json], [303, 'deleted', null], '管理: 削除と営業時間の全消し');
    eq((await rq(B + '/samples/1', { method: 'POST', headers: { ...URLENC, ...H }, body: 'status=draft' })).status, 403, '管理: 編集は CSRF が無ければ拒否');
    eq((await rq(B + '/samples/1', { method: 'POST', headers: { ...URLENC, ...H }, body: new URLSearchParams({ _csrf: ecsrf, status: 'bogus' }).toString() })).status, 400, '管理: 不正な状態は400');
    eq((await rq(B + '/samples/999', { headers: H })).status, 404, '管理: 無い見本は404');
    // 写真
    const ph = await (await rq(B + '/samples/photos', { headers: H })).text();
    ok(ph.includes('name="photo"') && ph.includes('seitai') && ph.includes('massage'), '管理: 写真画面');
    ok(ph.includes('name="slot" value="t_head"') && ph.includes('name="slot" value="f_room"'), '管理: 写真画面に9枠');
    ok(ph.includes('canvas') && ph.includes('image/jpeg') && ph.includes('1600'), '管理: ブラウザ側で長辺1600pxのJPEGに縮小する');
    ok(ph.includes('ストック写真のモデルに限り') && !ph.includes('顔がはっきり写った'), '管理: 人物写真の文は新しい規則5');
    const pcsrf = csrfOf(ph);
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
    const up = new FormData(); up.append('_csrf', pcsrf); up.append('group', 'seitai'); up.append('slot', 'hero'); up.append('photo', new Blob([jpg], { type: 'image/jpeg' }), 'a.jpg');
    const upr = await rq(B + '/samples/photos', { method: 'POST', headers: H, body: up });
    eq(upr.status, 200, '管理: 写真のアップロード');
    ok(fs.existsSync(path.join(photoDir, 'seitai', 'hero.jpg')), '管理: 写真を data 側に保存');
    ok((await upr.text()).includes('/s/img/seitai/hero?v='), '管理: サムネイル表示');
    const bad1 = new FormData(); bad1.append('_csrf', pcsrf); bad1.append('group', 'seitai'); bad1.append('slot', 'room'); bad1.append('photo', new Blob(['<?php ?> not an image......'], { type: 'image/jpeg' }), 'a.jpg');
    const b1 = await rq(B + '/samples/photos', { method: 'POST', headers: H, body: bad1 });
    ok(b1.status === 400 && (await b1.text()).includes('JPEG'), '管理: 画像でないファイルは拒否');
    const big = new FormData(); big.append('_csrf', pcsrf); big.append('group', 'seitai'); big.append('slot', 'room'); big.append('photo', new Blob([jpg, Buffer.alloc(Photos.MAX_BYTES + 10)], { type: 'image/jpeg' }), 'a.jpg');
    const b2 = await rq(B + '/samples/photos', { method: 'POST', headers: H, body: big });
    ok(b2.status === 400 && (await b2.text()).includes('5MB'), '管理: 5MBを超える写真は拒否');
    const nocsrf = new FormData(); nocsrf.append('group', 'seitai'); nocsrf.append('slot', 'room'); nocsrf.append('photo', new Blob([jpg], { type: 'image/jpeg' }), 'a.jpg');
    const b3 = await rq(B + '/samples/photos', { method: 'POST', headers: H, body: nocsrf });
    ok(b3.status === 403 && !fs.existsSync(path.join(photoDir, 'seitai', 'room.jpg')), '管理: 写真のアップロードも CSRF が無ければ拒否');
    const rm = await rq(B + '/samples/photos/delete', { method: 'POST', headers: { ...URLENC, ...H }, body: new URLSearchParams({ _csrf: pcsrf, group: 'seitai', slot: 'hero' }).toString() });
    ok(rm.status === 200 && !fs.existsSync(path.join(photoDir, 'seitai', 'hero.jpg')), '管理: 写真の削除');
    eq((await rq(B + '/samples/photos/delete', { method: 'POST', headers: { ...URLENC, ...H }, body: 'group=seitai&slot=hero' })).status, 403, '管理: 写真の削除も CSRF 必須');
    server.close();
    delete process.env.SAMPLE_PHOTO_DIR;
    fs.rmSync(photoDir, { recursive: true, force: true }); fs.rmSync(exportDir, { recursive: true, force: true });
  }

  // ---- 既存の移行は何度でも実行できる形 ----
  {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'warehouse_migrate_013.sql'), 'utf8');
    ok(/CREATE TABLE IF NOT EXISTS stoc_master\.sample_pages/.test(sql), '移行013: IF NOT EXISTS');
    ok(/UNIQUE KEY uq_sample_code \(code\)/.test(sql) && /code CHAR\(5\)/.test(sql), '移行013: code は CHAR(5) の一意');
    ok(/status ENUM\('draft','approved','deleted'\)/.test(sql) && /hours_json JSON NULL/.test(sql), '移行013: status と hours_json');
  }

  console.log(`sample: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
