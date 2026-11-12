# 管理画面の集計を裏で実行して保存する(ai/admin-stats-cache)

## 何を変えたか
- 「状況」(都道府県別件数)と「夜間フォーム探し」(進み具合)の集計は、画面を開いたときではなく、アプリが裏で数分おきに実行して `stoc_master.admin_stats_snapshot` に保存する。画面は保存済みの結果を読むだけ。
- 間隔: 既定5分、夜間フォーム探しの時間帯は10分。集計は同時に1つだけ(実行中なら新しく始めない)。
- 画面に「○月○日 ○時○分時点の集計」と「今すぐ更新」ボタン(POST・CSRFあり)。旧 60秒キャッシュ(`getStats`)は廃止。画面の自動更新は追加していない。
- ログイン処理は軽い(パスワード比較とクッキー発行のみ)ので変更なし。ログイン後の `/` が集計を待っていたのが遅さの原因で、今は保存結果をすぐ表示する。
- 排他はプロセス内だけ。PM2 は1プロセス(`instances: 1`)が前提。増やすときは `GET_LOCK` などで DB 側の排他が必要。
- 再起動直後は、保存済みの表から前回の結果を読み込んですぐ表示し、裏で最初の集計を始める。壊れた保存値は読み込まない。
- 保存先の表が無くても動く(プロセス内だけ。再起動後は次の集計が終わるまで「集計中」)。

## 9〜10秒かかる一覧クエリの特定(コードを読んでの推定。本番では未確認)
`SELECT id, form_status, name, …, gbp_registered` の形で `form_status` を2番目に選んでいるのは次の2つ。

| 候補 | 場所 | 判断 |
|---|---|---|
| 夜間の対象の取り出し | `cli/find-forms.js` の `buildWarehouseTargetQuery({ priority: true })`(`PRIORITY_COLUMNS`) | **本命**。未調査 約243万件から `ORDER BY COALESCE(review_count,-1) DESC, id` で次のまとまりを選ぶ。夜間に何度も繰り返し実行される。 |
| WEB入れ替えの取り出し | `cli/warehouse-promote.js:82` | 可能性は低い。`form_found` などで絞ったうえで使う手動の取り出し。 |

本命と考える理由:
- WHERE が `website_url` ありに加えて、`form_status`/`form_checked_at` の4通りの `OR`(未調査・エラー再試行・永続エラー再試行・なし再確認)で、1本の索引では範囲を絞れない。
- `ORDER BY COALESCE(review_count, -1) DESC, id` は式なので、`review_count` の索引があっても並べ替えに使えない。条件に合う行をすべて読んでから並べ替えている(filesort)可能性が高い。
- `fetchPrioritized` は、業種ルールで外れた店を JS 側で読み飛ばすたびに、同じ重いクエリをもう1ページ分実行する。
- `--night` では統合済み除外の `NOT EXISTS (SELECT … FROM stoc_sales.stores …)` も付く。

## 提案(この PR では実装しない。本番の EXPLAIN で確かめてから別 PR)
どれも、まず本番で次を実行して、`type`・`key`・`rows`・`Extra`(`Using filesort` の有無)を確認する。

```sql
EXPLAIN SELECT id, form_status, name, category, category_main, postal, address_raw, phone, rating, review_count, gbp_registered, website_url, gmap_url, photo_count, site_host, prefecture
FROM stoc_master.shops
WHERE website_url IS NOT NULL AND website_url <> ''
  AND (form_status = 'unknown' AND form_checked_at IS NULL)
  AND phone IS NOT NULL AND phone REGEXP '[0-9]'
ORDER BY COALESCE(review_count, -1) DESC, id LIMIT 2000;
```
(実際の文は `buildWarehouseTargetQuery` が作るものを、ログから取って使う。)

1. **件数の絞り込み(索引なしでまず試せる)**
   - 取り出す件数(`PAGE = max(1000, limit*2)`)を、実際に使う件数に近づけ、ルールで外れる分の再実行を減らす。
   - 夜間フォーム探しは `--prefecture` を付けて県ごとに動かすと、`idx_pref_form (prefecture, form_status)` で範囲が絞れる(全国を1本で動かすより軽い)。
2. **索引の追加(MySQL 8.0 を想定。本番のバージョンは未確認)**
   - 並べ替えと合う索引: `ALTER TABLE stoc_master.shops ADD KEY idx_night_pick (form_status, form_checked_at, review_count DESC, id)`。
     `form_status='unknown' AND form_checked_at IS NULL` で絞ってから `review_count DESC, id` の順に読める。`review_count` が NULL の行は DESC では最後になり、`COALESCE(review_count,-1)` の並びと同じ。
   - ただし `ORDER BY` が式のままだと使われない。使うには `ORDER BY review_count DESC, id` に書き換え、カーソル条件も `review_count` の直接比較に直す必要がある(動作は同じだが、コードの変更になる)。
   - 4通りの `OR` は1本の索引では順番に読めない。主な経路(未調査)だけ別のクエリに分けて `UNION ALL` する案もある。
   - 作成は 270万行を読むため数分かかる(読み取りはその間もできる)。書き込みも少し重くなるので、本番で EXPLAIN と所要時間を確かめてから決める。
3. 統合済みの除外(`NOT EXISTS`)は、取り出したあとの行にだけ適用する案もある(先に件数を絞ってから確認する)。

## 未確認のこと
- 本番のスロークエリログの全文と、どのプロセスのクエリか(上は推定)
- 本番の MySQL のバージョン(降順索引・`REGEXP_REPLACE` の挙動)
- 索引の効果(本番で EXPLAIN により確認する)
