-- 倉庫でのフォーム探し(地域ごと)用の列・索引を足す。何度実行しても安全。
-- 適用: mysql < sql/warehouse_migrate_002.sql
SET @db = 'stoc_master';

-- form_status に 'needs_browser'(JSで作られたサイトなど、ブラウザでの確認が必要)を追加
ALTER TABLE stoc_master.shops MODIFY form_status ENUM('unknown','url_found','no_form','error','needs_browser') NOT NULL DEFAULT 'unknown';

-- form_note
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN form_note VARCHAR(100) NULL AFTER form_checked_at', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'form_note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- form_kind (onsite / external)
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN form_kind VARCHAR(20) NULL AFTER form_url', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'form_kind');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- form_captcha
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN form_captcha TINYINT(1) NULL AFTER form_kind', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'form_captcha');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- インデックス (prefecture, form_status)
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD INDEX idx_pref_form (prefecture, form_status)', 'SELECT 1')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND INDEX_NAME = 'idx_pref_form');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
