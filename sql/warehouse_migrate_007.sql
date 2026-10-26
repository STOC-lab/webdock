-- 御社専用ページ(webdock_pages)に、見せた版(variant)の列を足す。何度実行しても安全。
-- variant: 'titles'(他の項目は題名だけ) / 'full'(題名+要約)。版はトークンから決まり、ページを人が開いたとき・申し込んだときに控える。
-- 列がなくてもアプリは動く(版の記録を飛ばす)。既存の行はNULLのまま。
-- 適用: mysql < sql/warehouse_migrate_007.sql
SET @db = 'stoc_master';

-- variant
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.webdock_pages ADD COLUMN variant VARCHAR(10) NULL COMMENT ''見せた版 titles/full(最初に開いた・申し込んだときに控える)''', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'webdock_pages' AND COLUMN_NAME = 'variant');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
