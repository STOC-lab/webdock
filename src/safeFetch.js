'use strict';

/**
 * 安全なHTTP取得処理。
 * 入力URLのトップページを「外から見るだけ」で取得する。
 * - 公開サーバーが社内ネットワークや内部サービスへアクセスさせられること(SSRF)を防ぐ
 * - 解決済みIPに接続を固定し、DNSの差し替え(リバインディング)を防ぐ
 * - 80/443のみ、リダイレクト最大5回、毎回再検査
 */

const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');

const USER_AGENT = 'WEBDock-Scanner/1.0 (+https://webdock.stoc-plus.site/about)';
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB
const TOTAL_TIMEOUT_MS = 15000;
const PROBE_TIMEOUT_MS = 8000; // http転送調査の全体タイムアウト

/** 接続を許可しないIP範囲か判定する(許可しないものは true) */
function isBlockedIp(ip) {
  if (net.isIP(ip) === 0) return true;

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) は中のIPv4で判定
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) ip = mapped[1];

  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p.some((n) => n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0) return true;                          // 0.0.0.0/8
    if (a === 10) return true;                         // プライベート
    if (a === 127) return true;                        // ループバック
    if (a === 169 && b === 254) return true;           // リンクローカル
    if (a === 172 && b >= 16 && b <= 31) return true;  // プライベート
    if (a === 192 && b === 168) return true;           // プライベート
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 192 && b === 0) return true;             // 192.0.0/24,192.0.2/24
    if (a === 198 && (b === 18 || b === 19)) return true; // ベンチマーク
    if (a === 198 && b === 51) return true;            // 198.51.100/24 TEST-NET-2
    if (a === 203 && b === 0) return true;             // 203.0.113/24 TEST-NET-3
    if (a >= 224) return true;                         // マルチキャスト/予約
    return false;
  }

  // IPv6
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;  // 未指定/ループバック
  if (lower.startsWith('fe80')) return true;           // リンクローカル
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ユニークローカル
  if (lower.startsWith('ff')) return true;             // マルチキャスト
  return false;
}

/** ホスト名を解決し、全解決IPが許可範囲なら最初のIPを返す。危険なら例外。 */
async function resolveSafely(hostname) {
  // IPアドレス直書きは拒否(診断対象はドメイン名のみ)
  if (net.isIP(hostname) !== 0) {
    const err = new Error('IPアドレスの直接指定はできません。ドメイン名を入力してください。');
    err.userSafe = true;
    throw err;
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch (e) {
    const err = new Error('ドメインが見つかりませんでした。URLをご確認ください。');
    err.userSafe = true;
    throw err;
  }
  if (!records.length) {
    const err = new Error('ドメインが見つかりませんでした。');
    err.userSafe = true;
    throw err;
  }
  for (const r of records) {
    if (isBlockedIp(r.address)) {
      const err = new Error('この宛先は診断できません。');
      err.userSafe = true;
      throw err;
    }
  }
  return records[0].address;
}

/** URLの形式・スキーム・ポートを検査して正規化。問題あれば例外。 */
function validateUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    const err = new Error('URLの形式が正しくありません。(例: https://example.co.jp)');
    err.userSafe = true;
    throw err;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    const err = new Error('http:// または https:// のURLを入力してください。');
    err.userSafe = true;
    throw err;
  }
  if (u.username || u.password) {
    const err = new Error('認証情報付きのURLは診断できません。');
    err.userSafe = true;
    throw err;
  }
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (port !== 80 && port !== 443) {
    const err = new Error('標準ポート(80/443)以外は診断できません。');
    err.userSafe = true;
    throw err;
  }
  return u;
}

/**
 * 1ホップ分の取得。解決済みIPへ接続を固定する。
 * 戻り値: { status, headers, body, finalUrl, tls }
 */
function fetchOneHop(u, pinnedIp, deadline) {
  return new Promise((resolve, reject) => {
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const port = u.port ? Number(u.port) : (isHttps ? 443 : 80);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(Object.assign(new Error('タイムアウトしました。'), { userSafe: true }));

    const options = {
      host: pinnedIp,            // 解決済みIPへ直接接続(リバインディング対策)
      port,
      method: 'GET',
      path: u.pathname + u.search,
      headers: {
        Host: u.host,            // 証明書・バーチャルホスト用に本来のホスト名
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.8',
        Connection: 'close',
      },
      timeout: Math.min(remaining, 10000),
      servername: u.hostname,    // SNI
      // 接続の使い回し・TLSセッション再開を無効化(再開時は証明書情報が空になるため)
      agent: false,
      // 証明書エラーも「診断結果」として知りたいので検証は無効化し、結果はauthorizedで判定
      rejectUnauthorized: false,
    };

    const req = lib.request(options, (res) => {
      let tls = null;
      if (isHttps && res.socket && res.socket.getPeerCertificate) {
        const cert = res.socket.getPeerCertificate(false);
        tls = {
          authorized: res.socket.authorized === true,
          authorizationError: res.socket.authorizationError || null,
          protocol: res.socket.getProtocol ? res.socket.getProtocol() : null,
          validTo: cert && cert.valid_to ? cert.valid_to : null,
          validFrom: cert && cert.valid_from ? cert.valid_from : null,
          subjectCN: cert && cert.subject ? cert.subject.CN : null,
        };
      }
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > MAX_BODY_BYTES) {
          res.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          location: res.headers.location || null,
          tls,
        });
      });
      res.on('error', (e) => reject(Object.assign(e, { userSafe: false })));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(Object.assign(new Error('サイトの応答がありませんでした。'), { userSafe: true }));
    });
    req.on('error', (e) => {
      reject(Object.assign(new Error('サイトへ接続できませんでした。'), { userSafe: true, cause: e }));
    });
    req.end();
  });
}

/** 同一ホスト、または先頭の www. の有無だけが違うホストか(大文字小文字は区別しない) */
function sameSiteHost(a, b) {
  const strip = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
  return strip(a) !== '' && strip(a) === strip(b);
}

/**
 * http:// で開いたときの挙動を調べる(https で診断を始めた場合の「自動転送」判定用)。
 * 既存と同じ防御(URL検査・名前解決検査・IP固定・毎ホップ再検査)を通す。例外は投げない。
 * 戻り値:
 *   { result: 'redirects_to_https', chain }   同一ホスト/www違いのhttpsへ転送
 *   { result: 'serves_http', status, chain }  転送されずhttpのまま 2xx/4xx/5xx を返した
 *   { result: 'redirects_elsewhere', chain }  別ホスト・別ドメインなどへ転送(判断不能)
 *   { result: 'unreachable', error }          接続拒否・タイムアウト・DNS失敗(80番ポートを閉じているのは問題ではない)
 * deps(テスト用に差し替え可): { fetchOneHop, resolve, timeoutMs }
 */
async function probeHttpRedirect(host, deps) {
  const d = deps || {};
  const hop = d.fetchOneHop || fetchOneHop;
  const resolve = d.resolve || resolveSafely;
  const deadline = Date.now() + (d.timeoutMs || PROBE_TIMEOUT_MS);
  const chain = [];
  try {
    let u = validateUrl('http://' + host + '/');
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      let res;
      try {
        const ip = await resolve(u.hostname);
        res = await hop(u, ip, deadline);
      } catch (e) {
        // 最初のホップで失敗 = 接続できない。転送を受けた後の失敗は「転送先が不明」
        if (!chain.length) return { result: 'unreachable', error: (e && e.message) || String(e) };
        return { result: 'redirects_elsewhere', chain };
      }
      chain.push({ url: u.toString(), status: res.status });
      if (res.status >= 300 && res.status < 400) {
        if (!res.location) return { result: 'redirects_elsewhere', chain };
        let next;
        try {
          next = new URL(res.location, u);
          next.hash = '';
          next = validateUrl(next.toString()); // 転送先も毎回検査
        } catch { return { result: 'redirects_elsewhere', chain }; }
        const same = sameSiteHost(host, next.hostname);
        if (next.protocol === 'https:') {
          chain.push({ url: next.toString(), status: null });
          return { result: same ? 'redirects_to_https' : 'redirects_elsewhere', chain };
        }
        if (!same) return { result: 'redirects_elsewhere', chain };
        u = next; // 同一サイト内のhttp→http転送は追い続ける
        continue;
      }
      return { result: 'serves_http', status: res.status, chain };
    }
    return { result: 'redirects_elsewhere', chain }; // 転送回数超過
  } catch (e) {
    return { result: 'unreachable', error: (e && e.message) || String(e) };
  }
}

/**
 * 診断開始URLがhttpsで、fetchHomepage が http→https 転送を観測していないときだけ、
 * 最終ホストに対して probeHttpRedirect を実行して page.httpProbe に入れる。page を返す。
 */
async function withHttpProbe(page, probe) {
  try {
    if (page && !page.httpToHttps && /^https:/i.test(page.finalUrl || '')) {
      page.httpProbe = await (probe || probeHttpRedirect)(new URL(page.finalUrl).hostname);
    }
  } catch { /* 調査は補助情報。失敗しても診断は続ける */ }
  return page;
}

/**
 * トップページを取得(リダイレクト追従。毎ホップで再検査)。
 * 戻り値: { finalUrl, status, headers, body, tls, redirectChain, httpToHttps }
 */
async function fetchHomepage(raw) {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let u = validateUrl(raw);
  const chain = [];
  let httpToHttps = false;
  let last = null;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const ip = await resolveSafely(u.hostname);
    const hop = await fetchOneHop(u, ip, deadline);
    chain.push({ url: u.toString(), status: hop.status });
    last = hop;

    if (hop.status >= 300 && hop.status < 400 && hop.location) {
      const next = new URL(hop.location, u);
      next.hash = '';
      // 同一ホスト、または先頭の www. の有無だけが違うホスト(example.co.jp ⇄ www.example.co.jp)への転送を「http→https転送」とみなす
      if (u.protocol === 'http:' && next.protocol === 'https:' && sameSiteHost(u.hostname, next.hostname)) {
        httpToHttps = true;
      }
      u = validateUrl(next.toString());
      continue;
    }
    break;
  }

  return {
    finalUrl: u.toString(),
    status: last.status,
    headers: last.headers,
    body: last.body,
    tls: last.tls,
    redirectChain: chain,
    httpToHttps,
  };
}

/**
 * 公開ファイルの先頭だけを安全に取得する(JSライブラリの版数コメントを読む用)。
 * 既存と同じURL検査・名前解決検査・IP固定を通す。リダイレクトは追わない。失敗時は ''。
 */
async function fetchHead(raw, maxBytes = 4096, timeoutMs = 5000) {
  let u, ip;
  try {
    u = validateUrl(raw);
    ip = await resolveSafely(u.hostname);
  } catch { return ''; }
  return new Promise((resolve) => {
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    let done = false;
    const finish = (s) => { if (!done) { done = true; resolve(s); } };
    const req = lib.request({
      host: ip, port: u.port ? Number(u.port) : (isHttps ? 443 : 80),
      method: 'GET', path: u.pathname + u.search,
      headers: { Host: u.host, 'User-Agent': USER_AGENT, Range: `bytes=0-${maxBytes - 1}`, Connection: 'close' },
      servername: u.hostname, rejectUnauthorized: false, agent: false, timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300) { res.destroy(); return finish(''); }
      const chunks = []; let total = 0;
      res.on('data', (c) => {
        chunks.push(c); total += c.length;
        if (total >= maxBytes) { res.destroy(); finish(Buffer.concat(chunks).toString('utf8', 0, maxBytes)); }
      });
      res.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
      res.on('error', () => finish(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => { req.destroy(); finish(''); });
    req.on('error', () => finish(''));
    req.end();
  });
}

module.exports = { fetchHomepage, probeHttpRedirect, withHttpProbe, sameSiteHost, fetchHead, resolveSafely, isBlockedIp, validateUrl, USER_AGENT };
