'use strict';

/**
 * 倉庫 → 営業アプリ取り込み用CSV(Shift_JIS・カンマ区切り・11列)を作る
 *   node cli/warehouse-promote.js --out data/promote_20261024.csv --prefecture 東京都,神奈川県
 *        [--category 美容院,ネイル] [--has-website] [--include-closed] [--form-found] [--limit 5000] [--mark]
 *        [--rules 問い合わせ営業 | --no-rules] [--dedupe-phone | --no-dedupe-phone] [--report-only]
 * 除外ルール(rules/<名前>.json、cli/warehouse-rules.js で作成)は書き出し時にJSで適用する(倉庫には全件残る)。
 * --limit は ルール除外・電話番号重複除去のあとの件数。--report-only はCSVを書かず件数だけ表示。
 * 対象: stoc_store_id IS NULL(営業アプリに未登録)かつ promoted_at IS NULL(未出力)
 */

const fs = require('fs');
const path = require('path');
const wh = require('../src/warehouse');
const { compileRules, applyOverrides } = require('../src/rules');
const { makePool } = require('./warehouse-import');

const HEADERS = ['屋号', '業種', '郵便番号', '住所', '電話番号', '評価', '口コミ数', 'Googleマイビジネス登録有無', '登録URL', 'GMAP', '写真枚数'];

function parseArgs(argv) {
  const o = { out: null, prefecture: [], category: [], hasWebsite: false, excludeClosed: true, formFound: false, limit: 5000, mark: false, rules: undefined, dedupePhone: undefined, reportOnly: false };
  const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--prefecture') o.prefecture = list(argv[++i]);
    else if (a === '--category') o.category = list(argv[++i]);
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
  if (o.hasWebsite) where.push("website_url IS NOT NULL AND website_url <> ''");
  if (o.excludeClosed) where.push("(business_status IS NULL OR (business_status NOT LIKE '%閉業%' AND business_status NOT LIKE '%閉店%'))");
  if (o.formFound) where.push("form_status = 'url_found'");
  const sql = `SELECT id, name, category, category_main, postal, address_raw, phone, rating, review_count, gbp_registered, website_url, gmap_url, photo_count
FROM stoc_master.shops WHERE ${where.join(' AND ')}
ORDER BY review_count IS NULL, review_count DESC, id`;
  return { sql, params };
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
const PAGE = 5000;

/**
 * 条件に合う行をページ単位で読み、ルール除外→電話番号重複除去→limit の順で絞る。
 * 電話番号重複は「口コミ数が最大の1件」を残す(並びが口コミ降順なので、先に出た行が勝つ)。
 */
async function selectRows(pool, o, rules, log) {
  const { sql, params } = buildQuery(o);
  const check = rules ? compileRules(rules) : null;
  const dedupe = o.dedupePhone === undefined ? !!(rules && (rules.dedupeColumns || []).includes('電話番号')) : o.dedupePhone;
  const st = { scanned: 0, excluded: 0, byKeyword: new Map(), dupRemoved: 0, written: 0, dedupe, rules: rules ? rules.name : null };
  const seen = new Set();
  const out = [];
  for (let off = 0; out.length < o.limit; off += PAGE) {
    const [rows] = await pool.query(sql + ' LIMIT ? OFFSET ?', [...params, PAGE, off]);
    for (const r of rows) {
      st.scanned++;
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
  log(`ルールで除外: ${st.excluded}`);
  const top = [...st.byKeyword.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [k, n] of top) log(`  ${k} : ${n}`);
  log(`電話番号の重複で除外: ${st.dupRemoved}`);
  log(`書き出し対象: ${st.written}`);
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
    const { rows, stats } = await selectRows(pool, o, rules);
    printStats(stats);
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

module.exports = { parseArgs, buildQuery, loadRules, selectRows, rowToCsv, HEADERS };
