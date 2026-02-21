/**
 * modules/auth.js — Radiko 認証モジュール
 *
 * Rajiko 設計参照:
 *   - genRandomDeviceInfo(): Android 端末情報をランダム生成して偽装
 *   - retrieveToken(): Auth1/Auth2 に GPS 座標を付与してエリアを確定
 *   - トークン有効期間は約 70 分（Rajiko 準拠）
 */

import { APP_KEY_MAP, GPS_COORDINATES, VERSION_MAP, RADIKO_APP_VERSION } from "./static.js";

const AUTH1_URL = "https://radiko.jp/v2/api/auth1";
const AUTH2_URL = "https://radiko.jp/v2/api/auth2";

// トークン有効期間 (70 分)
export const TOKEN_TTL_MS = 70 * 60 * 1000;

// ストレージキー
export const SK = {
  TOKEN:      "radiko_auth_token",
  AREA_ID:    "radiko_area_id",
  AREA_INFO:  "radiko_area_info",
  TOKEN_TIME: "radiko_token_timestamp",
  DEVICE:     "radiko_device_info",
  PREF_AREA:  "radiko_preferred_area", // ユーザー選択エリア
};

// ─── デバイス情報生成 ─────────────────────────────────────────────────────────

/**
 * Android 端末情報をランダムに生成する。
 * Rajiko の genRandomInfo() 相当。
 * @returns {{ userId: string, appVersion: string, device: string, userAgent: string }}
 */
export function genRandomDeviceInfo() {
  // 16 文字のランダム hex 文字列をユーザー ID として使用
  const userId = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join("");

  const ver = VERSION_MAP[Math.floor(Math.random() * VERSION_MAP.length)];

  // X-Radiko-Device: "<sdkVersion>_<buildNumber>" 形式
  const device    = `${ver.sdkVersion}_${ver.buildNumber}`;
  const userAgent = `radiko/${RADIKO_APP_VERSION} (Android; ${ver.androidVersion}; ${ver.buildNumber})`;

  return { userId, appVersion: RADIKO_APP_VERSION, device, userAgent };
}

// ─── 認証フロー ───────────────────────────────────────────────────────────────

/**
 * Auth1 / Auth2 フローを実行し AuthToken とエリア情報を返す。
 *
 * Rajiko との差分:
 *   - Auth2 に X-Radiko-Location (緯度,経度,精度) を追加
 *   - これにより IP ではなく GPS でエリアが確定し、
 *     エリア外でも指定都道府県として認証される
 *
 * @param {ReturnType<genRandomDeviceInfo>} deviceInfo
 * @param {string} areaId  例: "JP13" — 希望するエリア
 * @returns {Promise<{ authToken: string, areaId: string, areaInfo: string }>}
 */
export async function retrieveToken(deviceInfo, areaId = "JP13") {
  const { userId, appVersion, device, userAgent } = deviceInfo;
  const [lat, lng] = GPS_COORDINATES[areaId] ?? GPS_COORDINATES["JP13"];

  // ── Auth1 ─────────────────────────────────────────────────────────────────
  const r1 = await fetch(AUTH1_URL, {
    method: "GET",
    headers: {
      "X-Radiko-App":         "pc_html5",
      "X-Radiko-App-Version": appVersion,
      "X-Radiko-User":        userId,
      "X-Radiko-Device":      device,
      "User-Agent":           userAgent,
    },
  });

  if (!r1.ok) throw new Error(`auth1 failed: HTTP ${r1.status}`);

  const authToken = r1.headers.get("X-Radiko-AuthToken");
  // Rajiko は declarativeNetRequest でレスポンスヘッダーを書き換えて常に 0 にするが、
  // ここでは実際の値を読み取る（Rajiko 方式も将来的に rules.js で実装可能）
  const keyOffset = parseInt(r1.headers.get("X-Radiko-KeyOffset") ?? "0", 10);
  const keyLength = parseInt(r1.headers.get("X-Radiko-KeyLength") ?? "16", 10);

  if (!authToken) throw new Error("auth1: X-Radiko-AuthToken がレスポンスにありません");

  console.log("[auth] auth1 OK — offset:", keyOffset, "length:", keyLength);

  // ── PartialKey 生成 ───────────────────────────────────────────────────────
  const rawKey    = APP_KEY_MAP["pc_html5"];
  const partial   = rawKey.substring(keyOffset, keyOffset + keyLength);
  const partialKey = btoa(partial);

  // ── Auth2 ─────────────────────────────────────────────────────────────────
  // X-Radiko-Location: "緯度,経度,精度" — GPS でエリアを強制指定
  const r2 = await fetch(AUTH2_URL, {
    method: "GET",
    headers: {
      "X-Radiko-App":         "pc_html5",
      "X-Radiko-App-Version": appVersion,
      "X-Radiko-User":        userId,
      "X-Radiko-Device":      device,
      "X-Radiko-AuthToken":   authToken,
      "X-Radiko-PartialKey":  partialKey,
      "X-Radiko-Connection":  "wifi",
      "X-Radiko-Location":    `${lat},${lng},130`,
      "User-Agent":           userAgent,
    },
  });

  if (!r2.ok) throw new Error(`auth2 failed: HTTP ${r2.status}`);

  // レスポンス例: "JP13,東京都,tokyo Japan\r\n"
  const areaInfo     = (await r2.text()).trim();
  const detectedArea = areaInfo.split(",")[0]; // "JP13"

  console.log("[auth] auth2 OK — area:", areaInfo);
  return { authToken, areaId: detectedArea, areaInfo };
}

// ─── ストレージ経由のトークン管理 ────────────────────────────────────────────

/**
 * ストレージのキャッシュが有効なら返し、期限切れなら再認証する。
 * @param {string} [preferredAreaId]  ユーザー選択エリア（省略時はストレージ値 or JP13）
 * @returns {Promise<{ authToken: string, areaId: string, areaInfo: string }>}
 */
export async function loadOrRefreshToken(preferredAreaId) {
  const stored = await chrome.storage.local.get([
    SK.TOKEN, SK.AREA_ID, SK.AREA_INFO, SK.TOKEN_TIME, SK.DEVICE, SK.PREF_AREA,
  ]);

  const areaId = preferredAreaId
    ?? stored[SK.PREF_AREA]
    ?? "JP13";

  const age = Date.now() - (stored[SK.TOKEN_TIME] ?? 0);

  if (stored[SK.TOKEN] && age < TOKEN_TTL_MS) {
    console.log("[auth] キャッシュトークンを使用 (残り", Math.round((TOKEN_TTL_MS - age) / 60000), "分)");
    return {
      authToken: stored[SK.TOKEN],
      areaId:    stored[SK.AREA_ID],
      areaInfo:  stored[SK.AREA_INFO],
    };
  }

  // 期限切れ or 未取得 → 再認証
  let deviceInfo = stored[SK.DEVICE];
  if (!deviceInfo) {
    deviceInfo = genRandomDeviceInfo();
    // デバイス情報は永続化（セッションをまたいで同一デバイスに見せる）
    await chrome.storage.local.set({ [SK.DEVICE]: deviceInfo });
  }

  const result = await retrieveToken(deviceInfo, areaId);

  await chrome.storage.local.set({
    [SK.TOKEN]:      result.authToken,
    [SK.AREA_ID]:    result.areaId,
    [SK.AREA_INFO]:  result.areaInfo,
    [SK.TOKEN_TIME]: Date.now(),
  });

  return result;
}
