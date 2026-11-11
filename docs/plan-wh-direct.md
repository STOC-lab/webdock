# 実装計画: 倉庫から直接送り、反応があった店だけ営業管理に入れる（PR-2・PR-3）

作成: 2026-11-11。VPS 上で作った実装計画に、代表者が決めた方針を反映したもの。
PR-1（src/stocMatch.js・golden テスト・sql/warehouse_migrate_010.sql）は main にマージ済み。

## 決まった方針（必ず守る）

1. 今回作るのは PR-2 と PR-3 だけ。PR-4（送信結果CSVの取り込み）・PR-5（申込で営業管理へ自動登録）・PR-6（閲覧した店の一覧と登録ボタン）は後日。
2. 倉庫から直接送る場合、**兵庫県・岡山県・徳島県・香川県・愛媛県・高知県は対象外**（営業管理経由に限定）。管理画面で選べないようにし、CLI でもこの6県が含まれていたら診断前にエラーで止める。
3. 倉庫の送信履歴で外す日数の既定は **60日**。
4. **営業管理（stoc_sales）には書き込まない**。stores への INSERT もしない（PR-5 は後日、営業管理側のAPI方式で設計し直す）。直接送信のとき STOC へは読み取り（SELECT）だけ。
5. フリーダイヤル・ナビダイヤル（0120/0800/0570）だけで一致した店は「要確認」とし、**直接送信では送らない**。一覧は 要確認_freedial.csv に出す。
6. 営業管理経由の出力は **1文字も変えない**（npm run test:golden が全件通ること）。
7. 送信結果の取り込み（PR-4）ができるまでは、送信履歴の pending も「送信済み」として扱い、日数の除外に含める（取り込み前に重ねて送らないため）。PR-4 では「送信失敗の店は次回また送ってよい。ただし営業お断りが理由の失敗は除外」とする予定。

## 前提（既存コードについて分かっていること）

- 除外の場所は outreachSingle.pickCandidates()（stoc_store_id がない店は「営業管理に未登録」）と buildItems()（STOC側の店の行が必要）の2か所。会社名・評価・電話・住所もSTOCの店の行から取っている。
- 専用ページの部品は、stoc_store_id が NULL でも閲覧・申込・配信停止を倉庫に記録できる。STOCへ書く部分は飛ばされる。
- 配信停止の除外（loadOptOutSet）と送信済みの除外（loadResendSet）は、どちらも STOCの店ID を手がかりにしている。営業管理に未登録の店はこのままでは外れない。
- 電話番号・店名+住所の照合は src/stocMatch.js（PR-1）。`{ withIds: true }` の索引は一致したSTOCの店IDとステータスを持つ（matchShop）。
- 表は sql/warehouse_migrate_010.sql で定義済み: stoc_master.webdock_send_batches、stoc_master.webdock_sends、webdock_pages.origin（stoc/warehouse）ほか。

## PR-2: 倉庫から直接送る

### 2-1. 除外条件（cli/batch-scan.js・src/stocMatch.js・src/exclusions.js）

`--source warehouse --direct` のとき、診断の前に次の順で外し、理由ごとの件数を まとめ.txt に出す。

| # | 条件 | 判定 | 今の仕組み |
|---|---|---|---|
| 0 | 対象外の6県 | prefecture が方針2の6県 | 新規（CLIで指定されていたらエラー） |
| 1 | 営業お断り・閉業 | warehouseWhere（form_no_sales=0） | そのまま |
| 2 | クレーム（営業管理と紐付いた店） | claimConditions（stoc_store_id 経由） | そのまま |
| 3 | 倉庫の送信履歴でN日以内 | webdock_sends の shop_id。pending と success を数え、created_at >= NOW() - INTERVAL N DAY | 新規 loadWarehouseResendSet(pool, days) |
| 4 | 配信停止（倉庫） | webdock_pages.opt_out_at を shop_id で見る。期間は問わない | 新規 loadOptOutShopSet |
| 5 | 除外ドメイン・チェーン | applyPreScanExclusions | そのまま |
| 6 | 営業管理と一致した店のクレーム・失注・契約 | 手がかりは cid／stoc_store_id／電話（固定・携帯）／店名+住所。一致した店IDの status とクレーム履歴を引く | src/stocMatch.js の matchShop |
| 7 | 一致した店のWEBドック送信済み・配信停止 | 一致した店IDに今の loadResendSet と loadOptOutSet を当てる | 今の関数を流用 |
| 8 | フリーダイヤルのみ一致 | 要確認として送らない | matchShop の要確認 |

### 2-2. 送信ファイルの作成（src/outreachSingle.js、新しい src/warehouseSends.js）

- buildSingleFiles(opts) に `direct: true` を足す。direct が偽のときは今のまま（golden で保証）。
- direct のとき:
  - pickCandidates: stoc_store_id を必須にしない（キーは倉庫の store_id）。
  - buildItems: 店の情報は倉庫の shops から取る。新しく fetchWarehouseShops(pool, ids) を作り、`{ name, phone, address: address_raw, gbp_rating: rating, gbp_review_count: review_count, website_url }` の形にそろえる。S.ratingInfo と S.contactPhone をそのまま使い、9列CSVの形も同じにする。
  - 失注・契約の判定は 2-1 で済ませるので、ここではしない。
  - 専用ページを必ず付ける（withPage を強制。stocStoreId: null、origin: 'warehouse'）。
  - stoc.register の代わりに sends.createBatch() を呼び、1つのトランザクションで webdock_send_batches と webdock_sends を書く。失敗したら作ったページを pages.remove(tokens) で消す。
  - webdock_sends.matched_stoc_store_id には、送った時点で一致したSTOCの店ID（参考）を入れる。form_url_key は正規化した送信先URLのSHA1。
  - バッチコードは `whd_YYYYMMDD_HHmmss_xxxx`（STOCの sender_ と混ざらない）。
  - まとめ.txt・result.json の文言は「営業管理には登録していません。送信結果の取り込みは今後の機能で対応します」とする。
- cli/batch-scan.js:
  - 新しい引数: `--direct`（`--source warehouse --single-out` と一緒の場合だけ有効。`--with-page` を含む）、`--min-days-since-sent-wh N`（既定60）。
  - 直接送信のとき、STOC には読み取りの確認だけ（checkStocAccess を読み取り専用で。sales_logs / store_flags / inquiry_export_* の SELECT）。倉庫側は webdock_sends・webdock_send_batches・webdock_pages への書き込みを確認する。
  - `--dry-run`（倉庫に何も書かない試し）も作る。

### 2-3. 管理画面（src/adminWarehouse.js・views/admin/export.ejs・views/admin/job.ejs）

- 「診断して文面も作る」（工場・建設用の preset）に「送り方」の選択を足す。
  - 営業管理経由（今までどおり。既定）
  - 倉庫から直接（営業管理に入れない・専用ページ付き）
- 「倉庫から直接」を選んだときだけ「倉庫の送信履歴で○日以内に送った店は外す」（既定60）を出す。専用ページは常に付ける。
- 「倉庫から直接」では方針2の6県を選べないようにする（チェックボックスを無効化し、サーバー側でも拒否）。
- 「送信成功済みの店（stocsent）」は「直接」を選べない。buildStocSentScanArgs は変えない。
- buildB2bScanArgs に direct と days を足し、`--direct` 付きの引数を作る。job の meta に direct: true を入れる。
- job.ejs: 直接送信のときは「送信結果はこのコードでSTOCへ戻ります」の代わりに「営業管理には登録していません」と表示する。

## PR-3: 二重送信を防ぐ（営業管理経由の送信への小さな変更）

- 営業管理経由の送信（今までの経路）でも、次の店を外す:
  - 倉庫から直接送った店: webdock_sends（N日以内）の shop_id → shops.stoc_store_id が一致する店
  - 倉庫で配信停止した店: webdock_pages.opt_out_at の shop_id → shops.stoc_store_id が一致する店
- 除外が増える方向の変更なので、追加した除外は まとめ.txt に新しい理由として件数を出す。
- golden の比較用出力は「除外が0件のとき今と1文字も変わらない」ことを保つ。golden の入力に新しい除外が出るケースを足す場合は、別のテストケースにする（既存の3ケースは変えない）。
- PR-2 と PR-3 は同じ日に本番へ出す（PR-2 だけだと、直接送った店が後で営業管理経由でもう一度送られるおそれがあるため）。

## 既存の営業管理経由の送信への影響と守り方

| 変更箇所 | 影響 | 守り方 |
|---|---|---|
| outreachSingle.buildSingleFiles | direct が偽なら今のまま | 分岐は direct のときだけ。golden で確認 |
| cli/batch-scan.js | --direct がなければ今のまま | 引数の組み合わせの検査を足すだけ |
| webdock_pages の列 | origin の既定値 stoc で今の行は同じ | 列がなくても動くようにする（variant と同じ扱い） |
| job.ejs | 営業管理経由の表示は今のまま | meta.direct で分ける |
| PR-3 の除外追加 | 営業管理経由の除外が増える | 別コミット。件数を まとめ.txt に出す |

## テスト（DBを使わない偽の接続で）

- golden: 営業管理経由の出力が1文字も変わらないこと（既存の3ケース）。
- test/direct.test.js（新規）: 未登録の店が通るか。9列CSVの評価・電話・住所が倉庫の値になるか。webdock_sends へのINSERTのSQLと値。失敗したらページを消すか。バッチコードの頭が whd_ か。まとめ.txt の文言。6県の拒否。フリーダイヤルのみ一致を送らないこと。
- test/exclude.test.js に追加: 倉庫の送信履歴（N日の境目、pending／success の扱い）、shop_id による配信停止、PR-3 の新しい除外。
- test/admin.test.js に追加: buildB2bScanArgs（direct・日数の検査、6県の拒否）、stocsent で direct を拒むこと。
- 実DBでの確認（マイグレーション010の適用・INSERT）は本番反映のときに行う。本番に出す前に `--direct --dry-run` で数十社分を出し、除外の件数を確認する。

## コミットの分け方

1. PR-2 本体（2-1〜2-3）
2. PR-3（二重送信の防止）

どちらも ai/wh-direct-pr2 ブランチ上で、コミットを分ける。終わったら /codex-diff-review を実行し、push はしない。
