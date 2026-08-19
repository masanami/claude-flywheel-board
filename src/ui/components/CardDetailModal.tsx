import { useEffect, useRef, useState } from "react";
import type { Challenge, ChallengeRef, LogEntry, Run } from "../board-types.ts";
import { formatLogTimestamp } from "../lib/format-log-ts.ts";
import {
  type GithubRefKind,
  buildGithubRefUrl,
} from "../lib/github-ref-url.ts";
import { END_EVENT_LABEL } from "../lib/provenance-labels.ts";
import {
  buildResumeCommand,
  findStaleDelegateRun,
} from "../lib/resume-command.ts";
import { prefill } from "../terminal-control.ts";

type CardDetailModalProps = {
  challenge: Challenge;
  agentName: string;
  onClose: () => void;
  // 対象エージェントの実行中 Run（AgentColumn → TaskCard → CardDetailModal と
  // 中継される。#31・FR-12）。更新なし（stale）の delegate run が対象課題に
  // 見つかった場合のみ、resumebox（再開コマンドの表示＋プリフィル導線）を出す。
  // FR-A1（取得元）の対象 run 特定にも同じ配列を参照する。
  runningRuns?: Run[];
};

/**
 * run 由来のタスク行の取得元（FR-A1）を特定する。runningRuns のうち、対象課題
 * に一致し、かつ provenance を持つ最初の run を返す（kind: cycle は provenance
 * が常に undefined のため自然に除外される。仕様のスコープ外決定に一致）。
 */
function findProvenanceRun(
  runs: Run[] | undefined,
  challengeId: string,
): Run | undefined {
  return runs?.find(
    (run) => run.provenance !== undefined && run.challenge === challengeId,
  );
}

// 開始イベント種別 → 対応する終了イベント名の表示ラベル。AgentColumn の
// describeProvenance と同じ導出ロジックのため lib/provenance-labels.ts に
// 集約している（PRレビュー指摘対応。Record 採用理由は同ファイル参照）。

type LogState =
  | { status: "loading" }
  | { status: "success"; entries: LogEntry[] }
  | { status: "error" };

/**
 * 参照フィールド（関連リポジトリ・関連Issue・関連PR。#155）の1行。
 *
 * owner を解決できた参照だけ GitHub へのリンクにし、解決できなかった値
 * （短縮形で owner 不明・自由記述・URL 直書き等）は台帳の記載どおりテキストで出す
 * （claude-flywheel `docs/challenge-ledger-format.md` §関連リポジトリ・関連Issue・関連PR）。
 * 値が無いフィールドは他の台帳項目と同じく半角ハイフンを表示する。
 * board はローカルツールなので、リンクは新規タブで開いてボード側の状態
 * （ターミナルの WebSocket 接続等）を壊さないようにする。
 */
function ChallengeRefs({
  refs,
  kind,
}: {
  refs: ChallengeRef[] | undefined;
  kind: GithubRefKind;
}) {
  if (refs === undefined || refs.length === 0) {
    return <>-</>;
  }
  return (
    <ul className="card-detail-ref-list">
      {refs.map((ref, index) => {
        const url = buildGithubRefUrl(ref, kind);
        return (
          // 同じ参照が重複記入されうる（規定は重複させないと定めるが、消費側は
          // 壊れた入力でも表示できる必要がある）ため index を key に含める。
          <li key={`${ref.raw}-${index}`}>
            {url ? (
              <a href={url} target="_blank" rel="noreferrer">
                {ref.raw}
              </a>
            ) : (
              ref.raw
            )}
          </li>
        );
      })}
    </ul>
  );
}

// カード詳細モーダル（読み取り専用・NFR-01）: 台帳の全項目と作業ログタイムラインを
// 表示するのみで、編集・承認・実行等の操作ボタンは一切持たない。作業ログは
// GET /api/log?agent&challenge をモーダルを開いたタイミングでオンデマンド取得する。
//
// ネイティブ <dialog> + showModal() を採用し、フォーカストラップ・ESC・背景 inert は
// ブラウザ実装に委ねる（自前実装はしない）。「閉じるボタン」「ESC」「オーバーレイ
// （dialog 自身）クリック」の3経路はすべて dialog.close() → ネイティブの "close"
// イベントへ収束させ、そこで一度だけ onClose を呼ぶ。
export function CardDetailModal({
  challenge,
  agentName,
  onClose,
  runningRuns,
}: CardDetailModalProps) {
  const [logState, setLogState] = useState<LogState>({ status: "loading" });
  const [rawRecordExpanded, setRawRecordExpanded] = useState(false);
  const staleDelegateRun = findStaleDelegateRun(runningRuns, challenge.id);
  // repo の truthy チェックを一度だけ行い、コマンド文字列も一度だけ組み立てる
  // （表示用の <input value> とボタンの onClick の双方から参照する）。
  const resumeCommand =
    staleDelegateRun?.repo &&
    buildResumeCommand(staleDelegateRun.repo, staleDelegateRun.key);

  // 取得元（provenance。FR-A1/FR-A3/FR-A4）: resumebox が表示対象にする run
  // （findStaleDelegateRun で選ばれた、再開コマンドを提示できる stale delegate
  // run）に provenance があれば、その run を最優先で採用する（セルフレビュー
  // 指摘対応: findProvenanceRun 単独だと選択規則が resumebox と独立してしまい、
  // resumebox が示す run と異なる run の取得元を提示しうる。#85 の動機＝
  // 「どの記録を閉じれば表示が消えるか」を自明にするため、少なくとも resumebox
  // 表示中はその根拠と一致させる）。
  // 注意: AgentColumn の「⚠ 更新なし」表示自体は run.stale のみで出るため、
  // repo/session_id が安全な文字集合から外れる等で resumebox が出ない stale
  // run（isResumableDelegateRun 不成立）の場合は、この優先規則の対象外となり
  // 従来どおり findProvenanceRun の先頭一致にフォールバックする。
  // 該当が無ければ、対象課題に一致する provenance 付き run（delegate/adhoc
  // のみ。cycle は provenance が undefined のため自然に除外される）の先頭を
  // 採用する。
  const provenanceRun =
    staleDelegateRun?.provenance !== undefined
      ? staleDelegateRun
      : findProvenanceRun(runningRuns, challenge.id);
  const provenance = provenanceRun?.provenance;

  const dialogRef = useRef<HTMLDialogElement>(null);
  const mouseDownOnDialog = useRef(false);
  // onClose は呼び出し元（TaskCard）の再レンダーのたびに新しい関数参照になりうる。
  // dialog.showModal() の呼び出しはマウント時の1回だけにしたいため（既に開いている
  // dialog に showModal() を再度呼ぶと例外になる）、常に最新の onClose を参照できる
  // よう ref 経由で保持し、effect の依存配列には含めない。
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // dialog を開き、close イベント（閉じるボタン / ESC / オーバーレイクリックの
  // いずれから来ても最終的にここへ集約する）を onClose に橋渡しする。
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    // StrictMode では effect が setup → cleanup → setup と 2 回走るため、
    // open 済みの dialog に showModal() を再度呼ばないようガードする
    // （open 済みへの呼び出しは InvalidStateError になる）
    if (!dialog.open) {
      dialog.showModal();
    }

    const handleClose = () => {
      onCloseRef.current();
    };
    dialog.addEventListener("close", handleClose);
    return () => {
      dialog.removeEventListener("close", handleClose);
    };
  }, []);

  // 作業ログのオンデマンド取得。
  useEffect(() => {
    let cancelled = false;
    setLogState({ status: "loading" });

    fetch(
      `/api/log?agent=${encodeURIComponent(agentName)}&challenge=${encodeURIComponent(challenge.id)}`,
    )
      .then((response) => {
        if (!response.ok) {
          throw new Error(`unexpected status: ${response.status}`);
        }
        return response.json() as Promise<LogEntry[]>;
      })
      .then((entries) => {
        if (!cancelled) {
          setLogState({ status: "success", entries });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLogState({ status: "error" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [agentName, challenge.id]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: オーバーレイ（dialog 自身）のクリック閉じはポインタ操作のみの補助的な導線であり、キーボードでの閉じ方はネイティブ ESC ハンドリングで確保している
    <dialog
      ref={dialogRef}
      className="card-detail-modal"
      data-testid="modal-overlay"
      aria-labelledby="card-detail-modal-title"
      onMouseDown={(event) => {
        // 押下（mousedown）が dialog 自身（オーバーレイ相当）から始まった場合のみ
        // 「クリックで閉じる」候補として記録する。ダイアログ内で始めたテキスト
        // 選択ドラッグの終点が外側にずれても、誤って閉じないようにするため。
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
        className="card-detail-modal-content"
        data-testid="card-detail-content"
      >
        <div className="card-detail-modal-header">
          <h2 id="card-detail-modal-title" className="card-detail-modal-title">
            {challenge.title}
          </h2>
          <button
            type="button"
            className="modal-close-button"
            onClick={() => dialogRef.current?.close()}
          >
            閉じる
          </button>
        </div>

        <dl className="card-detail-fields">
          <dt>ID</dt>
          <dd>{challenge.id}</dd>
          <dt>タイトル</dt>
          <dd>{challenge.title}</dd>
          <dt>ステータス</dt>
          <dd>{challenge.status}</dd>
          <dt>優先度</dt>
          <dd>{challenge.priority ?? "-"}</dd>
          <dt>担当ポジション</dt>
          <dd>{challenge.position ?? "-"}</dd>
          <dt>要対応</dt>
          <dd>{challenge.needsHuman ? "はい" : "いいえ"}</dd>
          <dt>要約</dt>
          <dd>{challenge.summary ?? "-"}</dd>
        </dl>

        {/* 課題台帳（FR-B2・#102）: このモーダルは台帳カード（TaskCard）から
         * のみ開かれるため、表示すべき台帳エントリは challenge prop として
         * 既に手元にある。join（agent prop 経由の findChallengeById 呼び出し）
         * は行わない（設計変更: 当初案は本番の唯一の呼び出し元 TaskCard が
         * agent を渡さず到達不能なデッドコードになると判明したため、
         * 2026-08-01 にユーザー承認のうえ直接表示方式へ変更。詳細は
         * docs/features/task-provenance-ledger-join.md 参照）。クラス名・
         * testid は当初の join 前提の命名を維持している（変更必須ではない
         * ため）。 */}
        <section className="card-detail-ledger-join" data-testid="ledger-join">
          <h3 className="card-detail-ledger-join-heading">課題台帳</h3>
          <dl className="card-detail-fields">
            {/* 表示順は FR-13 の承認対象を先頭に置く（#151・PRレビュー指摘対応）。
             * 規定 §FR-13 の承認対象は「承認者が見るべき欄」を タスク案・完了条件・
             * 関連リポジトリ と定めており、説明（ingest 由来だと実データで数千文字の
             * ブロック引用になる）を先頭に置くと承認対象が初期表示の外へ押し出される。
             * 説明は文脈情報なので最後に置き、CSS 側で高さを制限する。
             *
             * 説明・完了条件・タスク案は複数行になりうる（台帳の正規形はフィールド行＋
             * 直下のネスト箇条書き／ingest 由来の説明はブロック引用）。パーサが結合した
             * 改行・ネストのインデントをそのまま見せるため card-detail-multiline
             * （white-space: pre-wrap）で描画し、markdown としての再解釈はしない
             * （board は消費者に徹する。NFR-05。HTML/スクリプト断片がプレーンテキスト
             * のまま表示される AC-8 も維持）。 */}
            <dt>タスク案</dt>
            <dd
              className="card-detail-multiline"
              data-testid="ledger-task-plan"
            >
              {challenge.taskPlan ?? "-"}
            </dd>
            <dt>完了条件</dt>
            <dd
              className="card-detail-multiline"
              data-testid="ledger-completion-criteria"
            >
              {challenge.completionCriteria ?? "-"}
            </dd>
            {/* ラベルは台帳のフィールド名（関連リポジトリ）をそのまま使う。規定は
             * 関連サービス（ドメイン上のサービス名）と 関連リポジトリ（実リポジトリ）を
             * 別概念として併存させており、board 側で言い換えない（NFR-05）。 */}
            <dt>関連リポジトリ</dt>
            <dd data-testid="ledger-related-repos">
              <ChallengeRefs refs={challenge.relatedRepos} kind="repo" />
            </dd>
            <dt>関連Issue</dt>
            <dd data-testid="ledger-related-issues">
              <ChallengeRefs refs={challenge.relatedIssues} kind="issue" />
            </dd>
            <dt>関連PR</dt>
            <dd data-testid="ledger-related-prs">
              <ChallengeRefs refs={challenge.relatedPrs} kind="pull" />
            </dd>
            <dt>説明</dt>
            <dd
              className="card-detail-multiline card-detail-description"
              data-testid="ledger-description"
            >
              {challenge.description ?? "-"}
            </dd>
          </dl>
        </section>

        {provenance && (
          <section className="card-detail-provenance">
            <h3 className="card-detail-provenance-heading">取得元</h3>
            <dl className="card-detail-fields">
              <dt>ファイル</dt>
              <dd>{provenance.file}</dd>
              <dt>イベント</dt>
              <dd>{provenance.event}</dd>
              <dt>ts</dt>
              {/* 取得元の ts は runs.jsonl の該当行を人間が突き合わせるための
               * 照合材料（#85 の動機）なので、作業ログ（#152 で分精度へ整形）
               * とは違い秒・オフセットまで含めた生の値を表示し続ける。 */}
              <dd>{provenance.ts}</dd>
              <dt>キー</dt>
              <dd>{provenance.key}</dd>
              <dt>終了イベント</dt>
              <dd>
                {/* runningRuns（endedAt 未設定の run のみ。cache.ts の
                 * deriveRunningRuns 参照）から選ばれた run の provenance は、
                 * 現行の実装契約上 hasEnd が常に false（closeLatestOpenRun が
                 * endedAt と provenance.hasEnd を必ず同時に更新するため）。
                 * hasEnd: true 分岐は将来 runningRuns 以外の run 集合が渡され
                 * ても正しく表示できるよう防御的に残す。 */}
                {provenance.hasEnd
                  ? "対応する終了イベントあり"
                  : `対応する ${END_EVENT_LABEL[provenance.event]} なし`}
              </dd>
            </dl>
            <div className="card-detail-raw-record" data-testid="raw-record">
              <button
                type="button"
                className="card-detail-raw-record-toggle"
                aria-expanded={rawRecordExpanded}
                onClick={() => setRawRecordExpanded((expanded) => !expanded)}
              >
                元レコード{rawRecordExpanded ? "を折りたたむ" : "を表示"}
              </button>
              {rawRecordExpanded && (
                <pre className="card-detail-raw-record-content">
                  {provenance.raw}
                </pre>
              )}
            </div>
          </section>
        )}

        {resumeCommand && (
          <div className="resumebox" data-testid="resumebox">
            <p className="resumebox-heading">
              ⚠
              更新なし（要確認）のセッションがあります。再開コマンドをタブに挿入できます
            </p>
            <input
              type="text"
              readOnly
              className="resumebox-command"
              value={resumeCommand}
            />
            <button
              type="button"
              className="resumebox-prefill-button"
              onClick={() => prefill(agentName, resumeCommand)}
            >
              タブにプリフィル
            </button>
          </div>
        )}

        <h3 className="card-detail-log-heading">作業ログ</h3>
        {logState.status === "loading" && (
          <div className="card-detail-log-loading">読み込み中...</div>
        )}
        {logState.status === "error" && (
          <div className="card-detail-log-error">
            作業ログの取得に失敗しました
          </div>
        )}
        {logState.status === "success" && (
          <div className="card-detail-log-timeline">
            {logState.entries.length === 0 ? (
              <div className="card-detail-log-empty">作業ログはありません</div>
            ) : (
              logState.entries.map((entry, index) => (
                <div className="log-entry-row" key={`${entry.ts}-${index}`}>
                  {/* 表示は分精度の短い形式（Issue #152）。完全な ts は title で
                   * 参照できるようにし、データ層の値は無加工のまま保つ。 */}
                  <span className="log-entry-ts" title={entry.ts}>
                    {formatLogTimestamp(entry.ts)}
                  </span>
                  <span className="log-source-badge" data-source={entry.source}>
                    {entry.source}
                  </span>
                  <span className="log-entry-text">{entry.text}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </dialog>
  );
}
