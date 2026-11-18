'use strict';
/**
 * 見本ページの写真(業種グループごとに hero / room / reception の3枚)。
 * 写真ファイルは git に入れない(ストック写真の再配布にあたるため)。管理画面からアップロードして data/sample-photos/<group>/ に保存する。
 * 保存先は SAMPLE_PHOTO_DIR で変えられる。
 * 長辺1600pxへの縮小は管理画面のブラウザ側(canvas)で行う。サーバーは受け取った画像をそのまま保存する(1枚5MBまで)。
 */
const fs = require('fs');
const path = require('path');
const C = require('./sampleCategories');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SIDE = 1600;
const TYPES = { jpg: 'image/jpeg', png: 'image/png' };

const photoDir = (env = process.env) => path.resolve(env.SAMPLE_PHOTO_DIR || path.join(__dirname, '..', 'data', 'sample-photos'));

/** 画像の種類を中身(先頭バイト)で判定。'jpg' / 'png' / null */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}

/** あるグループ・枠の写真を探す(そのグループに無ければ fallbackPhotoFolder のグループを見る)。戻り: { file, ext, type, mtime } か null */
function find(groupId, slot, env = process.env) {
  const g = C.groupById(groupId);
  if (!g || !C.PHOTO_SLOTS.includes(slot)) return null;
  const root = photoDir(env);
  for (const folder of [g.photoFolder, g.fallbackPhotoFolder].filter(Boolean)) {
    for (const ext of Object.keys(TYPES)) {
      const file = path.join(root, folder, `${slot}.${ext}`);
      try {
        const st = fs.statSync(file);
        if (st.isFile()) return { file, ext, type: TYPES[ext], mtime: Math.floor(st.mtimeMs) };
      } catch { /* 無ければ次 */ }
    }
  }
  return null;
}

/** ページに出す写真のURL(無い枠は null)。?v= は差し替え後に古い画像が残らないための印 */
function urlsFor(groupId, env = process.env) {
  const out = {};
  for (const slot of C.PHOTO_SLOTS) {
    const f = find(groupId, slot, env);
    out[slot] = f ? `/s/img/${groupId}/${slot}?v=${f.mtime}` : null;
  }
  return out;
}

/** 管理画面の一覧用: そのグループ自身に保存されている写真だけ(フォールバックは含めない) */
function ownStatus(groupId, env = process.env) {
  const g = C.groupById(groupId);
  const out = {};
  for (const slot of C.PHOTO_SLOTS) {
    out[slot] = null;
    for (const ext of Object.keys(TYPES)) {
      try {
        const st = fs.statSync(path.join(photoDir(env), g.photoFolder, `${slot}.${ext}`));
        if (st.isFile()) { out[slot] = { ext, size: st.size, mtime: Math.floor(st.mtimeMs) }; break; }
      } catch { /* なし */ }
    }
  }
  return out;
}

/** 保存する。戻り: { ext }。不正な画像・大きすぎる画像は userSafe の例外 */
async function save(groupId, slot, buf, env = process.env) {
  const g = C.groupById(groupId);
  if (!g || !C.PHOTO_SLOTS.includes(slot)) throw Object.assign(new Error('写真の場所が正しくありません。'), { userSafe: true });
  if (!Buffer.isBuffer(buf) || !buf.length) throw Object.assign(new Error('ファイルを選んでください。'), { userSafe: true });
  if (buf.length > MAX_BYTES) throw Object.assign(new Error('写真は1枚5MBまでです。'), { userSafe: true });
  const ext = sniff(buf);
  if (!ext) throw Object.assign(new Error('JPEG か PNG の写真を選んでください。'), { userSafe: true });
  const out = buf;
  const dir = path.join(photoDir(env), g.photoFolder);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${slot}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, path.join(dir, `${slot}.${ext}`));
  for (const other of Object.keys(TYPES)) if (other !== ext) fs.rmSync(path.join(dir, `${slot}.${other}`), { force: true });
  return { ext };
}

/** その枠の写真を消す(そのグループ自身のものだけ) */
function remove(groupId, slot, env = process.env) {
  const g = C.groupById(groupId);
  if (!g || !C.PHOTO_SLOTS.includes(slot)) return;
  for (const ext of Object.keys(TYPES)) fs.rmSync(path.join(photoDir(env), g.photoFolder, `${slot}.${ext}`), { force: true });
}

module.exports = { MAX_BYTES, photoDir, sniff, find, urlsFor, ownStatus, save, remove };
