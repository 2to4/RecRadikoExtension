/**
 * modules/timeshift.js — タイムフリーダウンロードモジュール
 *
 * Rajiko 設計参照:
 *   - FIXED_SEEK_SEC (300秒) 単位で m3u8 をチャンク取得
 *   - parseAAC(): 各セグメントの ID3 タグを除去して純粋な AAC-ADTS を抽出
 *   - fetchSegments(): 最大 MAX_WORKERS 並列でセグメントをダウンロード
 *   - ab2str() / str2ab(): ArrayBuffer ↔ string 変換（拡張 storage への保存用）
 *   - Blob({ type: "audio/aac" }) で結合 → chrome.downloads.download()
 */

import { FIXED_SEEK_SEC, MAX_WORKERS } from "./static.js";

// ─── バイナリ ↔ 文字列変換 ───────────────────────────────────────────────────
// chrome.storage は文字列/JSON のみ保存可能なため変換が必要

/**
 * ArrayBuffer → バイナリ文字列
 * @param {ArrayBuffer} buf
 * @returns {string}
 */
export function ab2str(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  // 64KB ずつ処理（大きな引数で call stack overflow を防ぐ）
  const chunk = 65536;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return s;
}

/**
 * バイナリ文字列 → ArrayBuffer
 * @param {string} s
 * @returns {ArrayBuffer}
 */
export function str2ab(s) {
  const buf  = new ArrayBuffer(s.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < s.length; i++) {
    view[i] = s.charCodeAt(i) & 0xff;
  }
  return buf;
}

// ─── ID3 タグ除去 ─────────────────────────────────────────────────────────────

/**
 * HLS セグメントの先頭に付与された ID3 タグを取り除き、
 * AAC-ADTS フレームの開始位置以降のデータを返す。
 *
 * Rajiko の parseAAC() 相当。
 * ID3v2 フォーマット:
 *   [0-2]  : "ID3"
 *   [3-4]  : バージョン
 *   [5]    : フラグ
 *   [6-9]  : サイズ（synchsafe integer、各バイトの MSB を無視した 28bit 値）
 *   [10..] : タグ内容
 * AAC-ADTS フレームは 0xFF 0xF1 または 0xFF 0xF9 で始まる。
 *
 * @param {ArrayBuffer} buffer
 * @returns {ArrayBuffer}
 */
export function parseAAC(buffer) {
  const view   = new DataView(buffer);
  let   offset = 0;

  while (offset + 10 < buffer.byteLength) {
    // ID3 マジックバイト確認
    if (
      view.getUint8(offset)     === 0x49 && // "I"
      view.getUint8(offset + 1) === 0x44 && // "D"
      view.getUint8(offset + 2) === 0x33    // "3"
    ) {
      // synchsafe integer: 各バイトの 7bit だけ使う
      const b0 = view.getUint8(offset + 6) & 0x7f;
      const b1 = view.getUint8(offset + 7) & 0x7f;
      const b2 = view.getUint8(offset + 8) & 0x7f;
      const b3 = view.getUint8(offset + 9) & 0x7f;
      const id3Size = (b0 << 21) | (b1 << 14) | (b2 << 7) | b3;
      offset += 10 + id3Size;
    } else {
      break; // ID3 タグ終了 → AAC データ先頭
    }
  }

  return buffer.slice(offset);
}

// ─── M3U8 パーサ ─────────────────────────────────────────────────────────────

/**
 * M3U8 テキストからセグメント URL を抽出する。
 * "#" で始まらない非空行がセグメント URL。
 * @param {string} text
 * @returns {string[]}
 */
function parseM3U8(text) {
  return text
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#"));
}

// ─── M3U8 フェッチ ───────────────────────────────────────────────────────────

/**
 * 指定時間範囲の Radiko タイムフリー M3U8 プレイリストを取得する。
 * @param {string} stationId
 * @param {string} ft  YYYYMMDDHHMMSS (開始)
 * @param {string} to  YYYYMMDDHHMMSS (終了)
 * @param {string} authToken
 * @param {string} areaId
 * @returns {Promise<string[]>} セグメント URL 配列
 */
async function fetchM3U8Chunk(stationId, ft, to, authToken, areaId) {
  const url = new URL("https://radiko.jp/v2/api/ts/playlist.m3u8");
  url.searchParams.set("station_id", stationId);
  url.searchParams.set("l",          "15");
  url.searchParams.set("ft",         ft);
  url.searchParams.set("to",         to);

  const r = await fetch(url.toString(), {
    headers: {
      "X-Radiko-AuthToken": authToken,
      "X-Radiko-AreaId":    areaId,
    },
  });

  if (r.status === 404) {
    // 7日以上前のコンテンツや期限切れ
    throw new Error(`playlist 404: ${stationId} ${ft}–${to} は取得できません`);
  }
  if (!r.ok) throw new Error(`playlist fetch failed: HTTP ${r.status}`);

  const text = await r.text();
  return parseM3U8(text);
}

// ─── セグメント並列フェッチ ──────────────────────────────────────────────────

/**
 * セグメント URL 配列を MAX_WORKERS 並列でフェッチし、
 * ID3 除去済みの ArrayBuffer 配列を返す。
 *
 * @param {string[]} segmentUrls
 * @param {string}   authToken
 * @param {string}   areaId
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<ArrayBuffer[]>}
 */
async function fetchSegments(segmentUrls, authToken, areaId, onProgress) {
  const total   = segmentUrls.length;
  const results = new Array(total);
  let   done    = 0;
  let   index   = 0;

  async function worker() {
    while (index < total) {
      const i   = index++;
      const url = segmentUrls[i];
      const r   = await fetch(url, {
        headers: {
          "X-Radiko-AuthToken": authToken,
          "X-Radiko-AreaId":    areaId,
        },
      });
      if (!r.ok) throw new Error(`segment fetch failed: HTTP ${r.status} — ${url}`);

      const buf    = await r.arrayBuffer();
      results[i]   = parseAAC(buf); // ID3 除去
      done++;
      onProgress?.(done, total);
    }
  }

  // MAX_WORKERS 本のワーカーを並列実行
  const workers = Array.from({ length: MAX_WORKERS }, () => worker());
  await Promise.all(workers);

  return results;
}

// ─── 時刻ユーティリティ ──────────────────────────────────────────────────────

/**
 * YYYYMMDDHHMMSS 形式の時刻に秒数を加算した文字列を返す。
 * @param {string} timeStr "YYYYMMDDHHMMSS"
 * @param {number} seconds
 * @returns {string}
 */
function addSeconds(timeStr, seconds) {
  const y  = +timeStr.slice(0,  4);
  const mo = +timeStr.slice(4,  6) - 1;
  const d  = +timeStr.slice(6,  8);
  const h  = +timeStr.slice(8,  10);
  const mi = +timeStr.slice(10, 12);
  const s  = +timeStr.slice(12, 14);
  const dt = new Date(Date.UTC(y, mo, d, h, mi, s + seconds));
  return [
    dt.getUTCFullYear(),
    String(dt.getUTCMonth() + 1).padStart(2, "0"),
    String(dt.getUTCDate()).padStart(2, "0"),
    String(dt.getUTCHours()).padStart(2, "0"),
    String(dt.getUTCMinutes()).padStart(2, "0"),
    String(dt.getUTCSeconds()).padStart(2, "0"),
  ].join("");
}

/**
 * YYYYMMDDHHMMSS → Date.getTime() の差分（秒）
 */
function diffSeconds(start, end) {
  function toDate(t) {
    return new Date(Date.UTC(
      +t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8),
      +t.slice(8, 10), +t.slice(10, 12), +t.slice(12, 14),
    ));
  }
  return Math.round((toDate(end) - toDate(start)) / 1000);
}

// ─── メインダウンロード関数 ──────────────────────────────────────────────────

/**
 * タイムフリー番組を AAC ファイルとしてダウンロードする。
 *
 * 処理フロー (Rajiko 準拠):
 *   1. startTime → endTime を FIXED_SEEK_SEC 単位でチャンク分割
 *   2. 各チャンクの m3u8 を順次取得してセグメント URL を収集
 *   3. 全セグメントを MAX_WORKERS 並列でフェッチ
 *   4. ID3 除去 → 全バッファを結合
 *   5. Blob({ type: "audio/aac" }) → chrome.downloads.download()
 *
 * @param {{
 *   stationId: string,
 *   startTime: string,   // YYYYMMDDHHMMSS
 *   endTime:   string,   // YYYYMMDDHHMMSS
 *   authToken: string,
 *   areaId:    string,
 *   onProgress?: (phase: string, done: number, total: number) => void,
 * }} params
 * @returns {Promise<void>}
 */
export async function downloadTimefree({
  stationId, startTime, endTime, authToken, areaId, onProgress,
}) {
  const totalSecs = diffSeconds(startTime, endTime);
  if (totalSecs <= 0) throw new Error("endTime は startTime より後にしてください");

  console.log(`[timeshift] ダウンロード開始: ${stationId} ${startTime}–${endTime} (${totalSecs}秒)`);

  // ── フェーズ 1: m3u8 チャンク収集 ────────────────────────────────────────
  const allSegmentUrls = [];
  let chunkStart = startTime;
  let elapsed    = 0;

  while (elapsed < totalSecs) {
    const chunkEnd = elapsed + FIXED_SEEK_SEC >= totalSecs
      ? endTime
      : addSeconds(chunkStart, FIXED_SEEK_SEC);

    onProgress?.("playlist", elapsed, totalSecs);

    const urls = await fetchM3U8Chunk(stationId, chunkStart, chunkEnd, authToken, areaId);
    allSegmentUrls.push(...urls);

    elapsed    += FIXED_SEEK_SEC;
    chunkStart  = chunkEnd;
  }

  console.log(`[timeshift] セグメント数: ${allSegmentUrls.length}`);
  if (allSegmentUrls.length === 0) throw new Error("セグメントが 0 件でした");

  // ── フェーズ 2: セグメント並列フェッチ ───────────────────────────────────
  const buffers = await fetchSegments(
    allSegmentUrls, authToken, areaId,
    (done, total) => onProgress?.("segments", done, total),
  );

  // ── フェーズ 3: 結合 → Blob → ダウンロード ───────────────────────────────
  const blob = new Blob(buffers, { type: "audio/aac" });
  const blobUrl = URL.createObjectURL(blob);

  const filename = buildFilename(stationId, startTime);

  await chrome.downloads.download({
    url:      blobUrl,
    filename: filename,
    saveAs:   false,
  });

  // Blob URL は downloads API がファイルを読み終えた後に解放
  // （即時 revoke すると Safari でダウンロードが失敗する可能性があるため遅延）
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);

  console.log(`[timeshift] ダウンロード完了: ${filename}`);
}

/**
 * ダウンロードファイル名を生成する。
 * 例: "RADIKO_TBS_20240101_120000.aac"
 */
function buildFilename(stationId, startTime) {
  const date = startTime.slice(0, 8);   // YYYYMMDD
  const time = startTime.slice(8, 14);  // HHMMSS
  return `RADIKO_${stationId}_${date}_${time}.aac`;
}
