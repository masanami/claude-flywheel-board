import { useEffect, useState } from "react";
import type { MdTreeRepo, MdTreeResponse } from "../board-types.ts";

type FileTreeProps = {
  // PreviewPanel が保持する再取得トリガー。値の変化のみで再フェッチする
  // （ポーリングはしない。親要件 #61 の決定）。
  refreshToken: number;
  onSelectFile: (repo: string, path: string) => void;
};

type TreeState =
  | { status: "loading" }
  | {
      status: "success";
      repos: MdTreeRepo[];
      // リフレッシュ中・リフレッシュ失敗時も直前の取得結果を表示し続ける
      // ため（セルフレビュー指摘: 押下のたびに一覧が消えるちらつき・失敗時の
      // データ消失を防ぐ）、成功状態の中にサブフラグとして持たせる。
      refreshing: boolean;
      refreshFailed: boolean;
    }
  | { status: "error" };

export function FileTree({ refreshToken, onSelectFile }: FileTreeProps) {
  const [treeState, setTreeState] = useState<TreeState>({ status: "loading" });
  // 選択状態はクリック時の視覚的フィードバックのためだけにローカル
  // （uncontrolled）に保持する。選択ファイルの内容取得・レンダリングは
  // #69 で実装済み（onSelectFile 経由で PreviewPanel が取得・表示する）。
  // - リフレッシュ後は明示的にリセットしない（`repo/file` キーが新しい
  //   一覧に存在すれば選択状態を保持し、無くなっていれば該当ボタンが
  //   存在しないため自然にハイライトが外れる）。
  // - パネルを閉じると PreviewPanel 側で body（＝FileTree）がアンマウント
  //   されるため、この selectedKey も破棄される。#69 では「選択状態を
  //   PreviewPanel へ持ち上げて controlled にする」ではなく「パネルを
  //   閉じた時点で PreviewPanel 側の表示中ファイル state も破棄する」方を
  //   採用した（PreviewPanel.tsx の handleToggleOpen が閉じる操作時に
  //   selectedFile を null に戻し、表示中の Markdown 内容も idle 状態へ戻す）。
  //   これにより両者は常に「未選択」状態で揃った状態からパネルの再オープンを
  //   迎える。
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // マウント時（＝パネルオープン時）と refreshToken 変化時（＝リフレッシュ
  // ボタン押下時）にのみ取得する。CardDetailModal の fetch パターン
  // （cancelled フラグ・AbortController不使用）を踏襲。
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken は本体で読まないが、リフレッシュボタン押下のたびに再フェッチを発火させる意図的なトリガー依存（TerminalPane.tsx と同じパターン）
  useEffect(() => {
    let cancelled = false;
    // 既に取得済みのツリーがある場合（＝リフレッシュ）は、取得中も直前の
    // 結果を表示したままにする（初回取得のみ loading 表示にする）。
    setTreeState((prev) =>
      prev.status === "success"
        ? { ...prev, refreshing: true, refreshFailed: false }
        : { status: "loading" },
    );

    fetch("/api/md/tree")
      .then((response) => {
        if (!response.ok) {
          throw new Error(`unexpected status: ${response.status}`);
        }
        return response.json() as Promise<MdTreeResponse>;
      })
      .then((data) => {
        if (!cancelled) {
          setTreeState({
            status: "success",
            repos: data.repos,
            refreshing: false,
            refreshFailed: false,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTreeState((prev) =>
            prev.status === "success"
              ? { ...prev, refreshing: false, refreshFailed: true }
              : { status: "error" },
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  if (treeState.status === "loading") {
    return <div className="file-tree-loading">読み込み中...</div>;
  }

  if (treeState.status === "error") {
    return (
      <div className="file-tree-error">ファイルツリーの取得に失敗しました</div>
    );
  }

  const hasFiles = treeState.repos.some((repo) => repo.files.length > 0);

  return (
    <div className="file-tree" data-testid="file-tree">
      {treeState.refreshing && (
        <div className="file-tree-status">更新中...</div>
      )}
      {treeState.refreshFailed && (
        <div className="file-tree-status file-tree-status-error">
          最新の更新に失敗しました
        </div>
      )}
      {hasFiles ? (
        treeState.repos.map((repo) => (
          <div className="file-tree-repo" key={repo.name}>
            <div className="file-tree-repo-name">{repo.name}</div>
            <ul className="file-tree-file-list">
              {repo.files.map((file) => {
                const key = `${repo.name}/${file}`;
                return (
                  <li key={key}>
                    <button
                      type="button"
                      className="file-tree-file-button"
                      aria-current={key === selectedKey ? "true" : undefined}
                      onClick={() => {
                        setSelectedKey(key);
                        onSelectFile(repo.name, file);
                      }}
                    >
                      {file}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      ) : (
        <div className="file-tree-empty">.md ファイルが見つかりません</div>
      )}
    </div>
  );
}
