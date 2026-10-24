-- 倉庫DB(全国データ)。営業アプリ(stoc_sales)を軽く保つため、全件はここに置く。
-- 適用: mysql < sql/warehouse_schema.sql
CREATE DATABASE IF NOT EXISTS stoc_master CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS stoc_master.shops (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  cid VARCHAR(20) NULL,
  fallback_key CHAR(40) NULL,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(500) NULL,
  category_main VARCHAR(100) NULL,
  postal VARCHAR(10) NULL,
  address_raw VARCHAR(500) NULL,
  address VARCHAR(500) NULL,
  prefecture VARCHAR(10) NULL,
  phone VARCHAR(30) NULL,
  rating DECIMAL(2,1) NULL,
  review_count INT NULL,
  gbp_registered VARCHAR(10) NULL,
  business_status VARCHAR(50) NULL,
  website_url VARCHAR(1000) NULL,
  gmap_url VARCHAR(1000) NULL,
  photo_count INT NULL,
  place_id VARCHAR(100) NULL,
  lat DECIMAL(10,7) NULL,
  lng DECIMAL(10,7) NULL,
  source_file VARCHAR(300) NULL,
  first_seen_at DATETIME NOT NULL,
  last_seen_at DATETIME NOT NULL,
  stoc_store_id INT NULL,
  form_status ENUM('unknown','url_found','no_form','error','needs_browser') NOT NULL DEFAULT 'unknown',
  form_url VARCHAR(1000) NULL,
  form_kind VARCHAR(20) NULL,
  form_captcha TINYINT(1) NULL,
  form_checked_at DATETIME NULL,
  form_note VARCHAR(100) NULL,
  email VARCHAR(255) NULL,
  instagram_url VARCHAR(500) NULL,
  webdock_grade VARCHAR(2) NULL,
  webdock_score INT NULL,
  webdock_finding VARCHAR(20) NULL,
  webdock_checked_at DATETIME NULL,
  promoted_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cid (cid),
  UNIQUE KEY uq_fallback (fallback_key),
  KEY idx_pref_cat (prefecture, category(100)),
  KEY idx_pref_catmain (prefecture, category_main),
  KEY idx_stoc_store (stoc_store_id),
  KEY idx_form_pref (form_status, prefecture),
  KEY idx_pref_form (prefecture, form_status),
  KEY idx_promoted (promoted_at),
  KEY idx_last_seen (last_seen_at),
  KEY idx_lat_lng (lat, lng)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stoc_master.import_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  started_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  root_path VARCHAR(500) NULL,
  files INT NOT NULL DEFAULT 0,
  rows_read BIGINT NOT NULL DEFAULT 0,
  inserted BIGINT NOT NULL DEFAULT 0,
  updated BIGINT NOT NULL DEFAULT 0,
  skipped BIGINT NOT NULL DEFAULT 0,
  errors TEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- DBユーザー(パスワードは変更して root で実行):
-- CREATE USER 'stoc_wh'@'localhost' IDENTIFIED BY '…';
-- GRANT ALL ON stoc_master.* TO 'stoc_wh'@'localhost';
-- GRANT SELECT ON stoc_sales.stores TO 'stoc_wh'@'localhost';
-- (フォームURL等の引き継ぎ --carry-forms を使う場合)
-- GRANT SELECT, INSERT, UPDATE ON stoc_sales.store_contact_channels TO 'stoc_wh'@'localhost';
-- GRANT SELECT, INSERT, UPDATE ON stoc_sales.contact_channel_candidates TO 'stoc_wh'@'localhost';
-- FLUSH PRIVILEGES;
