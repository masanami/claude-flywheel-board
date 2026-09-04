import { useState } from "react";
import type { ApprovalKind, Challenge } from "../board-types.ts";

// 承認 POST の結果型（AddAgentSubmitResult と同じ形）。エラー時はサーバ側の
// 構造化エラーメッセージ（src/server/api.ts の `{ error: string }`）をそのまま載せる。
export type ApproveSubmitResult = { ok: true } | { ok: false; error: string };

// 承認ボタンを出せるステータスと、そのとき書き込む承認種別（FR-13 / FR-32）。
// 正本は claude-flywheel 側 challenge-ledger-format.md §承認プロトコルの
// 「ステータス前提」列で、server 側の APPROVAL_REQUIRED_STATUS と対になる。
// `人間対応待ち` は needsHuman だが承認ではなく**回答**を待つ保留（§保留プロトコル）
// のため、ここには含めない——チェックボックスを立てても意味がなく、人間は
// 分類欄の `人間の回答` に書く必要がある。
const APPROVABLE_STATUS: Partial<Record<Challenge["status"], ApprovalKind>> = {
  計画承認待ち: "plan",
  完了確認待ち: "completion",
};

const APPROVAL_BUTTON_LABEL: Record<ApprovalKind, string> = {
  plan: "計画を承認",
  completion: "完了を承認",
};

type ApprovalControlProps = {
  challenge: Challenge;
  // 読み取り専用表示（アーカイブビュー等）。true のとき承認導線を出さない。
  readOnly?: boolean;
  // 承認 POST の送信ハンドラ。未指定なら承認導線を出さない（アーカイブビュー等、
  // 承認導線を持たない呼び出し元のため）。TaskCard と CardDetailModal は
  // どちらも Board.tsx → AgentColumn.tsx が結線する同一の関数をそのまま渡す
  // （承認は「同一経路・同一 API」。#171 完了条件2）。
  onApprove?: (
    challengeId: string,
    kind: ApprovalKind,
  ) => Promise<ApproveSubmitResult>;
  // 呼び出し元固有の余白・配置を載せるための追加クラス名。
  // TaskCard は "task-card-approval"（カード下端・左右の余白）、
  // CardDetailModal は "card-detail-modal-footer"（sticky footer）を渡す。
  // 共通の見た目（flex レイアウト・ボタン装飾）は .approval-control* に集約し、
  // ホスト固有のレイアウトだけをこのクラス側へ残す（#171・D3）。
  className?: string;
};

// 承認コントロール（Issue #165・FR-20 → #171 で TaskCard / CardDetailModal の
// 共通コンポーネントへ抽出）。
//
// 判定（readOnly / onApprove 未指定 / 承認対象外ステータス / 既に [x]）と
// 2 段階フロー（idle → confirming → submitting。誤操作対策）・エラー表示を
// この 1 箇所へ閉じ込め、呼び出し側（TaskCard / CardDetailModal）で条件分岐を
// 重複させない。承認導線を出すべきでない場合は null を返す。
//
// board が書いてよいのは NFR-01 の区分②（人間の入力）＝承認チェックボックスまでで、
// **区分③（ステータス・分類欄・journal・memory・runs.jsonl）には引き続き書かない**。
// この制約は server 側（ledger-approval.ts）で担保しており、ここから送るのは
// 種別（plan / completion）と対象課題 ID のみ。
export function ApprovalControl({
  challenge,
  readOnly,
  onApprove,
  className,
}: ApprovalControlProps) {
  // 承認ボタンの状態。"idle" → "confirming"（確認待ち）→ "submitting"。
  // 誤操作対策の 2 段階と、送信中の二重押下防止を兼ねる。
  const [approvalPhase, setApprovalPhase] = useState<
    "idle" | "confirming" | "submitting"
  >("idle");
  const [approvalError, setApprovalError] = useState<string | null>(null);

  // 承認種別は台帳のステータスから決まる（server 側 APPROVAL_REQUIRED_STATUS と対）。
  const approvalKind = APPROVABLE_STATUS[challenge.status];
  // 既に `[x]` が付いているエントリではボタンを出さない（押しても server が 409 を
  // 返すだけで、利用者には「なぜか押せるが失敗する」ボタンにしか見えないため）。
  const alreadyApproved =
    approvalKind !== undefined &&
    (challenge.approvals?.[approvalKind]?.checked ?? false);
  const canApprove =
    !readOnly &&
    onApprove !== undefined &&
    approvalKind !== undefined &&
    !alreadyApproved;

  if (!canApprove || approvalKind === undefined) {
    return null;
  }

  const submitApproval = async (kind: ApprovalKind) => {
    if (!onApprove) {
      return;
    }
    setApprovalPhase("submitting");
    setApprovalError(null);
    const result = await onApprove(challenge.id, kind);
    if (result.ok) {
      // 成功時は idle へ戻す。台帳の `[x]` は fs-watch → WS agent_update 経由で
      // 反映され、次の描画で canApprove が false になりこのコンポーネント自体が
      // null を返す（board は自分の書き込み結果でキャッシュを直接更新しない
      // ＝NFR-04・正本はファイル）。呼び出し元（CardDetailModal）はこの消滅を
      // 見せるためにモーダル自体を閉じない（#171・D1）。
      setApprovalPhase("idle");
      return;
    }
    setApprovalPhase("idle");
    setApprovalError(result.error);
  };

  const rootClassName = className
    ? `approval-control ${className}`
    : "approval-control";

  return (
    <div className={rootClassName}>
      {approvalPhase === "confirming" ? (
        <>
          <span className="approval-control-question">
            {APPROVAL_BUTTON_LABEL[approvalKind]}？
          </span>
          <button
            type="button"
            className="approval-control-confirm"
            onClick={() => void submitApproval(approvalKind)}
          >
            承認する
          </button>
          <button
            type="button"
            className="approval-control-cancel"
            onClick={() => setApprovalPhase("idle")}
          >
            やめる
          </button>
        </>
      ) : (
        <button
          type="button"
          className="approval-control-start"
          disabled={approvalPhase === "submitting"}
          onClick={() => {
            setApprovalError(null);
            setApprovalPhase("confirming");
          }}
        >
          {approvalPhase === "submitting"
            ? "承認中…"
            : APPROVAL_BUTTON_LABEL[approvalKind]}
        </button>
      )}
      {approvalError !== null && (
        <p className="approval-control-error" role="alert">
          {approvalError}
        </p>
      )}
    </div>
  );
}
