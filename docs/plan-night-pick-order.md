# 夜間フォーム探しの取り出しを ID 順にする(ai/night-pick-order)

## 何を変えたか
- 夜間(`wantsPriority` が真)の対象取り出しの既定を **ID 順** にした。`ORDER BY id`、続きは `AND id > ?`(cursor は `{ id }`)。主キーで順に読めるので、全件読み・filesort をしない想定。
- 電話番号あり・統合済み除外・4つの条件(未調査/エラー再試行/永続エラー再試行/なし再確認)・業種ルールでの読み飛ばしは従来どおり。
- 口コミ順は残してある。`--order reviews` を付けたときだけ従来の SQL(`ORDER BY COALESCE(review_count, -1) DESC, id`)で動く。既定は `--order id`。値が `id` / `reviews` 以外なら起動時にエラー。
- `fetchPrioritized` は、1回の取り出しごとに「クエリ回数と各ミリ秒」を時刻つき1行で `console.error`(pm2 logs)に出す。
  例: `[2026-11-14T13:00:01.234Z] 夜間の対象取り出し: order=id クエリ2回 (35ms, 12ms) 合計47ms 取得10/10件`
- `priority: false` の経路、規模チェック、お断り判定の SQL は変えていない。マイグレーション・package.json の変更なし。

## 注意
- ID 順になるので、口コミの多い店から先に、という優先順位はなくなる(必要なら `--order reviews`、ただし重い)。
- 途中で夜間の時間帯が閉じたときの「次の夜は先頭からやり直す」動作は従来どおり(cursor を捨てる)。

## 本番での確認手順(実装後、PM2 を再起動する前に)
1. 夜間に使っている起動引数と同じもので、SQL を作って表示する(DB には触れない)。例(引数は実際の pm2 の設定に合わせる):

   ```
   node -e "const f=require('./cli/find-forms'); const o=f.parseArgs(['--source','warehouse','--night','--loop','--prefecture','大阪府']); const q=f.buildWarehouseTargetQuery({...o,limit:1000,priority:true,cursor:{id:0}}); console.log(q.sql); console.log(JSON.stringify(q.params));"
   ```

   `--order` を付けていなければ `ORDER BY id` と `AND id > ?` が出る。
2. その SQL の `?` に params を当てはめて(`IN (?)` の都道府県は `'大阪府'` のように)、本番の MySQL で `EXPLAIN` を実行する。

   ```sql
   EXPLAIN SELECT id, form_status, ... FROM stoc_master.shops WHERE ... AND id > 0 ORDER BY id LIMIT 1000;
   ```
3. 見るところ:
   - `shops` の行の **`key` が `PRIMARY`**
   - **`Extra` に `Using filesort` がない**
   - `rows` が約262万のままでも、LIMIT で早く打ち切られれば問題ない。実測は下の pm2 logs で確かめる。
4. 再起動後は `pm2 logs` で `夜間の対象取り出し:` の行を見て、`合計` ミリ秒が口コミ順のときより十分短いこと、読み飛ばしが多い夜でも `クエリ○回` の各 ms が短いことを確認する。
5. 問題があれば、起動引数に `--order reviews` を付ければ従来の動きに戻せる(コードの差し戻しは不要)。

(この手順は未実施。本番では確認していない。)
