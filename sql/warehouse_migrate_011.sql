-- 取り込みで「CIDがない行」を電話番号で既存の店と照合するための索引と、取り込みの記録の列。何度実行しても安全。
-- 適用: mysql --default-character-set=utf8mb4 stoc_master < sql/warehouse_migrate_011.sql   (stoc_wh は stoc_master の全権限を持つのでそのまま作れる)
-- この移行だけでは動きは変わらない。取り込み(cli/warehouse-import.js)が、列と索引があれば電話番号の照合を行い、
-- なければ警告を出して今までどおり(電話番号の照合なし)に動く。
--
-- phone_key1 / phone_key2: shops.phone の「1つ目・2つ目の番号」を数字だけにした生成列(VIRTUAL。phone を直すと自動で変わる)。
--   phone は「,」「/」「、」で複数の番号が入ることがある。全角数字は半角にそろえ、数字以外は捨てる。3つ目以降の番号は索引に入らない。
--   値の作り方は src/importMatch.js の phoneKeys() と同じ(test/importphone.test.js で突き合わせている)。
-- idx_pref_phone1 / idx_pref_phone2: (prefecture, phone_key1) / (prefecture, phone_key2)。同じ都道府県の店を番号で引く。
-- import_runs の列: 電話番号の照合の件数(CIDで一致 / 電話番号で一致 / うちURLを補った・URLが異なった / 複数一致で保留)。
--   新規・スキップは既存の inserted / skipped、既存の店に当たった合計は updated のまま。
-- 注意: 索引の作成は shops 全件を読むので、件数が多いと数分かかる(その間も読み取りはできる)。
SET @db = 'stoc_master';

-- phone_key1
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN phone_key1 VARCHAR(30) GENERATED ALWAYS AS (NULLIF(REGEXP_REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(SUBSTRING_INDEX(REGEXP_REPLACE(phone,''[,/、]'','',''),'','',1),''０'',''0''),''１'',''1''),''２'',''2''),''３'',''3''),''４'',''4''),''５'',''5''),''６'',''6''),''７'',''7''),''８'',''8''),''９'',''9''),''[^0-9]'',''''),'''')) VIRTUAL', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'phone_key1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- phone_key2
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD COLUMN phone_key2 VARCHAR(30) GENERATED ALWAYS AS (IF(LOCATE('','',REGEXP_REPLACE(phone,''[,/、]'','',''))>0,NULLIF(REGEXP_REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(SUBSTRING_INDEX(SUBSTRING_INDEX(REGEXP_REPLACE(phone,''[,/、]'','',''),'','',2),'','',-1),''０'',''0''),''１'',''1''),''２'',''2''),''３'',''3''),''４'',''4''),''５'',''5''),''６'',''6''),''７'',''7''),''８'',''8''),''９'',''9''),''[^0-9]'',''''),''''),NULL)) VIRTUAL', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'phone_key2');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- idx_pref_phone1
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD KEY idx_pref_phone1 (prefecture, phone_key1)', 'SELECT 1')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND INDEX_NAME = 'idx_pref_phone1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- idx_pref_phone2
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.shops ADD KEY idx_pref_phone2 (prefecture, phone_key2)', 'SELECT 1')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'shops' AND INDEX_NAME = 'idx_pref_phone2');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- import_runs.cid_matched
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.import_runs ADD COLUMN cid_matched BIGINT NOT NULL DEFAULT 0', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'import_runs' AND COLUMN_NAME = 'cid_matched');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- import_runs.phone_matched
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.import_runs ADD COLUMN phone_matched BIGINT NOT NULL DEFAULT 0', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'import_runs' AND COLUMN_NAME = 'phone_matched');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- import_runs.phone_url_filled
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.import_runs ADD COLUMN phone_url_filled BIGINT NOT NULL DEFAULT 0', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'import_runs' AND COLUMN_NAME = 'phone_url_filled');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- import_runs.phone_url_differed
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.import_runs ADD COLUMN phone_url_differed BIGINT NOT NULL DEFAULT 0', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'import_runs' AND COLUMN_NAME = 'phone_url_differed');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- import_runs.held
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.import_runs ADD COLUMN held BIGINT NOT NULL DEFAULT 0', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'import_runs' AND COLUMN_NAME = 'held');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
