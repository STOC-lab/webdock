'use strict';

/**
 * 倉庫の管理画面用の小さな作業実行係。
 *  - 同時に動かせる作業は1つだけ(実行中に頼まれたら断る)
 *  - 作業は node の子プロセスで実行(シェルは使わず、引数は配列で渡す)
 *  - 画面に出す記録(ログ)は最新の500行だけ、作業の履歴は最新20件だけ(メモリ上。再起動で消える)
 */

const { spawn } = require('child_process');
const path = require('path');

const MAX_LOG_LINES = 500;
const MAX_JOBS = 20;
const MAX_LINE = 2000;

function createJobRunner(opts = {}) {
  const cwd = opts.cwd || path.join(__dirname, '..');
  const spawnFn = opts.spawn || spawn;
  const jobs = []; // 新しい順
  let seq = 0;
  let current = null;

  function snapshot(j, withLog) {
    const s = {
      id: j.id, title: j.title, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt,
      exitCode: j.exitCode, meta: j.meta, lineCount: j.lineCount,
    };
    if (withLog) s.log = j.log.slice();
    return s;
  }

  function pushLine(j, line) {
    const text = line.length > MAX_LINE ? line.slice(0, MAX_LINE) + '…' : line;
    j.log.push(text);
    j.lineCount++;
    if (j.log.length > MAX_LOG_LINES) j.log.splice(0, j.log.length - MAX_LOG_LINES);
  }

  // 出力を行に分ける(進捗表示の \r も改行として扱う)
  function lineCollector(j) {
    let rest = '';
    return {
      write(chunk) {
        rest += chunk.toString('utf8');
        const parts = rest.split(/\r\n|\n|\r/);
        rest = parts.pop();
        if (rest.length > MAX_LINE * 4) { pushLine(j, rest); rest = ''; }
        for (const p of parts) if (p !== '') pushLine(j, p);
      },
      flush() { if (rest) pushLine(j, rest); rest = ''; },
    };
  }

  /** 作業を始める。args は node に渡す引数の配列(最初はスクリプトのパス)。 */
  function start({ title, args, meta }) {
    if (current && current.status === 'running') {
      return { ok: false, runningId: current.id, message: `別の作業(#${current.id} ${current.title})が実行中です。終わってからやり直してください。` };
    }
    const j = {
      id: ++seq, title: String(title || '作業'), status: 'running', startedAt: Date.now(), endedAt: null,
      exitCode: null, meta: meta || {}, log: [], lineCount: 0,
    };
    current = j;
    jobs.unshift(j);
    if (jobs.length > MAX_JOBS) jobs.length = MAX_JOBS;
    pushLine(j, '$ node ' + args.join(' '));

    let finished = false;
    const done = (status, code) => {
      if (finished) return;
      finished = true;
      j.status = status;
      j.exitCode = code;
      j.endedAt = Date.now();
      if (current === j) current = null;
    };
    try {
      const child = spawnFn(process.execPath, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      const out = lineCollector(j);
      const err = lineCollector(j);
      child.stdout && child.stdout.on('data', (d) => out.write(d));
      child.stderr && child.stderr.on('data', (d) => err.write(d));
      child.on('error', (e) => { pushLine(j, '起動できませんでした: ' + e.message); done('failed', null); });
      child.on('close', (code, signal) => {
        out.flush(); err.flush();
        if (signal) pushLine(j, '強制終了されました(' + signal + ')');
        done(code === 0 ? 'success' : 'failed', code);
      });
    } catch (e) {
      pushLine(j, '起動できませんでした: ' + e.message);
      done('failed', null);
    }
    return { ok: true, id: j.id };
  }

  return {
    start,
    get: (id) => { const j = jobs.find((x) => x.id === Number(id)); return j ? snapshot(j, true) : null; },
    list: () => jobs.map((j) => snapshot(j, false)),
    running: () => (current && current.status === 'running' ? snapshot(current, false) : null),
  };
}

module.exports = { createJobRunner, MAX_LOG_LINES, MAX_JOBS };
