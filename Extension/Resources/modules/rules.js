/**
 * modules/rules.js — declarativeNetRequest ルール管理
 *
 * Rajiko 設計参照:
 *   - updatePlayerRules(): AuthToken + AreaId の両方をヘッダーへ注入
 *   - PLAYER_URL_FILTERS: CDN を含む複数 URL パターンへ同時に適用
 *   - RULE_IDS で用途別に ID を分離し衝突を防ぐ
 *
 * 【Safari MV3 検証ポイント】
 *   updateDynamicRules() の modifyHeaders が
 *   "xmlhttprequest" / "media" / "other" 各リソースタイプで
 *   正しく動作するかを Safari DevTools で確認する。
 */

import { RULE_IDS, PLAYER_URL_FILTERS } from "./static.js";

// ─── プレイヤー用ルール（AuthToken + AreaId 注入） ──────────────────────────

/**
 * HLS プレイヤーリクエストに X-Radiko-AuthToken と X-Radiko-AreaId を注入する。
 *
 * Rajiko との差分:
 *   - 局ごとの個別ルールではなく、PLAYER_URL_FILTERS でまとめて 1 ルールずつ適用。
 *   - Safari の dynamicRules 上限（100 件）を考慮してルール数を最小化。
 *
 * @param {string} authToken
 * @param {string} areaId  例: "JP13"
 */
export async function updatePlayerRules(authToken, areaId) {
  // 既存の RADIO_BASE ルールを全削除
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeIds = existingRules
    .filter(r => r.id >= RULE_IDS.RADIO_BASE)
    .map(r => r.id);

  const addRules = PLAYER_URL_FILTERS.map((urlFilter, i) => ({
    id:       RULE_IDS.RADIO_BASE + i,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "X-Radiko-AuthToken", operation: "set", value: authToken },
        { header: "X-Radiko-AreaId",    operation: "set", value: areaId },
      ],
    },
    condition: {
      urlFilter,
      resourceTypes: ["xmlhttprequest", "media", "other"],
    },
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds, addRules });

  console.log("[rules] プレイヤールール更新 —", addRules.length, "件 / areaId:", areaId);
}

// ─── 認証エンドポイント用ルール ──────────────────────────────────────────────

/**
 * auth1 / auth2 リクエストに Android 端末情報ヘッダーを付与するルール。
 *
 * 【Safari 注意】
 *   declarativeNetRequest で User-Agent を上書きできないブラウザがある。
 *   その場合は fetch() 内で直接ヘッダーを指定する（auth.js で実施済み）。
 *   このルールは補助的な用途として登録する。
 *
 * @param {string} userId
 * @param {string} device
 */
export async function updateAuthRules(userId, device) {
  const removeIds = [RULE_IDS.AUTH1, RULE_IDS.AUTH2];

  const commonHeaders = [
    { header: "X-Radiko-User",   operation: "set", value: userId },
    { header: "X-Radiko-Device", operation: "set", value: device },
  ];

  const addRules = [
    {
      id:       RULE_IDS.AUTH1,
      priority: 2,
      action:   { type: "modifyHeaders", requestHeaders: commonHeaders },
      condition: {
        urlFilter:     "https://radiko.jp/v2/api/auth1",
        resourceTypes: ["xmlhttprequest"],
      },
    },
    {
      id:       RULE_IDS.AUTH2,
      priority: 2,
      action:   { type: "modifyHeaders", requestHeaders: commonHeaders },
      condition: {
        urlFilter:     "https://radiko.jp/v2/api/auth2",
        resourceTypes: ["xmlhttprequest"],
      },
    },
  ];

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds, addRules });
  console.log("[rules] 認証ルール更新");
}

// ─── 全ルール削除（デバッグ・リセット用） ────────────────────────────────────

export async function clearAllRules() {
  const rules  = await chrome.declarativeNetRequest.getDynamicRules();
  const ids    = rules.map(r => r.id);
  if (ids.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
  }
  console.log("[rules] 全ルール削除:", ids);
}

// ─── デバッグ: 現在のルール一覧を返す ────────────────────────────────────────

export async function getDynamicRules() {
  return chrome.declarativeNetRequest.getDynamicRules();
}
