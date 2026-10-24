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
