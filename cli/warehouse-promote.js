'use strict';

/**
 * 倉庫 → 営業アプリ取り込み用CSV(Shift_JIS・カンマ区切り・11列)を作る
 *   node cli/warehouse-promote.js --out data/promote_20261024.csv --prefecture 東京都,神奈川県
 *        [--category 美容院,ネイル] [--has-website] [--include-closed] [--form-found] [--limit 5000] [--mark]
 *        [--rules 問い合わせ営業 | --no-rules] [--dedupe-phone | --no-dedupe-phone] [--report-only]
 *        [--exclude-large | --small-only]   (会社規模: sql/warehouse_migrate_003.sql と find-forms --with-size/--size-only が必要)
 * --form-found のときは、フォームのページに「営業お断り」の記載があった店(form_no_sales=1)を外す(sql/warehouse_migrate_004.sql が必要。
 *   未適用なら警告を出して絞り込みをスキップする)。
 * --exclude-large は size_class='large'(従業員が多い会社)を外す(未調査・不明は残す)。--small-only は size_class='small' だけ。
 * 除外ルール(rules/<名前>.json、cli/warehouse-rules.js で作成)は書き出し時にJSで適用する(倉庫には全件残る)。
 * --limit は ルール除外・電話番号重複除去のあとの件数。--report-only はCSVを書かず件数だけ表示。
 * 電話番号の照合(既定ON。--no-phone-check で従来どおり cid だけ): 電話番号なしの除外のあと、STOC営業管理(merged_into が空の店)の
 *   電話4列(代表・携帯・フリーダイヤル・その他)と総当たりで照合する(数字だけで比較・6桁未満は照合しない)。
 *   固定・携帯で一致 → 登録済みとして外す。フリーダイヤル(0120/0800)だけで一致 → 残して「要確認」にし、番号と STOC の店数を付けた一覧を
 *   別ファイル(--review-out <file>。--out があれば <out>_review.csv)に書く。
 * 電話番号が空(NULL・空・ハイフン/空白だけ)の行は、常に除外する(固定条件。倉庫には残し、promoted_at も付けない)。
 * 対象: stoc_store_id IS NULL(営業アプリに未登録)かつ promoted_at IS NULL(未出力)
 */

const fs = require('fs');
const path = require('path');
const wh = require('../src/warehouse');
const { compileRules, applyOverrides } = require('../src/rules');
const { makePool } = require('./warehouse-import');

const HEADERS = ['屋号', '業種', '郵便番号', '住所', '電話番号', '評価', '口コミ数', 'Googleマイビジネス登録有無', '登録URL', 'GMAP', '写真枚数'];

function parseArgs(argv) {
  const o = { out: null, prefecture: [], category: [], mainCategory: [], hasWebsite: false, excludeClosed: true, formFound: false, limit: 5000, mark: false, rules: undefined, dedupePhone: undefined, reportOnly: false, excludeLarge: false, smallOnly: false, phoneCheck: true, reviewOut: null };
  const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--prefecture') o.prefecture = list(argv[++i]);
    else if (a === '--category') o.category = list(argv[++i]);
    else if (a === '--main-category') o.mainCategory = list(argv[++i]);
    else if (a === '--has-website') o.hasWebsite = true;
    else if (a === '--exclude-closed') o.excludeClosed = true;
    else if (a === '--include-closed') o.excludeClosed = false;
    else if (a === '--form-found') o.formFound = true;
    else if (a === '--limit') o.limit = Math.floor(Number(argv[++i]));
    else if (a === '--mark') o.mark = true;
    else if (a === '--rules') o.rules = argv[++i];
    else if (a === '--no-rules') o.rules = null;
    else if (a === '--dedupe-phone') o.dedupePhone = true;
    else if (a === '--no-dedupe-phone') o.dedupePhone = false;
    else if (a === '--report-only') o.reportOnly = true;
    else if (a === '--no-phone-check') o.phoneCheck = false;
    else if (a === '--review-out') o.reviewOut = argv[++i];
    else if (a === '--exclude-large') o.excludeLarge = true;
    else if (a === '--small-only') o.smallOnly = true;
    else throw new Error('不明なオプション: ' + a);
  }
  if (!o.out && !o.reportOnly) throw new Error('--out <出力CSV> を指定してください');
  if (!Number.isFinite(o.limit) || o.limit < 1) throw new Error('--limit の値が不正です');
  return o;
}

function buildQuery(o) {
  const where = ['stoc_store_id IS NULL', 'promoted_at IS NULL'];
  const params = [];
  if (o.prefecture.length) { where.push('prefecture IN (?)'); params.push(o.prefecture); }
  if (o.category.length) {
    where.push('(' + o.category.map(() => 'category LIKE ?').join(' OR ') + ')');
    for (const c of o.category) params.push('%' + c.replace(/[\\%_]/g, '\\$&') + '%');
  }
  if (o.mainCategory.length) {
    // 主業種(category_main)だけで絞る(工場・建設向け。副業種で飲食店などが混ざらない)
    where.push('(' + o.mainCategory.map(() => 'category_main LIKE ?').join(' OR ') + ')');
    for (const c of o.mainCategory) params.push('%' + c.replace(/[\\%_]/g, '\\$&') + '%');
  }
  if (o.hasWebsite) where.push("website_url IS NOT NULL AND website_url <> ''");
  if (o.excludeClosed) where.push("(business_status IS NULL OR (business_status NOT LIKE '%閉業%' AND business_status NOT LIKE '%閉店%'))");
  if (o.formFound) where.push("form_status = 'url_found'");
  if (o.smallOnly) where.push("size_class = 'small'");
  else if (o.excludeLarge) where.push("(size_class IS NULL OR size_class <> 'large')");
  if (o.noSalesFilter) where.push('(form_no_sales IS NULL OR form_no_sales = 0)');
  const sql = `SELECT id, form_status, name, category, category_main, postal, address_raw, phone, rating, review_count, gbp_registered, website_url, gmap_url, photo_count
FROM stoc_master.shops WHERE ${where.join(' AND ')}
ORDER BY review_count IS NULL, review_count DESC, id`;
  return { sql, params };
}

/** 会社規模の絞り込み(--exclude-large / --small-only)で外れる件数を数えるSQL。ルール除外・limit の前の件数 */
function buildSizeExcludedCountQuery(o) {
  const { sql, params } = buildQuery({ ...o, excludeLarge: false, smallOnly: false });
  const cond = o.smallOnly ? "(size_class IS NULL OR size_class <> 'small')" : "size_class = 'large'";
  const count = sql.replace(/^SELECT[\s\S]*?\nFROM/, 'SELECT COUNT(*) AS n\nFROM').replace(/\nORDER BY[\s\S]*$/, '') + ' AND ' + cond;
  return { sql: count, params };
}

/** 「営業お断り」で外れる件数を数えるSQL(ルール除外・limit の前の件数) */
function buildNoSalesExcludedCountQuery(o) {
  const { sql, params } = buildQuery({ ...o, noSalesFilter: false });
  const count = sql.replace(/^SELECT[\s\S]*?\nFROM/, 'SELECT COUNT(*) AS n\nFROM').replace(/\nORDER BY[\s\S]*$/, '') + ' AND form_no_sales = 1';
  return { sql: count, params };
}

/** ルールJSONを読む。name===undefined なら既定(問い合わせ営業があれば使う)、null なら無効。 */
function loadRules(name) {
  const dir = path.join(__dirname, '..', 'rules');
  if (name === null) return null;
  const n = name === undefined ? '問い合わせ営業' : name;
  const file = path.join(dir, n + '.json');
  if (!fs.existsSync(file)) {
    if (name === undefined) return null;
    throw new Error('ルールファイルが見つかりません: ' + file);
  }
  let json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ovFile = path.join(dir, n + '.overrides.json');
  if (fs.existsSync(ovFile)) json = applyOverrides(json, JSON.parse(fs.readFileSync(ovFile, 'utf8')));
  json.name = n;
  return json;
}

const normPhone = (p) => String(p || '').replace(/\D/g, '');

/* ---------- STOC営業管理との電話番号の総当たり照合 ---------- */
const PHONE_MIN_DIGITS = 6;
/** ハイフン・空白・全角を除いた数字だけ(全角数字は半角にそろえる) */
const phoneDigits = (v) => String(v === null || v === undefined ? '' : v).normalize('NFKC').replace(/\D/g, '');
/** フリーダイヤル(0120/0800)か。チェーン・本部の共通番号のことがあるので別扱いにする */
const isFreeDial = (d) => /^(0120|0800)/.test(d);
/** 倉庫の phone 欄は「,」「/」「、」で複数入っていることがある */
const phoneNumbersOf = (v) => String(v === null || v === undefined ? '' : v).split(/[,/、]/).map(phoneDigits).filter((d) => d.length >= PHONE_MIN_DIGITS);

/**
 * STOC営業管理の電話の索引(正規化した数字 → { n: その番号を持つ店数, last })。
 * 代表・携帯・フリーダイヤル・その他の4列を区別せず1つの索引に入れる(列が違っても同じ番号なら一致)。
 * rows は id 昇順で、同じ店が続けて来る前提(同じ店が同じ番号を2列に持っていても1店と数える)。
 */
function buildPhoneIndex(rows) {
  const idx = new Map();
  for (const s of rows) {
    for (const c of ['phone', 'phone_mobile', 'phone_free', 'phone_other']) {
      const d = phoneDigits(s[c]);
      if (d.length < PHONE_MIN_DIGITS) continue;
      const e = idx.get(d);
      if (!e) idx.set(d, { n: 1, last: s.id });
      else if (e.last !== s.id) { e.n++; e.last = s.id; }
    }
  }
  return idx;
}

/**
 * 倉庫の電話1件を索引と照合する。戻り: { kind: 'registered' | 'review' | null, free?: [{ number, stores }] }
 *   registered: 固定・携帯(0120/0800以外)の番号がSTOCのどれかの列と一致 → 登録済みとみなす
 *   review: 一致したのがフリーダイヤルだけ → 登録済みとみなさない(要確認)。free に番号と STOC の店数を付ける
 */
function matchPhone(index, phone) {
  const free = [];
  for (const d of phoneNumbersOf(phone)) {
    const e = index.get(d);
    if (!e) continue;
    if (!isFreeDial(d)) return { kind: 'registered' };
    free.push({ number: d, stores: e.n });
  }
  return free.length ? { kind: 'review', free } : { kind: null };
}

/** 営業管理(merged_into が空の店だけ)の電話索引を作る。id 範囲で読む */
async function loadStocPhoneIndex(pool, db = require('../src/stocBatch').stocDbName()) {
  const PG = 100000;
  const idx = new Map();
  let last = 0;
  for (;;) {
    const [rows] = await pool.query(
      `SELECT id, phone, phone_mobile, phone_free, phone_other FROM ${db}.stores WHERE merged_into IS NULL AND id > ? ORDER BY id LIMIT ?`, [last, PG]);
    if (!rows || !rows.length) break;
    for (const [k, v] of buildPhoneIndex(rows)) {
      const e = idx.get(k);
      if (!e) idx.set(k, v);
      else { e.n += v.n; e.last = v.last; } // ページ境目で同じ店が分かれることはない(id で区切る)ので単純に足す
    }
    last = rows[rows.length - 1].id;
    if (rows.length < PG) break;
  }
  return idx;
}
/** 電話なし(NULL・空・ハイフン/空白だけ)。出力から必ず外す固定条件(--rules/--no-rules に関係しない) */
const isNoPhone = (p) => p === null || p === undefined || /^[\s\u3000\-\u2010-\u2015\u2212\u30fc\uff0d\uff70]*$/.test(String(p));
const PAGE = 5000;

/**
 * 条件に合う行をページ単位で読み、ルール除外→電話番号重複除去→limit の順で絞る。
 * 電話番号重複は「口コミ数が最大の1件」を残す(並びが口コミ降順なので、先に出た行が勝つ)。
 */
async function selectRows(pool, o, rules, log) {
  const { sql, params } = buildQuery(o);
  const check = rules ? compileRules(rules) : null;
  const dedupe = o.dedupePhone === undefined ? !!(rules && (rules.dedupeColumns || []).includes('電話番号')) : o.dedupePhone;
  const st = { withForm: 0, scanned: 0, excluded: 0, noPhone: 0, byKeyword: new Map(), dupRemoved: 0, written: 0, dedupe, rules: rules ? rules.name : null, sizeExcluded: null, noSalesExcluded: null, phoneCheck: !!o.phoneCheck, phoneRegistered: 0, phoneReview: 0, reviewRows: [] };
  const phoneIdx = o.phoneCheck ? await loadStocPhoneIndex(pool) : null;
  if (o.excludeLarge || o.smallOnly) {
    try {
      const c = buildSizeExcludedCountQuery(o);
      const [r] = await pool.query(c.sql, c.params);
      st.sizeExcluded = Number(r[0].n);
    } catch { st.sizeExcluded = null; }
  }
  if (o.noSalesFilter) {
    try {
      const c = buildNoSalesExcludedCountQuery(o);
      const [r] = await pool.query(c.sql, c.params);
      st.noSalesExcluded = Number(r[0].n);
    } catch { st.noSalesExcluded = null; }
  }
  const seen = new Set();
  const out = [];
  for (let off = 0; out.length < o.limit; off += PAGE) {
    const [rows] = await pool.query(sql + ' LIMIT ? OFFSET ?', [...params, PAGE, off]);
    for (const r of rows) {
      st.scanned++;
      if (isNoPhone(r.phone)) { st.noPhone++; continue; }
      let review = null;
      if (phoneIdx) {
        const m = matchPhone(phoneIdx, r.phone);
        if (m.kind === 'registered') { st.phoneRegistered++; continue; }
        if (m.kind === 'review') review = m.free;
      }
      if (check) {
        const hit = check(r);
        if (hit) {
          st.excluded++;
          const k = hit.column + ':' + hit.keyword;
          st.byKeyword.set(k, (st.byKeyword.get(k) || 0) + 1);
          continue;
        }
      }
      if (dedupe) {
        const p = normPhone(r.phone);
        if (p) {
          if (seen.has(p)) { st.dupRemoved++; continue; }
          seen.add(p);
        }
      }
      if (r.form_status === 'url_found') st.withForm++;
      if (review) { st.phoneReview++; st.reviewRows.push({ row: r, free: review }); }
      out.push(r);
      if (out.length >= o.limit) break;
    }
    if (rows.length < PAGE) break;
  }
  st.written = out.length;
  return { rows: out, stats: st };
}

function printStats(st, log = console.error) {
  log(`ルール: ${st.rules || '(なし)'} / 電話番号重複除去: ${st.dedupe ? 'ON' : 'OFF'}`);
  log(`走査した行: ${st.scanned}`);
  if (st.sizeExcluded !== null && st.sizeExcluded !== undefined) log(`会社規模で除外: ${st.sizeExcluded}(ルール除外の前の件数)`);
  if (st.noSalesExcluded !== null && st.noSalesExcluded !== undefined) log(`営業お断りで除外: ${st.noSalesExcluded}(ルール除外の前の件数)`);
  log(`電話番号なしで除外: ${st.noPhone}件`);
  if (st.phoneCheck) {
    log(`電話番号の照合でSTOC登録済みとして除外: ${st.phoneRegistered}件(固定・携帯がSTOCの代表・携帯・フリーダイヤル・その他のどれかと一致)`);
  } else log('電話番号の照合: OFF(--no-phone-check。cid だけで登録済みを判定)');
  log(`ルールで除外: ${st.excluded}`);
  const top = [...st.byKeyword.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [k, n] of top) log(`  ${k} : ${n}`);
  log(`電話番号の重複で除外: ${st.dupRemoved}`);
  log(`書き出し対象: ${st.written}(うちフォームあり ${st.withForm})`);
  if (st.phoneCheck) log(`要確認(フリーダイヤルのみ一致。書き出しには残す): ${st.phoneReview}件`);
}

/** 要確認(フリーダイヤルのみ一致)の一覧CSV(UTF-8・BOM付き)。番号と、その番号が STOC の何店に入っているかを付ける */
function reviewCsv(reviewRows) {
  let t = '﻿' + csvLine(['倉庫ID', '屋号', '住所', '電話番号', '一致したフリーダイヤル', 'STOCでその番号を持つ店数', 'ウェブサイト']);
  for (const { row: r, free } of reviewRows) {
    t += csvLine([r.id, r.name, r.address_raw, r.phone, free.map((f) => f.number).join(' '), Math.max(...free.map((f) => f.stores)), r.website_url]);
  }
  return t;
}

function csvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const csvLine = (vals) => vals.map(csvField).join(',') + '\r\n';

function rowToCsv(r) {
  // 業種は営業管理の取り込み形式に合わせ「1つ目だけ」(リスツールでの整形と同じ)
  const { categoryMain } = require('../src/warehouse');
  return csvLine([r.name, r.category_main || categoryMain(r.category || '') || '', r.postal, r.address_raw, r.phone,
    r.rating === null ? '' : Number(r.rating).toFixed(1), r.review_count, r.gbp_registered, r.website_url, r.gmap_url, r.photo_count]);
}

async function main() {
  try { require('dotenv').config(); } catch { /* なくても動く */ }
  const o = parseArgs(process.argv.slice(2));
  const pool = makePool();
  try {
    const rules = loadRules(o.rules);
    if (o.formFound) {
      if (await wh.columnExists(pool, 'shops', 'form_no_sales')) o.noSalesFilter = true;
      else console.error('警告: shops.form_no_sales 列がないため「営業お断り」の除外をスキップします。先に sql/warehouse_migrate_004.sql を適用してください。');
    }
    const { rows, stats } = await selectRows(pool, o, rules);
    printStats(stats);
    const reviewFile = o.reviewOut || (o.out ? o.out.replace(/(\.csv)?$/i, '_review.csv') : null);
    if (stats.phoneCheck && stats.reviewRows.length && reviewFile) {
      fs.mkdirSync(path.dirname(path.resolve(reviewFile)), { recursive: true });
      fs.writeFileSync(reviewFile, reviewCsv(stats.reviewRows));
      console.error(`要確認の一覧を書きました -> ${reviewFile}`);
    }
    if (o.reportOnly) { console.log(`[report-only] ${rows.length}件が書き出し対象です(ファイルは作成していません)`); return; }
    let text = csvLine(HEADERS);
    for (const r of rows) text += rowToCsv(r);
    fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
    fs.writeFileSync(o.out, wh.encodeShiftJis(text));
    if (o.mark && rows.length) {
      const ids = rows.map((r) => r.id);
      for (let i = 0; i < ids.length; i += 1000) {
        await pool.query('UPDATE stoc_master.shops SET promoted_at = NOW() WHERE id IN (?)', [ids.slice(i, i + 1000)]);
      }
    }
    console.log(`${rows.length}件を書き出しました -> ${o.out}${o.mark ? '(出力済みとして記録)' : ''}`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('エラー: ' + e.message); process.exit(1); });
}

module.exports = { parseArgs, buildQuery, buildSizeExcludedCountQuery, buildNoSalesExcludedCountQuery, printStats, loadRules, selectRows, rowToCsv, isNoPhone, HEADERS, phoneDigits, isFreeDial, buildPhoneIndex, matchPhone, loadStocPhoneIndex, reviewCsv };
