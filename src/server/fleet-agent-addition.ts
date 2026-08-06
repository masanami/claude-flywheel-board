import type { FleetEntry } from "./manifest.ts";
import type { FleetWatcher } from "./watcher.ts";

/**
 * 稼働中サーバへ新規エージェントを1件動的に追加する「再構築機構」（Issue #121）。
 *
 * HTTP（registerApiRoutes / createApp 経由）・WS（attachWebSocketServer）・
 * pty ブリッジ（createTerminalWebSocketServer）は起動時に渡された getFleetEntries
 * コールバック経由で fleetEntries 配列を遅延参照している（Issue #62）。この
 * 配列（同一参照）へ push することで、次回以降の getFleetEntries() 呼び出しが
 * 新 entry を含むようになる。fleetWatcher へは addAgentWatch で追加し、
 * 稼働中の chokidar 監視ハンドルを再生成せずに監視対象へ加える。
 *
 * 配置場所（Issue #122 セルフレビュー指摘対応）: 当初 index.ts に置いていたが、
 * `POST /api/fleet/agents`（api.ts）からも同じ push+addAgentWatch の手順を
 * 再利用する必要があり、index.ts → api.ts の既存 import 方向（index.ts が
 * registerApiRoutes 等を api.ts から import する）があるため、api.ts から
 * index.ts を import すると循環依存になる。両者から依存できる独立モジュールに
 * 切り出すことで、index.ts（isMainModule ブロックからの本番配線）と api.ts
 * （POST ハンドラ）の両方がこの1つの実装を再利用できるようにする。テストも
 * このモジュール隣（fleet-agent-addition.test.ts）へ合わせて移設済み（元は
 * index.test.ts。index.ts はこの関数を re-export せず、直接 import しない）。
 *
 * クリティカル設計決定: loadFleetManifest() をここから再度呼び出さない
 * （「loadFleetManifest() の呼び出しは起動時1箇所のみ」という isMainModule
 * ブロックの不変条件を維持する）。fleet.tsv への追記（#120）・API エンドポイント
 * としての配線（#122）・name 重複や repo パス妥当性等のバリデーションはこの
 * 関数のスコープ外（無条件追加。呼び出し元の責務）。
 *
 * 失敗時の挙動（セルフレビュー指摘対応の明記）: fleetEntries への push は常に
 * 成功する（同期処理・例外なし）。その後の addAgentWatch が失敗した場合、
 * push 済みの entry はロールバックされず、HTTP/WS/pty からは見えるが
 * watcher には監視されない状態になりうる。また戻り値の Promise が resolve
 * することは「追加した entry の初回スキャンが完了した」ことを意味するのみで、
 * スキャン自体の成否（parseErrors の有無）までは表さない
 * （scanAgent の既存方針どおり、読み込み失敗は例外ではなく該当 entry の
 * ParseError として可視化される）。呼び出し元（api.ts の POST ハンドラ）が
 * これらを利用者へ通知する必要がある場合は、呼び出し元の責務として設計する
 * （実際に api.ts は addAgentWatch 失敗時、push 済みの entry を自前で
 * ロールバックしている）。
 */
export async function addFleetEntry(
  fleetEntries: FleetEntry[],
  fleetWatcher: FleetWatcher,
  entry: FleetEntry,
): Promise<void> {
  fleetEntries.push(entry);
  await fleetWatcher.addAgentWatch(entry);
}
