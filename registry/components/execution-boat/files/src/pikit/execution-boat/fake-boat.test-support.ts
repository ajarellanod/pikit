/**
 * A fake boat.dev API: a `fetch` that answers the calls execution-boat makes (`api.ts`), as the API
 * reference documents them, over local directories: each sandbox's home is `<root>/<workspace
 * label>/home` (its `/tmp/pikit`, `<root>/<workspace label>/tmp`), and its commands run in a real
 * local `bash`, so the tests check the real helper and the real wrapper. What a VM is (Ubuntu, its
 * own kernel) is not faked: the live test (`live.test.ts`) checks that.
 *
 * - **Lifecycle**: a create or a resume is `provisioning`, then `ready` after `createMs` / `resumeMs`
 *   (real time: the resume latency the tests set); a stop kills the sandbox's commands (boat keeps no
 *   running programs) and archives it, its `stoppedAt` on the test's clock; a delete removes its
 *   directory. Commands and file URLs on a sandbox that is not ready answer 409 `sandbox_not_ready`.
 * - **Checks** what boat would refuse: the key on every API call (401), `noEnv: true` on each create
 *   and resume (recorded), the confirmation header of a delete, file URLs only under the home or the
 *   temporary directory, and no `Authorization` on a signed URL (recorded as a leak).
 * - **Faults**: `down` (every call fails, as a network outage), `hang` (no answer until cancelled),
 *   `override` (one route answers what the test says: an error, a malformed body), `cutDownloads`
 *   (a signed download's body fails after its first bytes). A signed upload whose Content-Length is
 *   not its body's is refused (400), as a server would.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Clock } from "@pikit/core";

export interface FakeProcess {
  pid: number;
  child: ChildProcess;
  stdout: Buffer;
  stderr: Buffer;
  running: boolean;
  exitCode: number | null;
  command: string;
}

export interface FakeSandbox {
  id: string;
  state: string;
  labels: Record<string, string>;
  type: string;
  createdAt: number;
  stoppedAt?: number | undefined;
  hydratedAt?: number;
  readyAt: number;
  dir: string;
  processes: Map<number, FakeProcess>;
  ttlSeconds: number | null;
}

export interface Recorded {
  method: string;
  path: string;
  body?: unknown;
  query?: string;
}

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const failure = (status: number, code: string, message: string) => json(status, { ok: false, type: "sandbox.error", status, code, message, requestId: "req_fake", error: { code, message, status } });

export class FakeBoat {
  readonly sandboxes = new Map<string, FakeSandbox>();
  readonly calls: Recorded[] = [];
  /** Authorization headers seen on signed file URLs (none expected). */
  readonly leaks: string[] = [];
  /** Saved snapshots (templates) by name: the directory a sandbox made `from` it starts with. */
  readonly templates = new Map<string, string>();
  down = false;
  hang = false;
  /** Answers one route (method and a path regex) with what it returns, while set. */
  override: { method: string; path: RegExp; answer: () => Response | Promise<Response> } | undefined;
  createMs = 0;
  resumeMs = 0;
  /** While true, a signed download's body errors after its first 100 bytes. */
  cutDownloads = false;
  /** Each signed upload: its Content-Length header and the bytes received. */
  readonly uploads: { contentLength: string | null; bytes: number }[] = [];
  /** The page size of the sandbox list (tests paging). */
  pageSize = 100;
  private next = 1;
  private nextPid = 100;
  private signed = new Map<string, { sandbox: string; path: string; method: "GET" | "PUT" }>();

  constructor(
    readonly root: string,
    readonly key: string,
    private readonly clock: Clock,
  ) {}

  /** Where workspace `key`'s VM keeps its files: what the component's `paths` seam gives. */
  static paths(root: string) {
    return (workspace: string) => ({ home: join(root, workspace, "home"), tmp: join(root, workspace, "tmp") });
  }

  /** The sandboxes of a workspace (its label), newest last. */
  of(workspace: string): FakeSandbox[] {
    return [...this.sandboxes.values()].filter((s) => s.labels["pikit-workspace"] === workspace);
  }

  count(method: string, path: RegExp): number {
    return this.calls.filter((call) => call.method === method && path.test(call.path)).length;
  }

  private state(sandbox: FakeSandbox): string {
    if (sandbox.state === "provisioning" && Date.now() >= sandbox.readyAt) sandbox.state = "ready";
    return sandbox.state;
  }

  private view(sandbox: FakeSandbox) {
    return {
      id: sandbox.id,
      name: `fake-${sandbox.id}`,
      state: this.state(sandbox),
      labels: sandbox.labels,
      type: sandbox.type,
      createdAt: new Date(sandbox.createdAt).toISOString(),
      stoppedAt: sandbox.stoppedAt === undefined ? null : new Date(sandbox.stoppedAt).toISOString(),
      hydratedAt: sandbox.hydratedAt === undefined ? null : new Date(sandbox.hydratedAt).toISOString(),
      ttlSeconds: sandbox.ttlSeconds,
      desktopAvailable: false,
      snapshotAvailable: true,
    };
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const signal = init?.signal ?? undefined;
    if (this.down) throw new TypeError("fetch failed");
    if (this.hang) {
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("aborted", "AbortError")), { once: true });
      });
    }
    if (url.pathname.startsWith("/signed/")) return this.file(url, method, headers, init);
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") body = JSON.parse(init.body) as Record<string, unknown>;
    const path = url.pathname.replace(/^\/api\/v1/, "");
    this.calls.push({ method, path, ...(init?.body !== undefined && { body }), ...(url.search !== "" && { query: url.search }) });
    if (headers.get("authorization") !== `Bearer ${this.key}`) return failure(401, "unauthorized", "missing or wrong API key");
    if (this.override !== undefined && this.override.method === method && this.override.path.test(path)) return this.override.answer();
    return this.route(method, path, url, body, headers);
  }) as typeof fetch;

  private route(method: string, path: string, url: URL, body: Record<string, unknown>, headers: Headers): Response | Promise<Response> {
    if (method === "POST" && path === "/sandboxes") return this.create(body);
    if (method === "GET" && path === "/sandboxes") return this.list(url);
    const match = /^\/sandboxes\/([^/]+)(\/.*)?$/.exec(path);
    if (match === null) return failure(404, "not_found", "no such route");
    const sandbox = this.sandboxes.get(decodeURIComponent(match[1] as string));
    const rest = match[2] ?? "";
    if (sandbox === undefined) return failure(404, "sandbox_not_found", "no such sandbox");
    if (rest === "" && method === "GET") return json(200, { ok: true, type: "sandbox.info", sandbox: this.view(sandbox) });
    if (rest === "" && method === "PATCH") {
      if ("ttlSeconds" in body) sandbox.ttlSeconds = body.ttlSeconds as number | null;
      return json(200, { ok: true, type: "sandbox.info", sandbox: this.view(sandbox) });
    }
    if (rest === "" && method === "DELETE") {
      if (headers.get("x-ascii-confirm-delete") !== sandbox.id) return failure(409, "confirmation_required", "X-Ascii-Confirm-Delete must equal the sandbox id");
      this.kill(sandbox);
      this.sandboxes.delete(sandbox.id);
      rmSync(sandbox.dir, { recursive: true, force: true });
      return json(202, { ok: true, type: "deletion.accepted" });
    }
    if (rest === "/stop" && method === "POST") {
      this.kill(sandbox);
      sandbox.state = "archived";
      sandbox.stoppedAt = this.clock.now();
      return json(202, { ok: true, type: "sandbox.stopping", id: sandbox.id, status: "archiving", sandbox: this.view(sandbox) });
    }
    if (rest === "/resume" && method === "POST") {
      if (this.state(sandbox) !== "archived") return failure(409, "sandbox_not_stopped", "only a stopped sandbox resumes");
      if (body.noEnv !== true) return failure(400, "test_requires_noenv", "the fake requires noEnv on every resume");
      sandbox.state = "provisioning";
      sandbox.readyAt = Date.now() + this.resumeMs;
      sandbox.stoppedAt = undefined;
      sandbox.hydratedAt = this.clock.now();
      if (typeof body.type === "string") sandbox.type = body.type;
      return json(202, { ok: true, type: "sandbox.resuming", id: sandbox.id, status: "provisioning", sandbox: this.view(sandbox) });
    }
    if (this.state(sandbox) !== "ready") return failure(409, "sandbox_not_ready", `the sandbox is ${sandbox.state}`);
    if (rest === "/commands" && method === "POST") return this.command(sandbox, body);
    const command = /^\/commands\/([0-9]+)$/.exec(rest);
    if (command !== null) {
      const process = sandbox.processes.get(Number(command[1]));
      if (process === undefined) return failure(404, "process_not_found", "no such process");
      if (method === "DELETE") {
        const signaled = process.running;
        this.stopProcess(process);
        return json(200, { ok: true, type: "command.stopped", processId: process.pid, running: false, signaled, command: null });
      }
      const stdoutOffset = Number(url.searchParams.get("stdoutOffset") ?? 0);
      const stderrOffset = Number(url.searchParams.get("stderrOffset") ?? 0);
      return json(200, {
        ok: true,
        type: "command.status",
        success: true,
        processId: process.pid,
        status: process.running ? "running" : "exited",
        running: process.running,
        exitCode: process.exitCode,
        stdout: process.stdout.subarray(stdoutOffset).toString("utf8"),
        stderr: process.stderr.subarray(stderrOffset).toString("utf8"),
        stdoutNextOffset: process.stdout.length,
        stderrNextOffset: process.stderr.length,
        more: false,
      });
    }
    const fileUrl = /^\/files\/(upload|download)-url$/.exec(rest);
    if (fileUrl !== null && method === "POST") {
      const target = resolve(String(body.path));
      const home = join(sandbox.dir, "home");
      const tmp = join(sandbox.dir, "tmp");
      if (![home, tmp].some((dir) => target === dir || target.startsWith(`${dir}/`))) return failure(400, "invalid_path", "the path must be under /home/user or /tmp");
      const token = crypto.randomUUID();
      this.signed.set(token, { sandbox: sandbox.id, path: target, method: fileUrl[1] === "upload" ? "PUT" : "GET" });
      return json(200, { ok: true, type: `file.${fileUrl[1]}_url`, url: `https://fake-boat.local/signed/${token}`, method: fileUrl[1] === "upload" ? "PUT" : "GET", path: target, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    }
    return failure(404, "not_found", `no route ${method} ${rest}`);
  }

  private create(body: Record<string, unknown>): Response {
    if (body.noEnv !== true) return failure(400, "test_requires_noenv", "the fake requires noEnv on every create");
    const labels = (body.labels ?? {}) as Record<string, string>;
    const id = `sbx_${this.next++}`;
    const dir = join(this.root, labels["pikit-workspace"] ?? id);
    if (typeof body.from === "string") {
      const template = this.templates.get(body.from);
      if (template === undefined) return failure(404, "snapshot_not_found", "no saved snapshot by that name");
      rmSync(dir, { recursive: true, force: true });
      cpSync(template, join(dir, "home"), { recursive: true });
    }
    mkdirSync(join(dir, "home"), { recursive: true });
    mkdirSync(join(dir, "tmp"), { recursive: true });
    const sandbox: FakeSandbox = {
      id,
      state: "provisioning",
      labels,
      type: String(body.type ?? "default"),
      createdAt: this.clock.now(),
      readyAt: Date.now() + this.createMs,
      dir,
      processes: new Map(),
      ttlSeconds: (body.ttlSeconds as number | null | undefined) ?? 3600,
    };
    this.sandboxes.set(id, sandbox);
    return json(202, { ok: true, type: "sandbox.created", status: "provisioning", ttlSeconds: sandbox.ttlSeconds, sandbox: this.view(sandbox) });
  }

  private list(url: URL): Response {
    const filters = url.searchParams.getAll("label").map((pair) => pair.split("=", 2) as [string, string]);
    const all = [...this.sandboxes.values()].filter((s) => filters.every(([k, v]) => s.labels[k] === v));
    const from = Number(url.searchParams.get("cursor") ?? 0);
    const page = all.slice(from, from + this.pageSize);
    const hasMore = from + this.pageSize < all.length;
    return json(200, { ok: true, type: "sandbox.list", sandboxes: page.map((s) => this.view(s)), pageInfo: { nextCursor: hasMore ? String(from + this.pageSize) : null, hasMore, limit: this.pageSize } });
  }

  private spawn(sandbox: FakeSandbox, command: string): FakeProcess {
    const home = join(sandbox.dir, "home");
    const child = spawn("bash", ["-c", command], { cwd: home, env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const proc: FakeProcess = { pid: this.nextPid++, child, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), running: true, exitCode: null, command };
    child.stdout?.on("data", (chunk: Buffer) => (proc.stdout = Buffer.concat([proc.stdout, chunk])));
    child.stderr?.on("data", (chunk: Buffer) => (proc.stderr = Buffer.concat([proc.stderr, chunk])));
    sandbox.processes.set(proc.pid, proc);
    return proc;
  }

  private ended(proc: FakeProcess): Promise<void> {
    if (!proc.running) return Promise.resolve();
    return new Promise((resolve) => proc.child.once("close", () => resolve()));
  }

  private async command(sandbox: FakeSandbox, body: Record<string, unknown>): Promise<Response> {
    const proc = this.spawn(sandbox, String(body.command));
    const closed = new Promise<void>((resolve) =>
      proc.child.once("close", (code) => {
        proc.running = false;
        proc.exitCode = code;
        resolve();
      }),
    );
    if (body.detached === true) return json(200, { ok: true, type: "command.started", success: true, processId: proc.pid, pid: proc.pid, command: proc.command, startedAt: new Date().toISOString() });
    const seconds = Number(body.timeoutSeconds ?? 60);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.stopProcess(proc);
    }, seconds * 1000);
    await closed;
    clearTimeout(timer);
    sandbox.processes.delete(proc.pid);
    return json(200, { ok: true, type: "command.finished", success: proc.exitCode === 0, exitCode: proc.exitCode, stdout: proc.stdout.toString("utf8"), stderr: proc.stderr.toString("utf8"), timedOut });
  }

  private stopProcess(proc: FakeProcess): void {
    if (!proc.running) return;
    try {
      process.kill(-(proc.child.pid as number), "SIGKILL");
    } catch {}
  }

  private kill(sandbox: FakeSandbox): void {
    for (const proc of sandbox.processes.values()) this.stopProcess(proc);
  }

  /** Waits until every command of every sandbox has ended (a test's cleanup). */
  async settle(): Promise<void> {
    for (const sandbox of this.sandboxes.values()) for (const proc of sandbox.processes.values()) await this.ended(proc);
  }

  private async file(url: URL, method: string, headers: Headers, init?: RequestInit): Promise<Response> {
    const auth = headers.get("authorization");
    if (auth !== null) this.leaks.push(auth);
    const token = url.pathname.slice("/signed/".length);
    const grant = this.signed.get(token);
    if (grant === undefined || grant.method !== method) return new Response("no such URL", { status: 403 });
    const { mkdir, readFile, writeFile } = await import("node:fs/promises");
    if (method === "GET") {
      if (!existsSync(grant.path)) return new Response("not found", { status: 404 });
      const bytes = await readFile(grant.path);
      if (!this.cutDownloads) return new Response(bytes);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes.subarray(0, 100)));
          controller.error(new Error("the connection was reset"));
        },
      }));
    }
    await mkdir(resolve(grant.path, ".."), { recursive: true });
    const body = init?.body;
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body as ConstructorParameters<typeof Response>[0]).arrayBuffer());
    const contentLength = headers.get("content-length");
    this.uploads.push({ contentLength, bytes: bytes.length });
    if (contentLength !== null && Number(contentLength) !== bytes.length) return new Response("Content-Length is not the body's", { status: 400 });
    await writeFile(grant.path, bytes);
    return new Response(null, { status: 200 });
  }
}
