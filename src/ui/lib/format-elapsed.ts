// 実行中 Run の経過時間を日本語表記でフォーマットする純粋関数。
// クライアント側タイマー（setInterval等）は持たない設計（要件どおり）。
// 呼び出し側が render 時点の Date.now() を渡すことで、agent_update push による
// 再レンダー時に自然と更新される。

export function formatElapsed(startedAt: string, now: Date): string {
  const elapsedMs = now.getTime() - Date.parse(startedAt);
  const totalMinutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}時間${minutes}分` : `${minutes}分`;
}
