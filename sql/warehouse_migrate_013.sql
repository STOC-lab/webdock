-- 見本ページ(営業提案用)の表。何度実行しても安全。
-- 適用: mysql --default-character-set=utf8mb4 < sql/warehouse_migrate_013.sql   (stoc_wh は stoc_master の全権限を持つのでそのまま作れる)
--
-- sample_pages: ホームページがない店に電話で見てもらう、その店専用の見本ページ(1店につき1行)。
--   code             電話で読み上げる5桁の数字(10000〜99999、ランダム、重複しない)。URLは /s/<code>
--   shop_id          stoc_master.shops.id。店名・住所・電話などは表示のたびにここから読む(コピーしない)
--   group_id         業種グループ(src/sampleCategories.js の seitai / massage)
--   hours_json       院長に聞いた営業時間 [["月","8:00〜12:00 / 15:00〜19:15"],...]。NULL なら「伺って掲載します」の案内
--   note             営業メモ
--   status           draft=見本 / approved=掲載OKをもらった / deleted=削除(表示しない・404)
--   first_opened_at, last_opened_at, open_count  開かれた記録(ボットは数えない)
--   batch_label      どのリストで作ったか(例: 兵庫_健康系_20261118)
CREATE TABLE IF NOT EXISTS stoc_master.sample_pages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  code CHAR(5) NOT NULL,
  shop_id BIGINT NOT NULL,
  group_id VARCHAR(20) NOT NULL,
  hours_json JSON NULL,
  note VARCHAR(500) NULL,
  status ENUM('draft','approved','deleted') NOT NULL DEFAULT 'draft',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  first_opened_at DATETIME NULL,
  last_opened_at DATETIME NULL,
  open_count INT NOT NULL DEFAULT 0,
  batch_label VARCHAR(100) NULL,
  UNIQUE KEY uq_sample_code (code),
  KEY idx_sample_shop (shop_id),
  KEY idx_sample_batch (batch_label)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
