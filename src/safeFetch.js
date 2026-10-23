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
      if (u.protocol === 'http:' && next.protocol === 'https:' && next.hostname === u.hostname) {
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

module.exports = { fetchHomepage, resolveSafely, isBlockedIp, validateUrl, USER_AGENT };
