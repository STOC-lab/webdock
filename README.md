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
   - `--max-employees 20`(既定20): この人数以下を `small`、超えると `large`、会社概要から人数が読めなければ上場・資本金1億円以上で `large`、それ以外は `unknown`。
   - 結果は `employees` / `capital_yen` / `listed` / `size_class` / `size_note` / `profile_url` / `size_checked_at` 列へ。dry-run のCSVには 従業員数・資本金・上場・規模・会社概要URL の列が付きます。

3. フォーム探しは済んでいて規模だけ調べたいときは `--size-only`(`size_checked_at` が空でホームページのある店舗が対象。`form_*` 列は触りません。`--loop` / `--limit` / `--dry-run` / `--concurrency` も同様に使えます):

```
node cli/find-forms.js --source warehouse --prefecture 兵庫県 --category 製造,建設,工事 --size-only --loop
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
