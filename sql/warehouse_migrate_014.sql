-- 送信ツールの結果CSVの取り込み(PR-4)で、取り込み済みのファイルを覚えておく表。何度実行しても安全。
-- 適用: mysql --default-character-set=utf8mb4 < sql/warehouse_migrate_014.sql   (先に warehouse_migrate_010.sql を適用しておくこと。stoc_wh は stoc_master の全権限を持つのでそのまま作れる)
-- この移行だけでは動きは変わらない(表を使うのは cli/import-send-results.js)。
--
-- webdock_send_result_files: 取り込んだ結果ファイル(1ファイル1行)
--   (file_name, file_mtime, file_size) が同じファイルは取り込み済みとして読み直さない。ファイルが書き換わる(更新時刻かサイズが変わる)と、また取り込む
--   warehouse_rows: 倉庫の分の行数 / matched: 送信履歴に当たった行 / success・failed・skipped: 更新した行 / unmatched: whd_ のコードなのに送信履歴にない行
CREATE TABLE IF NOT EXISTS stoc_master.webdock_send_result_files (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  file_name VARCHAR(255) NOT NULL,
  file_mtime DATETIME NOT NULL,
  file_size BIGINT NOT NULL,
  warehouse_rows INT NOT NULL DEFAULT 0,
  matched INT NOT NULL DEFAULT 0,
  success INT NOT NULL DEFAULT 0,
  failed INT NOT NULL DEFAULT 0,
  skipped INT NOT NULL DEFAULT 0,
  unmatched INT NOT NULL DEFAULT 0,
  imported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_file (file_name, file_mtime, file_size)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
