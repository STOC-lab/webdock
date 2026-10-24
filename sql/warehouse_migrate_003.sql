-- 会社の規模(従業員数・資本金・上場)を倉庫に記録する列・索引を足す。何度実行しても安全。
-- 適用: mysql < sql/warehouse_migrate_003.sql
-- 事前に warehouse_migrate_002.sql(form_note 列)が適用されている必要があります。
SET @db = 'stoc_master';

-- employees
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN employees INT NULL AFTER form_note', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'employees');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- capital_yen
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN capital_yen BIGINT NULL AFTER employees', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'capital_yen');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- listed
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN listed TINYINT(1) NULL AFTER capital_yen', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'listed');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- size_class
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN size_class ENUM(''small'',''large'',''unknown'') NULL AFTER listed', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'size_class');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- size_note
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN size_note VARCHAR(100) NULL AFTER size_class', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'size_note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- profile_url
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN profile_url VARCHAR(1000) NULL AFTER size_note', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'profile_url');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- size_checked_at
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN size_checked_at DATETIME NULL AFTER profile_url', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'size_checked_at');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- インデックス (prefecture, size_class)
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD INDEX idx_pref_size (prefecture, size_class)', 'SELECT 1')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND INDEX_NAME = 'idx_pref_size');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
