-- 管理画面の「状況」「夜間フォーム探し」の集計結果を保存する小さな表。何度実行しても安全。
-- 適用: mysql --default-character-set=utf8mb4 < sql/warehouse_migrate_012.sql   (stoc_wh は stoc_master の全権限を持つのでそのまま作れる)
--
-- admin_stats_snapshot: 裏で数分おきに実行した集計の結果(JSON)を、1種類につき1行で保存する。
--   k           'status'(状況の都道府県別件数) / 'night'(夜間フォーム探しの進み具合)
--   value_json  集計結果(JSON)。数十行ぶんの小さな値
--   computed_ms 集計が終わった時刻(UNIXミリ秒)。画面の「○時○分時点の集計」に使う
-- この表が無くても管理画面は動く(その場合は結果をプロセス内にだけ持ち、再起動すると次の集計が終わるまで「集計中」になる)。
CREATE TABLE IF NOT EXISTS stoc_master.admin_stats_snapshot (
  k VARCHAR(40) NOT NULL PRIMARY KEY,
  value_json MEDIUMTEXT NOT NULL,
  computed_ms BIGINT UNSIGNED NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
