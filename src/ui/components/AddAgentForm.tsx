import { type FormEvent, useEffect, useRef, useState } from "react";

export type AddAgentInput = { name: string; path: string };

type AddAgentFormProps = {
  onClose: () => void;
  // 送信ハンドラ（Issue #123 スコープでは仮実装。API 接続・ディレクトリ作成・
  // fleet.tsv 追記は #124 のスコープ）。バリデーション通過後は常に同期的に
  // フォームを閉じる（下記 handleSubmit 参照）。#124 でサーバ側エラー
  // （名前衝突・パス重複等）を扱う際は、この「検証通過 = 即クローズ」の
  // 前提ごと onSubmit の戻り値/クローズ制御を見直す必要がある
  // （セルフレビュー指摘。本チケットでは先取りしない・YAGNI）。
  onSubmit: (input: AddAgentInput) => void;
};

// パス欄の自動補完に使うベースディレクトリ。実際のパス確定・ディレクトリ
// 作成のロジックは #124 以降のスコープのため、ここでは軽量な UX 補助として
// ハードコードする（#123 の実装方針: ベースディレクトリの具体的な値は
// ハードコードで構わない。過度な作り込みは不要）。
// 注意（セルフレビュー指摘・#124 への申し送り）: "~" はこのプロジェクトの
// どの層（src/server/manifest.ts の loadFleetManifest・watcher・
// pty/tmux 起動）でも展開されない。#124 でフォーム確定値を fleet.tsv へ
// 書き込む際は、サーバ側でチルダ展開するか絶対パスへ変換する対応が必須。
const BASE_DIR = "~/agents";

function buildDefaultPath(name: string): string {
  const trimmedName = name.trim();
  return trimmedName === "" ? BASE_DIR : `${BASE_DIR}/${trimmedName}`;
}

// サーバ側正本（src/server/manifest.ts の loadFleetManifest）のバリデーション
// 規則のうち「名前が空でない」「末尾 -shell 禁止」をクライアント側の簡易
// バリデーションとして軽量に再現する（親 Issue #119 クリティカル設計決定）。
// name の重複チェック等の詳細な検証はサーバ側の責務であり、ここでは行わない。
function validate(name: string, path: string): string[] {
  const errors: string[] = [];
  const trimmedName = name.trim();
  if (trimmedName === "") {
    errors.push("エージェント名を入力してください");
  } else if (trimmedName.endsWith("-shell")) {
    errors.push(
      '末尾 "-shell" は手動シェルセッション用に予約されています。別の名前にしてください',
    );
  }
  if (path.trim() === "") {
    errors.push("パスを入力してください");
  }
  return errors;
}

// 「＋ エージェント追加」フォーム（Issue #123）: フォームの表示・入力状態管理・
// クライアント側簡易バリデーション・パス補完までが本チケットのスコープ。
// 送信ハンドラは仮実装で、API 呼び出し（ディレクトリ作成・fleet.tsv 追記）は
// 行わない（#124 のスコープ）。本チケット時点では一切の書き込みを行わない
// ため、NFR-01（board は台帳・journal・memory・runs.jsonl に書き込まない）
// への抵触は無い（NFR-01 と fleet.tsv 書き込みの境界整理の詳細・docs反映
// 状況は Board.tsx の handleAddAgentSubmit 直前コメント参照。#124 実装時も
// この区別が前提になる）。
//
// CardDetailModal と同じくネイティブ <dialog> + showModal() を採用し、
// フォーカストラップ・ESC・背景クリックでの close() 発火はブラウザ実装に
// 委ねる（自前実装はしない）。
export function AddAgentForm({ onClose, onSubmit }: AddAgentFormProps) {
  const [name, setName] = useState("");
  const [path, setPath] = useState(BASE_DIR);
  // path 欄をユーザーが直接編集した後は、name 変更による自動補完で上書き
  // しない（一度手動編集したら以降はユーザーの入力を尊重する）。
  const [pathTouched, setPathTouched] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const mouseDownOnDialog = useRef(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (!dialog.open) {
      dialog.showModal();
      // showModal() の既定フォーカス（DOM順で最初の focusable 要素 = 「閉じる」
      // ボタン）を、入力が主目的のフォームとして上書きする（セルフレビュー指摘）。
      nameInputRef.current?.focus();
    }

    const handleClose = () => {
      onCloseRef.current();
    };
    dialog.addEventListener("close", handleClose);
    return () => {
      dialog.removeEventListener("close", handleClose);
    };
  }, []);

  function handleNameChange(value: string) {
    setName(value);
    if (!pathTouched) {
      setPath(buildDefaultPath(value));
    }
    // 再編集を始めたら、直前の送信エラー表示は一旦引っ込める（セルフレビュー指摘）。
    setErrors([]);
  }

  function handlePathChange(value: string) {
    setPathTouched(true);
    setPath(value);
    setErrors([]);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const validationErrors = validate(name, path);
    if (validationErrors.length > 0) {
      setErrors(validationErrors);
      return;
    }
    onSubmit({ name: name.trim(), path: path.trim() });
    dialogRef.current?.close();
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: オーバーレイ（dialog 自身）のクリック閉じはポインタ操作のみの補助的な導線であり、キーボードでの閉じ方はネイティブ ESC ハンドリングで確保している（CardDetailModal と同じパターン）
    <dialog
      ref={dialogRef}
      className="add-agent-form-modal"
      data-testid="add-agent-form"
      aria-labelledby="add-agent-form-title"
      onMouseDown={(event) => {
        mouseDownOnDialog.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (mouseDownOnDialog.current && event.target === event.currentTarget) {
          dialogRef.current?.close();
        }
        mouseDownOnDialog.current = false;
      }}
    >
      <div
        className="add-agent-form-content"
        data-testid="add-agent-form-content"
      >
        <div className="add-agent-form-header">
          <h2 id="add-agent-form-title" className="add-agent-form-title">
            ＋ エージェント追加
          </h2>
          <button
            type="button"
            className="modal-close-button"
            onClick={() => dialogRef.current?.close()}
          >
            閉じる
          </button>
        </div>
        <form onSubmit={handleSubmit} className="add-agent-form-fields">
          <label className="add-agent-form-field">
            <span>エージェント名</span>
            <input
              ref={nameInputRef}
              type="text"
              value={name}
              placeholder="例: harness-guardian"
              onChange={(event) => handleNameChange(event.target.value)}
            />
          </label>
          <label className="add-agent-form-field">
            <span>パス</span>
            <input
              type="text"
              value={path}
              placeholder={BASE_DIR}
              onChange={(event) => handlePathChange(event.target.value)}
            />
          </label>
          {errors.length > 0 && (
            <ul
              className="add-agent-form-errors"
              data-testid="add-agent-form-errors"
              role="alert"
            >
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          )}
          <div className="add-agent-form-actions">
            <button type="submit" className="add-agent-form-submit">
              追加
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
