'use strict';
/**
 * B2B送信用の「単一本文」方式。全社同じ本文を使い、会社ごとの違い(指摘の一文・業種・ドメイン・会社名)は
 * 送信ツールの差し込みタグ [company] [name] [param1] [param2] で入れる。
 * 宛先CSVは STOC営業管理の「問い合わせ営業用CSV」と同じ9列。バッチはSTOC営業管理に登録する(src/stocBatch.js)ので、送信結果がSTOCへ戻る。
 */
const fs = require('fs');
const path = require('path');
const { fillTemplate } = require('./outreach');
const { audienceOf } = require('./outreach');
const { classifyIndustry } = require('./outreach');
const { domainOfUrl, groupKeyOfFinding, FINDING_KEY, GROUP_ORDER, GROUP_LABEL } = require('./outreachGroups');
const S = require('./stocBatch');

// 送信ツール用ヘッダー行(3列目は空欄のまま。STOC営業管理の書き出しと同じ)
const SENDER_HEADER = ['送信先URL', '会社名', '', 'レポートURL', '業種', '評価・口コミ', 'STOCバッチコード', '電話番号', '住所'];
const CHECK_HEADER = ['store_id', 'stoc_store_id', '会社名', 'ドメイン', '業種区分', '指摘', '一文', '送信先URL', '電話番号', '住所', 'バッチコード'];
const FORM_LIMIT_HINT = 500; // 送信先フォームの文字数上限の目安

const csvField = (v) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvLine = (vals) => vals.map(csvField).join(',') + '\r\n';
const len = (s) => [...s].length;

/** 本文(タグは [company] [name] [param1] [param2] のまま)。差出人情報は outreach-config.json から */
function renderBody(templates) {
  if (!templates.b2bSingle) throw new Error('templates/outreach-b2b-single.txt がありません');
  const cfg = templates.config || {};
  const vars = { ...cfg, 担当者姓: String(cfg.担当者名 || '').trim().split(/[\s　]+/)[0] || '' };
  return fillTemplate(templates.b2bSingle, vars).replace(/\n+$/, '');
}

/**
 * 診断結果の行(オブジェクト)から送信候補を選ぶ。
 * 行: { store_id, stoc_store_id, 店名, URL, 業種, 業種区分, 問い合わせURL, 画像認証, 営業お断り, 指摘種別, 送信推奨 }
 * 戻り: { candidates:[{rec,key,stocId}], excluded:{理由:件数} }
 */
function pickCandidates(rows) {
  const excluded = {};
  const bump = (k) => { excluded[k] = (excluded[k] || 0) + 1; };
  const candidates = [];
  const seenUrl = new Set();
  for (const r of rows) {
    const send = String(r['送信推奨'] || '');
    const key = groupKeyOfFinding(String(r['指摘種別'] || ''));
    if (send !== 'はい' || !key) {
      bump(send === 'はい' ? '指摘種別が不明' : send.startsWith('送らない:') ? send.slice('送らない:'.length) : (send === 'いいえ' ? '送信推奨なし' : (send || '不明')));
      continue;
    }
    const formUrl = String(r['問い合わせURL'] || '').trim();
    if (!formUrl) { bump('送信先URLなし'); continue; }
    if (String(r['画像認証'] || '').trim() === 'あり') { bump('画像認証あり'); continue; }
    if (String(r['営業お断り'] || '').trim() === 'あり') { bump('営業お断りの記載あり'); continue; }
    const stocId = /^\d+$/.test(String(r['stoc_store_id'] || '').trim()) ? Number(r['stoc_store_id']) : 0;
    if (!stocId) { bump('営業管理に未登録'); continue; }
    if (seenUrl.has(formUrl)) { bump('送信先URL重複'); continue; }
    seenUrl.add(formUrl);
    candidates.push({ rec: r, key, stocId, formUrl });
  }
  return { candidates, excluded };
}

/** 候補 + STOC店舗 → 送信項目。STOC側で見つからない・失注/契約の店は除外 */
function buildItems(candidates, storeMap, templates, excluded) {
  const f = templates.findingsB2b || {};
  const items = [];
  for (const c of candidates) {
    const store = storeMap.get(c.stocId);
    if (!store) { excluded['営業管理に未登録'] = (excluded['営業管理に未登録'] || 0) + 1; continue; }
    if (store.status === '失注' || store.status === '契約') { excluded['営業管理で失注・契約'] = (excluded['営業管理で失注・契約'] || 0) + 1; continue; }
    const sentence = (f[FINDING_KEY[c.key] || c.key] || {})['一文'];
    if (!sentence) throw new Error(`findings-b2b.json の ${FINDING_KEY[c.key] || c.key} に「一文」がありません`);
    const industry = c.rec['業種区分'] || classifyIndustry(c.rec['業種']);
    items.push({
      ...c, store, sentence, industry, audience: audienceOf(industry),
      company: store.name || c.rec['店名'] || '',
      domain: domainOfUrl(c.rec['URL']),
      websiteUrl: store.website_url || c.rec['URL'] || '',
    });
  }
  return items;
}

/** 送信ツール用の1行(9列・位置固定)。col3=[name]=指摘の一文、col6 は STOC と同じ書式 */
function senderRow(it, code) {
  return [it.formUrl, it.company, it.sentence, it.domain, it.audience, S.ratingInfo(it.store), code, S.contactPhone(it.store), it.store.address || ''];
}

/**
 * 本文の文字数の目安。[company] などを典型的な値に置き換えた長さ。
 * 戻り: { typical, longest }(最頻の一文の場合 / 最長の一文の場合)
 */
function bodyLengths(body, items) {
  const sub = (sentence, audience) => body.replace('[company]', '株式会社サンプル製作所').replace('[param1]', 'example-seisakusho.co.jp')
    .replace('[param2]', audience).replace('[name]', sentence);
  const cnt = new Map();
  for (const it of items) cnt.set(it.sentence, (cnt.get(it.sentence) || 0) + 1);
  const sentences = [...cnt.keys()];
  if (!sentences.length) return { typical: len(sub('', '取引先様・調達ご担当者様・求職者様')), longest: len(sub('', '取引先様・調達ご担当者様・求職者様')) };
  const aud = '取引先様・調達ご担当者様・求職者様'; // 最長の閲覧者文言
  const top = sentences.sort((a, b) => cnt.get(b) - cnt.get(a))[0];
  const longest = sentences.reduce((a, b) => (len(b) > len(a) ? b : a));
  return { typical: len(sub(top, aud)), longest: len(sub(longest, aud)) };
}

function summaryText({ batches, items, excluded, body, dryRun, now, scanned, preExcluded = {} }) {
  const L = [];
  const sorted = Object.entries(excluded).sort((a, b) => b[1] - a[1]);
  L.push('【B2B送信 まとめ(単一本文)】', '');
  L.push(dryRun ? '*** STOC未登録(--dry-run-stoc) ***  バッチコードは仮です。このまま送信しても結果はSTOCへ戻りません。' : 'STOC営業管理にバッチを登録済みです(結果はバッチコードでSTOCへ戻ります)。');
  L.push('', `診断した会社: ${scanned}社 / 送信対象: ${items.length}社 / 送らない: ${scanned - items.length}社`, '');
  L.push('バッチ(送信ツールに読み込ませるCSV)');
  for (const b of batches) L.push(`  ${b.code} / ${b.count}社 / ${b.file}`);
  if (!batches.length) L.push('  (送信対象がありません)');
  L.push('', '指摘ごとの件数(一文に入る内容)');
  for (const k of GROUP_ORDER) {
    const n = items.filter((i) => i.key === k).length;
    if (n) L.push(`  ${k}(${GROUP_LABEL[k]}): ${n}社`);
  }
  const pre = Object.entries(preExcluded).filter(([, n]) => n > 0);
  L.push('', '診断前に除外した会社(倉庫から選ぶ段階で外したので、診断していません。上の「診断した会社」には含みません)');
  for (const [r, n] of pre) L.push(`  ・${r}: ${n}社`);
  if (!pre.length) L.push('  (なし)');
  L.push('', '送らない理由(診断した会社のうち)');
  for (const [r, n] of sorted) L.push(`  ・${r}: ${n}社`);
  if (!sorted.length) L.push('  (なし)');
  const bl = bodyLengths(body, items);
  L.push('', `本文の文字数(会社名・ドメイン・業種・指摘の一文を典型的な値に置き換えた場合): 最頻の一文 ${bl.typical}文字 / 最長の一文 ${bl.longest}文字`);
  if (bl.longest > FORM_LIMIT_HINT) L.push(`  注意: 最長の場合 ${FORM_LIMIT_HINT}文字を超えます。送信先フォームの上限(約${FORM_LIMIT_HINT}文字のものが多い)に注意してください。`);
  L.push('', '送信前の確認');
  L.push('・本文は全社共通です(本文.txt)。送信ツールの3列目[name]に指摘の一文、[param1]にドメイン、[param2]に閲覧者の文言が入ります。');
  L.push('・CSVは9列(送信先URL,会社名,指摘の一文,レポートURL=ドメイン,業種=閲覧者,評価・口コミ,STOCバッチコード,電話番号,住所)。7列目のバッチコードは変えないでください。');
  L.push('・最初の100社は送る前に人が確認してください(確認用.csv で本文の差し込み結果を見られます)。');
  L.push('・送信先URLが同じ会社は1社だけにしています(送信ツールの重複排除と結果の戻しが送信先URLで行われるため)。');
  L.push(`作成: ${now.toISOString()}`);
  return L.join('\n') + '\n';
}

/**
 * 診断結果の行から送信ファイル一式を作る。
 * opts: { rows, outDir, templates, now, stoc:{ fetchStores(ids) → Map, register(batchOpts) → {code} }, dryRun, filter, memoDate }
 * - dryRun=true: register を呼ばず、バッチコードは DRYRUN, DRYRUN-2 ...
 * 戻り: { batches:[{code,count,file}], items, excluded, files }
 * 途中のバッチで登録が失敗したら、登録済みバッチのコードを含めて例外にする(登録済み分はSTOCに残る)。
 */
async function buildSingleFiles(opts) {
  const { rows, outDir, templates, now = new Date(), stoc, dryRun = false, filter = {}, preExcluded = {} } = opts;
  fs.mkdirSync(outDir, { recursive: true });
  for (const n of fs.readdirSync(outDir)) {
    if (/^send_.+\.csv$/.test(n) || ['確認用.csv', '本文.txt', 'まとめ.txt', 'result.json'].includes(n)) fs.unlinkSync(path.join(outDir, n));
  }
  const body = renderBody(templates);
  const { candidates, excluded } = pickCandidates(rows);
  const storeMap = candidates.length ? await stoc.fetchStores(candidates.map((c) => c.stocId)) : new Map();
  const items = buildItems(candidates, storeMap, templates, excluded);
  const files = [];
  const put = (name, text) => { fs.writeFileSync(path.join(outDir, name), text); files.push(name); };
  const batches = [];
  const memo = `WEBドック B2B診断 ${opts.memoDate || ''}`.trim();
  const parts = S.splitBatches(items, S.BATCH_MAX);
  for (let i = 0; i < parts.length; i++) {
    const code = dryRun ? (i === 0 ? 'DRYRUN' : `DRYRUN-${i + 1}`) : S.newBatchCode(now);
    const file = `send_${code}.csv`;
    if (!dryRun) {
      try {
        await stoc.register({
          code, fileName: file, memo, userId: opts.userId, filter: { ...filter, batch_no: i + 1, batch_total: parts.length },
          items: parts[i].map((it) => ({ stocId: it.stocId, store: it.store, formUrl: it.formUrl, key: it.key, sentence: it.sentence, websiteUrl: it.websiteUrl })),
        });
      } catch (e) {
        const done = batches.map((b) => b.code);
        if (done.length) e.message += `\n(この前に登録済みのバッチ: ${done.join(', ')}。STOC営業管理に残っています)`;
        throw e;
      }
    }
    for (const it of parts[i]) it.batchCode = code;
    put(file, '﻿' + csvLine(SENDER_HEADER) + parts[i].map((it) => csvLine(senderRow(it, code))).join(''));
    batches.push({ code, count: parts[i].length, file });
  }
  put('確認用.csv', '﻿' + csvLine(CHECK_HEADER) + items.map((it) => csvLine([
    it.rec['store_id'], it.stocId, it.company, it.domain, it.industry, GROUP_LABEL[it.key], it.sentence, it.formUrl,
    S.contactPhone(it.store), it.store.address || '', it.batchCode])).join(''));
  put('本文.txt', body + '\n');
  put('まとめ.txt', summaryText({ batches, items, excluded, body, dryRun, now, scanned: rows.length, preExcluded }));
  put('result.json', JSON.stringify({ dryRun, batches, count: items.length, excluded, preExcluded }, null, 2) + '\n');
  return { batches, items, excluded, files, body };
}

module.exports = { SENDER_HEADER, CHECK_HEADER, renderBody, pickCandidates, buildItems, senderRow, bodyLengths, summaryText, buildSingleFiles, csvLine };
