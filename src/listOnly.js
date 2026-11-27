'use strict';
/**
 * 「送信リストだけ作る(診断なし・倉庫から直接)」。無料掲載の案内など、文面を送信ツール側で決める送信用。
 * WEBドックの診断も専用ページも作らず、倉庫の店から送信用CSV(9列)だけを作り、送ったことは倉庫の送信履歴(webdock_sends / webdock_send_batches)に記録する。
 * 結果の取り込み(src/sendResults.js)・N日以内の再送の除外は、診断ありの「倉庫から直接」と同じ仕組みで効く。営業管理には何も書かない。
 */
const fs = require('fs');
const path = require('path');
const S = require('./stocBatch');
const WS = require('./warehouseSends');
const { SENDER_HEADER, senderRow, csvLine, reviewCsvText } = require('./outreachSingle');
const { domainOfUrl } = require('./outreachGroups');

const AUDIENCE = 'お客様'; // 送信ツールの [param2]
const NOTE = '診断なし・倉庫から直接。営業管理には登録していません。送信結果は毎時自動で倉庫に取り込まれます';

/**
 * 倉庫の行から送信候補を選ぶ。行: { store_id, formUrl, captcha('あり'|'なし'|''), noSales('あり'|'') ... }(cli/batch-scan.js の loadWarehouseRows と同じ形)
 * 戻り: { candidates:[{ shopId, formUrl, row }], excluded:{理由:件数} }
 */
function pickListCandidates(rows) {
  const excluded = {};
  const bump = (k) => { excluded[k] = (excluded[k] || 0) + 1; };
  const candidates = [];
  const seen = new Set();
  for (const r of rows) {
    const shopId = /^\d+$/.test(String(r.store_id === undefined || r.store_id === null ? '' : r.store_id).trim()) ? Number(r.store_id) : 0;
    if (!shopId) { bump('倉庫の店IDなし'); continue; }
    const formUrl = String(r.formUrl || '').trim();
    if (!formUrl) { bump('送信先URLなし'); continue; }
    if (String(r.captcha || '').trim() === 'あり') { bump('画像認証あり'); continue; }
    if (String(r.noSales || '').trim() === 'あり') { bump('営業お断りの記載あり'); continue; }
    const key = WS.normalizeFormUrl(formUrl);
    if (seen.has(key)) { bump('送信先URL重複'); continue; }
    seen.add(key);
    candidates.push({ shopId, formUrl, row: r });
  }
  return { candidates, excluded };
}

function summaryText({ batches, items, excluded, dryRun, now, preExcluded = {}, reviewCount = 0, loaded = 0, limit = 0, pickedCount = 0, cutCount = 0 }) {
  const L = [];
  L.push('【送信リストだけ作る(診断なし・倉庫から直接) まとめ】', '');
  L.push(dryRun
    ? `*** 試し(--dry-run) ***  倉庫の送信履歴に何も書いていません。バッチコードは仮です。${NOTE}。`
    : `${NOTE}。倉庫の送信履歴(stoc_master.webdock_sends)には、結果の取り込みまで「送信前(pending)」として記録しました。`);
  L.push('WEBドックの診断も御社専用ページも作っていません。本文は送信ツール側で決めた固定の文面です(このCSVの3列目は空欄)。', '');
  // 上限で区切った分は「送らない理由」ではなく、今回は選ばなかっただけ(記録もしていない)なので、送らない店には数えない
  L.push(`候補にした店: ${loaded}社 / 送信対象: ${items.length}社 / 送らない: ${loaded - items.length - cutCount}社`);
  if (limit > 0) {
    L.push(`上限件数: ${limit}社(画像認証・営業お断り・URL重複などを外したあとで数えています)`);
    L.push(`選んだ店: ${loaded}社 → 送れない店を外して ${pickedCount}社 → 上限 ${limit}社で区切って 送信対象 ${items.length}社` + (cutCount ? `(区切りで外れた ${cutCount}社は今回は送らず、送信履歴にも記録していません)` : ''));
  }
  L.push('');
  L.push('バッチ(送信ツールに読み込ませるCSV)');
  for (const b of batches) L.push(`  ${b.code} / ${b.count}社 / ${b.file}`);
  if (!batches.length) L.push('  (送信対象がありません)');
  const pre = Object.entries(preExcluded).filter(([, n]) => n > 0);
  L.push('', '倉庫から選ぶ段階で除外した店(送信済み・配信停止・除外ドメイン・チェーン・クレーム・営業管理の店との照合など)');
  for (const [r, n] of pre) L.push(`  ・${r}: ${n}社`);
  if (!pre.length) L.push('  (なし)');
  const ex = Object.entries(excluded).sort((a, b) => b[1] - a[1]);
  L.push('', '送らない理由(候補にした店のうち)');
  for (const [r, n] of ex) L.push(`  ・${r}: ${n}社`);
  if (!ex.length) L.push('  (なし)');
  L.push('', `フリーダイヤル・ナビダイヤル(0120/0800/0570)だけで営業管理の店と一致した店(要確認・送っていません): ${reviewCount}社${reviewCount ? ' → 要確認_freedial.csv' : ''}`);
  L.push('', '送信前の確認');
  L.push('・CSVは9列(送信先URL,会社名,空欄,ドメイン=[param1],お客様=[param2],評価・口コミ,バッチコード,電話番号,住所)。7列目のバッチコードは変えないでください。');
  L.push('・送信先URLが同じ店は1社だけにしています(送信ツールの重複排除と結果の戻しが送信先URLで行われるため)。');
  L.push(`作成: ${now.toISOString()}`);
  return L.join('\n') + '\n';
}

/**
 * 送信リスト一式を作る。
 * opts: { rows, outDir, now, dryRun, filter, preExcluded, matchedByShop, reviewRows, wh:{ fetchShops(ids) → Map, createBatch(opts) } }
 * - dryRun=true: createBatch を呼ばず、バッチコードは DRYRUN, DRYRUN-2 ...
 * 途中のバッチで登録が失敗したら、登録済みバッチのコードを含めて例外にする(登録済み分は倉庫の送信履歴に残る)。
 * 戻り: { batches:[{code,count,file}], items, excluded, files }
 */
async function buildListOnlyFiles(opts) {
  const { rows, outDir, now = new Date(), dryRun = false, filter = {}, preExcluded = {}, matchedByShop, reviewRows = [], wh } = opts;
  const limit = opts.limit > 0 ? opts.limit : 0; // 上限件数。送れない店を外したあとで数える(0なら上限なし)
  if (!wh) throw new Error('倉庫の店と送信履歴の読み書き(wh)が必要です');
  fs.mkdirSync(outDir, { recursive: true });
  for (const n of fs.readdirSync(outDir)) {
    if (/^send_.+\.csv$/.test(n) || ['まとめ.txt', 'result.json', '要確認_freedial.csv'].includes(n)) fs.unlinkSync(path.join(outDir, n));
  }
  const picked = pickListCandidates(rows);
  const { excluded } = picked;
  // 画像認証などで送れない店は送信履歴に残らず毎回上位に並ぶので、上限は送れない店を外したあと(順序は保つ)に適用する
  const candidates = limit > 0 ? picked.candidates.slice(0, limit) : picked.candidates;
  const pickedCount = picked.candidates.length;
  const cutCount = pickedCount - candidates.length;
  const storeMap = candidates.length ? await wh.fetchShops(candidates.map((c) => c.shopId)) : new Map();
  const items = [];
  for (const c of candidates) {
    const store = storeMap.get(c.shopId);
    if (!store) { excluded['倉庫に店がない'] = (excluded['倉庫に店がない'] || 0) + 1; continue; }
    items.push({
      shopId: c.shopId, formUrl: c.formUrl, store, company: store.name || c.row.name || '',
      domain: domainOfUrl(store.website_url || c.row.url), audience: AUDIENCE, sentence: '',
      stocId: (matchedByShop && matchedByShop.get(String(c.shopId))) || 0,
    });
  }
  const files = [];
  const put = (name, text) => { fs.writeFileSync(path.join(outDir, name), text); files.push(name); };
  const batches = [];
  const parts = S.splitBatches(items, S.BATCH_MAX);
  const usedCodes = new Set();
  for (let i = 0; i < parts.length; i++) {
    let code;
    if (dryRun) code = i === 0 ? 'DRYRUN' : `DRYRUN-${i + 1}`;
    else {
      // 同じ秒に複数バッチを作ってもコードが重ならないよう、重なったら1秒ずらす
      for (let k = 0; ; k++) {
        code = WS.newBatchCode(new Date(now.getTime() + k * 1000));
        if (!usedCodes.has(code)) break;
      }
      usedCodes.add(code);
    }
    const file = `send_${code}.csv`;
    if (!dryRun) {
      try {
        await wh.createBatch({
          code, fileName: file, outDir: path.basename(outDir), filter: { ...filter, batch_no: i + 1, batch_total: parts.length, with_page: false, direct: true, list_only: true },
          items: parts[i].map((it) => ({ shopId: it.shopId, key: null, sentence: null, pageToken: null, formUrl: it.formUrl, matchedStocStoreId: it.stocId || null })),
        });
      } catch (e) {
        const done = batches.map((b) => b.code);
        if (done.length) e.message += `\n(この前に登録済みのバッチ: ${done.join(', ')}。倉庫の送信履歴に残っています)`;
        throw e;
      }
    }
    put(file, '﻿' + csvLine(SENDER_HEADER) + parts[i].map((it) => csvLine(senderRow(it, code))).join(''));
    batches.push({ code, count: parts[i].length, file });
  }
  if (reviewRows.length) put('要確認_freedial.csv', reviewCsvText(reviewRows));
  put('まとめ.txt', summaryText({ batches, items, excluded, dryRun, now, preExcluded, reviewCount: reviewRows.length, loaded: rows.length, limit, pickedCount, cutCount }));
  put('result.json', JSON.stringify({ dryRun, withPage: false, direct: true, listOnly: true, note: NOTE, batches, count: items.length, limit, pickedCount, cutCount, excluded, preExcluded, reviewCount: reviewRows.length }, null, 2) + '\n');
  return { batches, items, excluded, files, pickedCount, cutCount };
}

module.exports = { buildListOnlyFiles, pickListCandidates, NOTE };
