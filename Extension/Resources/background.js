/**
 * background.js — RecRadiko Service Worker (エントリポイント)
 *
 * MV3 Service Worker は 30 秒無操作で終了する。
 * ダウンロード中は keepAlive() で storage 書き込みにより延命する（Rajiko 設計参照）。
 */

import { loadOrRefreshToken, SK }   from "./modules/auth.js";
import { updatePlayerRules,
         updateAuthRules,
         getDynamicRules }          from "./modules/rules.js";
import { downloadTimefree }         from "./modules/timeshift.js";

// ─── Service Worker キープアライブ ────────────────────────────────────────────
// Rajiko: 20 秒ごとに storage 書き込みでアクティビティを維持

let keepAliveTimer = null;

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    chrome.storage.session.set({ keepAlive: Date.now() });
  }, 20_000);
  console.log("[SW] キープアライブ開始");
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
    console.log("[SW] キープアライブ停止");
  }
}

// ─── 初期化 ──────────────────────────────────────────────────────────────────

async function init(forceReauth = false) {
  try {
    if (forceReauth) {
      await chrome.storage.local.remove([SK.TOKEN, SK.TOKEN_TIME]);
    }

    const { authToken, areaId } = await loadOrRefreshToken();

    // declarativeNetRequest ルールを両方更新
    const stored = await chrome.storage.local.get([SK.DEVICE]);
    const device = stored[SK.DEVICE];
    if (device) {
      await updateAuthRules(device.userId, device.device);
    }
    await updatePlayerRules(authToken, areaId);

    console.log("[SW] 初期化完了 — areaId:", areaId);
  } catch (err) {
    console.error("[SW] 初期化エラー:", err);
  }
}

// ─── ライフサイクル ───────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log("[SW] インストール");
  chrome.alarms.create("reauth", { periodInMinutes: 65 });
  init(true); // インストール時は強制再認証
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[SW] 起動");
  init();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "reauth") {
    console.log("[SW] 定期再認証");
    await init(true);
  }
});

// ─── メッセージハンドラ ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch(err => {
    console.error("[SW] message error:", err);
    sendResponse({ success: false, error: err.message });
  });
  return true; // 非同期応答
});

async function handleMessage(msg) {
  switch (msg.type) {

    // ── ステータス取得 ──────────────────────────────────────────────────────
    case "GET_STATUS": {
      const stored = await chrome.storage.local.get([
        SK.TOKEN, SK.AREA_ID, SK.AREA_INFO, SK.TOKEN_TIME,
      ]);
      const rules = await getDynamicRules();
      return {
        token:       stored[SK.TOKEN]      ?? null,
        areaId:      stored[SK.AREA_ID]    ?? null,
        areaInfo:    stored[SK.AREA_INFO]  ?? null,
        tokenAgeMs:  stored[SK.TOKEN_TIME] ? Date.now() - stored[SK.TOKEN_TIME] : null,
        ruleCount:   rules.length,
        rules,
      };
    }

    // ── 強制再認証 ─────────────────────────────────────────────────────────
    case "REAUTH": {
      await init(true);
      const stored = await chrome.storage.local.get([SK.TOKEN, SK.AREA_ID, SK.AREA_INFO]);
      return {
        success:  !!stored[SK.TOKEN],
        token:    stored[SK.TOKEN]   ?? null,
        areaId:   stored[SK.AREA_ID] ?? null,
        areaInfo: stored[SK.AREA_INFO] ?? null,
      };
    }

    // ── エリア変更 ─────────────────────────────────────────────────────────
    case "SET_AREA": {
      await chrome.storage.local.set({ [SK.PREF_AREA]: msg.areaId });
      await init(true); // 新エリアで再認証
      const stored = await chrome.storage.local.get([SK.TOKEN, SK.AREA_ID, SK.AREA_INFO]);
      return {
        success:  !!stored[SK.TOKEN],
        areaId:   stored[SK.AREA_ID] ?? null,
        areaInfo: stored[SK.AREA_INFO] ?? null,
      };
    }

    // ── タイムフリーダウンロード ────────────────────────────────────────────
    case "DOWNLOAD_TIMEFREE": {
      const { stationId, startTime, endTime } = msg;
      if (!stationId || !startTime || !endTime) {
        throw new Error("stationId / startTime / endTime が必要です");
      }

      const { authToken, areaId } = await loadOrRefreshToken();

      startKeepAlive(); // ダウンロード中は SW を延命

      try {
        await downloadTimefree({
          stationId,
          startTime,
          endTime,
          authToken,
          areaId,
          onProgress: (phase, done, total) => {
            // popup へ進捗を通知（接続中なら届く）
            chrome.runtime.sendMessage({
              type: "DOWNLOAD_PROGRESS",
              phase, done, total,
            }).catch(() => {}); // popup が閉じていても無視
          },
        });
        return { success: true };
      } finally {
        stopKeepAlive();
      }
    }

    // ── ストリーム URL 取得（デバッグ用） ───────────────────────────────────
    case "GET_STREAM_URL": {
      const { stationId, startTime, endTime } = msg;
      const params = new URLSearchParams({
        station_id: stationId,
        l:          "15",
        ft:         startTime,
        to:         endTime,
      });
      return { streamUrl: `https://radiko.jp/v2/api/ts/playlist.m3u8?${params}` };
    }

    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}
