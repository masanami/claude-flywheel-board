import { type FormEvent, useEffect, useRef, useState } from "react";

export type AddAgentInput = { name: string; path: string };

// POST /api/fleet/agents の成否をフォームへ伝える結果型（Issue #124）。
// エラー時はサーバー側の構造化エラーメッセージ（src/server/api.ts の
// `{ error: string }`）をそのまま error に載せ、add-agent-form-errors に
// 表示する。
export type AddAgentSubmitResult = { ok: true } | { ok: false; error: string };

type AddAgentFormProps = {
  onClose: () => void;
  // 送信ハンドラ（Issue #124: Board.tsx から POST /api/fleet/agents を叩く
  // 実処理が渡される）。Promise が解決するまでフォームは閉じない
  // （下記 handleSubmit 参照）。ok:false の場合はサーバー側バリデーション
  // エラーを add-agent-form-errors に表示し、フォームは開いたままにする。
  onSubmit: (input: AddAgentInput) => Promise<AddAgentSubmitResult>;
  // パス欄の自動補完に使うベースディレクトリ（絶対パス）。Board.tsx が
  // 既存 fleet エージェントの実際のパスから算出して渡す（ブラウザの JS から
  // は OS のホームディレクトリを取得できないため、"~" のハードコードでは
  // サーバー側の絶対パス限定バリデーションと必ず不整合になる。既存エージェント
  // が1件も無い場合は空文字が渡され、パス欄は空のまま始まる）。
  basePath: string;
};

function buildDefaultPath(name: string, basePath: string): string {
  if (basePath === "") {
    // 既存エージェントが1件も無く親ディレクトリを推測できない場合、名前だけ
    // から相対パスを組み立てない（セルフレビュー指摘: サーバは絶対パスしか
    // 受け付けないため、相対パスを既定値にすると初回追加が必ず 400 になる）。
    // ユーザーが絶対パスを直接入力する。
    return "";
  }
  const trimmedName = name.trim();
  return trimmedName === "" ? basePath : `${basePath}/${trimmedName}`;
}

// サーバ側正本（src/server/manifest.ts の loadFleetManifest・src/server/api.ts
// の絶対パス判定）のバリデーション規則のうち「名前が空でない」「末尾 -shell
// 禁止」「パスは絶対パス」をクライアント側の簡易バリデーションとして軽量に
// 再現する（親 Issue #119 クリティカル設計決定）。node:path はブラウザ
// バンドルへ持ち込まないため、絶対パス判定は POSIX の "/" 始まり判定に留める
// （このプロジェクトはローカル macOS/Linux 環境のみを対象とする。
// CLAUDE.md 技術スタック参照）。name の重複チェック等、より詳細な検証は
// サーバ側の責務であり、ここでは行わない。
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
  const trimmedPath = path.trim();
  if (trimmedPath === "") {
    errors.push("パスを入力してください");
  } else if (!trimmedPath.startsWith("/")) {
    errors.push(
      'パスは絶対パスで入力してください（"/" から始まる必要があります）',
    );
  }
  return errors;
}

// 「＋ エージェント追加」フォーム（Issue #123 で表示・入力状態管理・
// クライアント側簡易バリデーション・パス補完を実装。Issue #124 で
// POST /api/fleet/agents との結線・サーバー側エラー表示・送信中制御を追加）。
// 本チケット時点でも board 自身が fs 書き込みを行うことは無く、HTTP 呼び出し
// のみを行う（fleet.tsv への書き込みはサーバ側 API の境界内で完結。NFR-01 の
// 対象はエージェントの状態ファイルであり board 自身の設定である fleet.tsv は
// 対象外という整理は親 Issue #119 系列で確定し docs/requirements.md・
// docs/architecture.md に反映済み）。
//
// CardDetailModal と同じくネイティブ <dialog> + showModal() を採用し、
// フォーカストラップ・ESC・背景クリックでの close() 発火はブラウザ実装に
// 委ねる（自前実装はしない）。
export function AddAgentForm({
  onClose,
  onSubmit,
  basePath,
}: AddAgentFormProps) {
  const [name, setName] = useState("");
  // basePath は意図的に「マウント時のシード値」としてのみ扱う（useState の
  // 初期値は初回レンダーでのみ評価される）。Board.tsx は agent_update の
  // たびに basePath を再計算して渡すため、フォームを開いたまま裏で新規
  // エージェントが増える（＝computeBasePathHint の算出元が変わる）と、
  // 以降 handleNameChange の自動補完（basePath の最新値を直接参照）が
  // 表示中の path 欄の値と食い違いうる（セルフレビュー指摘）。ただし
  // これはあくまで手動編集可能な補完ヒントであり、実際に影響するのは稀な
  // タイミング（フォームを開いたまま最初の1体が追加される等）に限られる
  // ため、prop 変化への追随は過剰実装として見送る（YAGNI）。
  const [path, setPath] = useState(basePath);
  // path 欄をユーザーが直接編集した後は、name 変更による自動補完で上書き
  // しない（一度手動編集したら以降はユーザーの入力を尊重する）。
  const [pathTouched, setPathTouched] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  // サーバーへの送信中は二重送信を防ぐため送信ボタンを無効化する。
  const [submitting, setSubmitting] = useState(false);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const mouseDownOnDialog = useRef(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  // ESC（ネイティブ "cancel" イベント）ハンドラは mount 時の1回しか登録しない
  // effect 内から最新の submitting を読む必要があるため、ref 経由で参照する
  // （セルフレビュー指摘: 送信中に ESC で閉じると、後から届く onSubmit の結果
  // （特にサーバー側エラー）を表示する先が失われ、ユーザーに何のフィード
  // バックも残らない）。
  const submittingRef = useRef(false);
  useEffect(() => {
    submittingRef.current = submitting;
  }, [submitting]);

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
    // ESC 押下時は "cancel" → "close" の順でネイティブイベントが発火する。
    // 送信中は cancel を preventDefault してダイアログを閉じさせない
    // （オーバーレイクリック・「閉じる」ボタンのガードと合わせて三重に防ぐ）。
    const handleCancel = (event: Event) => {
      if (submittingRef.current) {
        event.preventDefault();
      }
    };
    dialog.addEventListener("close", handleClose);
    dialog.addEventListener("cancel", handleCancel);
    return () => {
      dialog.removeEventListener("close", handleClose);
      dialog.removeEventListener("cancel", handleCancel);
    };
  }, []);

  function handleNameChange(value: string) {
    setName(value);
    if (!pathTouched) {
      setPath(buildDefaultPath(value, basePath));
    }
    // 再編集を始めたら、直前の送信エラー表示は一旦引っ込める（セルフレビュー指摘）。
    setErrors([]);
  }

  function handlePathChange(value: string) {
    setPathTouched(true);
    setPath(value);
    setErrors([]);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const validationErrors = validate(name, path);
    if (validationErrors.length > 0) {
      setErrors(validationErrors);
      return;
    }
    setErrors([]);
    setSubmitting(true);
    let result: AddAgentSubmitResult;
    try {
      result = await onSubmit({ name: name.trim(), path: path.trim() });
    } catch {
      // onSubmit の契約は Promise<AddAgentSubmitResult>（reject しない想定。
      // Board.tsx の submitAddAgent も全経路で catch 済み）だが、将来の
      // onSubmit 実装が reject した場合でも submitting が固定されたまま
      // 送信ボタンが恒久的に無効化されないよう防御する（セルフレビュー指摘）。
      setSubmitting(false);
      setErrors(["エージェントの追加に失敗しました（予期しないエラー）"]);
      return;
    }
    setSubmitting(false);
    if (result.ok) {
      dialogRef.current?.close();
      return;
    }
    // サーバー側バリデーションエラー（名前規則・パス重複・名前衝突等）を
    // 既存のエラー表示 UI（add-agent-form-errors）に載せる。フォームは
    // 開いたままにし、ユーザーが値を修正して再送信できるようにする。
    setErrors([result.error]);
  }

  function closeIfNotSubmitting() {
    // 送信中はオーバーレイクリック・「閉じる」ボタンでは閉じない
    // （ESC 対策は上の "cancel" イベントハンドラ参照）。
    if (submitting) {
      return;
    }
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
          closeIfNotSubmitting();
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
            onClick={closeIfNotSubmitting}
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
              placeholder={basePath || "絶対パスを入力してください"}
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
            <button
              type="submit"
              className="add-agent-form-submit"
              disabled={submitting}
            >
              追加
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
