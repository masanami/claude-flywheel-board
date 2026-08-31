import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CYCLE_LOCK_RELATIVE_PATH,
  acquireCycleLock,
  cycleLockPathFor,
  pidStartTime,
  releaseCycleLock,
} from "./cycle-lock.ts";

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "board-cycle-lock-"));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function ownerMeta(): Record<string, string> {
  const content = fs.readFileSync(
    path.join(cycleLockPathFor(workspace), "owner"),
    "utf-8",
  );
  const meta: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) {
      meta[line.slice(0, eq)] = line.slice(eq + 1);
    }
  }
  return meta;
}

describe("acquireCycleLock", () => {
  it("ロックをディレクトリとして作り、所有者メタデータを key=value 行で書く", () => {
    const result = acquireCycleLock(workspace, { sessionId: "s-1" });

    expect(result.ok).toBe(true);
    const lockPath = path.join(workspace, CYCLE_LOCK_RELATIVE_PATH);
    expect(fs.statSync(lockPath).isDirectory()).toBe(true);

    const meta = ownerMeta();
    expect(meta.pid).toBe(String(process.pid));
    expect(meta.session_id).toBe("s-1");
    // 上流 cycle-lock.sh が読む 4 キーがすべて存在すること（キーが欠けると
    // 上流側の生存判定が「メタデータ不能」分岐へ落ちる）。
    expect(Object.keys(meta).sort()).toEqual([
      "acquired_at",
      "pid",
      "pid_start",
      "session_id",
    ]);
  });

  it("acquired_at をコロン付きオフセットの ISO 8601 で書く（上流 iso_now と同形）", () => {
    acquireCycleLock(workspace, { sessionId: "s-1" });

    expect(ownerMeta().acquired_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
    );
  });

  it("pid_start は ps -o lstart= の正規化済み値と一致する（上流の生存判定が照合するキー）", () => {
    acquireCycleLock(workspace, { sessionId: "s-1" });

    expect(ownerMeta().pid_start).toBe(pidStartTime(process.pid));
  });

  it("親ディレクトリ .flywheel が無くても取得できる", () => {
    expect(fs.existsSync(path.join(workspace, ".flywheel"))).toBe(false);

    expect(acquireCycleLock(workspace, { sessionId: "s-1" }).ok).toBe(true);
  });

  it("既にロックが存在すると取得に失敗する（原子性: mkdir に recursive を使わない）", () => {
    fs.mkdirSync(path.join(workspace, CYCLE_LOCK_RELATIVE_PATH), {
      recursive: true,
    });

    const result = acquireCycleLock(workspace, { sessionId: "s-2" });

    expect(result.ok).toBe(false);
  });

  it("生存中の保持者がいるロックは削除せず、実行中である旨を返す", () => {
    // 自プロセスを保持者として記録したロック＝「生存・開始時刻一致」の分岐。
    acquireCycleLock(workspace, { sessionId: "s-1" });

    const result = acquireCycleLock(workspace, { sessionId: "s-2" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("run-cycle が実行中");
    }
    // ロックは残っている（board は決して奪わない）。
    expect(fs.existsSync(cycleLockPathFor(workspace))).toBe(true);
    expect(ownerMeta().session_id).toBe("s-1");
  });

  it("保持者が生存していない残骸ロックも board は回収せず、取得を諦める", () => {
    // board は残骸回収を行わない（回収は runs.jsonl への abandoned 代筆を伴い
    // NFR-01 区分③にあたるため）。上流 cycle-lock.sh との意図的な差分。
    const lockPath = cycleLockPathFor(workspace);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(
      path.join(lockPath, "owner"),
      // 存在しない PID（PID 1 は init だが開始時刻が一致しないため「PID 再利用」扱い）
      "pid=1\npid_start=Thu Jan  1 00:00:00 1970\nsession_id=dead\nacquired_at=1970-01-01T00:00:00+00:00\n",
    );

    const result = acquireCycleLock(workspace, { sessionId: "s-2" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("残骸回収を行わない");
    }
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("所有者メタデータの無いロックは、2 時間以内なら並走とみなす（安全側）", () => {
    fs.mkdirSync(cycleLockPathFor(workspace), { recursive: true });

    const result = acquireCycleLock(workspace, { sessionId: "s-2" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("2 時間以内");
    }
  });

  it("所有者メタデータの無いロックは、2 時間超なら残骸の可能性として案内する", () => {
    fs.mkdirSync(cycleLockPathFor(workspace), { recursive: true });

    const threeHoursLater = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const result = acquireCycleLock(workspace, {
      sessionId: "s-2",
      now: threeHoursLater,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("2 時間以上経過");
    }
  });
});

describe("releaseCycleLock", () => {
  it("記録済み session_id が一致すれば解放する", () => {
    const result = acquireCycleLock(workspace, { sessionId: "s-1" });
    expect(result.ok).toBe(true);

    expect(releaseCycleLock(workspace, "s-1")).toBe(true);
    expect(fs.existsSync(cycleLockPathFor(workspace))).toBe(false);
  });

  it("acquire が返すハンドルの release でも解放できる", () => {
    const result = acquireCycleLock(workspace, { sessionId: "s-1" });
    if (!result.ok) {
      throw new Error(result.reason);
    }

    expect(result.handle.release()).toBe(true);
    expect(fs.existsSync(cycleLockPathFor(workspace))).toBe(false);
  });

  it("所有者（session_id・pid）がいずれも一致しないロックは削除しない", () => {
    const lockPath = cycleLockPathFor(workspace);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(
      path.join(lockPath, "owner"),
      "pid=999999\npid_start=x\nsession_id=other\nacquired_at=1970-01-01T00:00:00+00:00\n",
    );

    expect(releaseCycleLock(workspace, "s-1")).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("ロックが存在しなければ解放不要として true を返す", () => {
    expect(releaseCycleLock(workspace, "s-1")).toBe(true);
  });
});

describe("上流 scripts/cycle-lock.sh との相互運用", () => {
  // 上流スクリプトが手元にあるときだけ実行する（VENDORING.md と同じ方針＝
  // 上流不在の環境では pass ではなく skip として結果に残す）。
  const upstreamScript = path.resolve(
    process.cwd(),
    "../claude-flywheel/scripts/cycle-lock.sh",
  );
  const hasUpstream = fs.existsSync(upstreamScript);

  it.skipIf(!hasUpstream)(
    "board が取得したロックに対し、上流の acquire は並走（exit 2）を返す",
    () => {
      const result = acquireCycleLock(workspace, { sessionId: "s-1" });
      expect(result.ok).toBe(true);

      let exitCode = 0;
      try {
        execFileSync(
          "bash",
          [upstreamScript, "acquire", "--workspace", workspace, "--dry-run"],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch (error) {
        exitCode = (error as { status?: number }).status ?? -1;
      }

      // 2 = 並走検出。board のロックが上流から「生きている」と読めていること
      // （＝ pid / pid_start の表記が上流の照合と一致していること）を確かめる。
      expect(exitCode).toBe(2);
    },
  );

  it.skipIf(!hasUpstream)(
    "上流が取得したロックを board は奪わず、解放もしない",
    () => {
      execFileSync(
        "bash",
        [upstreamScript, "acquire", "--workspace", workspace, "--dry-run"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      const result = acquireCycleLock(workspace, { sessionId: "s-1" });
      expect(result.ok).toBe(false);
      expect(releaseCycleLock(workspace, "s-1")).toBe(false);
      expect(fs.existsSync(cycleLockPathFor(workspace))).toBe(true);
    },
  );
});
