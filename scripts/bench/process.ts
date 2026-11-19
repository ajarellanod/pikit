/**
 * The processes the bench starts, and their end: every command is awaited (async `Bun.spawn`, never
 * `spawnSync`: Bun 1.4's can lose a child's exit), and `wrangler dev` runs in a process group of its
 * own (`detached`), so stopping it ends workerd and esbuild with it. `stopAll` runs on exit, on
 * SIGINT and SIGTERM: the bench never leaves a wrangler behind.
 */

import type { Subprocess } from "bun";

const ENV = { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" };

/** Runs `command` in `cwd` to its end; rejects with its output when it exits non-zero or outlives `timeoutMs`. */
export async function run(command: string[], cwd: string, timeoutMs = 600_000): Promise<string> {
  const child = Bun.spawn(command, { cwd, env: ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}\n${out}${err}`);
    return out + err;
  } finally {
    clearTimeout(timer);
  }
}

const running = new Set<Dev>();

export interface Dev {
  url: string;
  /** Everything wrangler and workerd printed so far (stdout and stderr). */
  output(): string;
  stop(): Promise<void>;
}

async function readInto(stream: ReadableStream<Uint8Array>, append: (text: string) => void) {
  const decoder = new TextDecoder();
  for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }));
}

/** Signals the group, then waits for the leader's exit; SIGKILL to the group after `graceMs`. */
async function endGroup(child: Subprocess, graceMs = 5_000): Promise<void> {
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-child.pid, name);
    } catch {
      // The group is already gone.
    }
  };
  signal("SIGTERM");
  const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(graceMs).then(() => false)]);
  // workerd may outlive wrangler's node: the whole group goes, whatever the leader did.
  signal("SIGKILL");
  if (!exited) await child.exited;
}

/**
 * `wrangler dev` of `dir` with `config`, on `port`; resolves once it prints that it is ready. The
 * first request after that is the isolate's first.
 */
export async function startDev(dir: string, config: string, name: string, port: number, inspectorPort: number, readyMs = 120_000): Promise<Dev> {
  const child = Bun.spawn(
    [`${dir}/node_modules/.bin/wrangler`, "dev", "--config", config, "--name", name, "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspectorPort), "--show-interactive-dev-session=false"],
    { cwd: dir, env: ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true },
  );
  let text = "";
  const append = (chunk: string) => void (text += chunk);
  void readInto(child.stdout, append);
  void readInto(child.stderr, append);
  let stopped: Promise<void> | undefined;
  const dev: Dev = {
    url: `http://127.0.0.1:${port}`,
    output: () => text,
    stop: () =>
      (stopped ??= endGroup(child).finally(() => {
        running.delete(dev);
      })),
  };
  running.add(dev);
  const deadline = Date.now() + readyMs;
  while (!/Ready on http/.test(text)) {
    if (child.exitCode !== null || Date.now() > deadline) {
      await dev.stop();
      throw new Error(`bench: wrangler dev ${child.exitCode !== null ? `exited ${child.exitCode}` : `was not ready within ${readyMs} ms`}\n${text.slice(-4000)}`);
    }
    await Bun.sleep(50);
  }
  return dev;
}

/** Stops every `wrangler dev` still running. */
export async function stopAll(): Promise<void> {
  await Promise.all([...running].map((dev) => dev.stop()));
}

let hooked = false;
/** Stops every wrangler on SIGINT or SIGTERM (then exits 130 or 143); the caller awaits `stopAll` at its own end. */
export function stopOnSignals(): void {
  if (hooked) return;
  hooked = true;
  for (const [name, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.on(name, () => {
      void stopAll().finally(() => process.exit(code));
    });
  }
}
