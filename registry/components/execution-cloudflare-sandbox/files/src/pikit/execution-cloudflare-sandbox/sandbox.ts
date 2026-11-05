/**
 * One sandbox: what a `Sandbox` Durable Object does with its container, with no `cloudflare:*` import
 * (`entrypoint.ts` hands it the platform's objects). One object per sandbox id and agent, so one
 * container each: the Worker names the object (`objectName`), and the object keeps the id and agent of
 * its first request (`identity`), refusing any other.
 *
 * - **Started on demand, restored once.** The first operation of an object whose container is not
 *   running starts it with the agent's image (`profile`), waits until the helper answers, and restores
 *   the chat and agent's snapshot (the shared format, `@pikit/contracts`' `workspace-snapshot.ts`): its
 *   archive streamed from the bucket into a file of the container, checked on the way (size, SHA-256,
 *   entries: `readSnapshotArchive`), and only then extracted into an empty directory, moved into the
 *   root. A container still running (the object was evicted, the container was not) is used as it is:
 *   its disk is the truth. A snapshot that does not hold is never half-restored: the sandbox is
 *   `unavailable`, the log says why.
 * - **Every operation of execution-serve's protocol**, mapped onto the helper (`container.ts`) as
 *   pi-durable's local environment does it (its `FileError` codes), commands through the helper's
 *   `exec` (a process group of its own), output kept in an `OutputLog` read from a cursor
 *   (`output.ts`, execution-serve's own), readers on a hard link of the file as it was opened.
 * - **Checkpointed when idle.** Each operation pushes the object's alarm to `idleMs` after it (at most
 *   every 30 s); the alarm, when nothing ran or was asked since and no command runs, lists what a
 *   snapshot keeps (the helper's `snapshot-list`), has the helper tar and gzip it into a file of the
 *   container (`snapshot-make`: its size and SHA-256, which the key carries), streams that file from
 *   the container's output into `putStream` (checked on the way, the SHA-256 checked by the provider:
 *   `putSnapshotArchive`), writes the manifest, and only then destroys the container. The archive never
 *   is whole in the object's memory: the limit is the store's `maxStreamBytes`. A failed or skipped
 *   checkpoint keeps the container: the local copy is the truth until the upload is verified.
 * - **Bounded.** Every container call has its own deadline (`within`): past an account's
 *   container limit a start may never happen. At most `MAX_COMMANDS` running commands and
 *   `MAX_HANDLES` open readers. A command nobody reads for `leaseMs` is stopped (checked at each
 *   request and alarm: no timer keeps an object in memory).
 * - **No secrets.** Nothing secret is ever given to the container (owner's decision: this host never
 *   gets workspace secrets; the README).
 */

import { type BlobStore, commitSnapshotManifest, deleteSupersededSnapshots, putSnapshotArchive, readSnapshotArchive, SnapshotArchiveRefused, snapshotId } from "@pikit/contracts";
import type { Logger } from "@pikit/core";
import { LineScanner, StreamDecoder, type ShellOutputWindow } from "@pikit/pi-adapter/execution";
import { collect, ContainerTimeout, HELPER, helper, type ContainerProcess, type HelperAnswer, SIGKILL, SIGTERM, type SandboxContainer, within } from "./container.ts";
import { OutputLog } from "./output.ts";
import { fromBase64, MAX_READ_BYTES, type Operation, type Outcome, type ProtocolErrorCode, type RequestOf, toBase64, type WireError, type WireExecState, type WireFileInfo } from "./protocol.ts";

export const MAX_COMMANDS = 16;
export const MAX_HANDLES = 64;
export const MAX_PENDING_BYTES = 64 * 1024 * 1024;
export const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
/** How often an operation may move the alarm at most. */
const ALARM_SLACK_MS = 30_000;
/** How long a stopped command's process group gets between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2_000;
/** After a failed checkpoint, the next try. */
const RETRY_MS = 60_000;

/** What prefixes an agentless sandbox's agent (execution-serve's `_<id>`): no agent name can be one. */
export const AGENTLESS_PREFIX = "_";

/** The chat a sandbox is, as execution-serve's ConversationRef has it (`key`). */
export const chatKey = (sandbox: string): string => `execution-serve:${sandbox}`;
/** The agent a sandbox is for: the header's, or `_<sandbox>` without one. */
export const agentOf = (sandbox: string, agent: string | undefined): string => agent ?? `${AGENTLESS_PREFIX}${sandbox}`;
/** The object of a sandbox id and agent: one container each. */
export const objectName = (sandbox: string, agent: string | undefined): string => `${sandbox}\n${agentOf(sandbox, agent)}`;

/** The machine an agent gets: an image of `wrangler.jsonc`'s `containers[].images`, an instance type, the internet or not. */
export interface Profile {
  image: string;
  instance?: string;
  internet: boolean;
}

/** One request, as the Worker forwards it, checked already (token, sandbox id, agent, body). */
export interface SandboxRequest {
  sandbox: string;
  agent?: string;
  operation: Operation;
  body: unknown;
}

/** The object's answer: the operation's outcome, or the protocol's failure, whose status the Worker sends. */
export type SandboxReply = { ok: true; answer: Outcome<Operation> } | { ok: false; code: ProtocolErrorCode; message: string };

/** What is used of a Durable Object's storage. */
export interface ObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
}

export interface SandboxOptions {
  container: SandboxContainer;
  storage: ObjectStorage;
  /** `storage.blob`'s `workspace-snapshots` namespace. */
  snapshots: BlobStore;
  /** The largest archive: `storage.blob`'s `maxStreamBytes`. */
  maxArchiveBytes: number;
  profile(agent: string | undefined): Profile;
  root: string;
  idleMs: number;
  leaseMs: number;
  /** Each helper call. */
  callMs: number;
  /** A container's start, until its helper answers. */
  startMs: number;
  /** Making or restoring a snapshot. */
  snapshotMs: number;
  /** The platform's own inactivity timeout, past `idleMs`: the backstop when a checkpoint never releases the container. */
  backstopMs: number;
  maxUnpackedBytes: number;
  now(): number;
  logger: Logger;
}

export class ProtocolError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type Answer<O extends Operation> = Outcome<O>;
type Identity = { sandbox: string; agent?: string };

class Command {
  readonly log: OutputLog;
  result: { ok: true; value: { exitCode: number; spillPath?: string } } | { ok: false; error: WireError } | undefined;
  stoppedBecause: string | undefined;
  timedOut = false;
  stopped = false;
  used: number;
  process: ContainerProcess | undefined;
  private wakers = new Set<() => void>();

  constructor(
    readonly id: string,
    window: ShellOutputWindow | undefined,
    now: number,
  ) {
    this.log = new OutputLog(window);
    this.used = now;
  }

  get running(): boolean {
    return this.result === undefined;
  }

  changed(): { promise: Promise<void>; cancel(): void } {
    let wake!: () => void;
    const promise = new Promise<void>((resolve) => (wake = resolve));
    this.wakers.add(wake);
    return { promise, cancel: () => this.wakers.delete(wake) };
  }

  notify(): void {
    for (const wake of this.wakers) wake();
    this.wakers.clear();
  }

  /** SIGTERM to the helper, which kills the command's group; SIGKILL to the helper after a grace. */
  stop(): void {
    if (this.stopped || !this.running) return;
    this.stopped = true;
    const process = this.process;
    process?.kill(SIGTERM);
    setTimeout(() => {
      if (this.running) process?.kill(SIGKILL);
    }, KILL_GRACE_MS);
  }
}

type ReaderHandle = { kind: "reader"; pinned: string; info: WireFileInfo; used: number };
type DirHandle = { kind: "dir"; entries: WireFileInfo[]; at: number; used: number };

const textOf = (content: { text: string } | { base64: string }): Uint8Array => {
  if ("text" in content) return new TextEncoder().encode(content.text);
  const bytes = fromBase64(content.base64);
  if (bytes === undefined) throw new ProtocolError("invalid_request", "content.base64 is not base64");
  return bytes;
};

export class Sandbox {
  private identity: Identity | undefined;
  private ready: Promise<{ home: string }> | undefined;
  private gate: Promise<void> | undefined;
  private lastUsed = 0;
  private alarmAt = 0;
  private readonly handles = new Map<string, ReaderHandle | DirHandle>();
  private readonly commands = new Map<string, Command>();

  constructor(private readonly options: SandboxOptions) {}

  /** Serves one operation. Never throws: the protocol's failures are `{ ok: false }`. */
  async serve(request: SandboxRequest): Promise<SandboxReply> {
    try {
      while (this.gate !== undefined) await this.gate.catch(() => {});
      await this.identify(request);
      this.sweep();
      await this.touch();
      const run = this.operations[request.operation] as (body: unknown) => Promise<Answer<Operation>>;
      return { ok: true, answer: await run(request.body) };
    } catch (error) {
      if (error instanceof ProtocolError) return { ok: false, code: error.code, message: error.message };
      this.options.logger.error("execution-cloudflare-sandbox: an operation failed", { sandbox: request.sandbox, operation: request.operation, error: error instanceof Error ? error.message : String(error) });
      return { ok: false, code: "unavailable", message: error instanceof ContainerTimeout ? error.message : "the sandbox failed (the host's log says why)" };
    }
  }

  /** The object's alarm: the idle checkpoint, or a later alarm while the sandbox is in use. */
  async alarm(): Promise<void> {
    const { now, idleMs, leaseMs, container, logger } = this.options;
    this.identity ??= await this.options.storage.get<Identity>("identity");
    if (this.identity === undefined) return;
    this.sweep();
    if ([...this.commands.values()].some((command) => command.running)) return await this.alarmIn(Math.min(idleMs, leaseMs));
    const idleFor = now() - this.lastUsed;
    if (this.lastUsed !== 0 && idleFor < idleMs) return await this.alarmIn(idleMs - idleFor);
    if (!container.running) return;
    const checkpoint = this.checkpoint(this.identity);
    this.gate = checkpoint;
    try {
      await checkpoint;
    } catch (error) {
      logger.error("execution-cloudflare-sandbox: the idle checkpoint failed; the container is kept, and it is tried again", {
        sandbox: this.identity.sandbox,
        agent: agentOf(this.identity.sandbox, this.identity.agent),
        error: error instanceof Error ? error.message : String(error),
      });
      await this.alarmIn(RETRY_MS);
    } finally {
      this.gate = undefined;
    }
  }

  private async alarmIn(ms: number): Promise<void> {
    this.alarmAt = this.options.now() + ms;
    await this.options.storage.setAlarm(this.alarmAt);
  }

  private async identify(request: SandboxRequest): Promise<void> {
    this.identity ??= await this.options.storage.get<Identity>("identity");
    const given: Identity = { sandbox: request.sandbox, ...(request.agent !== undefined && { agent: request.agent }) };
    if (this.identity === undefined) {
      await this.options.storage.put("identity", given);
      this.identity = given;
      return;
    }
    if (this.identity.sandbox !== given.sandbox || this.identity.agent !== given.agent) {
      throw new ProtocolError("invalid_request", "this object is another sandbox's or agent's (the Worker names one object per sandbox id and agent)");
    }
  }

  private async touch(): Promise<void> {
    const now = this.options.now();
    this.lastUsed = now;
    if (this.alarmAt < now + this.options.idleMs - ALARM_SLACK_MS) await this.alarmIn(this.options.idleMs);
  }

  /** Stops the commands nobody read for the lease, forgets ended ones, closes idle readers. */
  private sweep(): void {
    const expired = this.options.now() - this.options.leaseMs;
    for (const [id, command] of this.commands) {
      if (command.used > expired) continue;
      if (command.running) {
        command.stoppedBecause ??= "execution-cloudflare-sandbox: the command was stopped because nobody read it for the lease";
        command.stop();
      } else this.commands.delete(id);
    }
    for (const [id, handle] of this.handles) {
      if (handle.used > expired) continue;
      this.handles.delete(id);
      if (handle.kind === "reader") void this.call("unpin", { pinned: handle.pinned }).catch(() => {});
    }
  }

  /** The container, started and restored when it is new; its helper's home. */
  private started(): Promise<{ home: string }> {
    const { container } = this.options;
    if (this.ready !== undefined && !container.running) this.ready = undefined;
    this.ready ??= this.prepare().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private async prepare(): Promise<{ home: string }> {
    const { container, logger, startMs, callMs, backstopMs } = this.options;
    const identity = this.identity as Identity;
    const agent = agentOf(identity.sandbox, identity.agent);
    const fresh = !container.running;
    if (fresh) {
      const profile = this.options.profile(identity.agent);
      const image = container.images[profile.image];
      if (image === undefined) {
        logger.error("execution-cloudflare-sandbox: the agent's image is not one of the container's (wrangler.jsonc's containers[].images)", { agent, image: profile.image, images: Object.keys(container.images) });
        throw new ProtocolError("unavailable", "the sandbox's image is not configured (the host's log says which)");
      }
      container.start({ image, enableInternet: profile.internet, ...(profile.instance !== undefined && { instance: profile.instance }), labels: { "pikit-sandbox": identity.sandbox.slice(0, 63), "pikit-agent": agent.slice(0, 63) } });
    }
    // The first answer of the helper: the container runs (or never will, within startMs).
    const deadline = this.options.now() + startMs;
    let opened: HelperAnswer<{ home: string }>;
    for (;;) {
      opened = await helper<{ home: string }>(container, "open", {}, Math.max(1, Math.min(callMs, deadline - this.options.now())));
      if (opened.ok || this.options.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!opened.ok) {
      logger.error("execution-cloudflare-sandbox: the container did not start", { sandbox: identity.sandbox, agent, error: opened.error.message });
      await within(container.destroy(), callMs, "destroy").catch(() => {});
      throw new ProtocolError("unavailable", `the sandbox's container did not start within ${startMs} ms (the account's container limit may be reached; the host's log says more)`);
    }
    await within(container.setInactivityTimeout(backstopMs), callMs, "setInactivityTimeout").catch((error: unknown) => logger.warn("execution-cloudflare-sandbox: the container's inactivity timeout was not set", { error: String(error) }));
    if (fresh) {
      try {
        await this.restore(identity);
      } catch (error) {
        await within(container.destroy(), callMs, "destroy").catch(() => {});
        if (error instanceof SnapshotArchiveRefused) {
          logger.error("execution-cloudflare-sandbox: the workspace's snapshot cannot be restored; the sandbox stays unavailable until it is fixed or removed", { sandbox: identity.sandbox, agent, error: error.message });
          throw new ProtocolError("unavailable", "the sandbox's snapshot cannot be restored (the host's log says why)");
        }
        throw error;
      }
    }
    return opened.value;
  }

  /** The workspace's snapshot id: the format's, of execution-serve's chat key and agent for this sandbox. */
  private async snapshotOf(identity: Identity): Promise<{ id: string; agent: string }> {
    const agent = agentOf(identity.sandbox, identity.agent);
    return { id: await snapshotId(chatKey(identity.sandbox), agent), agent };
  }

  /**
   * The chat and agent's snapshot, if any: its archive streamed into a file beside the root, checked on
   * the way; once all of it held, extracted into an empty directory whose entries are then moved into
   * the root. `SnapshotArchiveRefused` when it does not hold (nothing extracted).
   */
  private async restore(identity: Identity): Promise<void> {
    const { root, snapshots, logger, maxUnpackedBytes, snapshotMs } = this.options;
    const target = await this.snapshotOf(identity);
    const snapshot = await readSnapshotArchive(snapshots, target, { maxUnpackedBytes });
    if (snapshot === undefined) {
      await this.must(this.call("mkdir", { path: root, recursive: true }), "mkdir");
      return;
    }
    const staging = `${root}.restore`;
    const archive = `${root}.restore.tar.gz`;
    await this.must(this.call("remove", { path: staging, recursive: true, force: true }), "remove");
    await this.must(this.call("mkdir", { path: staging, recursive: true }), "mkdir");
    try {
      await this.receive(archive, snapshot.chunks);
      snapshot.result();
      const extracted = await this.run(["tar", "-xzf", archive, "-C", staging, "--no-same-owner"], snapshotMs);
      if (extracted.exitCode !== 0) throw new Error(`tar -x exited ${extracted.exitCode}: ${new TextDecoder().decode(extracted.stderr).slice(0, 500)}`);
      await this.must(this.call("swap", { from: staging, to: root }), "swap");
    } finally {
      await this.call("remove", { path: archive, force: true });
    }
    logger.info("execution-cloudflare-sandbox: workspace restored", { sandbox: identity.sandbox, agent: target.agent, object: snapshot.manifest.object, size: snapshot.manifest.size });
  }

  /**
   * `chunks` written to `path` in the container as they come (the helper's `snapshot-receive`). A chunk
   * that throws (the check refused the archive) ends the file there and is thrown once the helper
   * answered: what was written is then never extracted.
   */
  private async receive(path: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    const iterator = chunks[Symbol.asyncIterator]();
    let failure: unknown;
    const stdin = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done === true) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          failure = error;
          controller.close();
        }
      },
      async cancel() {
        await iterator.return?.();
      },
    });
    const answer = await this.call("snapshot-receive", { path }, this.options.snapshotMs, stdin);
    if (failure !== undefined) throw failure;
    if (!answer.ok) throw new Error(`pikit-sandbox snapshot-receive: ${answer.error.code}: ${answer.error.message}`);
  }

  /** The idle checkpoint: the archive made in the container, streamed to the bucket, the manifest written, then the container released. */
  private async checkpoint(identity: Identity): Promise<void> {
    const { root, container, snapshots, maxArchiveBytes, logger, snapshotMs, callMs } = this.options;
    const target = await this.snapshotOf(identity);
    const listed = await this.must(this.call<{ entries: string[]; skipped: { path: string; reason: string }[] }>("snapshot-list", { root }, snapshotMs), "snapshot-list");
    if (listed.skipped.length > 0) logger.warn("execution-cloudflare-sandbox: left out of the snapshot", { sandbox: identity.sandbox, agent: target.agent, skipped: listed.skipped.slice(0, 20), count: listed.skipped.length });
    const list = new TextEncoder().encode([".", ...listed.entries].join("\0"));
    const out = `${root}.snapshot.tar.gz`;
    let manifest;
    try {
      await this.call("remove", { path: out, force: true });
      const made = await this.must(this.call<{ size: number; sha256: string } | { tooLarge: true }>("snapshot-make", { root, out, maxBytes: maxArchiveBytes }, snapshotMs, list), "snapshot-make");
      if ("tooLarge" in made) {
        logger.error("execution-cloudflare-sandbox: the workspace's archive is larger than storage.blob's maxStreamBytes and is not saved; the container is kept until the platform's inactivity timeout, and its files are lost then", { sandbox: identity.sandbox, agent: target.agent, maxStreamBytes: maxArchiveBytes });
        return;
      }
      manifest = await this.upload(out, target, made.sha256);
    } finally {
      await this.call("remove", { path: out, force: true });
    }
    await commitSnapshotManifest(snapshots, target.id, manifest);
    await deleteSupersededSnapshots(snapshots, target.id, manifest.object).catch((error: unknown) =>
      logger.warn("execution-cloudflare-sandbox: superseded snapshots were not deleted; the next checkpoint tries again", { error: error instanceof Error ? error.message : String(error) }),
    );
    logger.info("execution-cloudflare-sandbox: workspace saved; the container is released", { sandbox: identity.sandbox, agent: target.agent, object: manifest.object, size: manifest.size });
    await within(container.destroy(), callMs, "destroy");
    this.ready = undefined;
    this.handles.clear();
  }

  /** The archive at `out` in the container, streamed from `cat`'s output into the bucket (`putSnapshotArchive`), within `snapshotMs`. */
  private async upload(out: string, target: { id: string; agent: string }, sha256: string) {
    const { container, snapshots, maxArchiveBytes, maxUnpackedBytes, snapshotMs } = this.options;
    let process: ContainerProcess | undefined;
    const go = async () => {
      process = await container.exec(["cat", out], { stdout: "pipe", stderr: "pipe" });
      const stderr = collect(process.stderr, 64 * 1024);
      const manifest = await putSnapshotArchive(snapshots, { ...target, createdAt: this.options.now(), sha256, body: process.stdout ?? new ReadableStream(), maxBytes: maxArchiveBytes, maxUnpackedBytes });
      const exitCode = await process.exitCode;
      if (exitCode !== 0) {
        await snapshots.delete(manifest.object).catch(() => {});
        throw new Error(`cat of the archive exited ${exitCode}: ${new TextDecoder().decode((await stderr) ?? new Uint8Array()).slice(0, 500)}`);
      }
      return manifest;
    };
    return await within(go(), snapshotMs, "the snapshot's upload", () => process?.kill(SIGKILL));
  }

  /** A program run in the container, its stderr kept (1 MiB), its stdout passed over. */
  private async run(cmd: string[], ms: number): Promise<{ exitCode: number; stderr: Uint8Array }> {
    let process: ContainerProcess | undefined;
    const go = async () => {
      process = await this.options.container.exec(cmd, { stdout: "pipe", stderr: "pipe" });
      const [, stderr] = await Promise.all([collect(process.stdout, 1024 * 1024), collect(process.stderr, 1024 * 1024)]);
      return { exitCode: await process.exitCode, stderr: stderr ?? new Uint8Array() };
    };
    return await within(go(), ms, cmd[0] ?? "a program", () => process?.kill(SIGKILL));
  }

  private call<T>(operation: string, args: Record<string, unknown>, ms = this.options.callMs, stdin?: Uint8Array | ReadableStream<Uint8Array>): Promise<HelperAnswer<T>> {
    return helper<T>(this.options.container, operation, args, ms, stdin);
  }

  private async must<T>(answer: Promise<HelperAnswer<T>>, what: string): Promise<T> {
    const settled = await answer;
    if (!settled.ok) throw new Error(`pikit-sandbox ${what}: ${settled.error.code}: ${settled.error.message}`);
    return settled.value;
  }

  /** A helper operation on the started container, as an answer. */
  private async file<T, V = T>(operation: string, args: Record<string, unknown>, map: (value: T) => V = (value) => value as unknown as V, stdin?: Uint8Array): Promise<{ ok: true; value: V } | { ok: false; error: WireError }> {
    await this.started();
    const answer = await this.call<T>(operation, args, this.options.callMs, stdin);
    return answer.ok ? { ok: true, value: map(answer.value) } : answer;
  }

  private async bytes(path: string, offset?: number, length?: number): Promise<HelperAnswer<Uint8Array>> {
    await this.started();
    const answer = await this.call<string>("read", { path, ...(offset !== undefined && { offset, length }) });
    if (!answer.ok) return answer;
    const bytes = fromBase64(answer.value);
    return bytes === undefined ? { ok: false, error: { code: "unknown", message: "pikit-sandbox read answered no base64" } } : { ok: true, value: bytes };
  }

  private handle<K extends "reader" | "dir">(id: string, kind: K): Extract<ReaderHandle | DirHandle, { kind: K }> {
    const handle = this.handles.get(id);
    if (handle === undefined || handle.kind !== kind) throw new ProtocolError("unknown_handle", "no such reader in this sandbox (closed, expired, or the sandbox was released)");
    handle.used = this.options.now();
    return handle as Extract<ReaderHandle | DirHandle, { kind: K }>;
  }

  private keep(handle: ReaderHandle | DirHandle): string {
    if (this.handles.size >= MAX_HANDLES) {
      if (handle.kind === "reader") void this.call("unpin", { pinned: handle.pinned }).catch(() => {});
      throw new ProtocolError("too_many", `this sandbox has ${MAX_HANDLES} readers open already`);
    }
    const id = crypto.randomUUID();
    this.handles.set(id, handle);
    return id;
  }

  private command(id: string): Command {
    const command = this.commands.get(id);
    if (command === undefined) throw new ProtocolError("unknown_command", "no such command in this sandbox (it ended long ago, its lease expired, or the object restarted)");
    command.used = this.options.now();
    return command;
  }

  private async state(command: Command, cursor: number, wait: number, linger: number): Promise<WireExecState> {
    if (!command.log.valid(cursor)) throw new ProtocolError("invalid_request", "cursor is before what was acknowledged or past what exists");
    const started = this.options.now();
    for (;;) {
      const now = this.options.now();
      const hasOutput = command.log.hasAfter(cursor);
      if (!command.running || now - started >= wait || (hasOutput && now - started >= linger)) break;
      const until = started + (hasOutput ? linger : wait);
      const change = command.changed();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([change.promise, new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.max(0, until - now))))]);
      change.cancel();
      clearTimeout(timer);
    }
    command.used = this.options.now();
    const read = command.log.read(cursor, MAX_ANSWER_BYTES);
    const state: WireExecState = { command: command.id, chunks: read.chunks, next: read.next };
    if (read.complete && command.result !== undefined) state.done = command.result;
    return state;
  }

  private async start(request: RequestOf<"execStart">): Promise<Command> {
    if (this.commands.has(request.command)) throw new ProtocolError("invalid_request", "execStart: this command id is in use");
    if ([...this.commands.values()].filter((command) => command.running).length >= MAX_COMMANDS) throw new ProtocolError("too_many", `this sandbox runs ${MAX_COMMANDS} commands already`);
    await this.started();
    const command = new Command(request.command, request.window, this.options.now());
    this.commands.set(command.id, command);
    let spillPath: string | undefined;
    if (request.spill !== undefined) {
      const made = await this.call<string>("mktemp", { file: true, prefix: "spill-", suffix: ".log" });
      if (made.ok) spillPath = made.value;
    }
    const spec = { run: request.run, cwd: request.cwd, ...(request.env !== undefined && { env: request.env }), ...(request.inheritEnv !== undefined && { inheritEnv: request.inheritEnv }), ...(spillPath !== undefined && { spill: spillPath }) };
    let process: ContainerProcess;
    try {
      process = await within(this.options.container.exec([HELPER, "exec", JSON.stringify(spec)], { stdout: "pipe", stderr: "pipe" }), this.options.callMs, "exec");
    } catch (error) {
      command.result = { ok: false, error: { code: "spawn_error", message: error instanceof Error ? error.message : String(error) } };
      command.notify();
      return command;
    }
    command.process = process;
    let bytes = 0;
    let lines = 0;
    let endsWithNewline = true;
    const pump = async (stream: ReadableStream<Uint8Array> | null, name: "stdout" | "stderr") => {
      if (stream === null) return;
      const decoder = new StreamDecoder();
      const reader = stream.getReader();
      const append = (text: string) => {
        if (text === "") return;
        bytes += new TextEncoder().encode(text).length;
        for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) lines++;
        endsWithNewline = text.endsWith("\n");
        command.log.append(text, name);
        if (request.window === undefined && command.log.pendingBytes > MAX_PENDING_BYTES && command.running) {
          command.stoppedBecause ??= `execution-cloudflare-sandbox: the command was stopped because more than ${MAX_PENDING_BYTES} bytes of its output were not read`;
          command.stop();
        }
        command.notify();
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        append(decoder.decode(value));
      }
      append(decoder.decode());
    };
    const timeout = request.timeout === undefined ? undefined : setTimeout(() => {
      command.timedOut = true;
      command.stop();
    }, request.timeout * 1000);
    void (async () => {
      let exitCode: number;
      try {
        [, , exitCode] = await Promise.all([pump(process.stdout, "stdout"), pump(process.stderr, "stderr"), process.exitCode]);
      } catch (error) {
        exitCode = -1;
        command.stoppedBecause ??= `execution-cloudflare-sandbox: the command's output was lost: ${error instanceof Error ? error.message : String(error)}`;
      }
      clearTimeout(timeout);
      const spill = request.spill;
      const linesSeen = lines + (endsWithNewline ? 0 : 1);
      const spilled = spill !== undefined && spillPath !== undefined && (bytes > spill.afterBytes || linesSeen > spill.afterLines) ? spillPath : undefined;
      if (spillPath !== undefined && spilled === undefined) void this.call("remove", { path: spillPath, force: true }).catch(() => {});
      const withSpill = (error: WireError): WireError => (spilled === undefined ? error : { ...error, spillPath: spilled });
      if (command.timedOut) command.result = { ok: false, error: withSpill({ code: "timeout", message: `Command timed out after ${request.timeout} seconds` }) };
      else if (command.stoppedBecause !== undefined) command.result = { ok: false, error: withSpill({ code: "unknown", message: command.stoppedBecause }) };
      else if (command.stopped) command.result = { ok: false, error: withSpill({ code: "aborted", message: "aborted" }) };
      else command.result = { ok: true, value: { exitCode, ...(spilled !== undefined && { spillPath: spilled }) } };
      command.notify();
    })();
    return command;
  }

  private readonly operations: { [O in Operation]: (body: RequestOf<O>) => Promise<Answer<O>> } = {
    open: async () => {
      const { home } = await this.started();
      return { ok: true, value: { cwd: this.options.root, home } };
    },
    fileInfo: ({ path }) => this.file<WireFileInfo>("info", { path }),
    exists: ({ path }) => this.file<boolean>("exists", { path }),
    canonicalPath: ({ path }) => this.file<string>("realpath", { path }),
    readTextFile: async ({ path }) => {
      const read = await this.bytes(path);
      return read.ok ? { ok: true, value: new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(read.value) } : read;
    },
    readTextLines: async ({ path, maxLines }) => {
      if (maxLines !== undefined && maxLines <= 0) return { ok: true, value: [] };
      const read = await this.bytes(path);
      if (!read.ok) return read;
      const decoder = new StreamDecoder();
      const text = decoder.decode(read.value) + decoder.decode();
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      return { ok: true, value: maxLines === undefined ? lines : lines.slice(0, maxLines) };
    },
    readBinaryFile: async ({ path }) => {
      const read = await this.bytes(path);
      return read.ok ? { ok: true, value: { base64: toBase64(read.value) } } : read;
    },
    writeFile: ({ path, content }) => this.file<null>("write", { path }, undefined, textOf(content)),
    appendFile: ({ path, content }) => this.file<null>("write", { path, append: true }, undefined, textOf(content)),
    truncateFile: ({ path, size }) => this.file<null>("truncate", { path, size }),
    flushFile: ({ path }) => this.file<null>("flush", { path }),
    renameFile: ({ from, to }) => this.file<null>("rename", { from, to }),
    listDir: ({ path }) => this.file<WireFileInfo[]>("list", { path }),
    createDir: ({ path, recursive }) => this.file<null>("mkdir", { path, ...(recursive !== undefined && { recursive }) }),
    remove: ({ path, recursive, force }) => this.file<null>("remove", { path, ...(recursive !== undefined && { recursive }), ...(force !== undefined && { force }) }),
    createTempDir: ({ prefix }) => this.file<string>("mktemp", { ...(prefix !== undefined && { prefix }) }),
    createTempFile: ({ prefix, suffix }) => this.file<string>("mktemp", { file: true, ...(prefix !== undefined && { prefix }), ...(suffix !== undefined && { suffix }) }),

    openBinaryReader: async ({ path, noFollow, prefetch }) => {
      const pinned = await this.file<{ info: WireFileInfo; pinned: string }>("pin", { path, ...(noFollow !== undefined && { noFollow }) });
      if (!pinned.ok) return pinned;
      const { info } = pinned.value;
      if (info.size <= prefetch) {
        const read = await this.bytes(pinned.value.pinned);
        await this.call("unpin", { pinned: pinned.value.pinned });
        if (!read.ok) return read;
        return { ok: true, value: { info: { ...info, size: read.value.length }, base64: toBase64(read.value) } };
      }
      return { ok: true, value: { info, handle: this.keep({ kind: "reader", pinned: pinned.value.pinned, info, used: this.options.now() }) } };
    },
    readerInfo: async ({ handle }) => {
      const reader = this.handle(handle, "reader");
      return await this.file<WireFileInfo>("info", { path: reader.pinned }, (info) => ({ ...info, name: reader.info.name, path: reader.info.path }));
    },
    readerRead: async ({ handle, offset, length }) => {
      const reader = this.handle(handle, "reader");
      const read = await this.bytes(reader.pinned, offset, length);
      return read.ok ? { ok: true, value: { base64: toBase64(read.value) } } : read;
    },
    readerScan: async ({ handle, startLine, endLine }) => {
      const reader = this.handle(handle, "reader");
      let scanner: LineScanner;
      try {
        scanner = new LineScanner(startLine, endLine);
      } catch {
        return { ok: false, error: { code: "invalid", message: "Invalid line range", path: reader.info.path } };
      }
      for (let offset = 0; ; ) {
        const read = await this.bytes(reader.pinned, offset, MAX_READ_BYTES);
        if (!read.ok) return read;
        if (read.value.length === 0) return { ok: true, value: { ...scanner.finish() } };
        scanner.push(read.value);
        offset += read.value.length;
      }
    },
    readerClose: async ({ handle }) => {
      const reader = this.handle(handle, "reader");
      this.handles.delete(handle);
      await this.call("unpin", { pinned: reader.pinned });
      return { ok: true, value: null };
    },
    openDirReader: async ({ path }) => {
      const listed = await this.file<WireFileInfo[]>("list", { path });
      if (!listed.ok) return listed;
      return { ok: true, value: { handle: this.keep({ kind: "dir", entries: listed.value, at: 0, used: this.options.now() }) } };
    },
    dirNext: async ({ handle, maxEntries }) => {
      const reader = this.handle(handle, "dir");
      const entries = reader.entries.slice(reader.at, reader.at + maxEntries);
      reader.at += entries.length;
      return { ok: true, value: { entries, done: reader.at >= reader.entries.length } };
    },
    dirClose: async ({ handle }) => {
      this.handle(handle, "dir");
      this.handles.delete(handle);
      return { ok: true, value: null };
    },

    execStart: async (request) => {
      const command = await this.start(request);
      return { ok: true, value: await this.state(command, 0, request.wait, request.linger) };
    },
    execRead: async ({ command, cursor, wait, linger }) => ({ ok: true, value: await this.state(this.command(command), cursor, wait, linger) }),
    execKill: async ({ command: id, cursor, wait }) => {
      const command = this.command(id);
      command.stop();
      return { ok: true, value: await this.state(command, command.log.valid(cursor) ? cursor : command.log.acknowledged, wait, wait) };
    },
  };
}

