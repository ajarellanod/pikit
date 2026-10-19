/**
 * What execution-serve keeps between requests, and how it serves each operation (protocol.ts) on the
 * sandbox's environment: the readers it opened and the commands it runs, each owned by one sandbox.
 *
 * - **Scoped.** A handle (a reader, a command) is found only under the sandbox that opened it: asked
 *   from another, it is `unknown_handle` / `unknown_command`, as one that never existed.
 * - **Leased.** A command nobody reads for `leaseMs` is stopped (a client evicted mid-command never
 *   comes back for it) and, once ended, forgotten; a reader unused as long is closed. `sweep` does it,
 *   on the component's timer.
 * - **Bounded.** At most `MAX_COMMANDS` running commands and `MAX_HANDLES` open readers per sandbox
 *   (`too_many`). Without a window, a command whose unread output passes `MAX_PENDING_BYTES` is
 *   stopped and ends with an `unknown` error saying so.
 * - **Never throws to the route** for the environment's failures: they are `{ ok: false, error }`.
 *
 * The environment is the sandbox provider's (`workspace.resolve`), asked at each request that needs
 * it: the provider keeps or makes its sandboxes. Paths are not confined here: a sandbox's walls are
 * its provider's (a VM), and a shell would step over any check this layer made.
 */

import type { AppContext } from "@pikit/core";
import type { ConversationRef } from "@pikit/contracts";
import { toChord } from "@pikit/pi-adapter";
import {
  BACKGROUND_CONTEXT,
  type BinaryReader,
  type Context,
  type DirReader,
  type ExecutionEnv,
  ExecutionError,
  type FileError,
  type FileInfo,
  type Result,
  type ShellExecResult,
  withAbortSignal,
} from "@pikit/pi-adapter/execution";
import { OutputLog } from "./output.ts";
import { fromBase64, type Operation, type ProtocolErrorCode, type RequestOf, toBase64, type Values, type WireError, type WireExecState, type WireFileInfo } from "./protocol.ts";

/** Running commands per sandbox. */
export const MAX_COMMANDS = 16;
/** Open readers per sandbox. */
export const MAX_HANDLES = 64;
/** Unread output a command without a window may hold before it is stopped. */
export const MAX_PENDING_BYTES = 64 * 1024 * 1024;
/** Text one answer carries at most (a backlog is read in several). */
export const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

/** What prefixes a remote sandbox's `conversationId`: never one of the host App's own (its runtime numbers them `1`, `2`…). */
export const CONVERSATION_PREFIX = "remote-";
/** The `conversationId` a sandbox provider takes (execution-gondolin's rule: a safe directory name). */
export const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The `ConversationRef` a sandbox is resolved as, every field derived from its id, so a provider
 * keyed by any of them keeps sandboxes apart:
 * - `conversationId` `remote-<id>`: what execution-gondolin keys its sandboxes by, alone; namespaced
 *   so it never meets a conversation of the host App's own runtime, and held to `CONVERSATION_ID`;
 * - `agent` the id itself (workspace-local keys its directories by it; gondolin names the VM by it);
 * - `key` `execution-serve:<id>`.
 * A sandbox id that cannot make one is refused (`invalid_request`): never cleaned up into another.
 */
export function sandboxConversation(sandbox: string): ConversationRef {
  const conversationId = `${CONVERSATION_PREFIX}${sandbox}`;
  if (!CONVERSATION_ID.test(conversationId)) {
    throw new ProtocolError("invalid_request", `the sandbox id makes no conversation id (${CONVERSATION_ID.source}): ${JSON.stringify(sandbox.slice(0, 40))}`);
  }
  return { key: `execution-serve:${sandbox}`, agent: sandbox, conversationId };
}

/** A failure of the protocol itself, which the route answers with its status. */
export class ProtocolError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type Answer<O extends Operation> = { ok: true; value: Values[O] } | { ok: false; error: WireError };

export interface SandboxHostOptions {
  /** The sandbox's environment: `workspace.resolve` of its `ConversationRef`. Throws when it cannot be had. */
  resolve(sandbox: string, ctx: AppContext): Promise<ExecutionEnv>;
  leaseMs: number;
  now(): number;
}

type ReaderHandle = { kind: "reader"; sandbox: string; reader: BinaryReader; used: number };
type DirHandle = { kind: "dir"; sandbox: string; reader: DirReader; used: number };

class Command {
  readonly log: OutputLog;
  readonly stop = new AbortController();
  result: Result<ShellExecResult, ExecutionError> | undefined;
  /** Why the host stopped it, when it did: its result says so instead of the environment's. */
  stoppedBecause: string | undefined;
  used: number;
  private wakers = new Set<() => void>();

  constructor(
    readonly id: string,
    readonly sandbox: string,
    window: RequestOf<"execStart">["window"],
    now: number,
  ) {
    this.log = new OutputLog(window);
    this.used = now;
  }

  get running(): boolean {
    return this.result === undefined;
  }

  /** Resolves at the next output or at the end. */
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
}

const fileFailure = (error: FileError): WireError => ({ code: error.code, message: error.message, ...(error.path !== undefined && { path: error.path }) });
const execFailure = (error: ExecutionError): WireError => ({ code: error.code, message: error.message, ...(error.spillPath !== undefined && { spillPath: error.spillPath }) });
const wireInfo = (info: FileInfo): WireFileInfo => ({ name: info.name, path: info.path, kind: info.kind, size: info.size, mtimeMs: info.mtimeMs });
const contentOf = (content: { text: string } | { base64: string }): string | Uint8Array => {
  if ("text" in content) return content.text;
  const bytes = fromBase64(content.base64);
  if (bytes === undefined) throw new ProtocolError("invalid_request", "content.base64 is not base64");
  return bytes;
};

/** `result` as an answer, its value through `map`. */
function answer<T, V>(result: Result<T, FileError>, map: (value: T) => V): { ok: true; value: V } | { ok: false; error: WireError } {
  return result.ok ? { ok: true, value: map(result.value) } : { ok: false, error: fileFailure(result.error) };
}

const done = (result: Result<void, FileError>) => answer(result, () => null);

export class SandboxHost {
  private readonly handles = new Map<string, ReaderHandle | DirHandle>();
  private readonly commands = new Map<string, Command>();
  private closed = false;

  constructor(private readonly options: SandboxHostOptions) {}

  /** Serves one operation of `sandbox`. Throws `ProtocolError` for the protocol's failures. */
  async serve<O extends Operation>(sandbox: string, operation: O, request: RequestOf<O>, ctx: AppContext): Promise<Answer<O>> {
    if (this.closed) throw new ProtocolError("unavailable", "execution-serve is stopping");
    const run = this.operations[operation] as (sandbox: string, request: RequestOf<O>, ctx: AppContext) => Promise<Answer<O>>;
    return run(sandbox, request, ctx);
  }

  /** Stops the commands nobody read for the lease, forgets the ended ones, closes idle readers. */
  async sweep(): Promise<void> {
    const expired = this.options.now() - this.options.leaseMs;
    for (const [id, command] of this.commands) {
      if (command.used > expired) continue;
      if (command.running) {
        command.stoppedBecause ??= "execution-serve: the command was stopped because nobody read it for the lease";
        command.stop.abort();
      } else this.commands.delete(id);
    }
    for (const [id, handle] of this.handles) {
      if (handle.used > expired) continue;
      this.handles.delete(id);
      await handle.reader.close(BACKGROUND_CONTEXT).catch(() => {});
    }
  }

  /** Stops every command and closes every reader: the host is stopping. */
  async close(): Promise<void> {
    this.closed = true;
    for (const command of this.commands.values()) {
      command.stoppedBecause ??= "execution-serve: the host stopped";
      command.stop.abort();
    }
    this.commands.clear();
    const handles = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(handles.map((handle) => handle.reader.close(BACKGROUND_CONTEXT).catch(() => {})));
  }

  private env(sandbox: string, ctx: AppContext): Promise<ExecutionEnv> {
    return this.options.resolve(sandbox, ctx);
  }

  private count(sandbox: string, which: "commands" | "handles"): number {
    let count = 0;
    if (which === "commands") {
      for (const command of this.commands.values()) if (command.sandbox === sandbox && command.running) count++;
    } else for (const handle of this.handles.values()) if (handle.sandbox === sandbox) count++;
    return count;
  }

  private handle<K extends "reader" | "dir">(sandbox: string, id: string, kind: K): Extract<ReaderHandle | DirHandle, { kind: K }> {
    const handle = this.handles.get(id);
    if (handle === undefined || handle.sandbox !== sandbox || handle.kind !== kind) throw new ProtocolError("unknown_handle", "no such reader in this sandbox (closed, expired, or the host restarted)");
    handle.used = this.options.now();
    return handle as Extract<ReaderHandle | DirHandle, { kind: K }>;
  }

  private keep(handle: ReaderHandle | DirHandle): string {
    if (this.count(handle.sandbox, "handles") >= MAX_HANDLES) {
      void handle.reader.close(BACKGROUND_CONTEXT).catch(() => {});
      throw new ProtocolError("too_many", `this sandbox has ${MAX_HANDLES} readers open already`);
    }
    const id = crypto.randomUUID();
    this.handles.set(id, handle);
    return id;
  }

  private command(sandbox: string, id: string): Command {
    const command = this.commands.get(id);
    if (command === undefined || command.sandbox !== sandbox) throw new ProtocolError("unknown_command", "no such command in this sandbox (it ended long ago, its lease expired, or the host restarted)");
    command.used = this.options.now();
    return command;
  }

  /** The command's state after `cursor`, once it has ended, or has output and `linger` passed, or `wait` passed. */
  private async state(command: Command, cursor: number, wait: number, linger: number, ctx: AppContext): Promise<WireExecState> {
    if (!command.log.valid(cursor)) throw new ProtocolError("invalid_request", "cursor is before what was acknowledged or past what exists");
    const started = this.options.now();
    const signal = ctx.abortSignal;
    for (;;) {
      const now = this.options.now();
      const hasOutput = command.log.hasAfter(cursor);
      if (!command.running || now - started >= wait || signal?.aborted === true || (hasOutput && now - started >= linger)) break;
      const until = started + (hasOutput ? linger : wait);
      const change = command.changed();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      await Promise.race([
        change.promise,
        new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.max(0, until - now)))),
        new Promise<void>((resolve) => {
          onAbort = () => resolve();
          signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      change.cancel();
      clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    }
    command.used = this.options.now();
    const read = command.log.read(cursor, MAX_ANSWER_BYTES);
    const state: WireExecState = { command: command.id, chunks: read.chunks, next: read.next };
    const result = command.result;
    if (read.complete && result !== undefined) {
      state.done = result.ok ? { ok: true, value: { exitCode: result.value.exitCode, ...(result.value.spillPath !== undefined && { spillPath: result.value.spillPath }) } } : { ok: false, error: execFailure(result.error) };
    }
    return state;
  }

  private start(sandbox: string, env: ExecutionEnv, request: RequestOf<"execStart">): Command {
    if (this.commands.has(request.command)) throw new ProtocolError("invalid_request", "execStart: this command id is in use");
    if (this.count(sandbox, "commands") >= MAX_COMMANDS) throw new ProtocolError("too_many", `this sandbox runs ${MAX_COMMANDS} commands already`);
    const command = new Command(request.command, sandbox, request.window, this.options.now());
    this.commands.set(command.id, command);
    // The command's own context: it outlives the request that started it, until it ends or is stopped.
    const context: Context = withAbortSignal(command.stop.signal, BACKGROUND_CONTEXT);
    const exec = async (): Promise<Result<ShellExecResult, ExecutionError>> => {
      try {
        return await env.exec(
          request.run,
          {
            cwd: request.cwd,
            ...(request.env !== undefined && { env: request.env }),
            ...(request.inheritEnv !== undefined && { inheritEnv: request.inheritEnv }),
            ...(request.timeout !== undefined && { timeout: request.timeout }),
            ...(request.spill !== undefined && { spill: request.spill }),
            onOutput: (text, _context, info) => {
              command.log.append(text, info.stream);
              if (request.window === undefined && command.log.pendingBytes > MAX_PENDING_BYTES && command.running) {
                command.stoppedBecause ??= `execution-serve: the command was stopped because more than ${MAX_PENDING_BYTES} bytes of its output were not read`;
                command.stop.abort();
              }
              command.notify();
            },
          },
          context,
        );
      } catch (error) {
        return { ok: false, error: new ExecutionError("unknown", error instanceof Error ? error.message : String(error)) };
      }
    };
    void exec().then((result) => {
      const because = command.stoppedBecause;
      if (because !== undefined && !result.ok && result.error.code === "aborted") {
        const stopped = new ExecutionError("unknown", because);
        if (result.error.spillPath !== undefined) stopped.spillPath = result.error.spillPath;
        command.result = { ok: false, error: stopped };
      } else command.result = result;
      command.notify();
    });
    return command;
  }

  /** Each operation, on the sandbox's environment or on what the sandbox opened. */
  private readonly operations: { [O in Operation]: (sandbox: string, request: RequestOf<O>, ctx: AppContext) => Promise<Answer<O>> } = {
    open: async (sandbox, _request, ctx) => {
      const env = await this.env(sandbox, ctx);
      const home = await env.absolutePath("~", toChord(ctx));
      return home.ok ? { ok: true, value: { cwd: env.cwd, home: home.value } } : { ok: false, error: fileFailure(home.error) };
    },
    fileInfo: async (sandbox, { path }, ctx) => answer(await (await this.env(sandbox, ctx)).fileInfo(path, toChord(ctx)), wireInfo),
    exists: async (sandbox, { path }, ctx) => answer(await (await this.env(sandbox, ctx)).exists(path, toChord(ctx)), (value) => value),
    canonicalPath: async (sandbox, { path }, ctx) => answer(await (await this.env(sandbox, ctx)).canonicalPath(path, toChord(ctx)), (value) => value),
    readTextFile: async (sandbox, { path }, ctx) => answer(await (await this.env(sandbox, ctx)).readTextFile(path, toChord(ctx)), (value) => value),
    readTextLines: async (sandbox, { path, maxLines }, ctx) =>
      answer(await (await this.env(sandbox, ctx)).readTextLines(path, maxLines === undefined ? undefined : { maxLines }, toChord(ctx)), (value) => value),
    readBinaryFile: async (sandbox, { path }, ctx) => answer(await (await this.env(sandbox, ctx)).readBinaryFile(path, toChord(ctx)), (bytes) => ({ base64: toBase64(bytes) })),
    writeFile: async (sandbox, { path, content }, ctx) => done(await (await this.env(sandbox, ctx)).writeFile(path, contentOf(content), toChord(ctx))),
    appendFile: async (sandbox, { path, content }, ctx) => done(await (await this.env(sandbox, ctx)).appendFile(path, contentOf(content), toChord(ctx))),
    truncateFile: async (sandbox, { path, size }, ctx) => done(await (await this.env(sandbox, ctx)).truncateFile(path, size, toChord(ctx))),
    flushFile: async (sandbox, { path }, ctx) => done(await (await this.env(sandbox, ctx)).flushFile(path, toChord(ctx))),
    renameFile: async (sandbox, { from, to }, ctx) => done(await (await this.env(sandbox, ctx)).renameFile(from, to, toChord(ctx))),
    listDir: async (sandbox, { path }, ctx) => answer(await (await this.env(sandbox, ctx)).listDir(path, toChord(ctx)), (entries) => entries.map(wireInfo)),
    createDir: async (sandbox, { path, recursive }, ctx) => done(await (await this.env(sandbox, ctx)).createDir(path, recursive === undefined ? undefined : { recursive }, toChord(ctx))),
    remove: async (sandbox, { path, recursive, force }, ctx) =>
      done(await (await this.env(sandbox, ctx)).remove(path, { ...(recursive !== undefined && { recursive }), ...(force !== undefined && { force }) }, toChord(ctx))),
    createTempDir: async (sandbox, { prefix }, ctx) => answer(await (await this.env(sandbox, ctx)).createTempDir(prefix, toChord(ctx)), (value) => value),
    createTempFile: async (sandbox, { prefix, suffix }, ctx) =>
      answer(await (await this.env(sandbox, ctx)).createTempFile({ ...(prefix !== undefined && { prefix }), ...(suffix !== undefined && { suffix }) }, toChord(ctx)), (value) => value),

    openBinaryReader: async (sandbox, { path, noFollow, prefetch }, ctx) => {
      const context = toChord(ctx);
      const opened = await (await this.env(sandbox, ctx)).openBinaryReader(path, noFollow === undefined ? undefined : { noFollow }, context);
      if (!opened.ok) return { ok: false, error: fileFailure(opened.error) };
      const reader = opened.value;
      const info = await reader.info(context);
      if (!info.ok) {
        await reader.close(context);
        return { ok: false, error: fileFailure(info.error) };
      }
      if (info.value.size <= prefetch) {
        // Small enough to send whole: the client reads it from memory, and nothing stays open here.
        const bytes = await reader.read(0, info.value.size, context);
        await reader.close(context);
        if (!bytes.ok) return { ok: false, error: fileFailure(bytes.error) };
        return { ok: true, value: { info: { ...wireInfo(info.value), size: bytes.value.length }, base64: toBase64(bytes.value) } };
      }
      return { ok: true, value: { info: wireInfo(info.value), handle: this.keep({ kind: "reader", sandbox, reader, used: this.options.now() }) } };
    },
    readerInfo: async (sandbox, { handle }, ctx) => answer(await this.handle(sandbox, handle, "reader").reader.info(toChord(ctx)), wireInfo),
    readerRead: async (sandbox, { handle, offset, length }, ctx) =>
      answer(await this.handle(sandbox, handle, "reader").reader.read(offset, length, toChord(ctx)), (bytes) => ({ base64: toBase64(bytes) })),
    readerScan: async (sandbox, { handle, startLine, endLine }, ctx) =>
      answer(await this.handle(sandbox, handle, "reader").reader.scanLines({ startLine, ...(endLine !== undefined && { endLine }) }, toChord(ctx)), (scan) => ({ ...scan })),
    readerClose: async (sandbox, { handle }, ctx) => {
      const reader = this.handle(sandbox, handle, "reader");
      this.handles.delete(handle);
      await reader.reader.close(toChord(ctx));
      return { ok: true, value: null };
    },
    openDirReader: async (sandbox, { path }, ctx) => {
      const opened = await (await this.env(sandbox, ctx)).openDirReader(path, toChord(ctx));
      if (!opened.ok) return { ok: false, error: fileFailure(opened.error) };
      return { ok: true, value: { handle: this.keep({ kind: "dir", sandbox, reader: opened.value, used: this.options.now() }) } };
    },
    dirNext: async (sandbox, { handle, maxEntries }, ctx) =>
      answer(await this.handle(sandbox, handle, "dir").reader.next(maxEntries, toChord(ctx)), (page) => ({ entries: page.entries.map(wireInfo), done: page.done })),
    dirClose: async (sandbox, { handle }, ctx) => {
      const reader = this.handle(sandbox, handle, "dir");
      this.handles.delete(handle);
      await reader.reader.close(toChord(ctx));
      return { ok: true, value: null };
    },

    execStart: async (sandbox, request, ctx) => {
      const env = await this.env(sandbox, ctx);
      const command = this.start(sandbox, env, request);
      return { ok: true, value: await this.state(command, 0, request.wait, request.linger, ctx) };
    },
    execRead: async (sandbox, { command, cursor, wait, linger }, ctx) => ({ ok: true, value: await this.state(this.command(sandbox, command), cursor, wait, linger, ctx) }),
    execKill: async (sandbox, { command: id, cursor, wait }, ctx) => {
      const command = this.command(sandbox, id);
      command.stop.abort();
      // A stop never fails on its cursor: one acknowledged already reads from what is kept.
      return { ok: true, value: await this.state(command, command.log.valid(cursor) ? cursor : command.log.acknowledged, wait, wait, ctx) };
    },
  };
}
