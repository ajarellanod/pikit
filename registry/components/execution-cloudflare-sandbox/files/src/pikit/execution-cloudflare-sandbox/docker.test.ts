/**
 * Opt-in: the object's logic against the real base image (Alpine, Node, GNU tar), its container run by
 * Docker and reached with `docker exec`, as a Durable Object reaches its container with `exec`. Set
 * `PIKIT_DOCKER_IMAGE` to an image built from `images/base.Dockerfile`:
 *
 *   docker build --platform linux/amd64 -t pikit-cf-sandbox-base -f images/base.Dockerfile images
 *   PIKIT_DOCKER_IMAGE=pikit-cf-sandbox-base bun test docker.test.ts
 *
 * Skipped otherwise. Not Cloudflare's runtime: its `exec` streams, its inactivity timeout and its
 * limits are Cloudflare's own.
 */

import { expect, test } from "bun:test";
import { silentLogger } from "@pikit/core";
import { createMemoryBlobStorage } from "@pikit/contracts/testing";
import type { ContainerExecOptions, ContainerProcess, ContainerStart, SandboxContainer } from "./container.ts";
import { createObjectStorage } from "./fake-container.test-support.ts";
import type { Outcome, Values } from "./protocol.ts";
import { Sandbox } from "./sandbox.ts";
import { MANIFEST, SNAPSHOT_NAMESPACE } from "./snapshot.ts";

const IMAGE = process.env.PIKIT_DOCKER_IMAGE;

function dockerContainer(): SandboxContainer & { starts: ContainerStart[]; remove(): Promise<void> } {
  let id: string | undefined;
  const starts: ContainerStart[] = [];
  const run = async (argv: string[]) => {
    const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return out.trim();
  };
  return {
    starts,
    get running() {
      return id !== undefined;
    },
    images: { base: IMAGE ?? "" },
    start(options) {
      starts.push(options);
      id = Bun.spawnSync(["docker", "run", "-d", "--platform", "linux/amd64", ...(options.enableInternet ? [] : ["--network", "none"]), options.image]).stdout.toString().trim();
    },
    async exec(cmd: string[], options: ContainerExecOptions = {}): Promise<ContainerProcess> {
      if (id === undefined) throw new Error("not running");
      const flags = [...(options.stdin !== undefined ? ["-i"] : []), ...(options.cwd !== undefined ? ["-w", options.cwd] : []), ...Object.entries(options.env ?? {}).flatMap(([name, value]) => ["-e", `${name}=${value}`])];
      const child = Bun.spawn(["docker", "exec", ...flags, id, ...cmd], { stdin: options.stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
      if (options.stdin !== undefined && typeof child.stdin !== "number" && child.stdin !== undefined) {
        const sink = child.stdin;
        void (async () => {
          const reader = (options.stdin as ReadableStream<Uint8Array>).getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            sink.write(value);
          }
          await sink.end();
        })();
      }
      return { stdout: child.stdout as ReadableStream<Uint8Array>, stderr: child.stderr as ReadableStream<Uint8Array>, exitCode: child.exited, kill: (signal) => child.kill(signal) };
    },
    async destroy() {
      if (id !== undefined) await run(["docker", "rm", "-f", id]);
      id = undefined;
    },
    async setInactivityTimeout() {},
    async remove() {
      await this.destroy();
    },
  };
}

test.skipIf(IMAGE === undefined)("the base image: files, a command, an idle checkpoint with GNU tar and a restore into a new container", async () => {
  const container = dockerContainer();
  const blobs = createMemoryBlobStorage().namespace(SNAPSHOT_NAMESPACE);
  const clock = { offset: 0 };
  const sandbox = new Sandbox({
    container,
    storage: createObjectStorage(),
    snapshots: blobs,
    maxBlobBytes: 25 * 1024 * 1024,
    profile: () => ({ image: "base", internet: false }),
    root: "/workspace",
    idleMs: 600_000,
    backstopMs: 1_500_000,
    leaseMs: 120_000,
    callMs: 30_000,
    startMs: 60_000,
    snapshotMs: 60_000,
    maxUnpackedBytes: 1 << 30,
    now: () => Date.now() + clock.offset,
    logger: { ...silentLogger, error: (message, fields) => console.error(message, fields) },
  });
  const call = async <O extends keyof Values>(operation: O, body: unknown): Promise<Values[O]> => {
    const reply = await sandbox.serve({ sandbox: "s-1", agent: "developer", operation, body });
    if (!reply.ok) throw new Error(`${operation}: ${reply.message}`);
    const answer = reply.answer as Outcome<O>;
    if (!answer.ok) throw new Error(`${operation}: ${answer.error.code} ${answer.error.message}`);
    return answer.value;
  };
  try {
    expect(await call("open", {})).toEqual({ cwd: "/workspace", home: "/root" });
    await call("writeFile", { path: "/workspace/src/a.txt", content: { text: "kept" } });
    let state = await call("execStart", { command: "c-1", run: "ln -s src/a.txt inside && ln -s /etc/passwd outside && mkdir empty && uname -m", cwd: "/workspace", wait: 20_000, linger: 0 });
    let text = state.chunks.map((chunk) => chunk.text).join("");
    while (state.done === undefined) {
      state = await call("execRead", { command: "c-1", cursor: state.next, wait: 20_000, linger: 0 });
      text += state.chunks.map((chunk) => chunk.text).join("");
    }
    expect(state.done).toEqual({ ok: true, value: { exitCode: 0 } });
    expect(text).toContain("x86_64");

    clock.offset += 11 * 60_000;
    await sandbox.alarm();
    expect(container.running).toBe(false);
    const manifests = (await blobs.list("")).entries.filter((entry) => entry.key.endsWith(MANIFEST));
    expect(manifests).toHaveLength(1);

    expect(await call("readTextFile", { path: "/workspace/inside" })).toBe("kept");
    expect(await call("exists", { path: "/workspace/outside" })).toBe(false);
    expect(await call("fileInfo", { path: "/workspace/empty" })).toMatchObject({ kind: "directory" });
    expect(container.starts).toHaveLength(2);
  } finally {
    await container.remove();
  }
}, 240_000);
