# RecRadiko — CLAUDE.md

Radiko のタイムフリー放送を AAC ファイルとしてダウンロードする **Safari Web Extension (MV3)**。
macOS コンテナアプリ (SwiftUI) + JavaScript 拡張機能の構成。
設計は Firefox 拡張機能 [Rajiko](https://github.com/jackyzy823/rajiko) を参考にしている。

---

## ディレクトリ構成

```
RecRadikoExtension/
├── project.yml                        # XcodeGen 設定（唯一の管理ファイル）
├── App/
│   └── Sources/
│       ├── RecRadikoApp.swift         # @main SwiftUI エントリポイント
│       └── ContentView.swift          # Safari 設定を開くボタン UI
├── Extension/
│   ├── Info.plist                     # XcodeGen が自動生成（直接編集しない）
│   ├── Sources/
│   │   └── SafariWebExtensionHandler.swift  # ネイティブメッセージハンドラ（現在はプレースホルダー）
│   └── Resources/                     # Web Extension 本体
│       ├── manifest.json              # MV3 マニフェスト
│       ├── background.js              # Service Worker（モジュール形式）
│       ├── content.js                 # radiko.jp ページ情報抽出
│       ├── popup.html / popup.js      # 拡張機能ポップアップ UI
│       └── modules/
│           ├── static.js              # 定数（RULE_IDS, APP_KEY_MAP, GPS座標, VERSION_MAP）
│           ├── auth.js                # Radiko 認証フロー
│           ├── rules.js               # declarativeNetRequest ルール管理
│           └── timeshift.js           # タイムフリーダウンロードエンジン
```

---

## ビルドコマンド

```bash
# Xcode プロジェクトを再生成（project.yml を変更したら必ず実行）
xcodegen generate

# ビルド確認（コード署名なし）
xcodebuild -scheme RecRadiko -configuration Debug \
  CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO build

# Xcode で開く
open RecRadiko.xcodeproj
```

**注意**: `RecRadiko.xcodeproj` は `project.yml` から生成されるため Git 管理不要。
`Extension/Info.plist` も XcodeGen が生成するので直接編集しない（`project.yml` の `info:` セクションを編集する）。

---

## モジュール依存関係

```
background.js (Service Worker)
  ├── modules/auth.js       — loadOrRefreshToken(), genRandomDeviceInfo()
  ├── modules/rules.js      — updatePlayerRules(), updateAuthRules()
  └── modules/timeshift.js  — downloadTimefree()
       └── modules/static.js — 定数（全モジュールが import）

content.js   — popup.js と background.js の両方からメッセージを受信
popup.js     — background.js と content.js へメッセージを送信（非 ES Module）
```

`popup.js` は `<script src="popup.js">` で読み込まれる非モジュール形式。
`static.js` の定数（AREA_NAMES など）は popup.js にインラインコピーが必要。

---

## 認証フロー

Rajiko 設計に準拠。Android デバイスを偽装して GPS でエリアを強制指定する。

```
genRandomDeviceInfo()
  └── userId: 16文字ランダム hex
      device: "<sdkVersion>_<buildNumber>"  (VERSION_MAP からランダム)
      userAgent: "radiko/7.5.0 (Android; 14.0.0; ...)"

retrieveToken(deviceInfo, areaId)
  1. Auth1 GET https://radiko.jp/v2/api/auth1
     → X-Radiko-AuthToken, X-Radiko-KeyOffset, X-Radiko-KeyLength を取得

  2. PartialKey = btoa( APP_KEY.substring(offset, offset+length) )
     APP_KEY = "bcd151073c03b352e1ef2fd66c32209da9ca0afa"  (pc_html5)

  3. Auth2 GET https://radiko.jp/v2/api/auth2
     送信: X-Radiko-AuthToken, X-Radiko-PartialKey
     ★ X-Radiko-Location: "35.689488,139.691706,130"  (GPS 座標でエリア強制)
     → レスポンス: "JP13,東京都,tokyo Japan"
```

トークン有効期間は **70分**（`TOKEN_TTL_MS`）。
デバイス情報は `chrome.storage.local` に永続化（セッション間で同一デバイスに見せる）。

---

## declarativeNetRequest ルール構造

### ルール ID 体系（static.js の RULE_IDS）

| ID | 用途 |
|----|------|
| 5002 | AUTH1 リクエストへのデバイス情報注入 |
| 5003 | AUTH2 リクエストへのデバイス情報注入 |
| 20000〜 | HLS プレイヤーへの AuthToken + AreaId 注入 |

### プレイヤールール（updatePlayerRules）

```javascript
// PLAYER_URL_FILTERS の各パターン（4件）に対して 1 ルールを登録
{
  action: {
    type: "modifyHeaders",
    requestHeaders: [
      { header: "X-Radiko-AuthToken", operation: "set", value: token },
      { header: "X-Radiko-AreaId",    operation: "set", value: areaId },
    ]
  },
  condition: {
    urlFilter: "||radiko.jp/v2/api/ts/",
    resourceTypes: ["xmlhttprequest", "media", "other"]
  }
}
```

`"media"` リソースタイプの指定が HLS セグメントへの注入に必須。

---

## タイムフリーダウンロード処理（timeshift.js）

```
downloadTimefree({ stationId, startTime, endTime, authToken, areaId })
  │
  Phase 1: M3U8 チャンク収集
  │  startTime → endTime を FIXED_SEEK_SEC (300秒) 単位で分割
  │  各チャンクで GET /v2/api/ts/playlist.m3u8?ft=...&to=...
  │  → M3U8 からセグメント URL を抽出（# で始まらない行）
  │
  Phase 2: セグメント並列フェッチ（MAX_WORKERS = 6）
  │  各セグメントをフェッチ → parseAAC() で ID3 タグを除去
  │  ID3 識別: 先頭が 0x49 0x44 0x33 ("ID3") の場合、synchsafe integer でサイズ計算してスキップ
  │
  Phase 3: 結合 → ダウンロード
     new Blob(buffers, { type: "audio/aac" })
     chrome.downloads.download({ url: blobUrl, filename: "RADIKO_TBS_20240101_120000.aac" })
     setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)  // Safari 対策で遅延 revoke
```

---

## Service Worker キープアライブ（background.js）

MV3 Service Worker は **30秒** 無操作で終了する。ダウンロード中は延命が必要。

```javascript
// ダウンロード開始時: startKeepAlive()
//   → 20秒ごとに chrome.storage.session.set({ keepAlive: Date.now() })
// ダウンロード完了時: stopKeepAlive()
```

---

## 既知の制限と注意点

| 項目 | 内容 |
|------|------|
| `User-Agent` 書き換え | Safari の declarativeNetRequest では不可。auth.js の fetch() 内で直接ヘッダー指定している |
| Blob URL の即時 revoke | Safari でダウンロードが失敗する。60秒後に revoke |
| dynamicRules 上限 | Safari は 100件制限。PLAYER_URL_FILTERS × 1ルール = 4件で最小化 |
| 番組終了時刻 | タイムフリー URL に含まれない場合は +60分で仮計算（不正確）。番組情報 API から取得が正確 |
| popup.js は非 ES Module | `import` 不可。static.js の AREA_NAMES をインラインコピーしている |
| Safari MV3 動作確認 | `modifyHeaders` の `"media"` リソースタイプが Safari で機能するか **要検証** |

---

## メッセージ API（background.js）

| type | 送信元 | 内容 |
|------|--------|------|
| `GET_STATUS` | popup.js | token, areaId, areaInfo, tokenAgeMs, ruleCount, rules を返す |
| `REAUTH` | popup.js | 強制再認証（ストレージを削除してから init）|
| `SET_AREA` | popup.js | エリアを変更して再認証 |
| `DOWNLOAD_TIMEFREE` | popup.js | stationId, startTime, endTime でダウンロード開始 |
| `GET_STREAM_URL` | popup.js | デバッグ用にストリーム URL を生成して返す |
| `PAGE_INFO` | content.js | ページ遷移時に放送局情報を通知（background は現在保存のみ）|
| `GET_PAGE_INFO` | popup.js | content.js からページ情報を取得 |
| `DOWNLOAD_PROGRESS` | background.js | ダウンロード進捗を popup に通知（phase, done, total）|

---

## XcodeGen project.yml の変更手順

1. `project.yml` を編集
2. `xcodegen generate` を実行
3. `Extension/Info.plist` は自動更新される（直接編集しない）
4. バンドル ID の変更時は `ContentView.swift` の `extensionBundleId` も合わせる

---

## 参照

- **Rajiko** (設計参考): https://github.com/jackyzy823/rajiko
- Safari Web Extension: https://developer.apple.com/documentation/safariservices/safari-web-extensions
- declarativeNetRequest: https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest
