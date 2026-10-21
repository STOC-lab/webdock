'use strict';

/** Cloudflare Turnstile 検証。TURNSTILE_SECRET 未設定時は常に成功(開発用)。 */
async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) return true; // dev: 未設定ならスキップ
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.append('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const j = await r.json();
    return j.success === true;
  } catch {
    return false;
  }
}

module.exports = { verifyTurnstile };
