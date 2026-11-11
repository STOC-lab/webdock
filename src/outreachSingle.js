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
const PC = require('./pageCore');

// 送信ツール用ヘッダー行(3列目は空欄のまま。STOC営業管理の書き出しと同じ)
const SENDER_HEADER = ['送信先URL', '会社名', '', 'レポートURL', '業種', '評価・口コミ', 'STOCバッチコード', '電話番号', '住所'];
const CHECK_HEADER = ['store_id', 'stoc_store_id', '会社名', 'ドメイン', '業種区分', '指摘', '一文', '送信先URL', '電話番号', '住所', 'バッチコード'];
const CHECK_HEADER_PAGE = [...CHECK_HEADER, '専用ページURL'];
const REVIEW_HEADER = ['store_id', '店名', '住所', '電話番号', '一致したフリーダイヤル等', 'その番号を持つ営業管理の店数', '営業管理の店ID'];
const FORM_LIMIT_HINT = 500; // 送信先フォームの文字数上限の目安

const csvField = (v) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvLine = (vals) => vals.map(csvField).join(',') + '\r\n';
const len = (s) => [...s].length;

/**
 * 本文(タグは [company] [name] [param1] [param2] のまま)。差出人情報は outreach-config.json から。
 * withPage=true は御社専用ページ版(templates/outreach-b2b-single-url.txt。[param1] にページのURLが入る)
 */
function renderBody(templates, { withPage = false } = {}) {
  const tpl = withPage ? templates.b2bSingleUrl : templates.b2bSingle;
  if (!tpl) throw new Error(withPage ? 'templates/outreach-b2b-single-url.txt がありません' : 'templates/outreach-b2b-single.txt がありません');
  const cfg = templates.config || {};
  const vars = { ...cfg, 担当者姓: String(cfg.担当者名 || '').trim().split(/[\s　]+/)[0] || '' };
  return fillTemplate(tpl, vars).replace(/\n+$/, '');
}

/**
 * 専用ページ版の一文。ドメインは本文に出さなくなるので、一文の先頭に入れる。
 * 「確認したところ、…」→「御社サイト(example.co.jp)を確認したところ、…」(それ以外の書き出しなら「御社サイト(…)について、」を前に付ける)
 */
function pageSentence(sentence, domain) {
  const s = String(sentence || '');
  const d = String(domain || '');
  if (!d) return s;
  return s.startsWith('確認したところ、') ? `御社サイト(${d})を${s}` : `御社サイト(${d})について、${s}`;
}

/**
 * 診断結果の行(オブジェクト)から送信候補を選ぶ。
 * 行: { store_id, stoc_store_id, 店名, URL, 業種, 業種区分, 問い合わせURL, 画像認証, 営業お断り, 指摘種別, 送信推奨 }
 * 戻り: { candidates:[{rec,key,stocId}], excluded:{理由:件数} }
 * direct=true(倉庫から直接送る): 営業管理の店ID(stoc_store_id)は要らない。キーは倉庫の店ID(store_id)。candidates に shopId を持つ。
 */
function pickCandidates(rows, { direct = false } = {}) {
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
    const shopId = direct && /^\d+$/.test(String(r['store_id'] || '').trim()) ? Number(r['store_id']) : 0;
    if (direct) { if (!shopId) { bump('倉庫の店IDなし'); continue; } } else if (!stocId) { bump('営業管理に未登録'); continue; }
    if (seenUrl.has(formUrl)) { bump('送信先URL重複'); continue; }
    seenUrl.add(formUrl);
    candidates.push({ rec: r, key, stocId, formUrl, ...(direct ? { shopId } : {}) });
  }
  return { candidates, excluded };
}

/**
 * 候補 + STOC店舗 → 送信項目。STOC側で見つからない・失注/契約の店は除外。
 * direct=true: storeMap は倉庫の店(キーは倉庫の店ID)。失注・契約は診断の前(除外条件)で外してあるので、ここでは見ない。
 *   matchedByShop(倉庫の店ID文字列 → 一致した営業管理の店ID)があれば、項目の stocId に入れる(参考。履歴の matched_stoc_store_id になる)
 */
function buildItems(candidates, storeMap, templates, excluded, { withPage = false, direct = false, matchedByShop } = {}) {
  const f = templates.findingsB2b || {};
  const items = [];
  for (const c of candidates) {
    const store = storeMap.get(direct ? c.shopId : c.stocId);
    if (!store) { const why = direct ? '倉庫に店がない' : '営業管理に未登録'; excluded[why] = (excluded[why] || 0) + 1; continue; }
    if (!direct && (store.status === '失注' || store.status === '契約')) { excluded['営業管理で失注・契約'] = (excluded['営業管理で失注・契約'] || 0) + 1; continue; }
    let baseSentence = (f[FINDING_KEY[c.key] || c.key] || {})['一文'];
    if (baseSentence && baseSentence.includes('{ver}')) {
      // PHPの指摘は、表示されていた版(診断CSVの「PHP版」列)を一文に入れる。読めなければ送らない
      const v = require('./phpVersions').parsePhpVersion('PHP/' + String(c.rec['PHP版'] || '').trim());
      if (!v) { excluded['PHPの版が不明'] = (excluded['PHPの版が不明'] || 0) + 1; continue; }
      baseSentence = baseSentence.split('{ver}').join(v.text);
    }
    if (!baseSentence) throw new Error(`findings-b2b.json の ${FINDING_KEY[c.key] || c.key} に「一文」がありません`);
    const industry = c.rec['業種区分'] || classifyIndustry(c.rec['業種']);
    const domain = domainOfUrl(c.rec['URL']);
    const sentence = withPage ? pageSentence(baseSentence, domain) : baseSentence;
    items.push({
      ...c, ...(direct ? { stocId: (matchedByShop && matchedByShop.get(String(c.shopId))) || 0 } : {}), store, sentence, industry, audience: audienceOf(industry),
      company: store.name || c.rec['店名'] || '',
      domain,
      websiteUrl: store.website_url || c.rec['URL'] || '',
    });
  }
  return items;
}

/** 送信ツール用の1行(9列・位置固定)。col3=[name]=指摘の一文、col4=[param1]=ドメイン(専用ページ版はページのURL)、col6 は STOC と同じ書式 */
function senderRow(it, code) {
  return [it.formUrl, it.company, it.sentence, it.pageUrl || it.domain, it.audience, S.ratingInfo(it.store), code, S.contactPhone(it.store), it.store.address || ''];
}

/**
 * 本文の文字数の目安。[company] などを典型的な値に置き換えた長さ。
 * 戻り: { typical, longest }(最頻の一文の場合 / 最長の一文の場合)
 */
function bodyLengths(body, items, { withPage = false } = {}) {
  const p1 = withPage ? PC.pageUrl('AbCdEfGh12') : 'example-seisakusho.co.jp';
  const sub = (sentence, audience) => body.replace('[company]', '株式会社サンプル製作所').replace('[param1]', p1)
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

const DIRECT_NOTE = '営業管理には登録していません。送信結果の取り込みは今後の機能で対応します';

function summaryText({ batches, items, excluded, body, dryRun, now, scanned, preExcluded = {}, withPage = false, direct = false, reviewCount = 0 }) {
  const L = [];
  const sorted = Object.entries(excluded).sort((a, b) => b[1] - a[1]);
  L.push('【B2B送信 まとめ(単一本文)】', '');
  if (direct) {
    L.push(dryRun
      ? `*** 倉庫から直接(--dry-run) ***  倉庫の送信履歴にも専用ページにも何も書いていません。バッチコードは仮です。${DIRECT_NOTE}。`
      : `倉庫から直接送るバッチです。${DIRECT_NOTE}。倉庫の送信履歴(stoc_master.webdock_sends)には、結果の取り込みまで「送信前(pending)」として記録しました。`);
  } else {
    L.push(dryRun ? '*** STOC未登録(--dry-run-stoc) ***  バッチコードは仮です。このまま送信しても結果はSTOCへ戻りません。' : 'STOC営業管理にバッチを登録済みです(結果はバッチコードでSTOCへ戻ります)。');
  }
  if (direct) {
    L.push(dryRun
      ? '*** 御社専用ページ版です。--dry-run のためページは作っていません。CSVの4列目のURLは仮で、開いてもページはありません。***'
      : `御社専用ページ版: ${items.length}社分のページを作りました(stoc_master.webdock_pages。origin=warehouse)。CSVの4列目[param1]がページのURLです。閲覧・申込・配信停止は管理画面の「専用ページ」に出ます(営業管理の見込み客には届きません)。`);
  } else if (withPage) {
    L.push(dryRun
      ? '*** 御社専用ページ版(--with-page)です。--dry-run-stoc のためページは作っていません。CSVの4列目のURLは仮で、開いてもページはありません。***'
      : `御社専用ページ版(--with-page): ${items.length}社分のページを作りました(stoc_master.webdock_pages)。CSVの4列目[param1]がページのURLです。閲覧・申込は管理画面の「専用ページ」と、STOC営業管理の見込み客(/report-leads)に出ます。`);
  }
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
  if (direct) L.push('', `フリーダイヤル・ナビダイヤル(0120/0800/0570)だけで営業管理の店と一致した店(要確認・送っていません): ${reviewCount}社${reviewCount ? ' → 要確認_freedial.csv' : ''}`);
  const bl = bodyLengths(body, items, { withPage });
  L.push('', `本文の文字数(会社名・${withPage ? 'ページURL' : 'ドメイン'}・業種・指摘の一文を典型的な値に置き換えた場合): 最頻の一文 ${bl.typical}文字 / 最長の一文 ${bl.longest}文字`);
  if (bl.longest > FORM_LIMIT_HINT) L.push(`  注意: 最長の場合 ${FORM_LIMIT_HINT}文字を超えます。送信先フォームの上限(約${FORM_LIMIT_HINT}文字のものが多い)に注意してください。`);
  L.push('', '送信前の確認');
  if (withPage) {
    L.push('・本文は全社共通です(本文.txt。御社専用ページ版)。送信ツールの3列目[name]に「御社サイト(ドメイン)を確認したところ、…」の一文、[param1]に専用ページのURL、[param2]に閲覧者の文言が入ります。');
    L.push('・CSVは9列(送信先URL,会社名,指摘の一文,レポートURL=専用ページのURL,業種=閲覧者,評価・口コミ,STOCバッチコード,電話番号,住所)。4列目のURLと7列目のバッチコードは変えないでください。');
    if (direct) L.push(`・${DIRECT_NOTE}(バッチコード whd_… は倉庫の送信履歴だけにあります)。`);
    else L.push('・STOCの明細の report_url にも専用ページのURLを入れています。');
  } else {
    L.push('・本文は全社共通です(本文.txt)。送信ツールの3列目[name]に指摘の一文、[param1]にドメイン、[param2]に閲覧者の文言が入ります。');
    L.push('・CSVは9列(送信先URL,会社名,指摘の一文,レポートURL=ドメイン,業種=閲覧者,評価・口コミ,STOCバッチコード,電話番号,住所)。7列目のバッチコードは変えないでください。');
  }
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
 *
 * direct=true(倉庫から直接送る。営業管理には何も書かない):
 *   opts.wh = { fetchShops(倉庫の店ID[]) → Map(店ID → 店), createBatch(opts) → 倉庫の送信履歴へ } を使い、stoc は使わない。専用ページは必ず付ける(withPage を強制)。
 *   opts.matchedByShop = 照合で一致した営業管理の店(参考。履歴に残す)、opts.reviewRows = フリーダイヤルのみ一致の店(要確認_freedial.csv に出す。送らない)
 *   バッチコードは whd_…。登録に失敗したら作った専用ページを消す。
 */
async function buildSingleFiles(opts) {
  const { rows, outDir, templates, now = new Date(), stoc, dryRun = false, filter = {}, preExcluded = {}, pages, resultsByStore, env = process.env,
    direct = false, wh, matchedByShop, reviewRows = [] } = opts;
  const withPage = direct || !!opts.withPage;
  if (direct && !wh) throw new Error('倉庫から直接送るには倉庫の店と送信履歴の読み書き(wh)が必要です');
  if (withPage && !dryRun && !pages) throw new Error('専用ページ版(--with-page)にはページの作成先(pages)が必要です');
  fs.mkdirSync(outDir, { recursive: true });
  for (const n of fs.readdirSync(outDir)) {
    if (/^send_.+\.csv$/.test(n) || ['確認用.csv', '本文.txt', 'まとめ.txt', 'result.json', '要確認_freedial.csv'].includes(n)) fs.unlinkSync(path.join(outDir, n));
  }
  const body = renderBody(templates, { withPage });
  const { candidates, excluded } = pickCandidates(rows, { direct });
  const storeMap = candidates.length
    ? await (direct ? wh.fetchShops(candidates.map((c) => c.shopId)) : stoc.fetchStores(candidates.map((c) => c.stocId)))
    : new Map();
  const items = buildItems(candidates, storeMap, templates, excluded, { withPage, direct, matchedByShop });
  const files = [];
  const put = (name, text) => { fs.writeFileSync(path.join(outDir, name), text); files.push(name); };
  const batches = [];
  const memo = `WEBドック B2B診断 ${opts.memoDate || ''}`.trim();
  const parts = S.splitBatches(items, S.BATCH_MAX);
  for (let i = 0; i < parts.length; i++) {
    const code = dryRun ? (i === 0 ? 'DRYRUN' : `DRYRUN-${i + 1}`) : (direct ? require('./warehouseSends').newBatchCode(now) : S.newBatchCode(now));
    const file = `send_${code}.csv`;
    let tokens = [];
    if (withPage) {
      // 専用ページ: 試し(--dry-run-stoc)ではページを作らず仮のURL。本番はSTOCへ登録する前に作り、登録に失敗したら消す
      if (dryRun) tokens = parts[i].map(() => PC.newToken());
      else {
        tokens = await pages.create(parts[i].map((it) => ({
          shopId: it.rec['store_id'], stocStoreId: direct ? null : it.stocId, batchCode: code, domain: it.domain, company: it.company, findingKey: it.key,
          sentence: it.sentence, findings: resultsByStore ? resultsByStore.get(String(it.rec['store_id'])) : null, audience: it.audience,
          ...(direct ? { origin: 'warehouse' } : {}),
        })));
      }
      parts[i].forEach((it, k) => { it.pageToken = tokens[k]; it.pageUrl = PC.pageUrl(tokens[k], env); });
    }
    if (!dryRun) {
      try {
        if (direct) {
          // 倉庫の送信履歴だけに書く(営業管理には書かない)
          await wh.createBatch({
            code, fileName: file, outDir: path.basename(outDir), filter: { ...filter, batch_no: i + 1, batch_total: parts.length, with_page: true, direct: true },
            items: parts[i].map((it) => ({ shopId: it.shopId, key: it.key, sentence: it.sentence, pageToken: it.pageToken, formUrl: it.formUrl, matchedStocStoreId: it.stocId || null })),
          });
        } else {
          await stoc.register({
            code, fileName: file, memo, userId: opts.userId, filter: { ...filter, batch_no: i + 1, batch_total: parts.length, ...(withPage ? { with_page: true } : {}) },
            items: parts[i].map((it) => ({ stocId: it.stocId, store: it.store, formUrl: it.formUrl, key: it.key, sentence: it.sentence, websiteUrl: it.websiteUrl, reportUrl: it.pageUrl || '' })),
          });
        }
      } catch (e) {
        if (withPage && tokens.length) { try { await pages.remove(tokens); } catch (e2) { e.message += `\n(作成した専用ページの削除にも失敗しました: ${e2.message})`; } }
        const done = batches.map((b) => b.code);
        if (done.length) e.message += `\n(この前に登録済みのバッチ: ${done.join(', ')}。${direct ? '倉庫の送信履歴' : 'STOC営業管理'}に残っています)`;
        throw e;
      }
    }
    for (const it of parts[i]) it.batchCode = code;
    put(file, '﻿' + csvLine(SENDER_HEADER) + parts[i].map((it) => csvLine(senderRow(it, code))).join(''));
    batches.push({ code, count: parts[i].length, file });
  }
  put('確認用.csv', '﻿' + csvLine(withPage ? CHECK_HEADER_PAGE : CHECK_HEADER) + items.map((it) => csvLine([
    it.rec['store_id'], it.stocId || '', it.company, it.domain, it.industry, GROUP_LABEL[it.key], it.sentence, it.formUrl,
    S.contactPhone(it.store), it.store.address || '', it.batchCode, ...(withPage ? [it.pageUrl] : [])])).join(''));
  if (direct) {
    put('要確認_freedial.csv', '﻿' + csvLine(REVIEW_HEADER) + reviewRows.map((x) => csvLine([
      x.row.store_id, x.row.name, x.row.address, x.row.phone, (x.free || []).map((f) => f.number).join(' / '),
      (x.free || []).map((f) => f.stores).join(' / '), (x.freeIds || []).join(' / ')])).join(''));
  }
  put('本文.txt', body + '\n');
  put('まとめ.txt', summaryText({ batches, items, excluded, body, dryRun, now, scanned: rows.length, preExcluded, withPage, direct, reviewCount: reviewRows.length }));
  put('result.json', JSON.stringify({ dryRun, withPage, batches, count: items.length, excluded, preExcluded,
    ...(direct ? { direct: true, note: DIRECT_NOTE, reviewCount: reviewRows.length } : {}) }, null, 2) + '\n');
  return { batches, items, excluded, files, body };
}

module.exports = { SENDER_HEADER, CHECK_HEADER, CHECK_HEADER_PAGE, pageSentence, renderBody, pickCandidates, buildItems, senderRow, bodyLengths, summaryText, buildSingleFiles, csvLine };
