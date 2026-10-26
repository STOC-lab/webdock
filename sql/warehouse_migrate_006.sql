-- 御社専用ページ(/r/<token>)の表を作る。何度実行しても安全。
-- B2B送信で batch-scan --single-out ... --with-page を使うと、会社ごとに1行ずつ作られる。
-- 適用: mysql < sql/warehouse_migrate_006.sql
-- token: 10文字の英数字(大文字小文字を区別するため ascii_bin)。URLに入る合言葉。
-- view_count: 人と思われるアクセスの回数 / bot_view_count: 機械・プレビューらしいアクセス(数えない) / human_at: 画面の操作が届いた最初の時刻
-- lead_at: 「詳しい簡易レポートを希望する」を押した時刻 / lead_stoc_at: STOC営業管理の見込み客へ登録できた時刻
SET @db = 'stoc_master';

CREATE TABLE IF NOT EXISTS stoc_master.webdock_pages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  token CHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  shop_id BIGINT NULL,
  stoc_store_id INT NULL,
  stoc_batch_code VARCHAR(40) NULL,
  domain VARCHAR(255) NOT NULL,
  company_name VARCHAR(255) NOT NULL,
  finding_key VARCHAR(30) NULL,
  finding_sentence TEXT NULL,
  findings_json TEXT NULL,
  audience VARCHAR(60) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  first_viewed_at DATETIME NULL,
  last_viewed_at DATETIME NULL,
  view_count INT NOT NULL DEFAULT 0,
  lead_at DATETIME NULL,
  bot_view_count INT NOT NULL DEFAULT 0,
  last_ua_class VARCHAR(10) NULL,
  human_at DATETIME NULL,
  lead_stoc_at DATETIME NULL,
  lead_contact TEXT NULL,
  opt_out_at DATETIME NULL,
  UNIQUE KEY uq_token (token),
  KEY idx_stoc_store (stoc_store_id),
  KEY idx_created (created_at),
  KEY idx_lead (lead_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 以前の版で表だけ作られていた場合に備えて、あとから足した列を補う(列があれば何もしない)
-- bot_view_count
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.webdock_pages ADD COLUMN bot_view_count INT NOT NULL DEFAULT 0 COMMENT ''人ではなさそうなアクセスの回数(数えない)''', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'webdock_pages' AND COLUMN_NAME = 'bot_view_count');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- last_ua_class
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.webdock_pages ADD COLUMN last_ua_class VARCHAR(10) NULL COMMENT ''最後のアクセスの種類 human/bot''', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'webdock_pages' AND COLUMN_NAME = 'last_ua_class');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- human_at
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.webdock_pages ADD COLUMN human_at DATETIME NULL COMMENT ''画面の操作が届いた最初の時刻(メールの自動巡回との見分け)''', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'webdock_pages' AND COLUMN_NAME = 'human_at');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- lead_stoc_at
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.webdock_pages ADD COLUMN lead_stoc_at DATETIME NULL COMMENT ''STOC営業管理の見込み客へ登録できた時刻(NULLで lead_at ありなら未連携)''', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'webdock_pages' AND COLUMN_NAME = 'lead_stoc_at');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- lead_contact
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.webdock_pages ADD COLUMN lead_contact TEXT NULL COMMENT ''申込の内容(JSON)。STOCへ登録できなかったときの控え''', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'webdock_pages' AND COLUMN_NAME = 'lead_contact');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- opt_out_at
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.webdock_pages ADD COLUMN opt_out_at DATETIME NULL COMMENT ''今後の案内は不要の申し出の時刻''', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'webdock_pages' AND COLUMN_NAME = 'opt_out_at');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
