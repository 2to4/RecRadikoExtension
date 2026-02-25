# RecRadiko — CLAUDE.md

Radiko のタイムフリー放送を AAC ファイルとしてダウンロードする **Safari Web Extension (MV3)**。
macOS コンテナアプリ (SwiftUI) + JavaScript 拡張機能の構成。
設計は Firefox 拡張機能 [Rajiko](https://github.com/jackyzy823/rajiko) を参考にしている。

現行バージョン: **0.2.0**

---

## ディレクトリ構成

```
RecRadikoExtension/
├── CLAUDE.md                              # このファイル（AI 向けガイド）
├── project.yml                            # XcodeGen 設定（唯一の管理ファイル）
├── App/
│   ├── Resources/
│   │   └── Assets.xcassets/               # アプリアイコン等アセット
│   │       ├── AppIcon.appiconset/
│   │       └── Contents.json
│   └── Sources/
│       ├── RecRadikoApp.swift             # @main SwiftUI エントリポイント
│       └── ContentView.swift              # Safari 設定を開くボタン UI
├── Extension/
│   ├── Info.plist                         # XcodeGen が自動生成（直接編集しない）
│   ├── Sources/
│   │   └── SafariWebExtensionHandler.swift  # ネイティブメッセージハンドラ（現在はプレースホルダー）
│   └── Resources/                         # Web Extension 本体
│       ├── manifest.json                  # MV3 マニフェスト（v0.2.0）
│       ├── background.js                  # Service Worker（ES Module 形式）
│       ├── content.js                     # radiko.jp ページ情報抽出
│       ├── popup.html / popup.js          # 拡張機能ポップアップ UI
│       └── modules/
│           ├── static.js                  # 定数（RULE_IDS, APP_KEY_MAP, GPS座標, VERSION_MAP, IGNORELIST）
│           ├── auth.js                    # Radiko 認証フロー
│           ├── rules.js                   # declarativeNetRequest ルール管理
│           └── timeshift.js               # タイムフリーダウンロードエンジン
```

> **注意**: `RecRadiko.xcodeproj` は `project.yml` から生成されるため Git 管理不要。
> `Extension/Info.plist` も XcodeGen が生成するので直接編集しない（`project.yml` の `info:` セクションを編集する）。

---

## ビルドコマンド

```bash
# Xcode プロジェクトを再生成（project.yml を変更したら必ず実行）
xcodegen generate

# ビルド確認（コード署名なし・Debug 設定）
xcodebuild -scheme RecRadiko -configuration Debug \
  CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO build

# Xcode で開く
open RecRadiko.xcodeproj
```

### Debug / Release 署名の違い

| 設定 | Debug | Release |
|------|-------|---------|
| `CODE_SIGN_STYLE` | Manual | Automatic |
| `CODE_SIGN_IDENTITY` | `-`（ad-hoc、Apple ID 不要） | `Apple Development` |
| `DEVELOPMENT_TEAM` | （不要） | `3KYQYNYN7U` |
| `ENABLE_HARDENED_RUNTIME` | NO | YES |

---

## モジュール依存関係

```
background.js (Service Worker / ES Module)
  ├── modules/auth.js       — loadOrRefreshToken(), genRandomDeviceInfo()
  ├── modules/rules.js      — updatePlayerRules(), updateAuthRules()
  └── modules/timeshift.js  — downloadTimefree()
       └── modules/static.js — 定数（全モジュールが import）

content.js   — popup.js と background.js の両方からメッセージを受信
popup.js     — background.js と content.js へメッセージを送信（非 ES Module）
```

`popup.js` は `<script src="popup.js">` で読み込まれる非モジュール形式。
`static.js` の定数（`AREA_NAMES` など）は popup.js にインラインコピーが必要。

---

## manifest.json 概要

```json
{
  "manifest_version": 3,
  "version": "0.2.0",
  "permissions": [
    "declarativeNetRequest",
    "declarativeNetRequestWithHostAccess",
    "storage", "alarms", "downloads", "tabs"
  ],
  "host_permissions": [
    "https://radiko.jp/*",
    "https://*.radiko.jp/*",
    "https://*.smartstream.ne.jp/*",
    "https://*.radiko-cf.com/*"
  ]
}
```

- `declarativeNetRequestWithHostAccess`: ホスト権限付きのヘッダー書き換えに必要
- コンテンツスクリプトは `https://radiko.jp/*` と `https://*.radiko.jp/*` に `document_idle` で注入

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
     ヘッダー: X-Radiko-User, X-Radiko-Device, X-Radiko-App, X-Radiko-App-Version, User-Agent
     → X-Radiko-AuthToken, X-Radiko-KeyOffset, X-Radiko-KeyLength を取得

  2. PartialKey = btoa( APP_KEY.substring(offset, offset+length) )
     APP_KEY = "bcd151073c03b352e1ef2fd66c32209da9ca0afa"  (pc_html5)

  3. Auth2 GET https://radiko.jp/v2/api/auth2
     送信: X-Radiko-AuthToken, X-Radiko-PartialKey
     ★ X-Radiko-Location: "<lat>,<lng>,130"  (GPS_COORDINATES[areaId] でエリア強制)
     → レスポンス例: "JP13,東京都,tokyo Japan"

loadOrRefreshToken(preferredAreaId)
  → キャッシュが 70 分未満なら再利用
  → デバイス情報は chrome.storage.local に永続化（セッション間で同一デバイスに見せる）
```

トークン有効期間は **70分**（`TOKEN_TTL_MS = 4_200_000`）。
65分ごとの Alarm（`chrome.alarms`）でバックグラウンド自動再認証。

---

## declarativeNetRequest ルール構造

### ルール ID 体系（static.js の RULE_IDS）

| 定数 | ID | 用途 |
|------|----|------|
| `AUTH1` | 5002 | AUTH1 リクエストへのデバイス情報注入 |
| `AUTH2` | 5003 | AUTH2 リクエストへのデバイス情報注入 |
| `AUTH_FETCH` | 5004 | （予約済み・現在未使用） |
| `RADIO_BASE` | 20000〜 | HLS プレイヤーへの AuthToken + AreaId 注入 |

### プレイヤールール（updatePlayerRules）

```javascript
// PLAYER_URL_FILTERS の各パターン（4件）に対して 1 ルールを登録（ID: 20000〜20003）
{
  id: RULE_IDS.RADIO_BASE + i,   // 20000, 20001, 20002, 20003
  priority: 1,
  action: {
    type: "modifyHeaders",
    requestHeaders: [
      { header: "X-Radiko-AuthToken", operation: "set", value: token },
      { header: "X-Radiko-AreaId",    operation: "set", value: areaId },
    ]
  },
  condition: {
    urlFilter: "||radiko.jp/v2/api/ts/",   // 各フィルターで異なる
    resourceTypes: ["xmlhttprequest", "media", "other"]
  }
}
```

`"media"` リソースタイプの指定が HLS セグメントへの注入に必須。

### 認証ルール（updateAuthRules）

```javascript
// AUTH1 (5002) / AUTH2 (5003) の 2 ルールを登録・更新
// priority: 2（プレイヤールールより高優先度）
requestHeaders: [
  { header: "X-Radiko-User",   operation: "set", value: userId },
  { header: "X-Radiko-Device", operation: "set", value: device },
]
// 補助的な用途（fetch() 内でも直接ヘッダー指定しているため冗長）
```

### IGNORELIST（removeHeaders 対象）

```javascript
// auth リクエスト等で削除するヘッダー（サーバー側で拒否される可能性があるもの）
export const IGNORELIST = [
  "accept-language", "cookie", "referer",
  "x-radiko-user", "x-radiko-device",
];
```

---

## タイムフリーダウンロード処理（timeshift.js）

```
downloadTimefree({ stationId, startTime, endTime, authToken, areaId })
  │
  Phase 1: M3U8 チャンク収集
  │  startTime → endTime を FIXED_SEEK_SEC (300秒) 単位で分割
  │  各チャンクで GET /v2/api/ts/playlist.m3u8?ft=...&to=...
  │    ヘッダー: X-Radiko-AuthToken, X-Radiko-AreaId
  │  parseM3U8() で # 以外の行をセグメント URL として抽出
  │
  Phase 2: セグメント並列フェッチ（MAX_WORKERS = 6）
  │  fetchSegments() → Promise プール（同時実行数上限 6）
  │  各セグメントをフェッチ → parseAAC() で ID3 タグを除去
  │  ID3 識別: 先頭が 0x49 0x44 0x33 ("ID3") の場合、
  │            synchsafe integer でサイズ計算してスキップ
  │
  Phase 3: 結合 → ダウンロード
     new Blob(buffers, { type: "audio/aac" })
     buildFilename(stationId, startTime)
       → "RADIKO_<STATION>_<YYYYMMDD>_<HHMMSS>.aac"
     chrome.downloads.download({ url: blobUrl, filename })
     setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)  // Safari 対策で遅延 revoke
```

### ユーティリティ関数（timeshift.js）

| 関数 | 説明 |
|------|------|
| `ab2str(buf)` | ArrayBuffer → 文字列（64KB チャンク分割で大バッファ対応） |
| `str2ab(str)` | 文字列 → ArrayBuffer |
| `parseAAC(buffer)` | ArrayBuffer から ID3 タグを除去して AAC-ADTS 部分を返す |
| `parseM3U8(text)` | M3U8 テキストからセグメント URL 一覧を返す（`#` 行を除外） |
| `fetchM3U8Chunk(stationId, ft, to, token, areaId)` | 指定時間範囲のプレイリストを取得 |
| `fetchSegments(urls, token, areaId, onProgress)` | セグメントを MAX_WORKERS 並列フェッチ |
| `addSeconds(timeStr, seconds)` | "YYYYMMDDHHMMSS" に秒数を加算 |
| `diffSeconds(start, end)` | 2 つの時刻文字列の差分（秒）を返す |
| `buildFilename(stationId, startTime)` | ダウンロードファイル名を生成 |

---

## Service Worker キープアライブ（background.js）

MV3 Service Worker は **30秒** 無操作で終了する。ダウンロード中は延命が必要。

```javascript
// ダウンロード開始時: startKeepAlive()
//   → 20秒ごとに chrome.storage.session.set({ keepAlive: Date.now() })
// ダウンロード完了時: stopKeepAlive()
```

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

## content.js — URL パース仕様

```javascript
// タイムフリー:  https://radiko.jp/#!/ts/TBS/20240101120000
// ライブ:        https://radiko.jp/#!/live/TBS
// SPA ナビゲーション: hashchange イベントで再解析
```

`GET_PAGE_INFO` メッセージに応答して `{ type, stationId, startTime }` を返す。

---

## 既知の制限と注意点

| 項目 | 内容 |
|------|------|
| `User-Agent` 書き換え | Safari の declarativeNetRequest では不可。auth.js の `fetch()` 内で直接ヘッダー指定している |
| Blob URL の即時 revoke | Safari でダウンロードが失敗する。60秒後に revoke |
| dynamicRules 上限 | Safari は 100件制限。PLAYER_URL_FILTERS × 1ルール = 4件で最小化 |
| 番組終了時刻 | タイムフリー URL に含まれない場合は popup.js で +60分で仮計算（不正確）。番組情報 API から取得が正確 |
| popup.js は非 ES Module | `import` 不可。`static.js` の `AREA_NAMES` をインラインコピーしている |
| Safari MV3 動作確認 | `modifyHeaders` の `"media"` リソースタイプが Safari で機能するか **要検証** |
| `AUTH_FETCH` (5004) | `RULE_IDS` に定義済みだが `rules.js` では未使用（将来の fetch 傍受用に予約） |

---

## XcodeGen project.yml の変更手順

1. `project.yml` を編集
2. `xcodegen generate` を実行
3. `Extension/Info.plist` は自動更新される（直接編集しない）
4. バンドル ID の変更時は `ContentView.swift` の `extensionBundleId` も合わせる

### ターゲット構成

| ターゲット | バンドル ID | 種別 |
|-----------|------------|------|
| RecRadiko | com.recradiko.app | macOS Application |
| RecRadikoExtension | com.recradiko.app.extension | Safari App-Extension |

両ターゲットのバージョン: `0.2.0 (Build 1)` / デプロイ対象: macOS 13.0+

---

## 参照

- **Rajiko** (設計参考): https://github.com/jackyzy823/rajiko
- Safari Web Extension: https://developer.apple.com/documentation/safariservices/safari-web-extensions
- declarativeNetRequest: https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest
