/**
 * Daemon integration tests:
 *   - Lockfile contention: second watch attempt exits non-zero
 *   - Daemon starts and stops cleanly
 *   - Daemon stays alive past startup (regression for keep-alive bug)
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import lockfile from "proper-lockfile";
import { buildConfig } from "../config/env.js";
import { runWatchDaemon } from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAEMON_LOCK_FILENAME = "watch.lock";

async function ensureFile(filePath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const fh = await fs.promises.open(filePath, "a", 0o600);
  await fh.close();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runWatchDaemon", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-test-"));
    // Point the projects dir to an empty tmp folder so chokidar doesn't scan ~/.claude
    process.env["GLYPHLING_PROJECTS_DIR"] = path.join(tmpDir, "projects");
    await fs.promises.mkdir(process.env["GLYPHLING_PROJECTS_DIR"]!, { recursive: true });
  });

  afterEach(async () => {
    delete process.env["GLYPHLING_PROJECTS_DIR"];
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("exits 1 when daemon lockfile is already held", async () => {
    const config = buildConfig(tmpDir);
    const lockFilePath = path.join(tmpDir, DAEMON_LOCK_FILENAME);

    // Pre-acquire the daemon lockfile to simulate a running watcher
    await ensureFile(lockFilePath);
    const release = await lockfile.lock(lockFilePath, {
      stale: 10_000,
      update: 2_000,
      retries: 0,
      realpath: false,
    });

    try {
      // runWatchDaemon should detect the held lock and return 1
      const exitCode = await runWatchDaemon(config);
      expect(exitCode).toBe(1);
    } finally {
      await release();
    }
  });

  it("acquires lockfile and releases it on stop signal", async () => {
    const config = buildConfig(tmpDir);
    const lockFilePath = path.join(tmpDir, DAEMON_LOCK_FILENAME);

    // We can't easily test the long-running path without process forking,
    // but we can verify: after a simulated run that immediately hits SIGTERM,
    // the lockfile is no longer held.
    //
    // Strategy: run the daemon in the same process with a SIGTERM sent after a
    // short delay. We check that the lockfile (.lock directory) is cleaned up.

    let exitCode: number | null = null;

    // Override process.exit to capture the exit code instead of actually exiting
    const origExit = process.exit.bind(process);
    let exitCalled = false;
    const mockExit = (code?: number | string | null | undefined) => {
      exitCalled = true;
      exitCode = typeof code === "number" ? code : 0;
      // Don't actually exit — just mark it
    };
    // @ts-expect-error — override for test
    process.exit = mockExit;

    // Start the daemon (it blocks internally, but we schedule a SIGTERM)
    const daemonPromise = runWatchDaemon(config);

    // Send SIGTERM after 300ms
    setTimeout(() => {
      process.emit("SIGTERM");
    }, 300);

    // Wait for the daemon to process the signal and call process.exit
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (exitCalled) {
          clearInterval(check);
          resolve();
        }
      }, 50);
      // Timeout safety
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, 3_000);
    });

    // Restore process.exit
    process.exit = origExit;

    // The daemon lockfile lock directory should not exist (was released)
    const lockDirPath = lockFilePath + ".lock";
    let lockDirExists = false;
    try {
      await fs.promises.access(lockDirPath);
      lockDirExists = true;
    } catch {
      lockDirExists = false;
    }

    expect(exitCalled).toBe(true);
    expect(exitCode).toBe(0);
    expect(lockDirExists).toBe(false);

    // Void the promise to avoid unhandled rejection warnings
    void daemonPromise.catch(() => undefined);
  });

  it("runs DEC-020 migration on startup (regression: applyDec020Migration must be wired)", async () => {
    // Fixture: a pet with stale (xp=6000, level=17 from old DEC-004 curve).
    // After migration the level under DEC-020 must be 31.
    const { writeState } = await import("../state/persistence.js");
    const config = buildConfig(tmpDir);
    const now = new Date().toISOString();
    const state = {
      schemaVersion: 1 as const,
      createdAt: now,
      updatedAt: now,
      pets: [
        {
          id: "01TEST00000000000000000000",
          schemaVersion: 1 as const,
          eggType: "shard" as const,
          name: "Bramble",
          createdAt: now,
          hatchedAt: now,
          lastFedAt: null,
          lastInteractionAt: now,
          xp: 6000,
          level: 17, // stale per DEC-004 curve
          personality: {
            dominant: "Energetic" as const,
            weights: {
              Stoic: 0.11,
              Friendly: 0.11,
              Pragmatic: 0.11,
              Energetic: 0.27,
              Gruff: 0.10,
              Philosophical: 0.10,
              Paranoid: 0.10,
              Curious: 0.10,
            },
            lockedAt: now,
            lastRefreshAt: now,
          },
          pauseIntervals: [],
          accumulatedNeglectSeconds: 0,
          lastTickAt: now,
          diedAt: null,
          tombstone: null,
          languageExposure: {},
          dailyCaps: {},
          lastLevelUpAt: null,
          lastPlayedAt: null,
          lastHatchedAt: null,
          lastEvolvedAt: null,
          lastPettedAt: null,
        },
      ],
      globals: {
        activePetId: "01TEST00000000000000000000",
        unlocks: { gifTier1: false, gifTier2: false, gifTier3: false, adoption: false },
        eventsCursor: 0,
        eventsHead: "",
        lastEventAt: 0,
      },
    };
    await writeState(config, state);

    // Mock process.exit, send SIGTERM after 300ms, wait for shutdown.
    const origExit = process.exit.bind(process);
    let exitCalled = false;
    process.exit = (() => {
      exitCalled = true;
    }) as typeof process.exit;
    const daemonPromise = runWatchDaemon(config);
    setTimeout(() => process.emit("SIGTERM"), 300);
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (exitCalled) {
          clearInterval(check);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, 3_000);
    });
    process.exit = origExit;
    void daemonPromise.catch(() => undefined);

    // Migration should have rewritten the state file with the corrected level.
    const stateAfter = JSON.parse(
      await fs.promises.readFile(path.join(tmpDir, "state.json"), "utf8")
    ) as { pets: Array<{ id: string; level: number; xp: number }> };
    const pet = stateAfter.pets.find((p) => p.id === "01TEST00000000000000000000")!;
    expect(pet.xp).toBe(6000); // XP preserved
    expect(pet.level).toBe(31); // recomputed under DEC-020 golden curve
  }, 10_000);

  it("stays alive past startup (regression: collector flushTimer must not be unref'd)", async () => {
    // Spawns the daemon from SOURCE via tsx and verifies it is still alive
    // 1.5 s after launch. Before the keep-alive fix, the daemon exited
    // silently within milliseconds of "Token collector started" because the
    // flush interval was unref'd and chokidar's persistent flag did not hold
    // the event loop open under macOS + iCloud Drive paths.
    //
    // Why tsx (not dist/src/bin.js)?
    // CI runs: npm ci → typecheck → npm test → npm run build
    // Tests run BEFORE the build, so dist/ does not exist on a fresh checkout.
    // The old guard (binExists early return) silently skipped this test in CI,
    // letting the regression go undetected. Running from source via tsx removes
    // the dist/ dependency entirely — the test now executes on every CI matrix
    // cell, every local run, and during prepublishOnly. Real built-artifact
    // coverage is owned by smoke-pack.yml.
    //
    // Why strip VITEST from the subprocess env?
    // src/cli.tsx:211 guards its auto-run with `if (process.env.VITEST !== "true")`.
    // The subprocess inherits env from vitest; without stripping it, main() never
    // runs, the daemon never starts, and the process exits immediately (code 0),
    // causing this assertion to pass spuriously. The allowlist below builds the
    // subprocess env from scratch so we're immune to whatever vitest injects next.
    const tsxBin = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
    const srcEntry = path.join(REPO_ROOT, "src", "bin.ts");

    // Build a clean env that mirrors a real user invocation.
    // Allowlist (not denylist) so new Vitest injections can't slip through.
    const spawnEnv: NodeJS.ProcessEnv = {
      PATH: process.env["PATH"],
      HOME: process.env["HOME"],
      GLYPHLING_HOME: tmpDir,
      GLYPHLING_PROJECTS_DIR: process.env["GLYPHLING_PROJECTS_DIR"]!,
    };

    const child = spawn(tsxBin, [srcEntry, "watch"], {
      env: spawnEnv,
      stdio: ["ignore", "ignore", "pipe"],
    });

    let exited = false;
    let earlyExitCode: number | null = null;
    child.on("exit", (code) => {
      exited = true;
      earlyExitCode = code;
    });

    try {
      // Give the daemon enough time to: acquire lock, start collector, and
      // run idle. If the keep-alive bug returns, it exits well before 1.5 s.
      await new Promise((r) => setTimeout(r, 1500));
      expect(exited, `daemon exited early with code ${earlyExitCode}`).toBe(false);
    } finally {
      // Clean shutdown
      if (!exited) child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (exited) return resolve();
        child.on("exit", () => resolve());
        // Hard timeout in case SIGTERM is ignored
        setTimeout(() => {
          if (!exited) child.kill("SIGKILL");
          resolve();
        }, 2_000);
      });
    }
  }, 10_000);
});
