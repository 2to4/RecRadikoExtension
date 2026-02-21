/**
 * content.js — radiko.jp ページで動作するコンテンツスクリプト
 *
 * 役割:
 *   - 現在の URL からタイムフリー / ライブ放送の情報を抽出
 *   - SPA (hashchange) によるナビゲーション変化を検知
 *   - popup.js からの問い合わせ (GET_PAGE_INFO) に応答
 */

(function () {
  "use strict";

  // ─── URL パーサ ──────────────────────────────────────────────────────────────

  /**
   * radiko.jp の URL ハッシュから放送情報を抽出する。
   *
   * タイムフリー: https://radiko.jp/#!/ts/TBS/20240101120000
   * ライブ:       https://radiko.jp/#!/live/TBS
   *
   * @returns {PageInfo|null}
   *
   * @typedef {{ type: "timefree", stationId: string, startTime: string } |
   *            { type: "live",     stationId: string } |
   *            null} PageInfo
   */
  function parseCurrentPage() {
    const hash = location.hash; // 例: "#!/ts/TBS/20240101120000"

    // タイムフリー
    const tsMatch = hash.match(/^#!\/ts\/([A-Z0-9_-]+)\/(\d{14})/i);
    if (tsMatch) {
      return {
        type:      "timefree",
        stationId: tsMatch[1].toUpperCase(),
        startTime: tsMatch[2],
      };
    }

    // ライブ
    const liveMatch = hash.match(/^#!\/live\/([A-Z0-9_-]+)/i);
    if (liveMatch) {
      return {
        type:      "live",
        stationId: liveMatch[1].toUpperCase(),
      };
    }

    return null;
  }

  // ─── background への通知 ──────────────────────────────────────────────────────

  function notifyPageInfo(info) {
    if (!info) return;
    chrome.runtime.sendMessage({ type: "PAGE_INFO", pageInfo: info });
  }

  // ─── 初回チェック & SPA ナビゲーション監視 ────────────────────────────────────

  let lastHash = "";

  function checkAndNotify() {
    if (location.hash === lastHash) return;
    lastHash = location.hash;
    const info = parseCurrentPage();
    notifyPageInfo(info);
  }

  // 初回
  checkAndNotify();

  // hashchange: Radiko は SPA で hash ベースルーティングを使用
  window.addEventListener("hashchange", checkAndNotify);

  // ─── popup.js からの問い合わせに応答 ─────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "GET_PAGE_INFO") {
      sendResponse(parseCurrentPage());
      return true;
    }
  });

})();
