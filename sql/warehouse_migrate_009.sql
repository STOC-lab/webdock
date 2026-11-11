-- 夜間のフォーム探し用の表を2つ作る。何度実行しても安全。
-- 適用: mysql < sql/warehouse_migrate_009.sql   (stoc_wh は stoc_master の全権限を持つのでそのまま作れる)
--
-- form_finder_settings: 夜間の時間帯などの設定(倉庫の管理画面「夜間フォーム探し」から変える)
--   night_start / night_end(時 0-23。既定 22 / 6) / night_enabled(1/0) / night_from(この日時より前は動かない。空なら制限なし)
-- form_host_visits: ホストごとの訪問の予約。複数プロセスが同じホストを同時に訪問しない・10秒以上あける・
--   7日以内に調べた結果を使い回す(result_json)ための表。
CREATE TABLE IF NOT EXISTS stoc_master.form_finder_settings (
  k VARCHAR(40) NOT NULL PRIMARY KEY,
  v VARCHAR(100) NOT NULL DEFAULT '',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stoc_master.form_host_visits (
  host VARCHAR(255) NOT NULL PRIMARY KEY,
  holder VARCHAR(80) NULL,
  next_ok_at DATETIME(3) NOT NULL,
  last_visit_at DATETIME NULL,
  result_json MEDIUMTEXT NULL,
  result_at DATETIME NULL,
  KEY idx_result_at (result_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
