// C→S（クライアント→サーバ）メッセージの型と解釈。
//
// クリティカル設計決定（親 Issue #2 / #14）: 「Enter を送る API・自動実行の口を
// 一切作らない」を型レベルで保証するため、ここで定義できるメッセージ種別は
// input（キー入力の転送）/ resize（ペインサイズ変更）/ prefill（改行なしの
// literal 文字列流し込み）の 3 つのみである。4 つ目の種別（例: 「送信して実行
// する」種別）を安易に追加しないこと。

// pty のサイズとして非現実的な巨大値（例: cols: 1e9）を受け取ると node-pty が
// 例外を throw しうる（未捕捉だと board プロセス全体が落ちる）。プロトコルの
// 型レベルで上限を設け、そもそも巨大値が ClientMessage として成立しないようにする。
const MAX_PTY_DIMENSION = 1000;

function isValidPtyDimension(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_PTY_DIMENSION
  );
}

/**
 * prefill の command が「改行を含まない文字列」であることを検証する。
 *
 * クリティカル設計決定（親 Issue #2 / #14）: prefill は Enter を送るコードパスを
 * 一切作らない契約のため、改行を含む command はプロトコルの型レベルで拒否する
 * （belt-and-braces）。tmux 層の stripNewlines（tmux.ts）は送信直前の第 2 層の
 * 防御として引き続き維持する。
 */
function isValidPrefillCommand(value: unknown): value is string {
  return typeof value === "string" && !/[\r\n]/.test(value);
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
      return isValidPtyDimension(record.cols) &&
        isValidPtyDimension(record.rows)
        ? { type: "resize", cols: record.cols, rows: record.rows }
        : undefined;
    case "prefill":
      return isValidPrefillCommand(record.command)
        ? { type: "prefill", command: record.command }
        : undefined;
    default:
      return undefined;
  }
}
