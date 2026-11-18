'use strict';
/**
 * 倉庫の管理画面「見本ページ」(adminWarehouse.js の router に足す。ログイン・IP制限・CSRFは親の仕組みをそのまま使う)
 *   GET  /samples                一覧(コード・店名・業種・市区町村・状態・開いた回数・最後に開いた日時。batch_label などで絞り込み)
 *   GET  /samples/new            作成(倉庫IDの貼り付け または CSV)
 *   POST /samples/new            作成を実行 → 結果とCSVダウンロード
 *   GET  /samples/download/:name 見本コード・見本URLを足したCSV
 *   GET  /samples/photos         写真(業種グループごとに hero / room / reception)
 *   POST /samples/photos         写真のアップロード
 *   POST /samples/photos/delete  写真の削除
 *   GET/POST /samples/:id        編集(営業時間・メモ・状態)
 */
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const wh = require('./warehouse');
const SP = require('./samplePages');
const Photos = require('./samplePhotos');
const Cat = require('./sampleCategories');

const CSV_MAX_BYTES = 2 * 1024 * 1024;
const EXPORT_NAME = /^sample_\d{8}-\d{6}(?:-\d+)?\.csv$/;
const REASON = { notfound: '倉庫に見つからない', nogroup: '業種が整骨院・整体・マッサージ系ではない', deleted: '削除済みの見本がある(断られた店のため作り直さない)' };

function register(router, ctx) {
  const { BASE, page, wrap, csrfOk, now, stamp } = ctx;
  const env = ctx.env || process.env;
  const exportDir = path.resolve(ctx.sampleExportDir || env.SAMPLE_EXPORT_DIR || path.join(__dirname, '..', 'data', 'sample-exports'));
  let store = ctx.sampleStore || null;
  const getStore = () => {
    if (!store) store = SP.createStore(require('./stocBatch').createStocPool());
    return store;
  };
  const bad = (msg, status = 400) => Object.assign(new Error(msg), { userSafe: true, status });
  const CSRF_MSG = '確認用の情報が正しくありません。ページを開き直してやり直してください。';

  // 取り出し用の共通の入れ物(画面に渡す値)
  const common = (extra) => ({ nav: 'samples', SP, Cat, Photos, statusLabel: SP.STATUS_LABEL, baseUrl: (code) => SP.sampleUrl(code, env), ...extra });

  const csvUpload = multer({
    storage: multer.memoryStorage(), defParamCharset: 'utf8',
    limits: { fileSize: CSV_MAX_BYTES, files: 1, fields: 10, parts: 20 },
    fileFilter(req, file, cb) {
      if (!csrfOk(req, req.body && req.body._csrf)) return cb(bad(CSRF_MSG, 403));
      cb(null, true);
    },
  }).single('csv');
  const photoUpload = multer({
    storage: multer.memoryStorage(), defParamCharset: 'utf8',
    limits: { fileSize: Photos.MAX_BYTES, files: 1, fields: 10, parts: 20 },
    fileFilter(req, file, cb) {
      if (!csrfOk(req, req.body && req.body._csrf)) return cb(bad(CSRF_MSG, 403));
      cb(null, true);
    },
  }).single('photo');
  const runUpload = (mw, req, res) => new Promise((resolve) => mw(req, res, (err) => resolve(err || null)));
  const uploadMessage = (err, tooBig) => {
    if (err.code === 'LIMIT_FILE_SIZE') return tooBig;
    if (err.userSafe) return err.message;
    console.error('[admin] sample upload error:', err.message);
    return 'アップロードに失敗しました。もう一度お試しください。';
  };

  // ----- 一覧 -----
  router.get('/samples', wrap(async (req, res) => {
    const q = req.query || {};
    const f = {
      batch: String(q.batch || '').slice(0, 100), status: SP.STATUSES.includes(q.status) ? q.status : '',
      q: String(q.q || '').trim().slice(0, 50), stale: q.stale === '1', offset: Math.max(Number(q.offset) || 0, 0), limit: 100,
    };
    let data = { rows: [], total: 0, limit: 100, offset: 0 }, labels = [], error = null;
    try { [data, labels] = await Promise.all([getStore().list(f), getStore().batchLabels()]); } catch (e) {
      console.error('[admin] samples list error:', e && e.message);
      error = '見本の一覧を読み込めませんでした。sql/warehouse_migrate_013.sql を適用したか、倉庫のデータベース接続(WH_DB_*)を確認してください。';
    }
    await page(req, res, 'samples', common({ error, f, data, labels }));
  }));

  // ----- 作成 -----
  router.get('/samples/new', wrap((req, res) => page(req, res, 'samples_new', common({ form: { label: '', ids: '' }, result: null }))));
  router.post('/samples/new', wrap(async (req, res) => {
    const err = await runUpload(csvUpload, req, res);
    const body = req.body || {};
    const form = { label: String(body.label || '').trim().slice(0, 100), ids: String(body.ids || '') };
    const fail = (msg, status = 400) => page(req, res, 'samples_new', common({ form, result: null, error: msg }), status);
    if (err) return fail(uploadMessage(err, `CSVが大きすぎます(${CSV_MAX_BYTES / 1024 / 1024}MBまで)。`), err.status || 400);
    if (!csrfOk(req, body._csrf)) return fail(CSRF_MSG, 403);
    if (!form.label) return fail('リストの名前(例: 兵庫_健康系_20261118)を入れてください。');
    if (/[\u0000-\u001f\u007f]/.test(form.label)) return fail('リストの名前に使えない文字があります。');
    let parsed;
    if (req.file && req.file.size) {
      const text = wh.decodeBuffer(req.file.buffer);
      const first = text.split(/\r?\n/, 1)[0];
      const rows = wh.parseDelimited(text, wh.detectDelimiter(first));
      parsed = SP.readCsvRows(rows);
      if (parsed.error) return fail(parsed.error);
    } else {
      const { ids, ignored } = SP.parseIdList(form.ids);
      if (!ids.length) return fail('倉庫IDを貼り付けるか、CSVを選んでください。');
      if (ignored) return fail(`数字ではない値が${ignored}個あります。倉庫IDは数字だけを、改行・カンマ・スペースで区切って貼り付けてください。`);
      parsed = { header: ['倉庫ID'], idCol: 0, rows: ids.map((id) => ({ cells: [id], id })) };
    }
    const ids = [...new Set(parsed.rows.map((r) => r.id).filter(Boolean))];
    if (!ids.length) return fail('倉庫IDが1つも見つかりませんでした。');
    if (ids.length > SP.MAX_IDS) return fail(`一度に作れるのは${SP.MAX_IDS}件までです(今回 ${ids.length}件)。分けてください。`);
    const noId = parsed.rows.filter((r) => !r.id).length;
    let r;
    try { r = await getStore().createForShops(ids, form.label); } catch (e) {
      if (e && e.userSafe) return fail(e.message);
      console.error('[admin] samples create error:', e && e.message);
      return fail('見本を作れませんでした。sql/warehouse_migrate_013.sql を適用したか、倉庫のデータベース接続を確認してください。', 500);
    }
    // 電話リストにそのまま使えるよう、入力のCSVに「見本コード」「見本URL」の列を足して保存する
    fs.mkdirSync(exportDir, { recursive: true });
    const base = `sample_${stamp(now(), '-')}`;
    let name = `${base}.csv`;
    for (let i = 2; fs.existsSync(path.join(exportDir, name)); i++) name = `${base}-${i}.csv`;
    fs.writeFileSync(path.join(exportDir, name), SP.buildResultCsv(parsed, r.byId, env));
    await page(req, res, 'samples_new', common({
      form: { label: '', ids: '' },
      result: { label: form.label, created: r.created, existing: r.existing, skipped: r.skipped.map((s) => ({ ...s, why: REASON[s.reason] })), noId, csv: name, total: ids.length },
    }));
  }));
  router.get('/samples/download/:name', (req, res) => {
    const name = String(req.params.name || '');
    const full = path.join(exportDir, name);
    if (!EXPORT_NAME.test(name) || !fs.existsSync(full)) return res.status(404).type('text/plain').send('Not Found');
    res.set({ 'Content-Type': 'text/csv; charset=UTF-8', 'Content-Disposition': `attachment; filename="${name}"` });
    fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
  });

  // ----- 写真 -----
  const photosPage = (req, res, extra = {}, status = 200) => page(req, res, 'samples_photos', common({
    groups: Cat.GROUPS.map((g) => ({ id: g.id, photoFolder: g.photoFolder, fallback: g.fallbackPhotoFolder || '', own: Photos.ownStatus(g.id, env) })),
    slots: Cat.PHOTO_SLOTS, maxMb: Photos.MAX_BYTES / 1024 / 1024, ...extra,
  }), status);
  const SLOT_LABEL = {
    hero: 'ヒーロー(最上部の大きな背景写真)・必須', room: '施術スペース・必須', reception: '受付・必須',
    f_explain: '特徴カード1の丸写真(任意。無ければヒーローで代用)', f_counsel: '特徴カード2の丸写真(任意。無ければ受付で代用)', f_room: '特徴カード3の丸写真(任意。無ければ施術スペースで代用)',
    t_back: '施術案内カード1の写真(任意。無ければアイコン表示)', t_stretch: '施術案内カード2の写真(任意。無ければアイコン表示)', t_head: '施術案内カード3の写真(任意。無ければアイコン表示)',
  };
  router.get('/samples/photos', wrap((req, res) => photosPage(req, res, { SLOT_LABEL })));
  router.post('/samples/photos', wrap(async (req, res) => {
    const err = await runUpload(photoUpload, req, res);
    const body = req.body || {};
    const fail = (msg, status = 400) => photosPage(req, res, { SLOT_LABEL, error: msg }, status);
    if (err) return fail(uploadMessage(err, `写真は1枚${Photos.MAX_BYTES / 1024 / 1024}MBまでです。`), err.status || 400);
    if (!csrfOk(req, body._csrf)) return fail(CSRF_MSG, 403);
    if (!req.file) return fail('写真のファイルを選んでください。');
    try {
      const r = await Photos.save(String(body.group || ''), String(body.slot || ''), req.file.buffer, env);
      await photosPage(req, res, { SLOT_LABEL, notice: '写真を保存しました。' });
    } catch (e) {
      if (e && e.userSafe) return fail(e.message);
      console.error('[admin] sample photo error:', e && e.message);
      return fail('写真を保存できませんでした。', 500);
    }
  }));
  router.post('/samples/photos/delete', wrap(async (req, res) => {
    Photos.remove(String((req.body || {}).group || ''), String((req.body || {}).slot || ''), env);
    await photosPage(req, res, { SLOT_LABEL, notice: '写真を削除しました。' });
  }));

  // ----- 編集 -----
  const editPage = async (req, res, row, extra = {}, status = 200) => page(req, res, 'samples_edit', common({ row, hours: SP.normalizeHours(row.hours_json) || [], notice: req.query && req.query.saved ? '保存しました。' : null, ...extra }), status);
  router.get('/samples/:id', wrap(async (req, res, next) => {
    if (!/^\d{1,15}$/.test(req.params.id)) return next();
    const row = await getStore().getById(req.params.id);
    if (!row) return res.status(404).type('text/plain').send('Not Found');
    await editPage(req, res, row);
  }));
  router.post('/samples/:id', wrap(async (req, res, next) => {
    if (!/^\d{1,15}$/.test(req.params.id)) return next();
    const row = await getStore().getById(req.params.id);
    if (!row) return res.status(404).type('text/plain').send('Not Found');
    const b = req.body || {};
    const status = String(b.status || '');
    if (!SP.STATUSES.includes(status)) return editPage(req, res, row, { error: '状態を選んでください。' }, 400);
    await getStore().update(row.id, { hours: SP.hoursFromForm(b), note: b.note, status });
    res.redirect(303, `${BASE}/samples/${row.id}?saved=1`);
  }));
}

module.exports = { register, REASON, EXPORT_NAME };
