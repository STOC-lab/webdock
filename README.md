# WEBドック ― ホームページ健康診断

URLを入れるだけで、会社ホームページのセキュリティ状態を **外から見える範囲** で点検し、総合評価(A〜E)と10項目の診断を表示する無料診断ツール。問い合わせ営業からのリード(見込み客)獲得が目的。

- 入口(無料): 簡易結果(主要3項目)を即表示
- 残り項目は「カルテ」としてフォーム入力(会社名・担当者・メール・電話)後に表示 → 見込み客として記録・営業へ通知
- 公開想定: `https://webdock.stoc-plus.site`(XServer VPS 162.43.32.37)

## 診断10項目(すべて受動的=サイトに攻撃はしない)
1. SSL証明書の有効期限 / 2. HTTPSへの自動転送 / 3. 古い暗号方式(TLS) /
4. セキュリティ用ヘッダー / 5. Cookieの保護設定 / 6. 混在コンテンツ /
7. CMSのバージョン露出 / 8. 古いJavaScriptライブラリ / 9. 外部スクリプトの送信先 /
10. メールのなりすまし対策(SPF/DMARC)

判定区分: `異常なし / 要注意 / 要精密検査 / 判定不可`(取れない情報は推測で断定しない)

## 安全設計
- **侵入テスト・攻撃は一切しない。** 取得するのはトップページのHTML・ヘッダー・TLS情報・DNSのTXTのみ
- **SSRF対策**: ホスト名を解決し、プライベート/ループバック/リンクローカル/CGNAT/予約済み/IPv4-mapped IPv6 等を全拒否。解決IPに接続を固定(DNSリバインディング対策)。80/443のみ、リダイレクト最大5回で毎回再検査。IP直書き・認証情報付きURL・http(s)以外を拒否。本文2MB・全体15秒上限
- **回数制限**: IP単位 1時間10回、同一ドメインは10分キャッシュ
- **ボット対策**: Cloudflare Turnstile(env設定時)
- UserAgentは正直に名乗る(`WEBDock-Scanner/1.0`)

## セットアップ(開発)
```bash
npm install
npm test          # SSRF・診断ロジックの単体テスト
npm start         # http://localhost:3020  (DB未設定時は ./data/ にファイル保存)
```

## 本番デプロイ(XServer VPS / nginx + PM2)
```bash
# 1) 配置・依存
cd /var/www && git clone <repo> webdock && cd webdock && npm install --omit=dev

# 2) 設定
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # → WEBDOCK_SECRET に設定
vi .env   # DB / Turnstile / SMTP を設定

# 3) MySQL(任意・推奨)。テーブルは初回起動時に自動作成
#   CREATE DATABASE webdock DEFAULT CHARACTER SET utf8mb4;
#   CREATE USER 'webdock_user'@'localhost' IDENTIFIED BY '...';
#   GRANT ALL ON webdock.* TO 'webdock_user'@'localhost';

# 4) 起動
pm2 start ecosystem.config.js && pm2 save
```

nginx(抜粋):
```nginx
server {
  server_name webdock.stoc-plus.site;
  location / { proxy_pass http://127.0.0.1:3020; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; }
}
```
→ `certbot --nginx -d webdock.stoc-plus.site` でSSL化。DNSは A レコード webdock → 162.43.32.37。

## 営業・商談版(/sales)
営業がお客様先でその場で見せる商談ツール。無料診断版とは別入口。
- `/sales` … 合言葉(`SALES_PIN`)で保護。営業だけが使う
- URLを入れると**フォームなしで即・全10項目のフルカルテ**を表示(重要度の高い順)
- 「対策をおすすめする項目 N件」を上部に強調表示
- 提案は画面上部のタブで **TOC(訪問)／STOC(オンライン・サイト)** を切替
- 診断記録は `source='sales'` で残る(リードフォームは無し)

### 返信があったときのレポート作成
アウトバウンドの返信で約束している無料の「簡易レポート」を、PDFにして返す手順。
1. https://webdock.stoc-plus.site/sales を開き、合言葉を入力
2. 相手サイトのURLを入力して診断
3. 結果画面の「お客様用レポート(印刷用)」を押す
4. 画面上部で会社名(宛名)を入力して「反映」
5. 「印刷・PDF保存」→ 送信先を「PDFに保存」で保存
6. 返信メールにPDFを添付(レポート内の「制作会社様への確認依頼文」はコピーボタンでも取れる)

※ 同じURLの診断結果は30分間メモリに保持(再読込しても再スキャンしない)。区分の対応表は `src/reportBuckets.js` の `BUCKET_TABLE`。テストは `npm run test:report`。

## 地域による対応会社の振り分け
申込フォームで選んだ都道府県で、対応会社を自動で振り分ける。
- **兵庫県・岡山県・大阪府 → TOC**: 訪問 → UTM/PC PATROL/防犯(現地設置)
- **上記以外(全国)→ STOC**: Zoom商談 → MEO対策付きのサイト制作・リニューアル

対象県は `TOC_PREFECTURES`(カンマ区切り)で変更可。通知先は `TOC_NOTIFY_TO` / `STOC_NOTIFY_TO`(未設定なら `LEAD_NOTIFY_TO`)。カルテのCTA(提案内容・電話番号)も会社別に出し分ける。

## データ
- `webdock_scans`: 診断結果(スコア・判定JSON)
- `webdock_leads`: 申込者(会社名・担当者・メール・電話・**都道府県・対応会社(TOC/STOC)**・対象ドメイン・診断ID)
  - 申込時に対応会社の通知先へメール通知
  - **TODO(次段階)**: このleadsを、TOCはTOC営業管理・STOCはSTOC営業管理の見込み客一覧へ連携(STOCのreport_leadsと同方式)

## 次段階の構想
- 精密検査(有料): ドメイン所有確認(DNS TXT)+同意取得済みサイト限定で、能動的な診断を提供
- TOC営業管理への見込み客自動登録・閲覧トラッキング

## 一括診断(問い合わせ営業用)
営業DBから書き出した店舗リストを、既存の10項目診断で順番に点検し、問い合わせフォーム用の文面つきCSVを作る。公開情報だけを見るので、サイトへの侵入や攻撃は行わない。

### 1. 入力リストを作る(サーバー上)
```
mysql stoc_sales -B -e "SELECT id AS store_id, name, website_url AS url, prefecture, category FROM stores WHERE inquiry_url_confirmed=1 AND website_url IS NOT NULL AND website_url<>'' AND status NOT IN ('失注','契約')" > /var/www/webdock/data/targets.tsv
```
タブ区切り(1行目は列名)。CSVも可。`NULL` と空欄は空として扱う。列名は `store_id|id|店舗ID`、`name|店名|会社名|shop_name`、`url|website_url|ウェブサイト`、`prefecture|都道府県`、`category|業種` に対応。

### 2. 実行する
```
nohup node cli/batch-scan.js --in data/targets.tsv --out data/result.csv --resume &
tail -f nohup.out
```
- `--concurrency 5`(同時実行数)、`--limit N`(先頭N件だけ)、`--template west|east|auto`(auto=都道府県で西/東を自動選択)
- 終わった行から順に追記される。中断(Ctrl+C / kill -INT)しても完了分は残り、`--resume` を付けて再実行すると出力済みの store_id を飛ばして続きから進む。`--resume` なしだと上書き。
- 同じドメインは1回だけ診断して結果を使い回す。1サイト45秒でタイムアウト。
- 進捗は20件ごとに「[完了/全体] 送信推奨 n件 / エラー m件 / 残り約X分」と表示。
- 出力は `result.csv`(UTF-8 BOM付き・Excelで開ける)と、診断の全項目を含む `result.csv.jsonl`。

### 3. 出力列の意味
- `store_id` `店名` `都道府県` `業種` `URL`: 入力そのまま。`ドメイン`: wwwを除いたホスト名
- `判定`: 総合評価 A〜E(診断不能は空)。`点数`: 総合点
- `証明書` `https転送` `暗号方式` `ヘッダー` `Cookie` `混在` `CMS露出` `JSライブラリ` `外部スクリプト` `なりすまし対策`: 10項目の判定。A=問題なし、C=要注意、D=要対策、—=確認不能
- `指摘種別`: 文面に使う指摘1点(https / dmarc / old_parts / headers / mixed)。優先順はこの順で、該当なしは空
- `指摘` `困ること`: 文面に差し込む文言
- `送信推奨`: はい=指摘があり総合判定がC・D・Eのもの。いいえ=送らない
- `本文`: 送信推奨が「はい」の行だけ、問い合わせフォームにそのまま貼れる文面
- `エラー`: 診断できなかった理由(URLなし等)。`診断日時`: 日本時間

### 4. 文面の編集
`templates/` のファイルを編集する(再実行で反映)。
- `findings.json`: 指摘ごとの「指摘」「困ること」の文言
- `outreach-west.txt` / `outreach-east.txt`: 西日本・東日本の本文。`{会社名}` などの `{}` 部分が差し込み項目
- `outreach-config.json`: 差出人会社・担当者名・電話・所在地・実績(`所在地`は `【所在地】` のままなので要入力。`実績` が空なら該当行は自動で消える)

テスト: `npm run test:batch`(ネットワーク不要)

### 5. 工場・建設向けの問い合わせ文面(B2B)
建設・製造・自動車整備の会社向けに、初回の問い合わせ文面(標準と短縮)と件名をつけて診断する。`--template b2b`。
```
# 倉庫から直接(WH_DB_* が必要。先に sql/warehouse_migrate_003.sql / 004.sql / 005.sql を適用)
node cli/batch-scan.js --source warehouse --prefecture 兵庫県 --main-category 製造,建設 --exclude-large --form-found \
  --template b2b --limit 2000 --out data/b2b_scan.csv

# 倉庫から取り出したCSV(Shift_JIS・11列)をそのまま使う場合
node cli/batch-scan.js --in data/promote_20261025.csv --template b2b --out data/b2b_scan.csv
```
- 倉庫の絞り込み: `--prefecture` `--main-category`(主業種のLIKE・カンマ区切り) `--exclude-large` `--small-only` `--form-found` `--limit`。「営業お断り」の記載があったフォーム(`form_no_sales=1`)は自動で外す。
- クレーム登録店の除外: STOC営業管理でクレーム登録された会社(`sales_logs.call_result='クレーム'`、または `store_flags` の未解除の「クレーム」フラグ)には営業をかけない。`--source warehouse` は `stoc_store_id` で営業管理と突き合わせて必ず外し、「クレーム登録で除外: N」を表示する(営業管理に未登録の店は対象外=通す)。DB名は既定 `stoc_sales`(`STOC_DB_NAME` で変更可)。倉庫DBユーザーに営業管理の読み取り権限がないと、黙ってスキップせず中止してエラーを出す。次を root で一度実行しておく(ユーザー名・ホストは `WH_DB_USER` に合わせる)。`warehouse-promote` は営業管理に未登録(`stoc_store_id IS NULL`)の店だけを出すので追加の除外は不要。
```
GRANT SELECT ON stoc_sales.sales_logs TO 'stoc_wh'@'localhost';
GRANT SELECT ON stoc_sales.store_flags TO 'stoc_wh'@'localhost';
```
- `--subject 1|2|3` で件名を固定(省略時は store_id で3種を巡回)。`--max-chars N` で、標準本文がN文字を超える行は短縮本文を使う(短縮も超えるなら「送らない:文字数超過」)。
- 初回に使う指摘は `templates/findings-b2b.json`(混在→https転送→証明書(期限切れ/30日以内)→古いJSライブラリ→CMS露出→ヘッダー→古いTLSの順)。Cookie・外部スクリプト・メールは初回には使わない。使える指摘がなければ「送らない:初回に使える指摘なし」。
- 末尾に追加される列: `業種区分` `件名` `本文文字数` `短縮本文` `使用本文`(標準/短縮) `問い合わせURL` `画像認証` `営業お断り`。`本文` は標準本文。
- 文面は `templates/outreach-b2b.txt` / `outreach-b2b-short.txt` / `outreach-b2b-subjects.txt`、差出人は `outreach-config.json`。
- 管理画面(`/admin/warehouse` の「取り出し」→ 工場・建設用)の「診断して文面も作る」ボタンで同じ処理を実行できる(同時5件・結果は `b2b_scan_<日時>.csv`)。1サイト1〜3秒で、2,000サイトでおよそ1時間前後。
- 営業お断りの検出: `node cli/find-forms.js --source warehouse ...` がフォームのページ(とトップ)の「営業お断り」の記載を `form_no_sales` に記録する。`warehouse-promote --form-found` も該当店を外し「営業お断りで除外: N」を表示。列がない(`sql/warehouse_migrate_004.sql` 未適用)ときは警告を出して絞り込みをスキップする。

#### 5-1b. 単一本文で送る(標準・推奨。結果がSTOC営業管理へ戻る)
全社同じ本文を1回の送信で送り、会社ごとの違いは送信ツールの差し込みタグで入れる方式。`--single-out <フォルダ>` を付ける(`--template b2b` のみ。`--group-out` とは併用不可。`--out` は省略可)。

```
node cli/batch-scan.js --source warehouse --prefecture 兵庫県 --main-category 製造,建設 --form-found \
  --template b2b --limit 2000 --single-out data/b2b_20261026 [--dry-run-stoc]
```
- 営業管理(STOC)に登録済みの会社(倉庫の `stoc_store_id` あり)だけが対象。未登録は「営業管理に未登録」で除外。クレーム・営業お断り・画像認証・フォームURLなし・指摘なしの除外は従来どおり。
- **STOCバッチの登録**: 診断のあと、STOC営業管理(`stoc_sales`)に `sender_YYYYmmdd_HHMMSS_xxxx` 形式のバッチを登録し(`inquiry_export_batches` / `inquiry_export_items`、`stores.exported_at` / `export_count` の更新まで1トランザクション)、そのコードを宛先CSVの7列目に入れる。送信ツールはこのコードと1列目(送信先URL)で結果をSTOCへ戻す。1バッチは最大5000社(超えたら複数バッチ)。`--dry-run-stoc` を付けるとDBには書かず、コードは `DRYRUN`(仮)になる(結果は戻らない。試し用)。`STOC_EXPORT_USER_ID`(任意)で `exported_by` を指定、`STOC_DB_NAME`(既定 `stoc_sales`)でDB名を変更。明細の `website_url` はSTOCの書き出しと同じく店舗のサイトURL(結果の突き合わせは `batch_code` + `website_url`)。送信ツールが結果を返すときのURLが送信先URL(1列目)の場合は一致しないので、その場合は `STOC_ITEM_WEBSITE_URL=form` を付けるとフォームURLを入れる。
- 書き込み権限は**診断を始める前に**確認し、足りなければ中止して次のGRANTを表示する。root で一度実行しておく(ユーザー名・ホストは `WH_DB_USER` / `WH_DB_HOST` に合わせる):
```
GRANT SELECT, INSERT ON stoc_sales.inquiry_export_batches TO 'stoc_wh'@'localhost';
GRANT SELECT, INSERT ON stoc_sales.inquiry_export_items TO 'stoc_wh'@'localhost';
GRANT SELECT ON stoc_sales.stores TO 'stoc_wh'@'localhost';
GRANT UPDATE (exported_at, export_count) ON stoc_sales.stores TO 'stoc_wh'@'localhost';
```
- **診断前の除外**(倉庫から選ぶ段階で外すので診断の時間もかからない。件数は `まとめ.txt` の「診断前に除外した会社」と `result.json` の `preExcluded` に出る。`--limit` は除外のあとに数える):
  - 「WEBドック送信済み・送信予定」: STOC営業管理で `inquiry_export_batches.filter_json` の `source` が `webdock_b2b` のバッチに、1回でも入っている店(`inquiry_export_items.store_id`。`send_status` は問わない)。再送信のオプションはない。読めなければ中止する(二重送信を防ぐため)。
  - 「除外ドメイン指定」: `rules/b2b_exclude_domains.txt`(1行1ドメイン・`#` でコメント)。サイトのホスト名がそのドメインと同じ、または `.<ドメイン>` で終わる(サブドメイン・`www.` 付きも)会社を外す。初期値は `autozam.jp` と `bunsen-kk.co.jp`。
  - 「チェーン・共通ドメイン」: サイトのホスト名(`www.` 除去・小文字)を、倉庫(全都道府県)の3店舗以上が使っている会社。`shops.site_host` 列を使うため、**移行 `sql/warehouse_migrate_005.sql` の適用と `node cli/warehouse-sitehost.js` の実行が必要**(下記)。列がないときは警告を出してこの除外だけスキップする。
  - 大きな会社は従来どおり `size_class`(`--exclude-large` / `--small-only`)で外す。
- 出力(`<フォルダ>/`):
  - `send_<バッチコード>.csv`: **送信ツール用**(UTF-8 BOM付き・9列・位置固定)。ヘッダーは `送信先URL,会社名,,レポートURL,業種,評価・口コミ,STOCバッチコード,電話番号,住所`。1=問い合わせフォームURL / 2=会社名 `[company]` / 3=指摘の一文 `[name]`(ヘッダーは空欄のまま。1社ごとの指摘がここに入る) / 4=ドメイン(`www.` 除去)`[param1]` / 5=閲覧者の文言(業種区分から)`[param2]` / 6=`評価4.2(口コミ15件)`(STOCと同じ書式・なければ空)`[param3]` / 7=バッチコード / 8=電話番号(STOCと同じ優先順) / 9=住所。
  - `本文.txt`: 全社共通の本文。`[company]` `[name]` `[param1]` `[param2]` はそのまま残す。差出人は `templates/outreach-config.json` から。
  - `確認用.csv`: `store_id,stoc_store_id,会社名,ドメイン,業種区分,指摘,一文,送信先URL,電話番号,住所,バッチコード`
  - `まとめ.txt`: 指摘別・除外理由別の件数、本文の文字数(典型的な値で置換)、送信前の確認事項
  - `result.json`: 管理画面用(登録したバッチコードなど)
- 指摘の一文は `templates/findings-b2b.json` の `一文`。業種区分は 整備 → 医療 → 製造 → 建設 → 美容 → 飲食 → その他の順で判定し、閲覧者の文言は `src/outreach.js` の `AUDIENCE`。
- 管理画面の「診断して文面も作る」はこの方式(`--single-out <書き出しフォルダ>/b2b_<日時>/`)を使う。終了後の作業画面に、本文(コピーボタン)・送信ツール用CSV・確認用・まとめのダウンロードと、登録したSTOCバッチコードが出る。**最初の100社は送る前に人が確認する。**


#### 5-1c. サイトのホスト名の列(移行005)とバックフィル
`shops.site_host`(サイトのホスト名。`www.` 除去・小文字)と索引 `idx_site_host` を足す。何度実行しても安全。約250万行への索引追加には数分かかることがある。
```
mysql < sql/warehouse_migrate_005.sql          # 列と索引を追加
node cli/warehouse-sitehost.js                 # 既存行の site_host を埋める(10000行ずつ。途中で止めても再実行で続きから)
```
- オプション: `--chunk N`(1回の行数)/ `--recompute`(値のある行も計算し直す)/ `--dry-run`(書かずに件数だけ)。URLからホスト名を取り出せない行は空文字を入れて処理済みにする。
- 以降の `node cli/warehouse-import.js` は新規・更新行の `site_host` を自動で入れる(列がなければ警告して従来どおり)。既存の `website_url` が埋まっている行は、バックフィルで直す。
- テスト: `npm run test:exclude`

#### 5-2. グループ別に送る(旧方式。STOCへ結果が戻らないため通常は使わない)
問い合わせの送信ツールが「1回の送信=全社まったく同じ本文」しか送れない場合は、`--group-out <フォルダ>` を付ける。各社に選ばれた指摘(1社1つ)ごとにグループ分けし、グループごとに固定の本文・件名・宛先CSVを作る。本文・件名・CSVには会社ごとの値は入らず、会社名とドメインは送信ツールの差し込み(差込)タグで入れる(下記)。
```
node cli/batch-scan.js --source warehouse --prefecture 兵庫県 --main-category 製造,建設 --exclude-large --form-found \
  --template b2b --limit 2000 --group-out data/b2b_20261025        # --out は省略可(省略時は <フォルダ>/scan_all.csv)
```
`--group-out` は `--template b2b` のときだけ使える。`--out` も併記すれば従来の1社1行CSVもそのまま出る。
- グループ(優先順): `mixed` → `https_redirect` → `cert_expired`(期限切れ) → `cert_soon`(30日以内) → `js_libs` → `cms` → `headers` → `tls_version`。1社は最優先の1グループにだけ入る。
- 出力(0社のグループは作らない):
  - `group_<グループ>_<件数>件.csv`: **送信ツール用**(STOC営業管理の書き出しと同じ9列・位置固定・UTF-8 BOM付き)。1行目は `送信先URL,会社名,,レポートURL,業種,評価・口コミ,STOCバッチコード,電話番号,住所`(http で始まらないので送信ツールは読み飛ばす)。1列目=問い合わせURL、2列目=会社名(`[company]`)、3列目=空欄、4列目=ドメイン(`www.` 除去。`[param1]`)、5列目=業種(`[param2]`)、6列目=空欄(`[param3]`)、7列目=バッチコード `WD-<グループ>-<YYYYMMDD>`(例 `WD-CERT-EXPIRED-20261025`)、8列目=電話番号、9列目=住所。7〜9列目は差し込まれず、結果の記録用(STOCの取り込みは電話番号で突き合わせる)。
  - `group_<グループ>_<件数>件_確認用.csv`: 送信前に人が見る用。列は `store_id,会社名,ドメイン,都道府県,業種区分,URL,問い合わせURL,画像認証,電話番号,住所`(UTF-8 BOM付き)
  - 送れない会社はグループに入れず、`まとめ.txt` に理由別の件数を出す: 問い合わせURLなし=「送信先URLなし」、画像認証あり(送信ツールが解けない)=「画像認証あり」
  - `group_<グループ>_本文.txt` / `group_<グループ>_本文_短縮.txt`: そのグループ全社に送る固定本文(標準/短縮)
  - `group_<グループ>_件名.txt`: 件名3候補(2番目は `「[param1]」の設定確認に関するご連絡` で、ドメインのタグが入る)
  - `まとめ.txt`: 優先順のグループ別の件数・標準/短縮の文字数、「送らない」会社の理由別件数、注意書き
- 手順: グループごとに1回ずつ送信ツールを動かす(CSV=宛先、本文=そのグループの本文)。**最初の100社は送る前に人が確認する。** 送る前に `まとめ.txt` を確認する。
- 本文は `templates/outreach-b2b-group.txt` / `outreach-b2b-group-short.txt`、件名は `outreach-b2b-group-subjects.txt`。使える差し込みは `{差込:会社名}` `{差込:ドメイン}`(送信ツール用の差し込みタグに置き換わる)と `{指摘}` `{困ること}` `{確認月}`(例:2026年10月)と `outreach-config.json` の項目だけ。指摘の文言は `findings-b2b.json`(`cert_soon` は `cert_expiring` の文言)。
- **差し込み(差込)**: 既定のタグは送信ツールの記法で、会社名=`[company]`、ドメイン=`[param1]`。本文の先頭は `[company] ご担当者様`、本文中に `「[param1]」`、件名にも `[param1]` が入る。
- **タグの記法を変える**: 送信ツールのタグが `[company]` `[param1]` 形式でないときは `templates/outreach-config.json` の `差し込みタグ` を書き換える(例: `"差し込みタグ": { "会社名": "%company%", "ドメイン": "%domain%" }`)。1回だけ変えるなら `--merge-tags '{"会社名":"%company%","ドメイン":"%domain%"}'`(JSON。設定ファイルより優先)。本文・件名ファイルの `{差込:会社名}` `{差込:ドメイン}` がその文字列に置き換わって出力される。管理画面からは設定できないので設定ファイルを使う。
- 管理画面の「診断して文面も作る」は `--group-out <書き出しフォルダ>/b2b_<日時>/` も自動で付ける。終了後の作業画面に、グループごとの送信ツール用CSV・確認用CSV・件名・本文のダウンロードと、本文の表示+「コピー」ボタンが出る(「取り出し」画面の一覧からもあとで取れる)。

テスト: `npm run test:b2b`

## 問い合わせフォーム事前調査(フォーム探し)

営業先の公式サイトを通常の訪問者と同じように見て(トップページ+問い合わせページ候補を最大3つ、1サイト最大4ページ)、問い合わせフォームの有無とURL、公開されているメールアドレス(mailto等)、InstagramプロフィールURLを記録するバックグラウンド処理です。送信時間帯に関係なくいつでも動かせます。**フォームの送信・入力は一切しません**(ページを取得して読むだけ)。取得は既存の安全な取得処理(`src/safeFetch.js`)を使うため、URL・IPの安全規則もそのまま適用されます。robots.txtで禁止されている候補ページは取得しません。

結果は営業DB(`stoc_sales`)の既存テーブルに書き込みます。
- `store_contact_channels`: `inquiry_status`(`url_found` / `no_form`)、確認日時、メール・Instagramの発見状況。`sent` `confirmed` `failed` は上書きしません。
- `contact_channel_candidates`: 見つかった問い合わせURL(`inquiry_url`)とメール(`email`)を `source='finder'` で追加。以前finderが記録した別URLは `is_active=0` にします(他の登録元の行は触りません)。

### 1. 権限を絞ったDBユーザーを作る

```sql
CREATE USER 'stoc_finder'@'localhost' IDENTIFIED BY '（強いパスワード）';
GRANT SELECT ON stoc_sales.stores TO 'stoc_finder'@'localhost';
GRANT SELECT, INSERT, UPDATE ON stoc_sales.store_contact_channels TO 'stoc_finder'@'localhost';
GRANT SELECT, INSERT, UPDATE ON stoc_sales.contact_channel_candidates TO 'stoc_finder'@'localhost';
```

`.env` に次を設定します(未設定の項目は括弧内の既定値)。

```
FINDER_DB_HOST=127.0.0.1
FINDER_DB_PORT=3306
FINDER_DB_USER=stoc_finder
FINDER_DB_PASS=（上で決めたパスワード）
FINDER_DB_NAME=stoc_sales
```

### 2. 最初はお試し実行(DBには書き込まない)

```
node cli/find-forms.js --dry-run --limit 50 --out data/forms-sample.csv
```

`data/forms-sample.csv`(Excelで開けます)を開き、「結果」「問い合わせURL」「種類」「画像認証」を目で確認します。問題なければ本番へ進みます。

### 3. 本番実行

```
node cli/find-forms.js --limit 2000                         # 2000件だけDBへ書き込み
pm2 start cli/find-forms.js --name form-finder -- --loop    # 常駐。500件ずつ処理し、対象がなくなると30分待って再確認
```

主なオプション: `--concurrency 5`(同時処理数)、`--prefecture 兵庫県`(都道府県で絞る)、`--recheck-days 90`(「フォームなし」を再調査するまでの日数)、`--error-retry-days 7`(エラーで状態が決まらなかったサイトを再試行するまでの日数)。同じドメインの店舗(チェーン店など)は1回だけ調べて全店舗に反映します。Ctrl+C(SIGINT)で新規の取得を止め、処理中のものが終わってから終了します。

### 4. 件数の確認

```
mysql stoc_sales -e "SELECT inquiry_status, COUNT(*) FROM store_contact_channels GROUP BY inquiry_status;"
```

テスト: `npm run test:finder`(ネットワーク・DB不要)

## 倉庫(全国データ)

営業アプリ(`stoc_sales`)を軽く保つため、全国の収集データ(約400万件)は別DB `stoc_master`(倉庫)にすべて置き、営業に使う分だけをCSVで営業アプリの既存CSV取り込み画面から入れます。倉庫の店舗は Google の CID で重複判定します(CIDがない行は 電話番号+屋号 のハッシュで判定)。

### 1. 初回セットアップ(1回だけ)

```
mysql < sql/warehouse_schema.sql
```

`sql/warehouse_schema.sql` の末尾にあるコメントのSQLを、パスワードを決めて root で実行し、専用ユーザー `stoc_wh` を作ります(`stoc_master` の全権限と `stoc_sales.stores` の参照のみ)。`.env` に次を追加します。

```
WH_DB_HOST=127.0.0.1
WH_DB_PORT=3306
WH_DB_USER=stoc_wh
WH_DB_PASS=（決めたパスワード）
```

### 2. データをサーバーへ上げる(Windows の PowerShell)

```
Compress-Archive -Path 'H:\…\全国データ\*' -DestinationPath "$HOME\Desktop\gmp_all.zip"
scp "$HOME\Desktop\gmp_all.zip" root@162.43.32.37:/var/data/gmp/
```

サーバー側(日本語ファイル名の文字化けを防ぐため `-O cp932` を付けます):

```
mkdir -p /var/data/gmp && cd /var/data/gmp && unzip -q -O cp932 gmp_all.zip -d all
```

### 3. 取り込み

まずお試し(DBには書き込まず、ファイルごとの件数だけ表示):

```
cd /path/to/webdock
npm run wh:import -- --root /var/data/gmp/all --dry-run
```

問題なければ本番(何度実行しても二重登録されず、既存店舗は最終確認日時などが更新されます):

```
npm run wh:import -- --root /var/data/gmp/all
```

取り込みの最後に、営業アプリに同じCIDの店舗があれば `stoc_store_id` が自動で入ります(単独実行: `--link-only`)。件数の確認:

```
mysql stoc_master -e "SELECT prefecture, COUNT(*) FROM shops GROUP BY prefecture;"
mysql stoc_master -e "SELECT COUNT(*) AS 全件, SUM(stoc_store_id IS NOT NULL) AS 営業アプリ登録済み, SUM(promoted_at IS NOT NULL) AS 出力済み FROM shops;"
mysql stoc_master -e "SELECT * FROM import_runs ORDER BY id DESC LIMIT 5;"
```

### 4. 営業アプリへ入れるCSVを作る

営業アプリに未登録(`stoc_store_id` が空)かつ未出力の店舗だけを、口コミ数の多い順に書き出します。出力は元データと同じ11列(Shift_JIS・カンマ区切り)なので、営業アプリの既存CSV取り込み画面にそのまま使えます。

```
npm run wh:promote -- --out data/promote_20261024.csv --prefecture 東京都,神奈川県 --category 美容院,ネイル --has-website --limit 5000 --mark
```

- `--category` は部分一致(カンマ区切りはOR)、`--has-website` はホームページありのみ、`--form-found` は問い合わせフォーム発見済みのみ
- `--mark` を付けると書き出した店舗に出力済みの印が付き、次回以降は重複して出力されません(付けなければ何度でも同じ結果を出せます)
- できた CSV を営業アプリの CSV取り込み画面からアップロードします

### 倉庫でフォーム探し(地域ごと)

営業アプリを軽く保つため、倉庫(`stoc_master.shops`)の店舗に対して地域ごとにフォーム探しを走らせ、**フォームが見つかった店舗だけ**を営業アプリへ入れます。結果は倉庫の `form_status`(`unknown` / `url_found` / `no_form` / `error` / `needs_browser`=JSで作られたサイトなどブラウザ確認が必要)、`form_url`、`form_kind`(onsite/external)、`form_captcha`、`form_note`、`form_checked_at` に書き、メール・Instagramは倉庫側が空のときだけ補います。フォームの送信・入力は一切しません。

1. 一度だけ、倉庫に列と索引を足します(何度実行しても安全)。

```
mysql < sql/warehouse_migrate_002.sql
```

2. 後で営業アプリへ引き継ぐため、root で `stoc_wh` に権限を足します(一度だけ)。

```sql
GRANT SELECT, INSERT, UPDATE ON stoc_sales.store_contact_channels TO 'stoc_wh'@'localhost';
GRANT SELECT, INSERT, UPDATE ON stoc_sales.contact_channel_candidates TO 'stoc_wh'@'localhost';
FLUSH PRIVILEGES;
```

3. 大阪府を別のpm2プロセスとして常駐させます(接続は倉庫と同じ `.env` の `WH_DB_*`。営業アプリ用の `form-finder` とは別です)。

```
pm2 start cli/find-forms.js --name form-finder-wh --cwd /var/www/webdock -- --source warehouse --prefecture 大阪府 --loop --concurrency 5 && pm2 save
```

   - 対象はホームページのある店舗で、口コミ数の多い順に処理します。未調査のほか、`error` は `--error-retry-days`(既定7日)後、`no_form` は `--recheck-days`(既定90日)後に再調査します。`needs_browser` は既定では再調査せず、`--retry-needs-browser` を付けたときだけ `--error-retry-days` 後に再試行します。
   - `--prefecture 大阪府,京都府` のようにカンマで複数指定できます。お試しは `--dry-run --limit 50 --out data/forms-wh.csv`(DBには書きません。CSVの `store_id` 列は倉庫の `shops.id`)。

4. 進み具合の確認:

```
mysql stoc_master -e "SELECT form_status, COUNT(*) FROM shops WHERE prefecture='大阪府' AND website_url IS NOT NULL GROUP BY form_status;"
```

5. フォームが見つかった店舗だけCSVにし、営業アプリのCSV取り込み画面から入れます。

```
npm run wh:promote -- --prefecture 大阪府 --form-found --out data/promote_osaka.csv --mark
```

   統計行に「書き出し対象: N(うちフォームあり M)」と出ます。

6. 営業アプリへの取り込みが終わったら、見つかったフォームURL(とメール・Instagram)を営業アプリへ引き継ぎます。これで営業アプリの書き出しがすぐフォームURLを使えます。

```
node cli/warehouse-import.js --link-only --carry-forms
```

   `stoc_store_id` で紐付いた `url_found` の店舗について、`contact_channel_candidates` に `source='finder'` で追加し、`store_contact_channels` の `inquiry_status` を `url_found` にします(`sent` `confirmed` `failed` は上書きしません。メール・Instagramも未設定のときだけ)。何度実行しても結果は同じです。権限が足りないときは必要な `GRANT` を表示します。通常の取り込み(`--root`)に `--carry-forms` を付けると、取り込みの最後に同じ処理をします。


### 会社の規模チェック(従業員数・資本金・上場)

従業員が多い会社にはIT担当者がいて成約しにくいため、各社のホームページの「会社概要」ページから従業員数・資本金・上場の記載を読み取り、倉庫に記録して、取り込みCSVから大きい会社を外せます。ページを見る(GET)だけで、フォームの送信はしません。robots.txt を守り、フォーム探しで取得済みのページを使い回すので、1サイトの追加取得は最大2ページです。

1. 一度だけ、倉庫に列と索引を足します(何度実行しても安全。先に002が必要)。

```
mysql < sql/warehouse_migrate_003.sql
```

2. 規模もあわせて調べます(`--with-size`)。お試しはCSVだけ出す dry-run:

```
node cli/find-forms.js --source warehouse --prefecture 兵庫県 --category 製造,建設,工事 --with-size --dry-run --limit 50 --out data/size-sample.csv
```

   - `--category` は業種(`category`)にいずれかの語を含む店舗だけ(カンマ区切り・OR)。通常の倉庫モードでも使えます。
   - `--max-employees 30`(既定30。2026-10 社内方針: 30名くらいまでが対象): この人数以下を `small`、超えると `large`、会社概要から人数が読めなければ上場・資本金1億円以上で `large`、それ以外は `unknown`。
   - 結果は `employees` / `capital_yen` / `listed` / `size_class` / `size_note` / `profile_url` / `size_checked_at` 列へ。dry-run のCSVには 従業員数・資本金・上場・規模・会社概要URL の列が付きます。

3. フォーム探しは済んでいて規模だけ調べたいときは `--size-only`(`size_checked_at` が空でホームページのある店舗が対象。`form_*` 列は触りません。`--loop` / `--limit` / `--dry-run` / `--concurrency` も同様に使えます):

```
node cli/find-forms.js --source warehouse --prefecture 兵庫県 --category 製造,建設,工事 --size-only --loop
```

3b. `form_no_sales` を入れる前に `url_found` になった既存フォームも「営業お断り」を確認します(`--no-sales-only`。`sql/warehouse_migrate_004.sql` が必要)。`form_status='url_found'` で `form_no_sales` が未判定(NULL)の店舗について、フォームのページだけを取得して `form_no_sales` を 0/1 で書き、お断りありなら `form_note` に「営業お断りの記載あり」を追記します(他の列は触りません)。取得失敗・robots.txt除外はNULLのままで、同じ周回では再試行しません。`--prefecture` / `--category` / `--limit` / `--loop` / `--dry-run` / `--concurrency` は同様に使え、`--size-only` / `--with-size` とは併用できません。dry-run のCSVは store_id・店名・都道府県・問い合わせURL・営業お断り・備考:

```
node cli/find-forms.js --source warehouse --prefecture 兵庫県 --no-sales-only --loop
```

4. 営業アプリ用CSVを作るときに規模で絞ります(CSVの形式は変わりません):

```
node cli/warehouse-promote.js --out data/promote.csv --prefecture 兵庫県 --exclude-large   # 大きい会社(large)を外す。未調査・不明は残る
node cli/warehouse-promote.js --out data/promote.csv --prefecture 兵庫県 --small-only      # 小規模(small)と確認できた会社だけ
```

   **工場・建設など(WEBドック・UTM用)を出すときは `--no-rules` を付けてください。** 既定の「問い合わせ営業」ルールはMEO用で、製造業者・金属加工業・運送会社・倉庫・卸売業・工場などを除外するためです。例:
   `node cli/warehouse-promote.js --out data/b2b.csv --prefecture 兵庫県 --main-category 製造,加工,建設,工事,工務店 --small-only --no-rules`

   find-forms の `--category` は主業種(category_main)で絞ります(副業種まで見ると飲食店などが混ざるため)。promote で主業種だけで絞るときは `--main-category`(従来の `--category` は副業種も含めて探します)。

   上場の判定は「上場市場」「証券コード」などの項目欄(と文中の「証券コード:1234」)だけを読みます。文章中の「東証」は取引先紹介のことが多いため読みません。

   読み取りは目安です。表記ゆれで外れることがあるので、最初は dry-run のCSVで `従業員数` の文字(`employeesText` 相当)と会社概要URLを目で確認してください。テストは `npm run test:size`(DB不要)。

### 倉庫の管理画面(ブラウザで操作 / `/admin/warehouse`)

取り込み・CSV作成・営業管理とのひも付け・件数確認を、コマンドなしでブラウザからできます。**会社のIPアドレスからしか開けません**(それ以外は 404)。

`.env` に次を追加します(**2つとも**設定したときだけ有効。どちらかが空なら `/admin` は全部 404):

```
WAREHOUSE_ADMIN_PASS=（8文字以上の合言葉）
ADMIN_ALLOW_IPS=（会社のグローバルIP。複数ならカンマ区切り）
# 省略可（既定値）
WAREHOUSE_UPLOAD_DIR=/var/data/gmp/uploads
WAREHOUSE_EXPORT_DIR=/var/www/webdock/data/exports
```

アップロードは大きいので、nginx の `/admin/` だけ上限を上げます(`express.urlencoded` の上限はアップロードに関係しません)。会社のIP制限は nginx 側にも二重にかけます:

```nginx
location /admin/ {
  allow 203.0.113.10;   # ← 会社のIPに書き換える
  deny all;
  client_max_body_size 300m;
  proxy_read_timeout 600s;
  proxy_pass http://127.0.0.1:3020;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

- アプリは「同じ機械(127.0.0.1)のnginxから来た接続」の `X-Real-IP` だけを信用します。外から直接つないだ相手が `X-Forwarded-For` を偽っても無視されます(それでもポート3020は外に公開しないでください)。
- 初回だけ: `npm install`、`mkdir -p /var/data/gmp/uploads`(アプリを動かすユーザーが書き込める権限)、`pm2 restart webdock --update-env`、`nginx -t && systemctl reload nginx`。
- 取り込みは、`gmp_*.csv` または .zip をアップロード → 自動で `warehouse-import` を実行(最後に営業管理とのひも付けも自動)。「営業管理とつなぐ」ボタンは、営業管理へCSVを入れた後にフォームURL・メールを引き継ぐ処理です。
- テスト: `npm run test:admin`(DB不要)

### 収集ツールの元ファイル(14列)の取り込みと閉業店の扱い

収集ツールが出力した14列の元ファイル(`緯度（世界測地系）`・`経度（世界測地系）`・`開閉店情報`・`掲載元URL` を含む)は、加工せずそのまま `--root` に置いて取り込めます。列は見出しの名前で判定します。`開閉店情報` は取り込みのたびに最新の内容へ更新され(空欄なら空に戻る)、業種は全体を `category`、先頭の1つを `category_main` に保存します。営業管理へ入れるCSVの業種は、リスツールでの整形と同じく**先頭の1つだけ**を出力します。**リスツールでの整形は不要です**(元ファイルをそのまま取り込めば、整形に当たる処理は倉庫側で行います)。

営業用CSVの書き出し(`wh:promote`)は、`開閉店情報` に「閉業」「閉店」を含む店舗を初期状態で除外します(「臨時休業」「一時休業」は除外しません)。含めたいときは `--include-closed` を付けます。

倉庫を `開閉店情報` の対応前に作成済みの場合は、一度だけ次を実行します(何度実行しても安全です)。

```
mysql < sql/warehouse_migrate_001.sql
```

### 除外ルール(リスツールの条件)

営業アプリ用CSVを書き出すとき(`wh:promote`)に、これまでリスツールで行っていた除外・重複除去を自動で適用します。倉庫そのものには**全件を残します**(Instagram DM やTOCの訪問営業など、別の用途で別のルールを使えるようにするため)。

- ルールは `rules/<名前>.json`。既定は `rules/問い合わせ営業.json`(`--rules <名前>` で切替、`--no-rules` で無効)。
- 屋号・業種・登録URL・電話番号に、キーワードが**含まれていたら除外**(リスツールと同じ完全一致の部分一致、大文字小文字を区別、末尾の空白も含めて照合)。業種は先頭の1つだけで判定します。注意: 屋号のキーワード「店」があるため「○○工務店」のような屋号も除外されます(リスツールと同じ動き)。
- 電話番号が同じ店舗は口コミ数が多い1件だけ残します(`--no-dedupe-phone` で無効。電話番号が空の行はすべて残す)。
- `--limit` はルール除外・重複除去のあとの件数です。`--mark` は実際に書き出した行だけに印を付けます。
- 除外される件数だけ先に見るには `--report-only` (CSVは作らず、走査数・除外数・除外理由の上位20キーワード・重複除去数を表示):

```
npm run wh:promote -- --prefecture 長崎県 --report-only
```

新しい .listt からルールを作り直す:

```
npm run wh:rules -- --from rules/source/GMAPSTOC.listt --name 問い合わせ営業
```

取り込み時の注意: 整形後のファイル(`nagasaki.csv` など)が元ファイル(`gmp_*.csv`)と同じフォルダにあるため、`--pattern "gmp_*.csv"`(ファイル名に対するワイルドカード `*` `?`、大文字小文字無視)を付けて元ファイルだけ取り込みます。元ファイルは UTF-8 です(Shift_JIS も自動判定)。

```
npm run wh:import -- --root /var/data/gmp/all --pattern "gmp_*.csv"
```

テスト: `npm run test:warehouse` と `npm run test:rules`(DB不要)、DBテストは **stoc_master と stoc_sales を削除して作り直すため、本番サーバーでは絶対に実行しないこと**(テスト専用環境で `WEBDOCK_DB_TEST_OK=1 node test/warehouse.db.test.js`。本番サーバー上・実データがある場合は自動で中止する安全装置あり)


**社内判断の上書き**: `rules/問い合わせ営業.overrides.json` に、.listt を作り直しても消えない判断を書きます(現在: 屋号の「店」は除外しない/電話番号が無い店は除外)。`remove` で条件を外し、`add` で足し、`excludeEmpty` で「空欄なら除外」を指定します。
