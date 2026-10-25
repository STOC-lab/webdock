-- サイトのホスト名(www.を除いた小文字)を倉庫に記録する列・索引を足す。何度実行しても安全。
-- 「チェーン・共通ドメイン」(同じホスト名を3店舗以上が使っている会社)を B2B 送信から外すために使う。
-- 適用: mysql < sql/warehouse_migrate_005.sql
-- そのあと既存行の値を入れる: node cli/warehouse-sitehost.js  (新しい取り込み warehouse-import は自動で入れる)
-- site_host: 値あり=ホスト名 / 空文字=URLからホスト名を取り出せなかった(処理済み) / NULL=未処理
SET @db = 'stoc_master';

-- site_host
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN site_host VARCHAR(255) NULL AFTER website_url', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'site_host');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- idx_site_host
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD KEY idx_site_host (site_host)', 'SELECT 1')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND INDEX_NAME = 'idx_site_host');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
