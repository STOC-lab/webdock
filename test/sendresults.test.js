'use strict';
/**
 * 送信結果CSVの取り込み(PR-4。src/sendResults.js・cli/import-send-results.js)のテスト。DB不要(偽の接続)。
 *   確かめること: BOM・引用符・改行のCSV / rows との結びつき(バッチ・トークン) / whd_ だけ(sender_ は無視) / 結果の対応 /
 *   success を後退させない / rows がないときの代替の照合 / 営業お断り → form_no_sales / --dry-run は書かない / 取り込み済みは飛ばす
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const SR = require('../src/sendResults');
const WS = require('../src/warehouseSends');
const CLI = require('../cli/import-send-results');

let pass = 0, fail = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('  x ' + msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
}
const ok = (c, msg) => eq(!!c, true, msg);

const MTIME = new Date('2026-11-16T12:00:00Z');
const B1 = 'whd_20261116_131928_d2ae';
const U = (n) => `https://shop${n}.example.jp/contact`;
const tok = 'AbC1234567';

/** 偽の接続: webdock_sends の行(sends)を持ち、SELECT に答え、UPDATE を記録する。 */
function fakePool({ sends = [], hasNoSalesCol = true, failKey = null } = {}) {
  const log = [];
  const q = async (sql, params) => {
    log.push({ sql, params });
    if (failKey && /form_url_key IN/.test(sql) && params[0].includes(failKey)) throw new Error('db down');
    if (/FROM stoc_master\.webdock_sends WHERE batch_code = \?/.test(sql)) {
      return [sends.filter((r) => r.batch_code === params[0] && params[1].includes(r.form_url_key))];
    }
    if (/FROM stoc_master\.webdock_sends WHERE form_url_key IN/.test(sql)) {
      const rows = sends.filter((r) => params[0].includes(r.form_url_key) && r.created_at <= params[1]);
      return [rows.sort((a, b) => b.created_at - a.created_at || b.id - a.id)];
    }
    if (/information_schema\.COLUMNS/.test(sql)) return [[{ n: hasNoSalesCol ? 1 : 0 }]];
    return [{ affectedRows: 1 }];
  };
  const conn = {
    beginTransaction: async () => log.push({ op: 'begin' }), commit: async () => log.push({ op: 'commit' }),
    rollback: async () => log.push({ op: 'rollback' }), release: () => log.push({ op: 'release' }), query: q,
  };
  return { log, query: q, getConnection: async () => conn };
}
const row = (id, shop, batch, url, status = 'pending', created = new Date('2026-11-16T04:00:00Z')) =>
  ({ id, shop_id: shop, batch_code: batch, form_url_key: WS.formUrlKey(url), send_status: status, send_result: null, created_at: created });
const writes = (log) => log.filter((l) => l.sql && /^(UPDATE|INSERT)/.test(l.sql));

(async () => {
  // ---- CSVの読み取り(BOM・引用符・埋め込み改行・カンマ) ----
  const resText = '﻿送信先URL,結果,トップページURL,問い合わせページURL,備考\r\n'
    + `${U(1)},成功,https://shop1.example.jp/,${U(1)},\r\n`
    + `${U(2)},失敗,,,"送信ボタンが見つかりません,\n再確認"\r\n`
    + `${U(3)},スキップ,,,除外ドメイン\r\n`
    + `${U(4)},不明な結果,,,x\r\n`;
  const parsed = SR.parseResultText(resText);
  eq(parsed.map((r) => r.result), ['success', 'failed', 'skipped'], '結果の対応(成功/失敗/スキップ。他は捨てる)');
  eq(parsed[1].note, '送信ボタンが見つかりません,\n再確認', '引用符・カンマ・改行を含む備考');
  eq(parsed[0].formUrl, U(1), 'BOMを除いた1列目');

  // ---- rows との結びつき ----
  const rowsText = `${U(1)},店1,"文面,あり\n2行目",https://webdock.stoc-plus.site/r/${tok},様,,${B1},0791-00-0000,姫路市\n`
    + `${U(2)},店2,文面,https://webdock.stoc-plus.site/r/Zz99999999?x=1,様,,sender_20261116_100000_ab12,,\n`
    + `${U(3)},店3,文面,,様,,,,\n`;
  const items = SR.parseSendResults(resText, rowsText);
  eq(items.map((i) => i.batchCode), [B1, 'sender_20261116_100000_ab12', null], 'バッチコードを rows から(位置に依らず)');
  eq(items.map((i) => i.pageToken), [tok, 'Zz99999999', null], 'ページのトークン');
  eq(items[0].key, WS.formUrlKey(U(1)), 'key は formUrlKey');
  eq(SR.parseSendResults(resText, null).map((i) => i.batchCode), [null, null, null], 'rows がなければコードなし');
  // WEBドック以外のURLのセルの /r/xxxxxxxxxx はトークンにしない
  const nt = SR.parseRowsText(`${U(1)},店,https://other.example.com/r/Qq12345678,https://webdock.stoc-plus.site/r/${tok},,\n${U(2)},店,https://other.example.com/r/Qq12345678,,\n`);
  eq([nt.get(WS.formUrlKey(U(1))).pageToken, nt.get(WS.formUrlKey(U(2))).pageToken], [tok, null], 'トークンは webdock のURLのセルだけ');
  // 同じキーが複数行 → 最初の空でない値
  const dup = SR.parseRowsText(`${U(1)},a,,,,,,,\n${U(1)},a,,,,,${B1},,\n`);
  eq(dup.get(WS.formUrlKey(U(1))).batchCode, B1, '同じキーは最初の空でない値');

  // ---- 適用: whd_ だけ・sender_ は無視・状態の対応 ----
  {
    const pool = fakePool({ sends: [row(1, 11, B1, U(1)), row(3, 13, B1, U(3))] });
    const st = await SR.applyResults(pool, items, { fileMtime: MTIME, fileName: 'job1.csv' });
    eq([st.rows, st.warehouseRows, st.matched, st.success, st.failed, st.skipped, st.unmatched], [3, 2, 2, 1, 0, 1, 0], 'sender_ は倉庫の分に数えない');
    const w = writes(pool.log);
    ok(w.some((l) => /SET send_status = \?, send_result = \?, sent_at = \? WHERE id IN/.test(l.sql) && l.params[0] === 'success' && l.params[1] === '成功' && l.params[2] === MTIME && l.params[3][0] === 1), '成功: send_result=成功・sent_at=ファイル時刻');
    ok(w.some((l) => /SET send_status = \?, send_result = \? WHERE id IN/.test(l.sql) && l.params[0] === 'skipped' && l.params[1] === '除外ドメイン'), 'スキップ: sent_at は触らない');
    ok(w.some((l) => /UPDATE stoc_master\.webdock_send_batches SET result_imported_at = NOW\(\), result_file = \?/.test(l.sql) && l.params[0] === 'job1.csv' && l.params[1][0] === B1), 'バッチに取り込み時刻・ファイル名');
    eq(pool.log.filter((l) => l.op).map((l) => l.op), ['begin', 'commit', 'release'], 'トランザクション');
    ok(!w.some((l) => l.params && l.params.flat(2).includes(12)), 'sender_ の行は触らない');
  }

  // ---- 成功は後退しない / failed↔skipped は後が勝つ / pending→failed ----
  {
    const mk = (n, res, note) => ({ formUrl: U(n), key: WS.formUrlKey(U(n)), result: res, note, batchCode: B1, pageToken: null });
    const pool = fakePool({ sends: [row(1, 11, B1, U(1), 'success'), row(2, 12, B1, U(2), 'failed'), row(3, 13, B1, U(3), 'pending'), row(4, 14, B1, U(4), 'failed'), row(5, 15, B1, U(5), 'skipped')] });
    const st = await SR.applyResults(pool, [mk(1, 'failed', 'x'), mk(2, 'success', ''), mk(3, 'failed', '確認ページを突破できませんでした'), mk(4, 'skipped', '除外ドメイン'), mk(5, 'success', '')], { fileMtime: MTIME, fileName: 'j.csv' });
    eq([st.matched, st.unchanged, st.success, st.failed, st.skipped], [5, 1, 2, 1, 1], 'success 維持(1件変更なし)・failed→success・pending→failed・failed→skipped・skipped→success');
    ok(!writes(pool.log).some((l) => l.params && Array.isArray(l.params[3]) && l.params[3].includes(1)), '成功の行は更新しない');
    // 同じ結果の再取り込みは変更なし
    const pool2 = fakePool({ sends: [{ ...row(4, 14, B1, U(4), 'skipped'), send_result: '除外ドメイン' }] });
    const st2 = await SR.applyResults(pool2, [mk(4, 'skipped', '除外ドメイン')], { fileMtime: MTIME, fileName: 'j.csv' });
    eq([st2.unchanged, st2.skipped], [1, 0], '同じ状態・同じ文言は変更なし');
    // 100文字に切る
    const pool3 = fakePool({ sends: [row(1, 11, B1, U(1))] });
    await SR.applyResults(pool3, [mk(1, 'failed', 'あ'.repeat(150))], { fileMtime: MTIME, fileName: 'j.csv' });
    ok(writes(pool3.log).some((l) => l.params && [...String(l.params[1])].length === 100), 'send_result は100文字まで');
  }

  // ---- 代替の照合(rows なし): pending・ファイル時刻以前・最新の1行 ----
  {
    const old = new Date('2026-11-14T00:00:00Z'), newer = new Date('2026-11-16T03:00:00Z'), later = new Date('2026-11-17T00:00:00Z');
    const pool = fakePool({ sends: [
      row(1, 11, 'whd_20261114_000000_aaaa', U(1), 'pending', old),
      row(2, 11, 'whd_20261116_030000_bbbb', U(1), 'pending', newer),
      row(3, 11, 'whd_20261117_000000_cccc', U(1), 'pending', later), // ファイルより後に作った分は対象外
      row(4, 12, 'whd_20261116_030000_bbbb', U(2), 'success', newer), // success は後退しない(変更なし)
    ] });
    const its = SR.parseSendResults(`送信先URL,結果,トップページURL,問い合わせページURL,備考\n${U(1)},成功,,,\n${U(2)},成功,,,\n${U(9)},失敗,,,x\n`, null);
    const st = await SR.applyResults(pool, its, { fileMtime: MTIME, fileName: 'noRows.csv' });
    eq([st.rows, st.warehouseRows, st.matched, st.success, st.unchanged, st.unmatched], [3, 2, 2, 1, 1, 0], '代替の照合は当たった行だけ倉庫の分(当たらない行は無視)');
    const upd = writes(pool.log).find((l) => /SET send_status = \?, send_result = \?, sent_at/.test(l.sql));
    eq(upd.params[3], [2], '最新のバッチの行だけ更新(古い行・success の行は触らない)');
  }

  // ---- 代替の照合: 再処理(最新の行がすでに success でも、古い pending には当てない) ----
  {
    const older = new Date('2026-11-14T00:00:00Z'), newer = new Date('2026-11-16T03:00:00Z');
    const pool = fakePool({ sends: [
      row(1, 11, 'whd_20261114_000000_aaaa', U(1), 'pending', older),
      row(2, 11, 'whd_20261116_030000_bbbb', U(1), 'success', newer),
    ] });
    const its = SR.parseSendResults(`送信先URL,結果,トップページURL,問い合わせページURL,備考\n${U(1)},成功,,,\n`, null);
    const st = await SR.applyResults(pool, its, { fileMtime: MTIME, fileName: 'again.csv' });
    eq([st.matched, st.success, st.unchanged], [1, 0, 1], '再処理は最新バッチ(success)に当たり変更なし');
    eq(writes(pool.log).filter((l) => /UPDATE stoc_master\.webdock_sends/.test(l.sql)).length, 0, '古い pending は更新しない');
  }

  // ---- 代替の照合: 同じバッチに同じフォームURLの店が複数 → 全部更新 ----
  {
    const t = new Date('2026-11-16T03:00:00Z');
    const pool = fakePool({ sends: [
      row(1, 11, 'whd_20261116_030000_bbbb', U(1), 'pending', t),
      row(2, 12, 'whd_20261116_030000_bbbb', U(1), 'pending', t),
    ] });
    const its = SR.parseSendResults(`送信先URL,結果,トップページURL,問い合わせページURL,備考\n${U(1)},成功,,,\n`, null);
    await SR.applyResults(pool, its, { fileMtime: MTIME, fileName: 'multi.csv' });
    const upd = writes(pool.log).find((l) => /SET send_status = \?, send_result = \?, sent_at/.test(l.sql));
    eq([...upd.params[3]].sort(), [1, 2], '同じバッチ・同じキーの全行を更新');
  }

  // ---- 備考にタブが入っていても更新できる ----
  {
    const pool = fakePool({ sends: [row(1, 11, B1, U(1))] });
    const it = { formUrl: U(1), key: WS.formUrlKey(U(1)), result: 'skipped', note: 'a\tb', batchCode: B1, pageToken: null };
    await SR.applyResults(pool, [it], { fileMtime: MTIME, fileName: 'tab.csv' });
    ok(writes(pool.log).some((l) => /SET send_status = \?, send_result = \? WHERE id IN/.test(l.sql) && l.params[0] === 'skipped' && l.params[1] === 'a\tb' && l.params[2][0] === 1), 'タブ入りの備考がそのまま send_result に入る');
  }

  // ---- whd_ のコードなのに送信履歴にない → unmatched ----
  {
    const pool = fakePool({ sends: [] });
    const st = await SR.applyResults(pool, [{ formUrl: U(1), key: WS.formUrlKey(U(1)), result: 'success', note: '', batchCode: B1, pageToken: null }], { fileMtime: MTIME, fileName: 'x.csv' });
    eq([st.warehouseRows, st.matched, st.unmatched], [1, 0, 1], '不一致の数え方');
  }

  // ---- 営業お断り → form_no_sales ----
  {
    const mk = (n, res, note) => ({ formUrl: U(n), key: WS.formUrlKey(U(n)), result: res, note, batchCode: B1, pageToken: null });
    const sends = [row(1, 11, B1, U(1)), row(2, 12, B1, U(2)), row(3, 13, B1, U(3), 'success')];
    const pool = fakePool({ sends });
    const st = await SR.applyResults(pool, [mk(1, 'failed', '営業目的のお問い合わせはお断りします'), mk(2, 'failed', '送信ボタンが見つかりません'), mk(3, 'failed', '営業お断り')], { fileMtime: MTIME, fileName: 'r.csv' });
    eq(st.refusal, 1, '営業お断りの失敗だけ数える(成功済みの店は対象外)');
    const nos = writes(pool.log).filter((l) => /UPDATE stoc_master\.shops SET form_no_sales = 1 WHERE id IN/.test(l.sql));
    eq(nos.map((l) => l.params[0]), [[11]], 'form_no_sales=1 は該当店だけ');
    const pool2 = fakePool({ sends: [row(1, 11, B1, U(1))], hasNoSalesCol: false });
    const st2 = await SR.applyResults(pool2, [mk(1, 'failed', '営業お断り')], { fileMtime: MTIME, fileName: 'r.csv' });
    ok(st2.refusal === 1 && !writes(pool2.log).some((l) => /shops SET/.test(l.sql)), '列がなければ shops は更新しない');
  }

  // ---- dry-run は何も書かない ----
  {
    const pool = fakePool({ sends: [row(1, 11, B1, U(1)), row(2, 12, B1, U(2))] });
    const mk = (n, res, note) => ({ formUrl: U(n), key: WS.formUrlKey(U(n)), result: res, note, batchCode: B1, pageToken: null });
    const st = await SR.applyResults(pool, [mk(1, 'success', ''), mk(2, 'failed', '営業お断り')], { fileMtime: MTIME, fileName: 'd.csv', dryRun: true });
    eq([st.matched, st.success, st.failed, st.refusal], [2, 1, 1, 1], 'dry-run でも件数は出る');
    eq(writes(pool.log).length, 0, 'dry-run は UPDATE/INSERT なし');
    ok(!pool.log.some((l) => l.op), 'dry-run はトランザクションも使わない');
  }

  // ---- 取り込み済みの記録 ----
  {
    const rec = [];
    const pool = { query: async (sql, params) => { rec.push({ sql, params }); return /SELECT id FROM/.test(sql) ? [[{ id: 1 }]] : [[]]; } };
    ok(await SR.isImported(pool, { name: 'a.csv', mtime: MTIME, size: 10 }), '記録があれば取り込み済み');
    eq(rec[0].params, ['a.csv', MTIME, 10], '名前+更新時刻+サイズで探す');
  }

  // ---- 取り込み済みの記録は同じトランザクションで(commit の直前) ----
  {
    const track = { name: 'a.csv', mtime: MTIME, size: 10 };
    const pool = fakePool({ sends: [row(1, 11, B1, U(1))] });
    const it = { formUrl: U(1), key: WS.formUrlKey(U(1)), result: 'success', note: '', batchCode: B1, pageToken: null };
    await SR.applyResults(pool, [it], { fileMtime: MTIME, fileName: 'a.csv', track });
    const seq = pool.log.map((l) => l.op || (/^INSERT IGNORE INTO stoc_master\.webdock_send_result_files/.test(l.sql) ? 'track' : null)).filter(Boolean);
    eq(seq, ['begin', 'track', 'commit', 'release'], '記録の INSERT は同じ接続で commit の前');
    const ins = pool.log.find((l) => l.sql && /INSERT IGNORE/.test(l.sql));
    eq([ins.params[0], ins.params[1], ins.params[2], ins.params[3], ins.params[5]], ['a.csv', MTIME, 10, 1, 1], '最終の件数で記録');
    // 0行のファイルも記録する
    const pool0 = fakePool();
    await SR.applyResults(pool0, [], { fileMtime: MTIME, fileName: 'z.csv', track });
    ok(pool0.log.some((l) => l.sql && /INSERT IGNORE INTO/.test(l.sql)), '0行のファイルも記録');
    // dry-run は記録しない
    const poolD = fakePool({ sends: [row(1, 11, B1, U(1))] });
    await SR.applyResults(poolD, [it], { fileMtime: MTIME, fileName: 'a.csv', track, dryRun: true });
    ok(!poolD.log.some((l) => l.sql && /INSERT/.test(l.sql)), 'dry-run は記録しない');
    // UPDATE が落ちたら rollback・commit なし・記録なし
    const poolE = fakePool({ sends: [row(1, 11, B1, U(1))] });
    const conn = await poolE.getConnection();
    const orig = conn.query;
    conn.query = async (sql, params) => { if (/^UPDATE stoc_master\.webdock_sends SET/.test(sql)) throw new Error('update failed'); return orig(sql, params); };
    poolE.getConnection = async () => conn;
    let err = null; try { await SR.applyResults(poolE, [it], { fileMtime: MTIME, fileName: 'a.csv', track }); } catch (x) { err = x; }
    ok(err && /update failed/.test(err.message), 'UPDATE のエラーはそのまま投げる');
    const ops = poolE.log.filter((l) => l.op).map((l) => l.op);
    ok(ops.includes('rollback') && !ops.includes('commit'), 'rollback して commit しない');
    ok(!poolE.log.some((l) => l.sql && /INSERT IGNORE/.test(l.sql)), 'エラー時は記録しない');
  }

  // ---- CLI: 引数・ファイル選び・取り込み済みの飛ばし・失敗時の終了コード ----
  {
    let e = null; try { CLI.parseArgs([]); } catch (x) { e = x; }
    ok(e && /--since/.test(e.message), '--since は必須');
    const a = CLI.parseArgs(['--since=2026-11-11', '--dry-run', '--limit=3', '--dir=/x']);
    eq([a.dryRun, a.limit, a.dir], [true, 3, '/x'], '引数');
    for (const bad of ['2026-02-31', '2026-13-01', '2026-00-10', '2026-04-31', '2025-02-29', '2026-11-00']) {
      let x = null; try { CLI.parseArgs(['--since=' + bad]); } catch (er) { x = er; }
      ok(x && /--since/.test(x.message), '実在しない日付は弾く: ' + bad);
    }
    eq(CLI.parseArgs(['--since=2028-02-29']).since, '2028-02-29', 'うるう日は通る');
    eq(CLI.stamp(new Date('2026-11-16T15:00:05Z')), '[2026-11-17 00:00:05]', 'ログの時刻は日本時間');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-test-'));
    try {
      fs.mkdirSync(path.join(dir, 'rows'));
      const write = (n, body, ageMin) => { const p = path.join(dir, n); fs.writeFileSync(p, body); const t = new Date(Date.now() - ageMin * 60000); fs.utimesSync(p, t, t); };
      const head = '﻿送信先URL,結果,トップページURL,問い合わせページURL,備考\n';
      write('new.csv', head + `${U(1)},成功,,,\n`, 120);
      fs.writeFileSync(path.join(dir, 'rows', 'new.csv'), `${U(1)},店,文面,,様,,${B1},,\n`);
      write('recent.csv', head + `${U(2)},成功,,,\n`, 1);          // 10分以内 → 読まない
      write('done.csv', head + `${U(3)},成功,,,\n`, 120);          // 取り込み済み
      write('stoc.csv', head + `${U(4)},成功,,,\n`, 130);          // 倉庫の分なし → 記録だけ
      write('bad.csv', head + `${U(5)},成功,,,\n`, 140);
      const files = CLI.listFiles(dir, Date.parse('2000-01-01T00:00:00+09:00'), Date.now());
      eq(files.map((f) => f.name), ['bad.csv', 'stoc.csv', 'done.csv', 'new.csv'], '10分以内は除く・更新が古い順');

      const lines = [];
      const sends = [row(1, 11, B1, U(1))];
      const base = fakePool({ sends, failKey: WS.formUrlKey(U(5)) });
      const pool = {
        ...base,
        query: async (sql, params) => {
          if (/SELECT 1 FROM stoc_master\.webdock_send_result_files/.test(sql)) return [[]];
          if (/SELECT id FROM stoc_master\.webdock_send_result_files/.test(sql)) return [params[0] === 'done.csv' ? [{ id: 9 }] : []];
          if (params && params[0] === 'bad.csv') throw new Error('x');
          return base.query(sql, params);
        },
      };
      // bad.csv だけ、代替の照合のSELECTで落とす(failKey)
      const code = await CLI.run(pool, { since: '2026-11-11', dir, dryRun: false, limit: 0 }, { out: (m) => lines.push(m) });
      eq(code, 1, 'ファイルの失敗があれば終了コード1');
      const recorded = base.log.filter((l) => l.sql && /INSERT IGNORE INTO stoc_master\.webdock_send_result_files/.test(l.sql)).map((l) => l.params[0]);
      eq(recorded.sort(), ['new.csv', 'stoc.csv'], '取り込み済み・失敗・10分以内は記録しない / 倉庫の分なしは記録する');
      ok(lines.some((l) => /bad\.csv: 失敗 db down/.test(l)) && lines.some((l) => /取り込み済みで飛ばした1件/.test(l)), 'ログ');

      // 表がない: 通常は中止(1)、dry-run は続ける
      const noTable = { query: async () => { throw Object.assign(new Error('no table'), { errno: 1146 }); } };
      eq(await CLI.run(noTable, { since: '2026-11-11', dir, dryRun: false, limit: 0 }, { out: () => {} }), 1, '記録の表がなければ中止');
      // 存在しないフォルダは0
      eq(await CLI.run(noTable, { since: '2026-11-11', dir: path.join(dir, 'nope'), dryRun: false, limit: 0 }, { out: () => {} }), 0, 'フォルダがなければ0で終了');

      // ロック
      const lock = path.join(dir, 'lock');
      ok(CLI.acquireLock(lock), 'ロックを取れる');
      ok(!CLI.acquireLock(lock), 'ロック中は取れない');
      ok(CLI.acquireLock(lock, Date.now() + 3 * 3600 * 1000), '2時間より古いロックは残骸として取り直す');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  console.log(`sendresults: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
