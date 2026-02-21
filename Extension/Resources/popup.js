/**
 * popup.js — RecRadiko ポップアップ UI ロジック
 * popup.html から <script src="popup.js"> で読み込まれる（非モジュール）。
 *
 * AREA_NAMES は static.js と同じ内容をインライン定義（popup は ES Module 非対応のため）。
 */

"use strict";

// ─── エリア名テーブル（static.js のコピー） ────────────────────────────────
const AREA_NAMES = {
  JP01:"北海道",JP02:"青森",  JP03:"岩手",  JP04:"宮城",  JP05:"秋田",
  JP06:"山形",  JP07:"福島",  JP08:"茨城",  JP09:"栃木",  JP10:"群馬",
  JP11:"埼玉",  JP12:"千葉",  JP13:"東京",  JP14:"神奈川",JP15:"新潟",
  JP16:"富山",  JP17:"石川",  JP18:"福井",  JP19:"山梨",  JP20:"長野",
  JP21:"岐阜",  JP22:"静岡",  JP23:"愛知",  JP24:"三重",  JP25:"滋賀",
  JP26:"京都",  JP27:"大阪",  JP28:"兵庫",  JP29:"奈良",  JP30:"和歌山",
  JP31:"鳥取",  JP32:"島根",  JP33:"岡山",  JP34:"広島",  JP35:"山口",
  JP36:"徳島",  JP37:"香川",  JP38:"愛媛",  JP39:"高知",  JP40:"福岡",
  JP41:"佐賀",  JP42:"長崎",  JP43:"熊本",  JP44:"大分",  JP45:"宮崎",
  JP46:"鹿児島",JP47:"沖縄",
};

// ─── DOM ヘルパー ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ─── エリア選択プルダウンを構築 ──────────────────────────────────────────────
(function buildAreaSelect() {
  const sel = $("area-select");
  for (const [id, name] of Object.entries(AREA_NAMES)) {
    const opt = document.createElement("option");
    opt.value       = id;
    opt.textContent = `${id} — ${name}`;
    sel.appendChild(opt);
  }
})();

// ─── UI 更新 ─────────────────────────────────────────────────────────────────

function renderAuthStatus(status) {
  const badge = $("auth-badge");
  if (status?.token) {
    badge.textContent = "認証済";
    badge.className   = "badge ok";
  } else {
    badge.textContent = "未認証";
    badge.className   = "badge err";
  }

  // エリア表示 (例: "JP13,東京都,tokyo Japan" → "東京都 (JP13)")
  if (status?.areaInfo) {
    const parts = status.areaInfo.split(",");
    $("area-info").textContent = `${parts[1] ?? "—"} (${parts[0] ?? "—"})`;
  } else {
    $("area-info").textContent = "—";
  }

  // トークン経過時間
  if (status?.tokenAgeMs != null) {
    const mins = Math.round(status.tokenAgeMs / 60_000);
    $("token-age").textContent = `${mins} 分前`;
  } else {
    $("token-age").textContent = "—";
  }

  // declarativeNetRequest ルール状態
  const ruleCount = status?.ruleCount ?? 0;
  $("rule-status").textContent = ruleCount > 0
    ? `✓ ${ruleCount} 件 注入中`
    : "✗ 未登録";
  $("rule-status").className = "val " + (ruleCount > 0 ? "rule-on" : "rule-off");

  // エリアプルダウンを現在値に合わせる
  if (status?.areaId) {
    $("area-select").value = status.areaId;
  }

  // デバッグ欄
  $("debug-pre").textContent = JSON.stringify(status?.rules ?? [], null, 2);
}

function renderPageInfo(info) {
  if (!info) {
    $("station-id").textContent    = "(タイムフリーページを開いてください)";
    $("broadcast-type").textContent = "—";
    $("row-start-time").style.display = "none";
    $("row-end-time").style.display   = "none";
    $("btn-download").disabled = true;
    return;
  }

  $("station-id").textContent    = info.stationId ?? "—";
  $("broadcast-type").textContent = info.type === "timefree" ? "タイムフリー" : "ライブ";

  if (info.type === "timefree" && info.startTime) {
    $("row-start-time").style.display = "";
    $("start-time").textContent = fmtTime(info.startTime);

    // 終了時刻：Radiko の番組情報 API から本来取得すべきだが、
    // プロトタイプでは URL に含まれる場合のみ表示、なければ空欄
    if (info.endTime) {
      $("row-end-time").style.display = "";
      $("end-time").textContent = fmtTime(info.endTime);
    } else {
      $("row-end-time").style.display = "none";
    }

    $("btn-download").disabled = false;
  } else {
    $("row-start-time").style.display = "none";
    $("row-end-time").style.display   = "none";
    $("btn-download").disabled = true;
  }
}

function fmtTime(t) {
  if (!t || t.length !== 14) return t ?? "—";
  return `${t.slice(0,4)}/${t.slice(4,6)}/${t.slice(6,8)} `
       + `${t.slice(8,10)}:${t.slice(10,12)}:${t.slice(12,14)}`;
}

// ─── 進捗 ────────────────────────────────────────────────────────────────────

function showProgress(phase, done, total) {
  $("progress-wrap").style.display = "";
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  $("progress-fill").style.width = pct + "%";
  const label = phase === "playlist"
    ? `プレイリスト取得中… (${done}/${total}秒)`
    : `セグメントDL中… ${done}/${total} (${pct}%)`;
  $("progress-label").textContent = label;
}

function hideProgress() {
  $("progress-wrap").style.display = "none";
}

// ─── データ取得 ──────────────────────────────────────────────────────────────

async function fetchStatus() {
  return chrome.runtime.sendMessage({ type: "GET_STATUS" }).catch(() => null);
}

async function fetchPageInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  return chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_INFO" }).catch(() => null);
}

// ─── 初期化 ──────────────────────────────────────────────────────────────────

async function init() {
  const [status, pageInfo] = await Promise.all([fetchStatus(), fetchPageInfo()]);
  renderAuthStatus(status);
  renderPageInfo(pageInfo);
}

init();

// ─── ダウンロード進捗リスナー ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "DOWNLOAD_PROGRESS") {
    showProgress(msg.phase, msg.done, msg.total);
  }
});

// ─── ボタンイベント ───────────────────────────────────────────────────────────

$("btn-reauth").addEventListener("click", async () => {
  $("btn-reauth").disabled = true;
  $("auth-badge").textContent = "認証中…";
  $("auth-badge").className   = "badge wait";
  const result = await chrome.runtime.sendMessage({ type: "REAUTH" }).catch(() => null);
  renderAuthStatus(result);
  $("btn-reauth").disabled = false;
});

$("btn-set-area").addEventListener("click", async () => {
  const areaId = $("area-select").value;
  $("btn-set-area").disabled = true;
  $("auth-badge").textContent = "変更中…";
  $("auth-badge").className   = "badge wait";
  const result = await chrome.runtime.sendMessage({ type: "SET_AREA", areaId }).catch(() => null);
  const status = await fetchStatus();
  renderAuthStatus(status);
  $("btn-set-area").disabled = false;
});

$("btn-download").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const pageInfo = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_INFO" }).catch(() => null);
  if (!pageInfo || pageInfo.type !== "timefree") return;

  // 終了時刻が URL にない場合は 60 分後を仮設定
  const endTime = pageInfo.endTime ?? addMinutes(pageInfo.startTime, 60);

  $("btn-download").disabled = true;
  showProgress("playlist", 0, 1);

  const result = await chrome.runtime.sendMessage({
    type:      "DOWNLOAD_TIMEFREE",
    stationId: pageInfo.stationId,
    startTime: pageInfo.startTime,
    endTime,
  }).catch(err => ({ success: false, error: err.message }));

  hideProgress();
  $("btn-download").disabled = false;

  if (!result?.success) {
    alert("ダウンロード失敗: " + (result?.error ?? "不明なエラー"));
  }
});

// ─── ユーティリティ ───────────────────────────────────────────────────────────

function addMinutes(timeStr, minutes) {
  if (!timeStr || timeStr.length !== 14) return timeStr;
  const dt = new Date(Date.UTC(
    +timeStr.slice(0, 4), +timeStr.slice(4, 6) - 1, +timeStr.slice(6, 8),
    +timeStr.slice(8, 10), +timeStr.slice(10, 12) + minutes, +timeStr.slice(12, 14),
  ));
  return [
    dt.getUTCFullYear(),
    String(dt.getUTCMonth() + 1).padStart(2, "0"),
    String(dt.getUTCDate()).padStart(2, "0"),
    String(dt.getUTCHours()).padStart(2, "0"),
    String(dt.getUTCMinutes()).padStart(2, "0"),
    String(dt.getUTCSeconds()).padStart(2, "0"),
  ].join("");
}
