/**
 * pi-durable's `ExecutionEnv` over the sandbox protocol (`protocol.ts`): one sandbox of a host that
 * runs execution-serve. As pi-durable requires, no method throws: the host's failures are its own
 * `FileError` / `ExecutionError` codes, and the protocol's are mapped (`unauthorized` is
 * `permission_denied`, a closed or unknown reader `invalid`, the network or the host down `unknown`,
 * a cancelled context `aborted`).
 *
 * - **`open`, once.** The first operation asks the host for the sandbox's working directory and home
 *   (`open`); after it, `cwd` is known and every path is resolved here (`paths.ts`), so
 *   `absolutePath` and `joinPath` cost no request. Before it, reading `cwd` throws: `workspace`
 *   resolves an environment opened already.
 * - **`id`** is `execution-remote:<endpoint>#<sandbox>`: each sandbox is its own file namespace.
 * - **`agent`**, when given, goes with every request (`Pikit-Agent`): the host resolves the sandbox for it.
 * - **Readers.** `openBinaryReader` brings a file of up to 1 MiB whole in its answer and serves it from
 *   memory (the file as it was opened, through a rename, as Node's does); a larger one stays open on
 *   the host behind a handle (`readerRead`, `readerScan`, `readerInfo`, `readerClose`). Directory
 *   readers are always the host's (an entry removed meanwhile is skipped there). `openTextLineReader`
 *   reads the file once (`readTextFile`) and serves its lines.
 * - **`watch`** is `not_supported`: changes would have to be polled across the network.
 * - **`exec`** starts the command under an id of its own (`execStart`), then reads its output from a
 *   cursor (`execRead`) until it ended, each request held by the host at most `WAIT_MS`. A command that
 *   ends quickly costs one request. Output reaches `onOutput` as it arrives, chunk by chunk, with the
 *   stream it came from; the host sends at most every `linger` ms, which starts at the caller's
 *   `window.minIntervalMs` (at least 200 ms) and doubles up to 5 s, so a long chatty command costs
 *   about a dozen requests a minute, and a silent one six. With `window`, the host leaves out what the
 *   caller would drop and says so (`info.skipped`). `timeout` and `spill` are the host environment's
 *   (the spill file is in the sandbox, readable through this environment). A cancelled context, or an
 *   `onOutput` that throws, stops the command on the host (`execKill`). A read that fails on the
 *   network is retried three times; a command the host lost (it restarted, or nobody read it for its
 *   lease) is an `unknown` error.
 *
 * Methods read `this.cwd` at each call and keep their state in a shared session, so `atCwd`'s views
 * work on the same sandbox.
 */

import {
  type BinaryReader,
  type Context,
  type DirReader,
  err,
  type ExecutionEnv,
  ExecutionError,
  type ExecutionErrorCode,
  FileError,
  type FileErrorCode,
  type FileInfo,
  type FileWatcher,
  type LineScan,
  LineScanner,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type ShellOutputInfo,
  type TextLine,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
} from "@pikit/pi-adapter/execution";
import { join, resolvePath } from "./paths.ts";
import { fromBase64, MAX_PREFETCH_BYTES, MAX_READ_BYTES, type Operation, type RequestOf, toBase64, type Values, type WireError, type WireExecState } from "./protocol.ts";
import type { CallFailure, CallResult, Transport } from "./transport.ts";

/** How long the host may hold a request waiting for a command. */
export const WAIT_MS = 10_000;
/** The first and longest pause between two answers carrying output. */
export const FIRST_LINGER_MS = 200;
export const MAX_LINGER_MS = 5_000;
/** How long a stop waits for the command to end, for its spill file. */
export const KILL_WAIT_MS = 3_000;
/** A request's own time limit, beyond what the host may hold it. */
export const REQUEST_TIMEOUT_MS = 60_000;
/** Pauses before retrying a command's read that got no answer. */
const READ_RETRIES_MS = [250, 1_000, 2_000];
/** The longest timeout `setTimeout` takes, in seconds (pi-durable's limit). */
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

const FILE_CODES = new Set<FileErrorCode>(["aborted", "not_found", "permission_denied", "not_directory", "is_directory", "invalid", "not_supported", "unknown"]);
const EXECUTION_CODES = new Set<ExecutionErrorCode>(["aborted", "timeout", "shell_unavailable", "spawn_error", "callback_error", "unknown"]);

/** What every view of one sandbox's environment shares. */
export interface Session {
  cwd?: string;
  home?: string;
  /** The `open` request in flight, shared by the calls that wait for it. */
  opening?: Promise<Result<void, FileError>>;
  /** Commands running, by id: `cleanup` stops them. */
  readonly commands: Set<string>;
  /** Readers open on the host, by handle: `cleanup` closes them. */
  readonly handles: Map<string, "reader" | "dir">;
}

export interface RemoteEnvOptions {
  transport: Transport;
  /** The sandbox's id; `undefined` while it is not known (before start). */
  sandbox(): string | undefined;
  /** The agent a conversation's sandbox is for, sent with every request (`Pikit-Agent`); none for `execution`'s own. */
  agent?: string;
}

type Call = <O extends Operation>(operation: O, request: RequestOf<O>, signal: AbortSignal | undefined, timeoutMs?: number) => Promise<CallResult<O>>;

function describe(failure: CallFailure): string {
  if (failure.kind === "aborted") return "the operation was cancelled";
  if (failure.kind === "network") return `execution-remote: the sandbox host did not answer: ${failure.message}`;
  return `execution-remote: the sandbox host refused (${failure.code}): ${failure.message}`;
}

function fileFailure(failure: CallFailure, path?: string): FileError {
  if (failure.kind === "aborted") return new FileError("aborted", "the operation was cancelled", path);
  const code: FileErrorCode =
    failure.kind === "protocol" && failure.code === "unauthorized"
      ? "permission_denied"
      : failure.kind === "protocol" && (failure.code === "unknown_handle" || failure.code === "invalid_request" || failure.code === "too_large")
        ? "invalid"
        : "unknown";
  return new FileError(code, describe(failure), path);
}

function executionFailure(failure: CallFailure): ExecutionError {
  if (failure.kind === "aborted") return new ExecutionError("aborted", "aborted");
  if (failure.kind === "protocol" && failure.code === "unknown_command") {
    return new ExecutionError("unknown", `execution-remote: the sandbox host lost the command (it restarted, or nobody read the command for its lease): ${failure.message}`);
  }
  return new ExecutionError("unknown", describe(failure));
}

function wireFileError(error: WireError, path?: string): FileError {
  const code = FILE_CODES.has(error.code as FileErrorCode) ? (error.code as FileErrorCode) : "unknown";
  return new FileError(code, error.message, error.path ?? path);
}

function wireExecutionError(error: WireError): ExecutionError {
  const code = EXECUTION_CODES.has(error.code as ExecutionErrorCode) ? (error.code as ExecutionErrorCode) : "unknown";
  const failure = new ExecutionError(code, error.message);
  if (error.spillPath !== undefined) failure.spillPath = error.spillPath;
  return failure;
}

const cancelled = (context: Context): boolean => context.abortSignal?.aborted === true;

const MALFORMED = "execution-remote: the sandbox host's answer is not the protocol's";

/** Whether `value` is a command's state as the protocol has it: what the loop reads of it. */
function isExecState(value: unknown): value is WireExecState {
  const state = value as Partial<WireExecState> | null;
  return (
    typeof state === "object" &&
    state !== null &&
    typeof state.command === "string" &&
    Number.isSafeInteger(state.next) &&
    Array.isArray(state.chunks) &&
    state.chunks.every((chunk) => typeof chunk?.text === "string" && (chunk.stream === "stdout" || chunk.stream === "stderr")) &&
    (state.done === undefined || (state.done.ok === true ? Number.isInteger(state.done.value?.exitCode) : typeof state.done.error?.code === "string"))
  );
}

/** `bytes` decoded from base64, or a failure saying the host's answer was not. */
function bytesOf(base64: string, path?: string): Result<Uint8Array, FileError> {
  const bytes = fromBase64(base64);
  return bytes === undefined ? err(new FileError("unknown", "execution-remote: the host's answer holds no base64", path)) : ok(bytes);
}

/** Text as lines, remembering whether the last one ended with a newline. */
function linesOf(content: string): TextLine[] {
  const lines = content.split("\n");
  const last = lines.pop() ?? "";
  const out = lines.map((text) => ({ text, terminated: true }));
  if (last !== "") out.push({ text: last, terminated: false });
  return out;
}

/** Why a reader cannot serve a call: a cancelled call, or the reader closed. */
function refused<T>(what: string, closed: boolean, path: string, context: Context): Result<T, FileError> | undefined {
  if (cancelled(context)) return err(new FileError("aborted", "the operation was cancelled", path));
  if (closed) return err(new FileError("invalid", `${what} is closed`, path));
  return undefined;
}

function validRange(offset: number, length: number, path: string): Result<void, FileError> | undefined {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
    return err(new FileError("invalid", "Offset and length must be non-negative safe integers", path));
  }
  return undefined;
}

/** A file brought whole with its opening: its bytes as they were then. */
class FetchedFile implements BinaryReader {
  private closed = false;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly opened: FileInfo,
  ) {}

  async info(context: Context): Promise<Result<FileInfo, FileError>> {
    return refused<FileInfo>("Binary reader", this.closed, this.opened.path, context) ?? ok({ ...this.opened });
  }

  async read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
    const refusal = refused<Uint8Array>("Binary reader", this.closed, this.opened.path, context) ?? (validRange(offset, length, this.opened.path) as Result<Uint8Array, FileError> | undefined);
    return refusal ?? ok(this.bytes.slice(offset, offset + length));
  }

  async scanLines(options: { startLine: number; endLine?: number }, context: Context): Promise<Result<LineScan, FileError>> {
    const refusal = refused<LineScan>("Binary reader", this.closed, this.opened.path, context);
    if (refusal !== undefined) return refusal;
    let scanner: LineScanner;
    try {
      scanner = new LineScanner(options.startLine, options.endLine);
    } catch {
      return err(new FileError("invalid", "Invalid line range", this.opened.path));
    }
    scanner.push(this.bytes);
    return ok(scanner.finish());
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** A file opened on the host, behind a handle. */
class HostFile implements BinaryReader {
  private closed = false;

  constructor(
    private readonly call: Call,
    private readonly session: Session,
    private readonly handle: string,
    private readonly path: string,
  ) {}

  async info(context: Context): Promise<Result<FileInfo, FileError>> {
    const refusal = refused<FileInfo>("Binary reader", this.closed, this.path, context);
    if (refusal !== undefined) return refusal;
    return this.answer(await this.call("readerInfo", { handle: this.handle }, context.abortSignal), (info) => info);
  }

  async read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
    const refusal = refused<Uint8Array>("Binary reader", this.closed, this.path, context) ?? (validRange(offset, length, this.path) as Result<Uint8Array, FileError> | undefined);
    if (refusal !== undefined) return refusal;
    const parts: Uint8Array[] = [];
    let got = 0;
    // Up to `length` bytes, fewer only at the end of the file: one request per MAX_READ_BYTES.
    while (got < length) {
      const asked = Math.min(length - got, MAX_READ_BYTES);
      const part = await this.answer(await this.call("readerRead", { handle: this.handle, offset: offset + got, length: asked }, context.abortSignal), (value) => value.base64);
      if (!part.ok) return part;
      const bytes = bytesOf(part.value, this.path);
      if (!bytes.ok) return bytes;
      parts.push(bytes.value);
      got += bytes.value.length;
      if (bytes.value.length < asked) break;
    }
    if (parts.length === 1) return ok(parts[0] as Uint8Array);
    const out = new Uint8Array(got);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return ok(out);
  }

  async scanLines(options: { startLine: number; endLine?: number }, context: Context): Promise<Result<LineScan, FileError>> {
    const refusal = refused<LineScan>("Binary reader", this.closed, this.path, context);
    if (refusal !== undefined) return refusal;
    if (!Number.isFinite(options.startLine) || (options.endLine !== undefined && !Number.isFinite(options.endLine))) return err(new FileError("invalid", "Invalid line range", this.path));
    const request = { handle: this.handle, startLine: options.startLine, ...(options.endLine !== undefined && { endLine: options.endLine }) };
    return this.answer(await this.call("readerScan", request, context.abortSignal), (scan) => scan);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.session.handles.delete(this.handle);
    // Best effort, never cancelled: a reader left open is closed by the host's lease.
    await this.call("readerClose", { handle: this.handle }, undefined);
  }

  private answer<O extends Operation, T>(result: CallResult<O>, map: (value: Values[O]) => T): Result<T, FileError> {
    if (!result.ok) return err(fileFailure(result.failure, this.path));
    if (!result.outcome.ok) return err(wireFileError(result.outcome.error, this.path));
    try {
      return ok(map(result.outcome.value));
    } catch {
      return err(new FileError("unknown", MALFORMED, this.path));
    }
  }
}

/** A directory opened on the host, read page by page. */
class HostDirectory implements DirReader {
  private closed = false;

  constructor(
    private readonly call: Call,
    private readonly session: Session,
    private readonly handle: string,
    private readonly path: string,
  ) {}

  async next(maxEntries: number, context: Context): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
    const refusal = refused<{ entries: FileInfo[]; done: boolean }>("Directory reader", this.closed, this.path, context);
    if (refusal !== undefined) return refusal;
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) return err(new FileError("invalid", "maxEntries must be a positive safe integer", this.path));
    const result = await this.call("dirNext", { handle: this.handle, maxEntries: Math.min(maxEntries, 100_000) }, context.abortSignal);
    if (!result.ok) return err(fileFailure(result.failure, this.path));
    const outcome = result.outcome as { ok: true; value: Values["dirNext"] } | { ok: false; error: WireError };
    return outcome.ok ? ok(outcome.value) : err(wireFileError(outcome.error, this.path));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.session.handles.delete(this.handle);
    await this.call("dirClose", { handle: this.handle }, undefined);
  }
}

/** Sleeps `ms`, or less when `signal` fires. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export class RemoteExecutionEnv implements ExecutionEnv {
  constructor(
    private readonly options: RemoteEnvOptions,
    private readonly session: Session = { commands: new Set(), handles: new Map() },
  ) {}

  get id(): string {
    return `execution-remote:${this.options.transport.endpoint}#${this.options.sandbox() ?? "unstarted"}`;
  }

  get cwd(): string {
    const cwd = this.session.cwd;
    if (cwd === undefined) throw new Error("execution-remote: the sandbox's working directory is not known before its first use (resolve it through `workspace`)");
    return cwd;
  }

  set cwd(value: string) {
    this.session.cwd = value;
  }

  /** Asks the host for the sandbox's working directory and home, once. */
  async open(context: Context): Promise<Result<void, FileError>> {
    if (cancelled(context)) return err(new FileError("aborted", "the operation was cancelled"));
    if (this.session.cwd !== undefined && this.session.home !== undefined) return ok(undefined);
    // Shared by every call waiting for it, so never cancelled by one of them.
    this.session.opening ??= (async (): Promise<Result<void, FileError>> => {
      const result = await this.call("open", {}, undefined);
      if (!result.ok) return err(fileFailure(result.failure));
      if (!result.outcome.ok) return err(wireFileError(result.outcome.error));
      const { cwd, home } = (result.outcome.value ?? {}) as Partial<Values["open"]>;
      if (typeof cwd !== "string" || !cwd.startsWith("/") || typeof home !== "string") return err(new FileError("unknown", MALFORMED));
      this.session.cwd ??= cwd;
      this.session.home = home;
      return ok(undefined);
    })().finally(() => {
      delete this.session.opening;
    });
    return this.session.opening;
  }

  private call: Call = (operation, request, signal, timeoutMs = REQUEST_TIMEOUT_MS) => {
    const sandbox = this.options.sandbox();
    if (sandbox === undefined) return Promise.resolve({ ok: false, failure: { kind: "protocol", status: 503, code: "unavailable", message: "execution-remote is not running" } });
    return this.options.transport.call(sandbox, operation, request, { signal, timeoutMs, agent: this.options.agent });
  };

  private abs(path: string): string {
    return resolvePath(this.cwd, this.session.home ?? "/", path);
  }

  /** One file operation: open first, the path made absolute, the answer mapped. */
  private async file<O extends Operation, T>(operation: O, path: string | undefined, request: (absolute: string) => RequestOf<O>, map: (value: Values[O], absolute: string) => Result<T, FileError>, context: Context): Promise<Result<T, FileError>> {
    if (cancelled(context)) return err(new FileError("aborted", "the operation was cancelled", path));
    const opened = await this.open(context);
    if (!opened.ok) return err(opened.error);
    const absolute = path === undefined ? "" : this.abs(path);
    const result = await this.call(operation, request(absolute), context.abortSignal);
    const at = path === undefined ? undefined : absolute;
    if (!result.ok) return err(fileFailure(result.failure, at));
    const outcome = result.outcome as { ok: true; value: Values[O] } | { ok: false; error: WireError };
    if (!outcome.ok) return err(wireFileError(outcome.error, at));
    try {
      return map(outcome.value, absolute);
    } catch {
      return err(new FileError("unknown", MALFORMED, at));
    }
  }

  async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    const opened = await this.open(context);
    return opened.ok ? ok(this.abs(path)) : err(opened.error);
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(join(parts));
  }

  readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.file("readTextFile", path, (absolute) => ({ path: absolute }), (text) => ok(text), context);
  }

  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const text = await this.readTextFile(path, context);
    if (!text.ok) return text;
    const lines = linesOf(text.value);
    let index = 0;
    return ok({ readLine: async () => ok(lines[index++]), close: async () => {} });
  }

  readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    return this.file("readTextLines", path, (absolute) => ({ path: absolute, ...(options?.maxLines !== undefined && { maxLines: Math.max(0, Math.floor(options.maxLines)) }) }), (lines) => ok(lines), context);
  }

  readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.file("readBinaryFile", path, (absolute) => ({ path: absolute }), (value, absolute) => bytesOf(value.base64, absolute), context);
  }

  async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    return this.file(
      "openBinaryReader",
      path,
      (absolute) => ({ path: absolute, prefetch: MAX_PREFETCH_BYTES, ...(options?.noFollow !== undefined && { noFollow: options.noFollow }) }),
      (value, absolute): Result<BinaryReader, FileError> => {
        if ("handle" in value) {
          this.session.handles.set(value.handle, "reader");
          return ok(new HostFile(this.call, this.session, value.handle, absolute));
        }
        const bytes = bytesOf(value.base64, absolute);
        return bytes.ok ? ok(new FetchedFile(bytes.value, value.info)) : bytes;
      },
      context,
    );
  }

  private content(content: string | Uint8Array): { text: string } | { base64: string } {
    return typeof content === "string" ? { text: content } : { base64: toBase64(content) };
  }

  writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.file("writeFile", path, (absolute) => ({ path: absolute, content: this.content(content) }), () => ok(undefined), context);
  }

  appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.file("appendFile", path, (absolute) => ({ path: absolute, content: this.content(content) }), () => ok(undefined), context);
  }

  async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    if (!Number.isSafeInteger(size) || size < 0) return err(new FileError("invalid", "File size must be a non-negative safe integer", path));
    return this.file("truncateFile", path, (absolute) => ({ path: absolute, size }), () => ok(undefined), context);
  }

  flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    return this.file("flushFile", path, (absolute) => ({ path: absolute }), () => ok(undefined), context);
  }

  renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    return this.file("renameFile", sourcePath, (absolute) => ({ from: absolute, to: this.abs(destinationPath) }), () => ok(undefined), context);
  }

  fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.file("fileInfo", path, (absolute) => ({ path: absolute }), (info) => ok(info), context);
  }

  listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.file("listDir", path, (absolute) => ({ path: absolute }), (entries) => ok(entries), context);
  }

  openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    return this.file(
      "openDirReader",
      path,
      (absolute) => ({ path: absolute }),
      (value, absolute): Result<DirReader, FileError> => {
        this.session.handles.set(value.handle, "dir");
        return ok(new HostDirectory(this.call, this.session, value.handle, absolute));
      },
      context,
    );
  }

  /** Not supported: changes in a remote sandbox would have to be polled across the network. */
  async watch(_targets: readonly WatchTarget[], _onChange: (change: WatchChange) => void, context: Context): Promise<Result<FileWatcher, FileError>> {
    if (cancelled(context)) return err(new FileError("aborted", "the operation was cancelled"));
    return err(new FileError("not_supported", "a remote sandbox cannot be watched"));
  }

  canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.file("canonicalPath", path, (absolute) => ({ path: absolute }), (value) => ok(value), context);
  }

  exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    return this.file("exists", path, (absolute) => ({ path: absolute }), (value) => ok(value), context);
  }

  createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    return this.file("createDir", path, (absolute) => ({ path: absolute, ...(options?.recursive !== undefined && { recursive: options.recursive }) }), () => ok(undefined), context);
  }

  remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    return this.file(
      "remove",
      path,
      (absolute) => ({ path: absolute, ...(options?.recursive !== undefined && { recursive: options.recursive }), ...(options?.force !== undefined && { force: options.force }) }),
      () => ok(undefined),
      context,
    );
  }

  createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.file("createTempDir", undefined, () => ({ ...(prefix !== undefined && { prefix }) }), (value) => ok(value), context);
  }

  createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.file(
      "createTempFile",
      undefined,
      () => ({ ...(options?.prefix !== undefined && { prefix: options.prefix }), ...(options?.suffix !== undefined && { suffix: options.suffix }) }),
      (value) => ok(value),
      context,
    );
  }

  async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    if (cancelled(context)) return err(new ExecutionError("aborted", "aborted"));
    if (typeof command !== "string" && command.length === 0) return err(new ExecutionError("spawn_error", "Empty argv: no program to run"));
    const seconds = options?.timeout;
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
    if (seconds !== undefined && seconds > MAX_TIMEOUT_SECONDS) return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
    const opened = await this.open(context);
    if (!opened.ok) return err(new ExecutionError(opened.error.code === "aborted" ? "aborted" : "unknown", opened.error.message));

    const id = crypto.randomUUID();
    const signal = context.abortSignal;
    let linger = Math.min(Math.max(options?.window?.minIntervalMs ?? 0, FIRST_LINGER_MS), MAX_LINGER_MS);
    const request: RequestOf<"execStart"> = {
      command: id,
      run: typeof command === "string" ? command : [...command],
      cwd: options?.cwd === undefined ? this.cwd : this.abs(options.cwd),
      ...(options?.env !== undefined && { env: options.env }),
      ...(options?.inheritEnv !== undefined && { inheritEnv: options.inheritEnv }),
      ...(seconds !== undefined && { timeout: seconds }),
      ...(options?.spill !== undefined && { spill: options.spill }),
      ...(options?.window !== undefined && { window: options.window }),
      wait: WAIT_MS,
      linger,
    };
    this.session.commands.add(id);
    try {
      const started = await this.call("execStart", request, signal, WAIT_MS + REQUEST_TIMEOUT_MS);
      if (!started.ok) {
        // It may have started anyway (the answer was what got lost, or the caller stopped waiting): stop it by its id.
        if (started.failure.kind === "aborted") return await this.aborted(id, 0);
        await this.stop(id, 0);
        return err(executionFailure(started.failure));
      }
      if (!started.outcome.ok) return err(wireExecutionError(started.outcome.error));
      if (!isExecState(started.outcome.value)) {
        await this.stop(id, 0);
        return err(new ExecutionError("unknown", MALFORMED));
      }
      let state: WireExecState = started.outcome.value;
      for (;;) {
        for (const chunk of state.chunks) {
          const info: ShellOutputInfo = { stream: chunk.stream, ...(chunk.skipped !== undefined && { skipped: chunk.skipped }) };
          try {
            options?.onOutput?.(chunk.text, context, info);
          } catch (error) {
            await this.stop(id, state.next);
            return err(new ExecutionError("callback_error", error instanceof Error ? error.message : String(error), error instanceof Error ? error : undefined));
          }
        }
        if (state.done !== undefined) return state.done.ok ? ok(state.done.value) : err(wireExecutionError(state.done.error));
        if (cancelled(context)) return await this.aborted(id, state.next);
        linger = Math.min(linger * 2, MAX_LINGER_MS);
        const read = await this.read(id, state.next, linger, signal);
        if (!read.ok) return read.error.code === "aborted" ? await this.aborted(id, state.next) : read;
        state = read.value;
      }
    } finally {
      this.session.commands.delete(id);
    }
  }

  /** The command's state after `cursor`, retried when no answer came. */
  private async read(id: string, cursor: number, linger: number, signal: AbortSignal | undefined): Promise<Result<WireExecState, ExecutionError>> {
    for (let attempt = 0; ; attempt++) {
      const result = await this.call("execRead", { command: id, cursor, wait: WAIT_MS, linger }, signal, WAIT_MS + REQUEST_TIMEOUT_MS);
      if (result.ok) {
        if (!result.outcome.ok) return err(wireExecutionError(result.outcome.error));
        return isExecState(result.outcome.value) ? ok(result.outcome.value) : err(new ExecutionError("unknown", MALFORMED));
      }
      const failure = result.failure;
      const transient = failure.kind === "network" || (failure.kind === "protocol" && (failure.status >= 500 || failure.code === "unknown"));
      const delay = READ_RETRIES_MS[attempt];
      if (!transient || delay === undefined) return err(executionFailure(failure));
      await pause(delay, signal);
      if (signal?.aborted === true) return err(new ExecutionError("aborted", "aborted"));
    }
  }

  /** Stops the command on the host and waits a little for its end. Best effort: the host's lease stops it otherwise. */
  private async stop(id: string, cursor: number): Promise<WireExecState | undefined> {
    const result = await this.call("execKill", { command: id, cursor, wait: KILL_WAIT_MS }, undefined, KILL_WAIT_MS + 10_000);
    return result.ok && result.outcome.ok && isExecState(result.outcome.value) ? result.outcome.value : undefined;
  }

  /** The caller cancelled: the command is stopped, and the result says `aborted`, with its spill file when it had one. */
  private async aborted(id: string, cursor: number): Promise<Result<ShellExecResult, ExecutionError>> {
    const state = await this.stop(id, cursor);
    const error = new ExecutionError("aborted", "aborted");
    const spillPath = state?.done === undefined ? undefined : state.done.ok ? state.done.value.spillPath : state.done.error.spillPath;
    if (spillPath !== undefined) error.spillPath = spillPath;
    return err(error);
  }

  /** Stops the commands still running and closes the readers left open: for the owner's shutdown. */
  async cleanup(_context: Context): Promise<void> {
    const commands = [...this.session.commands];
    const handles = [...this.session.handles];
    this.session.commands.clear();
    this.session.handles.clear();
    await Promise.all([
      ...commands.map((id) => this.stop(id, 0)),
      ...handles.map(([handle, kind]) => this.call(kind === "reader" ? "readerClose" : "dirClose", { handle }, undefined)),
    ]);
  }
}
