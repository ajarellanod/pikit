/**
 * pi-durable's `ExecutionEnv` over one boat VM: what execution-serve serves for a sandbox, and the
 * tools work on, unmodified.
 *
 * - **Files** are the VM's: each `FileSystem` method is one call of the in-VM helper (`helper.ts`,
 *   Node's own `fs` there, so `not_found`, `is_directory`, symbolic links and `noFollow` behave as
 *   in pi-durable's `NodeExecutionEnv`). Contents up to `INLINE_BYTES` travel in the call; larger ones
 *   through a file in the VM's `/tmp/pikit` and boat's signed upload and download URLs (the file API).
 *   A file read whole is at most `MAX_READ_BYTES`.
 * - **Readers** hold what they opened: a binary reader reads the file when it is opened (a rename
 *   afterwards changes nothing it reads); a directory reader takes the names when opened and each
 *   page's metadata when it is read (an entry removed meanwhile is skipped).
 * - **Commands** run detached (boat's `detached: true`), wrapped (`wrapCommand`): their output is
 *   read after offsets and streamed to `onOutput` per stream, as it comes; `window` is not used
 *   (every chunk is delivered, none `skipped`). A timeout, the call's cancellation, a throwing
 *   `onOutput` and `cleanup` stop the command and every process it started (boat's stop: SIGTERM,
 *   then SIGKILL). Past `spill`'s thresholds the whole output (at most `MAX_SPILL_BYTES`) is also
 *   written to a file in the VM's `/tmp/pikit` (`spillPath`).
 * - **Every call is a use** of the VM (`Vms.use`): it resumes a stopped VM first, and nothing is
 *   stopped while one runs. A VM that cannot be had answers `shell_unavailable` (a command) or
 *   `unknown` (a file), saying why; all `maxVms` busy is `spawn_error`. No method throws.
 * - `watch` is `not_supported`: nothing pikit reloads lives in these files.
 */

import { posix } from "node:path";
import {
  BACKGROUND_CONTEXT,
  type BinaryReader,
  type Context,
  type DirReader,
  err,
  type ExecutionEnv,
  ExecutionError,
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
  type TextLine,
  type TextLineReader,
} from "@pikit/pi-adapter/execution";
import { type BoatApi, BoatError } from "./api.ts";
import { helperCommand, INLINE_BYTES, SPAWN_EXIT, VARIABLE, wrapCommand } from "./helper.ts";
import { type Vm, VmError, type Vms } from "./vms.ts";

/** The largest file read whole (a read, a reader). */
export const MAX_READ_BYTES = 64 * 1024 * 1024;
/** The most output kept for a spill file. */
export const MAX_SPILL_BYTES = 64 * 1024 * 1024;
/** The longest timeout `setTimeout` takes, in seconds (pi-durable's limit). */
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CODES: Record<string, FileErrorCode> = {
  ENOENT: "not_found",
  EACCES: "permission_denied",
  EPERM: "permission_denied",
  ENOTDIR: "not_directory",
  EISDIR: "is_directory",
  EINVAL: "invalid",
  NOFOLLOW: "invalid",
};

/** Where a VM's files are: its user's home (the workspace is `<home>/workspace`) and this component's temporary directory. */
export interface VmPaths {
  home: string;
  tmp: string;
}

export interface BoatEnvOptions {
  vms: Vms;
  vm: Vm;
  api: BoatApi;
  paths: VmPaths;
  /** The program that runs the helper in the VM: `node` (or `bun`). */
  node: string;
  /** boat's own deadline for one helper call, in seconds. */
  callSeconds: number;
  /** How often a running command is polled, at most (real time). */
  pollMs: number;
}

function linesOf(content: string): TextLine[] {
  const lines = content.split("\n");
  const last = lines.pop() ?? "";
  const out = lines.map((text) => ({ text, terminated: true }));
  if (last !== "") out.push({ text: last, terminated: false });
  return out;
}

const aborted = (context: Context) => context.abortSignal?.aborted === true;

function refused<T>(what: string, closed: boolean, path: string, context: Context): Result<T, FileError> | undefined {
  if (aborted(context)) return err(new FileError("aborted", "the operation was cancelled", path));
  if (closed) return err(new FileError("invalid", `${what} is closed`, path));
  return undefined;
}

/** A failure to reach the VM, as a file error. */
function unreachable(error: unknown, path?: string): FileError {
  if ((error instanceof VmError || error instanceof BoatError) && error.code === "aborted") return new FileError("aborted", "the operation was cancelled", path);
  return new FileError("unknown", error instanceof Error ? error.message : String(error), path);
}

/** Whether `output` crosses `spill`'s thresholds: more bytes, or more (complete or partial) lines. */
function crosses(bytes: number, newlines: number, endsWithNewline: boolean, spill: NonNullable<ShellExecOptions["spill"]>): boolean {
  if (bytes === 0) return false;
  const lines = newlines + (endsWithNewline ? 0 : 1);
  return bytes > spill.afterBytes || lines > spill.afterLines;
}

class OpenedFile implements BinaryReader {
  private closed = false;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly opened: FileInfo,
  ) {}

  async info(context: Context): Promise<Result<FileInfo, FileError>> {
    return refused<FileInfo>("Binary reader", this.closed, this.opened.path, context) ?? ok({ ...this.opened });
  }

  async read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
    const refusal = refused<Uint8Array>("Binary reader", this.closed, this.opened.path, context);
    if (refusal !== undefined) return refusal;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      return err(new FileError("invalid", "Offset and length must be non-negative safe integers", this.opened.path));
    }
    return ok(this.bytes.slice(offset, offset + length));
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

class Listing implements DirReader {
  private position = 0;
  private closed = false;

  constructor(
    private readonly path: string,
    private readonly names: string[],
    private readonly describe: (names: string[], context: Context) => Promise<Result<FileInfo[], FileError>>,
  ) {}

  async next(maxEntries: number, context: Context): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
    const refusal = refused<{ entries: FileInfo[]; done: boolean }>("Directory reader", this.closed, this.path, context);
    if (refusal !== undefined) return refusal;
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) return err(new FileError("invalid", "maxEntries must be a positive safe integer", this.path));
    const entries: FileInfo[] = [];
    while (this.position < this.names.length && entries.length < maxEntries) {
      const batch = this.names.slice(this.position, this.position + (maxEntries - entries.length));
      this.position += batch.length;
      const described = await this.describe(batch, context);
      if (!described.ok) return described;
      entries.push(...described.value);
    }
    return ok({ entries, done: this.position >= this.names.length });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class BoatExecutionEnv implements ExecutionEnv {
  cwd: string;
  private readonly running = new Set<AbortController>();

  constructor(
    readonly id: string,
    private readonly options: BoatEnvOptions,
  ) {
    this.cwd = posix.join(options.paths.home, "workspace");
  }

  private abs(path: string): string {
    const home = this.options.paths.home;
    if (path === "~") return home;
    if (path.startsWith("~/")) return posix.join(home, path.slice(2));
    return path.startsWith("/") ? posix.resolve(path) : posix.resolve(this.cwd, path);
  }

  /** One helper call in the VM: its value, or the file error it answered. */
  private async op<T>(request: Record<string, unknown>, path: string | undefined, context: Context, seconds = this.options.callSeconds): Promise<Result<T, FileError>> {
    if (aborted(context)) return err(new FileError("aborted", "the operation was cancelled", path));
    const { vms, vm, api } = this.options;
    try {
      return await vms.use(vm, context.abortSignal, async (id) => {
        const answer = await api.run(id, helperCommand(this.options.node, request), seconds, context.abortSignal);
        let parsed: { ok?: unknown; value?: unknown; code?: unknown; message?: unknown } | undefined;
        try {
          parsed = JSON.parse(answer.stdout) as typeof parsed;
        } catch {
          parsed = undefined;
        }
        if (parsed === undefined || typeof parsed !== "object" || parsed === null || typeof parsed.ok !== "boolean") {
          const why = answer.timedOut ? "it timed out" : answer.truncated ? "its answer was cut" : `exit ${answer.exitCode}: ${api.redact(answer.stderr).slice(-300)}`;
          return err<T, FileError>(new FileError("unknown", `execution-boat: the file operation in the VM failed (${why})`, path));
        }
        if (parsed.ok) return ok<T, FileError>(parsed.value as T);
        const code = typeof parsed.code === "string" ? parsed.code : "";
        return err<T, FileError>(new FileError(CODES[code] ?? "unknown", typeof parsed.message === "string" ? parsed.message : code, path));
      });
    } catch (error) {
      return err(unreachable(error, path));
    }
  }

  /** `bytes` into the VM's file `path` (`append`ing): inline when small, else through an upload URL. */
  private async put(path: string, content: string | Uint8Array, append: boolean, context: Context): Promise<Result<void, FileError>> {
    const bytes = typeof content === "string" ? encoder.encode(content) : content;
    if (bytes.length <= INLINE_BYTES) {
      return this.op<null>({ op: "write", path, base64: Buffer.from(bytes).toString("base64"), append }, path, context).then((r) => (r.ok ? ok(undefined) : r));
    }
    const xfer = posix.join(this.options.paths.tmp, `xfer-${crypto.randomUUID()}`);
    const { vms, vm, api } = this.options;
    try {
      await vms.use(vm, context.abortSignal, async (id) => {
        const url = await api.fileUrl(id, "upload", xfer, context.abortSignal);
        await api.upload(url, bytes, context.abortSignal);
      });
    } catch (error) {
      return err(unreachable(error, path));
    }
    const written = await this.op<null>({ op: "write", path, from: xfer, append }, path, context);
    return written.ok ? ok(undefined) : written;
  }

  /** The bytes and metadata of the regular file `path`, as it was when read. */
  private async bytesOf(path: string, noFollow: boolean, context: Context): Promise<Result<{ info: FileInfo; bytes: Uint8Array }, FileError>> {
    const xfer = posix.join(this.options.paths.tmp, `xfer-${crypto.randomUUID()}`);
    const read = await this.op<{ info: FileInfo; base64?: string; xfer?: string }>({ op: "read", path, noFollow, inline: INLINE_BYTES, xfer }, path, context);
    if (!read.ok) return read;
    if (read.value.base64 !== undefined) return ok({ info: read.value.info, bytes: new Uint8Array(Buffer.from(read.value.base64, "base64")) });
    if (read.value.info.size > MAX_READ_BYTES) {
      await this.op({ op: "rm", path: xfer, recursive: false, force: true }, xfer, context);
      return err(new FileError("invalid", `execution-boat: the file is ${read.value.info.size} bytes, more than the ${MAX_READ_BYTES} read whole through boat`, path));
    }
    const { vms, vm, api } = this.options;
    try {
      const bytes = await vms.use(vm, context.abortSignal, async (id) => api.download(await api.fileUrl(id, "download", xfer, context.abortSignal), MAX_READ_BYTES, context.abortSignal));
      return ok({ info: read.value.info, bytes });
    } catch (error) {
      return err(unreachable(error, path));
    } finally {
      await this.op({ op: "rm", path: xfer, recursive: false, force: true }, xfer, BACKGROUND_CONTEXT);
    }
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    return ok(this.abs(path));
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(posix.join(...parts));
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const read = await this.bytesOf(this.abs(path), false, context);
    return read.ok ? ok(decoder.decode(read.value.bytes)) : read;
  }

  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const text = await this.readTextFile(path, context);
    if (!text.ok) return text;
    const lines = linesOf(text.value);
    let at = 0;
    let closed = false;
    const target = this.abs(path);
    return ok({
      readLine: async (c: Context) => refused<TextLine | undefined>("Line reader", closed, target, c) ?? ok(lines[at++]),
      close: async () => {
        closed = true;
      },
    });
  }

  async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    const text = await this.readTextFile(path, context);
    if (!text.ok) return text;
    const lines = linesOf(text.value).map((line) => line.text);
    return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
  }

  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const read = await this.bytesOf(this.abs(path), false, context);
    return read.ok ? ok(read.value.bytes) : read;
  }

  async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    const read = await this.bytesOf(this.abs(path), options?.noFollow === true, context);
    if (!read.ok) return read;
    if (aborted(context)) return err(new FileError("aborted", "the operation was cancelled", this.abs(path)));
    return ok(new OpenedFile(read.value.bytes, { ...read.value.info, size: read.value.bytes.length }));
  }

  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.put(this.abs(path), content, false, context);
  }

  async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.put(this.abs(path), content, true, context);
  }

  async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    const target = this.abs(path);
    if (!Number.isSafeInteger(size) || size < 0) return err(new FileError("invalid", "File size must be a non-negative safe integer", target));
    return this.done(await this.op({ op: "truncate", path: target, size }, target, context));
  }

  async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    const target = this.abs(path);
    return this.done(await this.op({ op: "flush", path: target }, target, context));
  }

  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    const from = this.abs(sourcePath);
    return this.done(await this.op({ op: "rename", from, to: this.abs(destinationPath) }, from, context));
  }

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const target = this.abs(path);
    return this.op<FileInfo>({ op: "info", path: target }, target, context);
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const target = this.abs(path);
    const names = await this.op<string[]>({ op: "names", path: target }, target, context);
    if (!names.ok) return names;
    return this.op<FileInfo[]>({ op: "infos", path: target, names: names.value }, target, context);
  }

  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    const target = this.abs(path);
    const names = await this.op<string[]>({ op: "names", path: target }, target, context);
    if (!names.ok) return names;
    if (aborted(context)) return err(new FileError("aborted", "the operation was cancelled", target));
    return ok(new Listing(target, names.value, (batch, c) => this.op<FileInfo[]>({ op: "infos", path: target, names: batch }, target, c)));
  }

  async watch(): Promise<Result<FileWatcher, FileError>> {
    return err(new FileError("not_supported", "execution-boat does not watch files: its tools and commands change them, and pikit reloads nothing from them"));
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    const target = this.abs(path);
    return this.op<string>({ op: "real", path: target }, target, context);
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const info = await this.fileInfo(path, context);
    if (info.ok) return ok(true);
    return info.error.code === "not_found" ? ok(false) : err(info.error);
  }

  async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    const target = this.abs(path);
    return this.done(await this.op({ op: "mkdir", path: target, recursive: options?.recursive ?? true }, target, context));
  }

  async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    const target = this.abs(path);
    return this.done(await this.op({ op: "rm", path: target, recursive: options?.recursive ?? false, force: options?.force ?? false }, target, context));
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.op<string>({ op: "mkdtemp", tmp: this.options.paths.tmp, prefix: prefix ?? "tmp-" }, undefined, context);
  }

  async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.op<string>({ op: "mktemp", tmp: this.options.paths.tmp, prefix: options?.prefix ?? "", suffix: options?.suffix ?? "" }, undefined, context);
  }

  private done(result: Result<unknown, FileError>): Result<void, FileError> {
    return result.ok ? ok(undefined) : result;
  }

  async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    if (aborted(context)) return err(new ExecutionError("aborted", "aborted"));
    const timeout = options?.timeout;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_SECONDS)) {
      return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
    }
    if (typeof command !== "string" && command.length === 0) return err(new ExecutionError("spawn_error", "no program to run (an empty argv)"));
    for (const name of Object.keys(options?.env ?? {})) {
      if (!VARIABLE.test(name)) return err(new ExecutionError("spawn_error", `not a variable name: ${JSON.stringify(name.slice(0, 40))}`));
    }
    const cwd = this.abs(options?.cwd ?? this.cwd);
    const spawnNote = posix.join(this.options.paths.tmp, `.spawn-${crypto.randomUUID()}`);
    const line = wrapCommand({
      run: command,
      cwd,
      spawnNote,
      ...(options?.env !== undefined && { env: options.env }),
      ...(options?.inheritEnv !== undefined && { inheritEnv: options.inheritEnv }),
    });
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    context.abortSignal?.addEventListener("abort", onAbort, { once: true });
    this.running.add(stop);
    let why: "timeout" | "aborted" | "callback" | undefined;
    // Started with the command, not before: bringing the VM up does not count against the timeout.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const { vms, vm, api } = this.options;
    // The output, for a spill file: kept only with `spill`, up to MAX_SPILL_BYTES.
    const spill = options?.spill;
    const kept: string[] = [];
    let keptBytes = 0;
    let bytes = 0;
    let newlines = 0;
    let lastChar = "";
    const deliver = (text: string, stream: "stdout" | "stderr") => {
      if (text === "") return;
      const size = encoder.encode(text).length;
      bytes += size;
      for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) newlines++;
      lastChar = text.slice(-1);
      if (spill !== undefined && keptBytes < MAX_SPILL_BYTES) {
        kept.push(text);
        keptBytes += size;
      }
      try {
        options?.onOutput?.(text, context, { stream });
      } catch {
        why ??= "callback";
        stop.abort();
      }
    };
    let result: Result<ShellExecResult, ExecutionError>;
    try {
      result = await vms.use(vm, stop.signal, async (id) => {
        const processId = await api.start(id, line, stop.signal);
        if (timeout !== undefined) {
          timer = setTimeout(() => {
            why ??= "timeout";
            stop.abort();
          }, timeout * 1000);
        }
        const offsets = { stdout: 0, stderr: 0 };
        let wait = 25;
        for (;;) {
          if (stop.signal.aborted) {
            await api.kill(id, processId).catch(() => {});
            return err<ShellExecResult, ExecutionError>(this.stopped(why));
          }
          const status = await api.status(id, processId, offsets, stop.signal).catch((error: unknown) => {
            if (stop.signal.aborted) return undefined;
            throw error;
          });
          if (status === undefined) continue;
          if (status.stdout.length > 0 || status.stderr.length > 0) wait = 25;
          offsets.stdout = status.stdoutNext;
          offsets.stderr = status.stderrNext;
          deliver(status.stdout, "stdout");
          deliver(status.stderr, "stderr");
          if (!status.running && !status.more) {
            if (stop.signal.aborted) return err<ShellExecResult, ExecutionError>(this.stopped(why));
            if (status.status === "lost") return err<ShellExecResult, ExecutionError>(new ExecutionError("unknown", "execution-boat: the VM lost the command (it stopped or its agent restarted)"));
            if (status.exitCode === null) return err<ShellExecResult, ExecutionError>(new ExecutionError("unknown", "execution-boat: the command ended without an exit code (a signal)"));
            if (status.exitCode === SPAWN_EXIT) {
              const note = await api.run(id, helperCommand(this.options.node, { op: "spawned", path: spawnNote }), this.options.callSeconds);
              let missing = "";
              try {
                const parsed = JSON.parse(note.stdout) as { ok?: boolean; value?: unknown };
                if (parsed.ok === true && typeof parsed.value === "string") missing = parsed.value;
              } catch {}
              if (missing === "cwd") return err<ShellExecResult, ExecutionError>(new ExecutionError("spawn_error", `the working directory does not exist or is not a directory: ${cwd}`));
              if (missing === "program") return err<ShellExecResult, ExecutionError>(new ExecutionError("spawn_error", `the program was not found: ${JSON.stringify(String((command as readonly string[])[0]).slice(0, 80))}`));
            }
            return ok<ShellExecResult, ExecutionError>({ exitCode: status.exitCode });
          }
          if (status.more) continue;
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, wait);
            stop.signal.addEventListener("abort", () => {
              clearTimeout(t);
              resolve();
            }, { once: true });
          });
          wait = Math.min(this.options.pollMs, wait * 2);
        }
      });
    } catch (error) {
      if (stop.signal.aborted) result = err(this.stopped(why));
      else if (error instanceof VmError && error.code === "busy") result = err(new ExecutionError("spawn_error", error.message));
      else if (error instanceof BoatError && error.code === "aborted") result = err(this.stopped(why));
      else result = err(new ExecutionError("shell_unavailable", error instanceof Error ? error.message : String(error)));
    } finally {
      clearTimeout(timer);
      context.abortSignal?.removeEventListener("abort", onAbort);
      this.running.delete(stop);
    }
    if (spill !== undefined && crosses(bytes, newlines, lastChar === "\n", spill)) {
      const file = await this.createTempFile({ prefix: "pikit-output-", suffix: ".log" }, BACKGROUND_CONTEXT);
      if (file.ok && (await this.put(file.value, kept.join(""), false, BACKGROUND_CONTEXT)).ok) {
        if (result.ok) result = ok({ ...result.value, spillPath: file.value });
        else result.error.spillPath = file.value;
      }
    }
    return result;
  }

  private stopped(why: "timeout" | "aborted" | "callback" | undefined): ExecutionError {
    if (why === "timeout") return new ExecutionError("timeout", "the command timed out");
    if (why === "callback") return new ExecutionError("callback_error", "onOutput threw: the command was stopped");
    return new ExecutionError("aborted", "aborted");
  }

  async cleanup(): Promise<void> {
    for (const stop of this.running) stop.abort();
  }
}

export function createBoatEnv(id: string, options: BoatEnvOptions): ExecutionEnv {
  return new BoatExecutionEnv(id, options);
}
