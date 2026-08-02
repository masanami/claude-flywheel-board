import { useEffect, useRef, useState } from "react";
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

// API（GET /api/md/tree）は repo ごとのフラットな相対パス一覧を返す
// （サーバはツリー構造を持たない。#61 の決定を変えない）。IDE 風の
// ネスト表示（#110）はクライアント側の表示専用の導出であり、ここで
// 相対パスをディレクトリ階層へ組み立てる。
type TreeFile = { name: string; path: string };
type TreeDir = {
  name: string;
  path: string;
  dirs: TreeDir[];
  files: TreeFile[];
};

function buildDirTree(paths: readonly string[]): TreeDir {
  const root: TreeDir = { name: "", path: "", dirs: [], files: [] };
  for (const filePath of paths) {
    const segments = filePath.split("/");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let child = node.dirs.find((dir) => dir.name === segment);
      if (!child) {
        child = {
          name: segment,
          path: node.path === "" ? segment : `${node.path}/${segment}`,
          dirs: [],
          files: [],
        };
        node.dirs.push(child);
      }
      node = child;
    }
    node.files.push({
      name: segments[segments.length - 1] ?? "",
      path: filePath,
    });
  }
  return root;
}

function toggleInSet(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

// キーボード操作（#114。WAI-ARIA ツリーパターンの矢印キー移動・開閉）。
//
// - 追加 state は持たず、DOM から「いま見えているノード（button）」を
//   描画順に列挙して辿る。閉じたディレクトリの子はそもそも DOM に無い
//   （条件レンダリング）ため、「表示中のノードだけを移動する」が自然に
//   成立する。ノード種別は aria-expanded 属性の有無で判定する
//   （ディレクトリ/repo は "true"/"false"・ファイルは属性なし）。
// - 開閉は対象 button の click() に委譲し、既存の onClick ハンドラ
//   （expandedDirs / collapsedRepos の toggle）を再利用する。ファイル
//   button は click() しない（フォーカス移動だけでは選択＝fetch + WS 購読を
//   発火させない。Enter/Space はブラウザ標準の button 動作で click になり、
//   そこで初めて選択が確定する）。
// - 親ノードへの移動（←）は DOM 構造に依存する: 子リスト（ul）は常に
//   親ノード button の直後の兄弟としてレンダリングされる（repo 直下・
//   ネスト内の li とも同じ並び）ため、closest("ul") の previousElementSibling
//   が親 button になる。repo 見出し自体は ul の外にあり、親を持たない。
// - role="tree"/"treeitem" は付与しない（button のアクセシブルロールを
//   変えると既存テスト・支援技術の挙動が広く変わるため。Issue #114 の決定）。
function handleTreeKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
  );
  const index = buttons.indexOf(target);
  if (index === -1) {
    return;
  }
  // ディレクトリ/repo は "true"/"false"、ファイルは null。
  const expandedAttr = target.getAttribute("aria-expanded");

  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      buttons[index + 1]?.focus();
      break;
    case "ArrowUp":
      event.preventDefault();
      buttons[index - 1]?.focus();
      break;
    case "ArrowRight": {
      event.preventDefault();
      if (expandedAttr === "false") {
        target.click();
      } else if (expandedAttr === "true") {
        // 展開済みなら最初の子へ移動する。DOM 上の次の button が本当に
        // このノードの子リスト（button 直後の ul）内にある場合のみ移動する
        // （子が空のノードで次の repo へ飛んでしまわないようにガード）。
        const subtree = target.nextElementSibling;
        const next = buttons[index + 1];
        if (subtree instanceof HTMLElement && next && subtree.contains(next)) {
          next.focus();
        }
      }
      break;
    }
    case "ArrowLeft": {
      event.preventDefault();
      if (expandedAttr === "true") {
        target.click();
        break;
      }
      const parentButton = target.closest("ul")?.previousElementSibling;
      if (parentButton instanceof HTMLButtonElement) {
        parentButton.focus();
      }
      break;
    }
  }
}

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
  // 開閉状態（#110）。既定は「repo は展開・ディレクトリは折りたたみ」の
  // ため、既定からの反転だけを持つ2つの Set で表現する（collapsedRepos は
  // 「閉じた repo」・expandedDirs は「開いたディレクトリ」。空集合＝既定）。
  // キーは selectedKey と同じ `repo` / `repo/dirPath` 形式。リフレッシュ後も
  // state が残るため開閉状態は保持され、一覧から消えたノードのキーは参照
  // されなくなるだけで無害。パネルを閉じるとアンマウントで破棄される
  // （selectedKey と同じライフサイクル）。
  const [collapsedRepos, setCollapsedRepos] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(
    new Set(),
  );

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

  // ディレクトリ→ファイルの順で描画する（IDE の慣例に合わせる）。並び順は
  // サーバがソート済みのフラット一覧の出現順をそのまま使う。
  const renderDirChildren = (repoName: string, node: TreeDir) => (
    <ul className="file-tree-node-list">
      {node.dirs.map((dir) => {
        const dirKey = `${repoName}/${dir.path}`;
        const expanded = expandedDirs.has(dirKey);
        return (
          <li key={dirKey}>
            <button
              type="button"
              className="file-tree-dir-button"
              aria-expanded={expanded}
              onClick={() =>
                setExpandedDirs((prev) => toggleInSet(prev, dirKey))
              }
            >
              <span className="file-tree-toggle-icon" aria-hidden="true">
                {expanded ? "▾" : "▸"}
              </span>
              <span className="file-tree-node-name">{dir.name}</span>
            </button>
            {expanded && renderDirChildren(repoName, dir)}
          </li>
        );
      })}
      {node.files.map((file) => {
        const fileKey = `${repoName}/${file.path}`;
        return (
          <li key={fileKey}>
            <button
              type="button"
              className="file-tree-file-button"
              aria-current={fileKey === selectedKey ? "true" : undefined}
              title={file.path}
              onClick={() => {
                setSelectedKey(fileKey);
                onSelectFile(repoName, file.path);
              }}
            >
              <span className="file-tree-node-name">{file.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div
      className="file-tree"
      data-testid="file-tree"
      onKeyDown={handleTreeKeyDown}
    >
      {treeState.refreshing && (
        <div className="file-tree-status">更新中...</div>
      )}
      {treeState.refreshFailed && (
        <div className="file-tree-status file-tree-status-error">
          最新の更新に失敗しました
        </div>
      )}
      {hasFiles ? (
        treeState.repos.map((repo) => {
          const collapsed = collapsedRepos.has(repo.name);
          return (
            <div className="file-tree-repo" key={repo.name}>
              <button
                type="button"
                className="file-tree-dir-button file-tree-repo-name"
                aria-expanded={!collapsed}
                onClick={() =>
                  setCollapsedRepos((prev) => toggleInSet(prev, repo.name))
                }
              >
                <span className="file-tree-toggle-icon" aria-hidden="true">
                  {collapsed ? "▸" : "▾"}
                </span>
                <span className="file-tree-node-name">{repo.name}</span>
              </button>
              {!collapsed &&
                renderDirChildren(repo.name, buildDirTree(repo.files))}
            </div>
          );
        })
      ) : (
        <div className="file-tree-empty">.md ファイルが見つかりません</div>
      )}
    </div>
  );
}
