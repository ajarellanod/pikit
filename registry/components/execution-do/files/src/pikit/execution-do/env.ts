/**
 * pi-durable's `ExecutionEnv` over the workspace (`files.ts`) and the shell (`shell.ts`): what
 * pi-durable's own `read`, `write`, `edit` and `bash` tools work on, unmodified (`index.ts` provides it
 * as `execution` and `execution.shell`).
 *
 * As pi-durable requires, no method throws: every failure is a `Result`. Changes inside a `.git` are
 * refused as `permission_denied`. What it adds to a plain environment:
 * - **`id`**: the object's files are its own, so each object is its own namespace (`execution-do:<object id>`):
 *   pi-durable serializes `edit` and `write` on one file by `id` and path, and two objects in one
 *   isolate never wait on each other.
 * - **`truncateFile`** cuts or zero-extends a file; **`flushFile`** has nothing to flush (a write is a
 *   committed row of the object's SQL) and answers whether the file is there.
 * - **`exec`** streams the output to `onOutput` and bounds nothing: the Harness keeps what a tool
 *   shows. just-bash runs a command to its end, so the output arrives in one chunk (stdout, then
 *   stderr), once it ended. Past `spill`'s thresholds the whole output is also written to a file under
 *   `/tmp` (`spillPath`). A command stopped by its timeout or the call's cancellation has no output.
 *
 * Methods read `this.cwd` at each call, so `atCwd` (`@pikit/pi-adapter/execution`) can give a
 * conversation another working directory over the same files.
 */

import {
  type Context,
  err,
  type ExecutionEnv,
  ExecutionError,
  FileError,
  type FileErrorCode,
  type FileInfo,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLine,
  type TextLineReader,
} from "@pikit/pi-adapter/execution";
import { type Files, fsError, nameOf, normalize, parentOf, resolvePath } from "./files.ts";
import type { createShell } from "./shell.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CODES: Record<string, FileErrorCode> = {
  ENOENT: "not_found",
  ENOTDIR: "not_directory",
  EISDIR: "is_directory",
  EPERM: "permission_denied",
  EEXIST: "invalid",
  ENOTEMPTY: "invalid",
  EINVAL: "invalid",
};
/** The longest timeout `setTimeout` takes, in seconds (pi-durable's limit). */
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

export interface DurableExecutionEnvOptions {
  /** The files' namespace: `execution-do:<the object's id>`. A function when the id is known only at start. */
  id: string | (() => string);
}

/** Text as lines, remembering whether the last one ended with a newline. */
function linesOf(content: string): TextLine[] {
  const lines = content.split("\n");
  const last = lines.pop() ?? "";
  const out = lines.map((text) => ({ text, terminated: true }));
  if (last !== "") out.push({ text: last, terminated: false });
  return out;
}

/** `work`'s value, or its thrown filesystem error as a `FileError` about `path`; an aborted call does nothing. */
async function attempt<T>(path: string, context: Context, work: () => T | Promise<T>): Promise<Result<T, FileError>> {
  if (context.abortSignal?.aborted === true) return err(new FileError("aborted", "the operation was cancelled", path));
  try {
    return ok(await work());
  } catch (error) {
    const code = (error as { code?: string }).code ?? "";
    return err(new FileError(CODES[code] ?? "unknown", error instanceof Error ? error.message : String(error), path));
  }
}

/** Whether `output` crosses `spill`'s thresholds: more bytes, or more (complete or partial) lines. */
function crosses(output: string, spill: NonNullable<ShellExecOptions["spill"]>): boolean {
  if (output === "") return false;
  const bytes = encoder.encode(output).length;
  let newlines = 0;
  for (let at = output.indexOf("\n"); at !== -1; at = output.indexOf("\n", at + 1)) newlines++;
  const lines = newlines + (output.endsWith("\n") ? 0 : 1);
  return bytes > spill.afterBytes || lines > spill.afterLines;
}

class DurableObjectExecutionEnv implements ExecutionEnv {
  cwd: string;
  /** Names of temporary files and directories, unique within this environment. */
  private temporary = 0;

  constructor(
    private readonly files: Files,
    private readonly shell: ReturnType<typeof createShell>,
    cwd: string,
    private readonly namespace: () => string,
  ) {
    this.cwd = normalize(cwd);
  }

  get id(): string {
    return this.namespace();
  }

  private abs(path: string): string {
    return resolvePath(this.cwd, path);
  }

  private info(path: string): FileInfo {
    const node = this.files.lstat(path);
    if (node === undefined) throw fsError("ENOENT", "lstat", path);
    return { name: nameOf(path), path, kind: node.kind === "dir" ? "directory" : node.kind, size: node.size, mtimeMs: node.mtime };
  }

  private readText(path: string): string {
    return decoder.decode(this.files.read(path));
  }

  /** Changes `path` (absolute) after refusing `.git` and making its directory. */
  private change(path: string, context: Context, write: (target: string) => void): Promise<Result<void, FileError>> {
    const target = this.abs(path);
    return attempt(target, context, () => {
      this.files.refuseGit("open", target);
      this.files.mkdirp(parentOf(target));
      write(target);
    });
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    return ok(this.abs(path));
  }

  /** Relative parts stay relative, as with Node's `path.join`. */
  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    const joined = parts.join("/");
    return ok(joined.startsWith("/") ? normalize(joined) : normalize(joined).slice(1) || ".");
  }

  readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return attempt(this.abs(path), context, () => this.readText(this.abs(path)));
  }

  openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    return attempt(this.abs(path), context, () => {
      const lines = linesOf(this.readText(this.abs(path)));
      let index = 0;
      return { readLine: async () => ok(lines[index++]), close: async () => {} };
    });
  }

  readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    return attempt(this.abs(path), context, () => {
      const lines = linesOf(this.readText(this.abs(path))).map((line) => line.text);
      return options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines);
    });
  }

  readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return attempt(this.abs(path), context, () => this.files.read(this.abs(path)));
  }

  writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.change(path, context, (target) => this.files.write(target, typeof content === "string" ? encoder.encode(content) : content));
  }

  appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.change(path, context, (target) => {
      const before = this.files.lstat(target) === undefined ? new Uint8Array() : this.files.read(target);
      const added = typeof content === "string" ? encoder.encode(content) : content;
      const out = new Uint8Array(before.length + added.length);
      out.set(before);
      out.set(added, before.length);
      this.files.write(target, out);
    });
  }

  truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    const target = this.abs(path);
    if (!Number.isSafeInteger(size) || size < 0) return Promise.resolve(err(new FileError("invalid", "File size must be a non-negative safe integer", target)));
    return attempt(target, context, () => {
      this.files.refuseGit("open", target);
      // Read first: a missing file is not_found (Node opens it r+), a directory is_directory.
      const before = this.files.read(target);
      const out = new Uint8Array(size);
      out.set(before.subarray(0, size));
      this.files.write(target, out);
    });
  }

  flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    const target = this.abs(path);
    return attempt(target, context, () => {
      // Every write is already a committed row of the object's SQL: nothing to flush.
      const node = this.files.stat(target);
      if (node.kind === "dir") throw fsError("EISDIR", "fsync", target);
    });
  }

  renameFile(source: string, destination: string, context: Context): Promise<Result<void, FileError>> {
    return attempt(this.abs(source), context, () => {
      this.files.refuseGit("rename", this.abs(source), this.abs(destination));
      this.files.mkdirp(parentOf(this.abs(destination)));
      this.files.rename(this.abs(source), this.abs(destination));
    });
  }

  fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return attempt(this.abs(path), context, () => this.info(this.abs(path)));
  }

  listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    return attempt(this.abs(path), context, () => {
      const dir = this.abs(path);
      return this.files.list(dir).map((name) => this.info(resolvePath(dir, name)));
    });
  }

  canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return attempt(this.abs(path), context, () => this.files.realpath(this.abs(path)));
  }

  exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    return attempt(this.abs(path), context, () => this.files.lstat(this.abs(path)) !== undefined);
  }

  createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    return attempt(this.abs(path), context, () => {
      this.files.refuseGit("mkdir", this.abs(path));
      if (options?.recursive === false) this.files.mkdir(this.abs(path));
      else this.files.mkdirp(this.abs(path));
    });
  }

  remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    return attempt(this.abs(path), context, () => {
      const target = this.abs(path);
      this.files.refuseGit("rm", target);
      const node = this.files.lstat(target);
      if (node === undefined) {
        if (options?.force === true) return;
        throw fsError("ENOENT", "rm", target);
      }
      if (node.kind === "dir" && options?.recursive !== true) this.files.rmdir(target);
      else this.files.removeTree(target);
    });
  }

  createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return attempt("/tmp", context, () => {
      const path = `/tmp/${prefix ?? "tmp-"}${Date.now()}-${this.temporary++}`;
      this.files.mkdirp(path);
      return path;
    });
  }

  createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    return attempt("/tmp", context, () => {
      this.files.mkdirp("/tmp");
      const path = `/tmp/${options?.prefix ?? ""}${Date.now()}-${this.temporary++}${options?.suffix ?? ""}`;
      this.files.write(path, new Uint8Array());
      return path;
    });
  }

  async exec(command: string, options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    if (context.abortSignal?.aborted === true) return err(new ExecutionError("aborted", "the command was cancelled"));
    const seconds = options?.timeout;
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
    if (seconds !== undefined && seconds > MAX_TIMEOUT_SECONDS) return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
    const cwd = options?.cwd === undefined ? this.cwd : this.abs(options.cwd);
    try {
      if (this.files.stat(cwd).kind !== "dir") throw fsError("ENOTDIR", "chdir", cwd);
    } catch (error) {
      return err(new ExecutionError("spawn_error", `Working directory does not exist: ${cwd}\nCannot execute bash commands.`, error instanceof Error ? error : undefined));
    }

    // A command stops at its timeout or when the call is cancelled (a slice's deadline, `stop`).
    const timeout = seconds === undefined ? undefined : AbortSignal.timeout(seconds * 1_000);
    const signals = [context.abortSignal, timeout].filter((signal): signal is AbortSignal => signal !== undefined);
    const signal = signals.length === 0 ? undefined : AbortSignal.any(signals);
    const stopped = (): Result<never, ExecutionError> | undefined => {
      if (timeout?.aborted === true) return err(new ExecutionError("timeout", `timeout:${seconds}`));
      if (context.abortSignal?.aborted === true) return err(new ExecutionError("aborted", "the command was cancelled"));
      return undefined;
    };

    let result: { stdout: string; stderr: string; exitCode: number };
    try {
      result = await this.shell.exec(command, {
        cwd,
        ...(options?.env !== undefined && { env: options.env }),
        ...(options?.inheritEnv === false && { replaceEnv: true }),
        ...(signal !== undefined && { signal }),
      });
    } catch (error) {
      return stopped() ?? err(new ExecutionError("unknown", error instanceof Error ? error.message : String(error)));
    }
    const cut = stopped();
    if (cut !== undefined) return cut;

    const separator = result.stdout !== "" && result.stderr !== "" && !result.stdout.endsWith("\n") ? "\n" : "";
    const output = `${result.stdout}${separator}${result.stderr}`;
    let spillPath: string | undefined;
    if (options?.spill !== undefined && crosses(output, options.spill)) {
      const created = await this.createTempFile({ prefix: "pi-output-", suffix: ".log" }, context);
      const written = created.ok ? await this.writeFile(created.value, output, context) : created;
      if (!written.ok) return err(new ExecutionError("unknown", `Failed to preserve complete shell output: ${written.error.message}`, written.error));
      spillPath = created.ok ? created.value : undefined;
    }
    if (output !== "" && options?.onOutput !== undefined) {
      try {
        options.onOutput(output, context);
      } catch (error) {
        return err(new ExecutionError("callback_error", error instanceof Error ? error.message : String(error), error instanceof Error ? error : undefined));
      }
    }
    return ok({ exitCode: result.exitCode, ...(spillPath !== undefined && { spillPath }) });
  }

  async cleanup(): Promise<void> {
    // No process outlives a command: a running one ends with its call, whose context is cancelled.
  }
}

/**
 * pi-durable's `ExecutionEnv` over the object's `files` and `shell`, at `cwd` (the component's `root`).
 * One environment serves `execution` and `execution.shell`.
 */
export function createDurableExecutionEnv(files: Files, shell: ReturnType<typeof createShell>, cwd: string, options: DurableExecutionEnvOptions): ExecutionEnv {
  const id = options.id;
  return new DurableObjectExecutionEnv(files, shell, cwd, typeof id === "string" ? () => id : id);
}
