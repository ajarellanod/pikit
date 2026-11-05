/**
 * Doubles for the tests: a container that runs the real helper (`images/pikit-sandbox`) and the
 * machine's `tar` as local processes in a temporary directory (its disk: `destroy` wipes the workspace,
 * as a released container loses it), a container that never answers, and a Durable Object's storage.
 * Archives no tar program would write: `archive.test-support.ts`.
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerExecOptions, ContainerProcess, ContainerStart, SandboxContainer } from "./container.ts";
import { HELPER } from "./container.ts";
import type { ObjectStorage } from "./sandbox.ts";

export const HELPER_SCRIPT = join(import.meta.dir, "images", "pikit-sandbox");

export interface FakeContainer extends SandboxContainer {
  readonly dir: string;
  /** The workspace root, inside `dir`. */
  readonly root: string;
  readonly starts: ContainerStart[];
  readonly execs: string[][];
  destroyed: number;
  inactivity: number[];
  /** While true, `exec` never answers (a container past `max_instances`). */
  hang: boolean;
  /** The container stops on its own (the platform's inactivity timeout): its disk is lost. */
  lose(): void;
  cleanup(): void;
}

export function createFakeContainer(options: { images?: Record<string, string> } = {}): FakeContainer {
  const dir = mkdtempSync(join(tmpdir(), "pikit-cf-sandbox-"));
  const root = join(dir, "workspace");
  const home = join(dir, "home");
  const temp = join(dir, "tmp");
  for (const path of [home, temp]) mkdirSync(path, { recursive: true });
  const live = new Set<ReturnType<typeof Bun.spawn>>();
  let running = false;
  const wipe = () => {
    for (const process of live) process.kill(9);
    live.clear();
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}.restore`, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
    mkdirSync(temp, { recursive: true });
  };
  const container: FakeContainer = {
    dir,
    root,
    starts: [],
    execs: [],
    destroyed: 0,
    inactivity: [],
    hang: false,
    get running() {
      return running;
    },
    images: options.images ?? { base: "registry.example/base@sha256:1", designer: "registry.example/designer@sha256:2" },
    start(start) {
      if (running) throw new Error("fake container: start while running");
      running = true;
      container.starts.push(start);
    },
    async exec(cmd: string[], exec: ContainerExecOptions = {}): Promise<ContainerProcess> {
      container.execs.push(cmd);
      if (container.hang) return await new Promise<never>(() => {});
      if (!running) throw new Error("fake container: not running");
      const argv = cmd[0] === HELPER ? [process.execPath, HELPER_SCRIPT, ...cmd.slice(1)] : cmd;
      const child = Bun.spawn(argv, {
        cwd: exec.cwd ?? dir,
        env: { ...process.env, ...exec.env, HOME: home, TMPDIR: temp, COPYFILE_DISABLE: "1" },
        stdin: exec.stdin === undefined ? "ignore" : "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      live.add(child);
      void child.exited.then(() => live.delete(child));
      if (exec.stdin !== undefined && child.stdin !== undefined && typeof child.stdin !== "number") {
        const sink = child.stdin;
        void (async () => {
          const reader = (exec.stdin as ReadableStream<Uint8Array>).getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              sink.write(value);
            }
          } finally {
            await sink.end();
          }
        })();
      }
      return { stdout: child.stdout as ReadableStream<Uint8Array>, stderr: child.stderr as ReadableStream<Uint8Array>, exitCode: child.exited, kill: (signal) => child.kill(signal) };
    },
    async destroy() {
      container.destroyed++;
      running = false;
      wipe();
    },
    async setInactivityTimeout(ms) {
      container.inactivity.push(ms);
    },
    lose() {
      running = false;
      wipe();
    },
    cleanup() {
      wipe();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return container;
}

/** A Durable Object's storage: values and the one alarm. */
export function createObjectStorage(): ObjectStorage & { values: Map<string, unknown>; alarm: number | null } {
  const values = new Map<string, unknown>();
  const storage = {
    values,
    alarm: null as number | null,
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) {
      values.set(key, structuredClone(value));
    },
    async getAlarm() {
      return storage.alarm;
    },
    async setAlarm(time: number) {
      storage.alarm = time;
    },
  };
  return storage;
}
