-- 「WEB入れ替え候補」用: 点数・ブログ更新の列と、口コミ・写真数の履歴表を足す。何度実行しても安全。
-- 適用: mysql < sql/warehouse_migrate_008.sql
-- そのあと一度だけ: node cli/metrics-baseline.js  (今ある口コミ・写真数を履歴の最初の1行として記録)
-- 列がなくても既存の機能は動く(新機能の画面だけ案内を出す)。
SET @db = 'stoc_master';

-- wd_score
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN wd_score SMALLINT NULL COMMENT ''WEBドック点数(0-100)''', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'wd_score');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- wd_grade
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN wd_grade CHAR(1) NULL COMMENT ''WEBドック判定 A-E''', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'wd_grade');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- wd_scanned_at
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN wd_scanned_at DATETIME NULL COMMENT ''点数を測った日時(エラーでも入る)''', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'wd_scanned_at');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- blog_latest_at
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN blog_latest_at DATETIME NULL COMMENT ''ブログ・お知らせの最新投稿日''', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'blog_latest_at');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- blog_posts_90d
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN blog_posts_90d SMALLINT NULL COMMENT ''直近90日の投稿数''', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'blog_posts_90d');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- blog_source
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN blog_source VARCHAR(20) NULL COMMENT ''取得元 rss/atom/sitemap/wp-json/external:名前''', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'blog_source');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- blog_checked_at
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN blog_checked_at DATETIME NULL COMMENT ''ブログを調べた日時''', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'blog_checked_at');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- idx_pref_wdscore
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD KEY idx_pref_wdscore (prefecture, wd_score)', 'SELECT 1')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND INDEX_NAME = 'idx_pref_wdscore');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 口コミ数・写真数・評価の履歴(値が変わったときだけ1行足す)
CREATE TABLE IF NOT EXISTS stoc_master.shop_metrics_history (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  shop_id BIGINT NOT NULL,
  captured_at DATETIME NOT NULL,
  review_count INT NULL,
  photo_count INT NULL,
  rating DECIMAL(2,1) NULL,
  KEY idx_shop_captured (shop_id, captured_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
