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
