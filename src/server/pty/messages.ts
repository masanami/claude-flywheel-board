// C→S（クライアント→サーバ）メッセージの型と解釈。
//
// クリティカル設計決定（親 Issue #2 / #14）: 「Enter を送る API・自動実行の口を
// 一切作らない」を型レベルで保証するため、ここで定義できるメッセージ種別は
// input（キー入力の転送）/ resize（ペインサイズ変更）/ prefill（改行なしの
// literal 文字列流し込み）の 3 つのみである。4 つ目の種別（例: 「送信して実行
// する」種別）を安易に追加しないこと。

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "prefill"; command: string };

/**
 * WS で受信した生の文字列フレームを ClientMessage に解釈する。
 * 形式が不正（JSON として壊れている / object でない / 型不一致 / 未知の type）
 * な場合は undefined を返す（呼び出し側は無視すればよい）。
 */
export function parseClientMessage(raw: string): ClientMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;

  switch (record.type) {
    case "input":
      return typeof record.data === "string"
        ? { type: "input", data: record.data }
        : undefined;
    case "resize":
      return isPositiveInteger(record.cols) && isPositiveInteger(record.rows)
        ? { type: "resize", cols: record.cols, rows: record.rows }
        : undefined;
    case "prefill":
      return typeof record.command === "string"
        ? { type: "prefill", command: record.command }
        : undefined;
    default:
      return undefined;
  }
}
