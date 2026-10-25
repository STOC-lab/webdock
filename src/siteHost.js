'use strict';
/**
 * 会社サイトURLから「サイトのホスト名」を取り出す(www. を除いた小文字のホスト名)。
 * 倉庫 stoc_master.shops.site_host 列(sql/warehouse_migrate_005.sql)の値と、batch-scan の除外判定で同じ関数を使う。
 * 戻り: ホスト名 / 取り出せない・255文字を超える場合は null
 */
function siteHostOf(url) {
  let s = String(url === undefined || url === null ? '' : url).trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  let h;
  try { h = new URL(s).hostname; } catch { return null; }
  h = h.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (!h || h.length > 255) return null;
  return h;
}

module.exports = { siteHostOf };
