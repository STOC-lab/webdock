-- 既に作成済みの stoc_master.shops に、開閉店情報・業種(長文/主業種)の列を足す。何度実行しても安全。
-- 適用: mysql < sql/warehouse_migrate_001.sql

SET @db = 'stoc_master';

-- business_status
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN business_status VARCHAR(50) NULL AFTER gbp_registered', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'business_status');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- category を長文に(カンマ/読点区切りの複数業種)
ALTER TABLE stoc_master.shops MODIFY category VARCHAR(500) NULL;

-- category_main
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN category_main VARCHAR(100) NULL AFTER category', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'category_main');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 既存行の主業種を補完(最初の「、」「,」「，」まで)
UPDATE stoc_master.shops
SET category_main = LEFT(TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(category, '、', 1), ',', 1), '，', 1)), 100)
WHERE category_main IS NULL AND category IS NOT NULL AND category <> '';

-- インデックス (prefecture, category_main)
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD INDEX idx_pref_catmain (prefecture, category_main)', 'SELECT 1')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND INDEX_NAME = 'idx_pref_catmain');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
