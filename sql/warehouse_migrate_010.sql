-- 倉庫から直接送る(営業管理に入れない)ための表と列。何度実行しても安全。
-- 適用: mysql < sql/warehouse_migrate_010.sql   (先に warehouse_migrate_006.sql を適用しておくこと。stoc_wh は stoc_master の全権限を持つのでそのまま作れる)
-- この移行だけでは動きは変わらない(表を使うのは「倉庫から直接」の送信を足す変更から)。
--
-- webdock_send_batches: 倉庫から直接送ったバッチ(1回の「診断して文面も作る」= 1〜複数バッチ)
--   batch_code: whd_YYYYMMDD_HHmmss_xxxx(STOC営業管理の sender_… とは別の頭。STOCの結果の戻しや送信済みの判定と混ざらない)
--   result_imported_at / result_file: 送信ツールの結果CSVを最後に取り込んだ時刻・ファイル名
-- webdock_sends: 倉庫の送信履歴(1店1行)
--   form_url_key: 正規化した送信先URLのSHA1(16進40文字)。結果CSVは「バッチコード + 送信先URL」で照合する
--   matched_stoc_store_id: 送った時点で電話・店名+住所が一致したSTOC営業管理の店(参考。一致しなければ NULL)
--   send_status: pending(送信ファイルを作っただけ・結果未取り込み) / success / failed / skipped
--   send_result: 送信ツールの結果の文言そのまま / sent_at: 送信ツールが送った時刻
-- webdock_pages に足す列:
--   origin: どちらの送り方で作ったページか(stoc=営業管理経由 / warehouse=倉庫から直接)。既にある行は stoc
--   stoc_registered_at / stoc_register_how / stoc_register_error: 反応があった店を営業管理へ入れた記録(後日の変更で使う)
SET @db = 'stoc_master';

CREATE TABLE IF NOT EXISTS stoc_master.webdock_send_batches (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  batch_code VARCHAR(40) NOT NULL,
  item_count INT NOT NULL DEFAULT 0,
  filter_json TEXT NULL,
  out_dir VARCHAR(100) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  result_imported_at DATETIME NULL,
  result_file VARCHAR(255) NULL,
  UNIQUE KEY uq_code (batch_code),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stoc_master.webdock_sends (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id BIGINT NOT NULL,
  batch_code VARCHAR(40) NOT NULL,
  finding_key VARCHAR(30) NULL,
  finding_sentence TEXT NULL,
  page_token CHAR(10) CHARACTER SET ascii COLLATE ascii_bin NULL,
  form_url VARCHAR(1000) NOT NULL,
  form_url_key CHAR(40) CHARACTER SET ascii NOT NULL,
  matched_stoc_store_id INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  send_status ENUM('pending','success','failed','skipped') NOT NULL DEFAULT 'pending',
  send_result VARCHAR(100) NULL,
  sent_at DATETIME NULL,
  UNIQUE KEY uq_batch_shop (batch_code, shop_id),
  KEY idx_batch_form (batch_code, form_url_key),
  KEY idx_shop_created (shop_id, created_at),
  KEY idx_token (page_token),
  KEY idx_matched (matched_stoc_store_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---- webdock_pages の列(列があれば何もしない) ----
-- origin
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.webdock_pages ADD COLUMN origin ENUM(''stoc'',''warehouse'') NOT NULL DEFAULT ''stoc'' COMMENT ''作った送り方 stoc=営業管理経由 / warehouse=倉庫から直接''', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'webdock_pages' AND COLUMN_NAME = 'origin');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- stoc_registered_at
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.webdock_pages ADD COLUMN stoc_registered_at DATETIME NULL COMMENT ''倉庫から直接送った店を営業管理へ入れた時刻''', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'webdock_pages' AND COLUMN_NAME = 'stoc_registered_at');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- stoc_register_how
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.webdock_pages ADD COLUMN stoc_register_how VARCHAR(20) NULL COMMENT ''営業管理へ入れた方法(新規・既存の店への紐付け・手動など)''', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'webdock_pages' AND COLUMN_NAME = 'stoc_register_how');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- stoc_register_error
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.webdock_pages ADD COLUMN stoc_register_error TEXT NULL COMMENT ''営業管理へ入れられなかったときの理由''', 'SELECT 1')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'webdock_pages' AND COLUMN_NAME = 'stoc_register_error');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ---- webdock_pages の索引(索引があれば何もしない) ----
-- idx_shop: 倉庫の店ごとの配信停止・ページを引く
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.webdock_pages ADD KEY idx_shop (shop_id)', 'SELECT 1')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'webdock_pages' AND INDEX_NAME = 'idx_shop');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- idx_origin_human: 倉庫から直接送ったページのうち、人が閲覧したもの
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE stoc_master.webdock_pages ADD KEY idx_origin_human (origin, human_at)', 'SELECT 1')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'webdock_pages' AND INDEX_NAME = 'idx_origin_human');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
