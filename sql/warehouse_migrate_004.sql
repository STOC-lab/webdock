-- 「営業お断り」の記載があるフォームを記録する列を足す。何度実行しても安全。
-- 適用: mysql < sql/warehouse_migrate_004.sql
-- 事前に warehouse_migrate_002.sql(form_* 列)が適用されている必要があります。
-- form_no_sales: 1=営業お断りの記載あり(送らない) / 0=記載なし / NULL=未判定(この機能より前に調べた店)
SET @db = 'stoc_master';

-- form_no_sales
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN form_no_sales TINYINT(1) NULL AFTER form_captcha', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'form_no_sales');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
