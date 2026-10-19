/**
 * pi-durable's `ExecutionEnv` over one sandbox: its files on the host, its commands in its VM.
 *
 * Paths are the guest's: `cwd` is `/workspace`, and every path a method takes or returns is one the
 * guest's shell would use. The file methods never touch the VM: `paths.ts` maps a guest path to the host
 * directory behind its mount (refusing one that leads outside), and pi-durable's own `NodeExecutionEnv`
 * does the work there, so readers, decoding and error codes are Pi's; the host paths in its results and
 * errors are written back as guest paths. Temporary files and spilled output go to `/tmp/pikit`, a
 * second mount, so the tools and the shell see them alike.
 *
 * `exec` runs a command in the sandbox's VM (`pool.ts` boots it on the first one): the output streams
 * to `onOutput` raw chunk by raw chunk, decoded per stream, all of it (`window` is not used: nothing is
 * skipped); past `spill`'s thresholds the whole output is also written to a file in `/tmp/pikit`
 * (`spillPath`, on a timeout or abort error too). A timeout, the call's cancellation or a throwing
 * `onOutput` kills the command and every process it started (`GuestRun.kill`). The VM's boot does not
 * count against `timeout`; the call's cancellation does stop the wait for it.
 *
 * `watch` is `not_supported`. No method throws.
 *
 * Methods read `this.cwd` at each call, so `atCwd` (`@pikit/pi-adapter/execution`) can give an agent
 * another working directory over the same sandbox.
 */

import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import {
  type BinaryReader,
  type Context,
  type DirReader,
  err,
  type ExecutionEnv,
  ExecutionError,
  FileError,
  type FileInfo,
  type FileWatcher,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type ShellSpillOptions,
  StreamDecoder,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
} from "@pikit/pi-adapter/execution";
import { NodeExecutionEnv } from "@pikit/pi-adapter/node";
import type { GuestCommand, GuestExit, GuestRun } from "./guest.ts";
import type { Mounts } from "./paths.ts";
import { type Pool, PoolError, type Slot } from "./pool.ts";

/** Where a sandbox's own files are, in the guest. */
export const WORKSPACE = "/workspace";
/** Where its temporary files and spilled output are, in the guest. */
export const TMP = "/tmp/pikit";

/** The longest timeout `setTimeout` takes, in seconds (pi-durable's limit). */
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
/** A variable name a command can be given: not empty, no `=`, no NUL. */
const VARIABLE = /^[^=\0]+$/;

/** One sandbox: its files (`mounts`; `workspace` and `tmp` the host directories behind `WORKSPACE` and `TMP`) and its VM slot. */
export interface Sandbox {
  /** Unique among sandboxes: the environment's `id`. */
  name: string;
  mounts: Mounts;
  workspace: string;
  tmp: string;
  pool: Pool;
  slot: Slot;
  /** Commands running now, killed by `cleanup`. */
  running: Set<GuestRun>;
}

const abortedFile = (path?: string) => err<never, FileError>(new FileError("aborted", "aborted", path));

/** The whole output past `spill`'s thresholds, in a file: what came before is kept until then. */
class Spill {
  private held: Uint8Array[] = [];
  private bytes = 0;
  private newlines = 0;
  private file: FileHandle | undefined;
  /** The guest path of the file, once there is one. */
  path: string | undefined;

  constructor(
    private readonly options: ShellSpillOptions | undefined,
    private readonly create: () => Promise<{ host: string; guest: string }>,
  ) {}

  async push(chunk: Uint8Array): Promise<void> {
    if (this.options === undefined || chunk.length === 0) return;
    if (this.file !== undefined) {
      await this.file.write(chunk);
      return;
    }
    this.bytes += chunk.length;
    for (let at = chunk.indexOf(0x0a); at !== -1; at = chunk.indexOf(0x0a, at + 1)) this.newlines++;
    const lines = this.newlines + (chunk[chunk.length - 1] === 0x0a ? 0 : 1);
    this.held.push(chunk);
    if (this.bytes <= this.options.afterBytes && lines <= this.options.afterLines) return;
    const created = await this.create();
    this.path = created.guest;
    this.file = await open(created.host, "a");
    for (const held of this.held) await this.file.write(held);
    this.held = [];
  }

  async finish(): Promise<void> {
    await this.file?.close();
  }
}

class GondolinExecutionEnv implements ExecutionEnv {
  cwd = WORKSPACE;

  constructor(
    private readonly sandbox: Sandbox,
    /** pi-durable's own file methods, given host paths only (never `~`, never relative). */
    private readonly host: NodeExecutionEnv,
  ) {}

  get id(): string {
    return `execution-gondolin:${this.sandbox.name}`;
  }

  private guestPath(path: string): string {
    return posix.resolve(this.cwd, path);
  }

  /** `error` with guest paths in its path and message: the host's layout is never shown. */
  private guestError(error: FileError): FileError {
    const mounts = this.sandbox.mounts;
    const path = error.path === undefined ? undefined : (mounts.toGuest(error.path) ?? mounts.hideHost(error.path));
    return new FileError(error.code, mounts.hideHost(error.message), path);
  }

  private guestResult<T>(result: Result<T, FileError>): Result<T, FileError> {
    return result.ok ? result : err(this.guestError(result.error));
  }

  /** `work` on the host path of `path` (links followed as the guest follows them; the last one only with `follow`). */
  private async onHost<T>(
    path: string,
    follow: boolean,
    context: Context,
    work: (host: string, guest: string) => Promise<Result<T, FileError>>,
  ): Promise<Result<T, FileError>> {
    const guest = this.guestPath(path);
    if (context.abortSignal?.aborted === true) return abortedFile(guest);
    const host = await this.sandbox.mounts.toHost(guest, follow);
    if (!host.ok) return host;
    return this.guestResult(await work(host.value, guest));
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    return ok(this.guestPath(path));
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(posix.join(...parts));
  }

  readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.onHost(path, true, context, (host) => this.host.readTextFile(host, context));
  }

  readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    return this.onHost(path, true, context, (host) => this.host.readTextLines(host, options, context));
  }

  readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.onHost(path, true, context, (host) => this.host.readBinaryFile(host, context));
  }

  openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    return this.onHost(path, true, context, async (host) => {
      const opened = await this.host.openTextLineReader(host, context);
      if (!opened.ok) return opened;
      const reader = opened.value;
      return ok({ readLine: async (c: Context) => this.guestResult(await reader.readLine(c)), close: (c: Context) => reader.close(c) });
    });
  }

  openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    // With noFollow the last part stays a link, and Pi's reader refuses it (O_NOFOLLOW).
    return this.onHost(path, options?.noFollow !== true, context, async (host, guest) => {
      const opened = await this.host.openBinaryReader(host, options, context);
      if (!opened.ok) return opened;
      const reader = opened.value;
      return ok({
        info: async (c: Context) => {
          const info = await reader.info(c);
          return info.ok ? ok({ ...info.value, name: posix.basename(guest), path: guest }) : err(this.guestError(info.error));
        },
        read: async (offset: number, length: number, c: Context) => this.guestResult(await reader.read(offset, length, c)),
        scanLines: async (o: { startLine: number; endLine?: number }, c: Context) => this.guestResult(await reader.scanLines(o, c)),
        close: (c: Context) => reader.close(c),
      });
    });
  }

  writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.onHost(path, true, context, (host) => this.host.writeFile(host, content, context));
  }

  appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.onHost(path, true, context, (host) => this.host.appendFile(host, content, context));
  }

  truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    return this.onHost(path, true, context, (host) => this.host.truncateFile(host, size, context));
  }

  flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    return this.onHost(path, true, context, (host) => this.host.flushFile(host, context));
  }

  renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    // Both ends as themselves: renaming a link moves the link.
    return this.onHost(sourcePath, false, context, (source) =>
      this.onHost(destinationPath, false, context, (destination) => this.host.renameFile(source, destination, context)),
    );
  }

  fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.onHost(path, false, context, async (host, guest) => {
      const info = await this.host.fileInfo(host, context);
      return info.ok ? ok({ ...info.value, name: posix.basename(guest), path: guest }) : info;
    });
  }

  listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.onHost(path, true, context, async (host, guest) => {
      const listed = await this.host.listDir(host, context);
      return listed.ok ? ok(listed.value.map((entry) => ({ ...entry, path: posix.join(guest, entry.name) }))) : listed;
    });
  }

  openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    return this.onHost(path, true, context, async (host, guest) => {
      const opened = await this.host.openDirReader(host, context);
      if (!opened.ok) return opened;
      const reader = opened.value;
      return ok({
        next: async (maxEntries: number, c: Context) => {
          const page = await reader.next(maxEntries, c);
          if (!page.ok) return err(this.guestError(page.error));
          return ok({ done: page.value.done, entries: page.value.entries.map((entry) => ({ ...entry, path: posix.join(guest, entry.name) })) });
        },
        close: (c: Context) => reader.close(c),
      });
    });
  }

  /** Not supported: the agent's own tools and commands are what changes these files, and pikit reloads nothing from them. */
  async watch(_targets: readonly WatchTarget[], _onChange: (change: WatchChange) => void, context: Context): Promise<Result<FileWatcher, FileError>> {
    if (context.abortSignal?.aborted === true) return abortedFile();
    return err(new FileError("not_supported", "execution-gondolin does not watch files"));
  }

  canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.onHost(path, true, context, async (host, guest) => {
      const real = await this.host.canonicalPath(host, context);
      if (!real.ok) return real;
      const mapped = this.sandbox.mounts.toGuest(real.value);
      return mapped === undefined ? err(new FileError("permission_denied", `${guest} leads outside this sandbox's files`, guest)) : ok(mapped);
    });
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const info = await this.fileInfo(path, context);
    if (info.ok) return ok(true);
    return info.error.code === "not_found" ? ok(false) : err(info.error);
  }

  createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    return this.onHost(path, true, context, (host) => this.host.createDir(host, options, context));
  }

  remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    // The last part as itself: removing a link removes the link, never what it points to.
    return this.onHost(path, false, context, (host) => this.host.remove(host, options, context));
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    if (context.abortSignal?.aborted === true) return abortedFile(TMP);
    const name = prefix ?? "tmp-";
    if (name.includes("/")) return err(new FileError("invalid", "A temporary name has no /", TMP));
    try {
      await mkdir(this.sandbox.tmp, { recursive: true });
      return ok(`${TMP}/${basename(await mkdtemp(join(this.sandbox.tmp, name)))}`);
    } catch (error) {
      return err(new FileError("unknown", this.sandbox.mounts.hideHost(error instanceof Error ? error.message : String(error)), TMP));
    }
  }

  async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    if (context.abortSignal?.aborted === true) return abortedFile(TMP);
    const created = await this.tempFile(options?.prefix ?? "", options?.suffix ?? "");
    return created.ok ? ok(created.value.guest) : created;
  }

  /** An empty file of its own in `/tmp/pikit`: its host and guest paths. */
  private async tempFile(prefix: string, suffix: string): Promise<Result<{ host: string; guest: string }, FileError>> {
    if (prefix.includes("/") || suffix.includes("/")) return err(new FileError("invalid", "A temporary name has no /", TMP));
    const name = `${prefix}${randomUUID()}${suffix}`;
    try {
      await mkdir(this.sandbox.tmp, { recursive: true });
      const host = join(this.sandbox.tmp, name);
      await writeFile(host, "", { flag: "wx" });
      return ok({ host, guest: `${TMP}/${name}` });
    } catch (error) {
      return err(new FileError("unknown", this.sandbox.mounts.hideHost(error instanceof Error ? error.message : String(error)), TMP));
    }
  }

  async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    const signal = context.abortSignal;
    if (signal?.aborted === true) return err(new ExecutionError("aborted", "aborted"));
    if (typeof command !== "string" && command.length === 0) return err(new ExecutionError("spawn_error", "Empty argv: no program to run"));
    const seconds = options?.timeout;
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
    if (seconds !== undefined && seconds > MAX_TIMEOUT_SECONDS) return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
    const env = { ...options?.env };
    for (const [name, value] of Object.entries(env)) {
      if (!VARIABLE.test(name) || value.includes("\0")) return err(new ExecutionError("spawn_error", `Invalid environment variable: ${JSON.stringify(name)}`));
    }
    const guestCommand: GuestCommand = {
      command,
      cwd: options?.cwd ? this.guestPath(options.cwd) : this.cwd,
      env,
      inheritEnv: options?.inheritEnv ?? true,
    };
    try {
      const { pool, slot } = this.sandbox;
      return await pool.use(slot, signal, async (guest) => {
        const { result, vmFailed } = await this.run(guest.run(guestCommand), options, context);
        if (vmFailed) await pool.discard(slot, guest);
        return result;
      });
    } catch (error) {
      if (error instanceof PoolError) {
        const code = error.reason === "aborted" ? "aborted" : error.reason === "busy" ? "spawn_error" : "shell_unavailable";
        return err(new ExecutionError(code, error.message, error));
      }
      return err(new ExecutionError("unknown", error instanceof Error ? error.message : String(error)));
    }
  }

  /** Streams `run` to `onOutput` and the spill until it ends, its timeout, the call's cancellation or a failed callback. */
  private async run(
    run: GuestRun,
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<{ result: Result<ShellExecResult, ExecutionError>; vmFailed: boolean }> {
    const result = (value: Result<ShellExecResult, ExecutionError>, vmFailed = false) => ({ result: value, vmFailed });
    const signal = context.abortSignal;
    const running = this.sandbox.running;
    running.add(run);
    let settled = false;
    let stopped: "timeout" | "aborted" | undefined;
    let failure: ExecutionError | undefined;
    let interrupt = () => {};
    const interrupted = new Promise<undefined>((resolve) => {
      interrupt = () => resolve(undefined);
    });
    const fail = (error: ExecutionError) => {
      failure ??= error;
      interrupt();
    };

    const decoders = { stdout: new StreamDecoder(), stderr: new StreamDecoder() };
    const emit = (text: string, stream: "stdout" | "stderr") => {
      if (settled || text === "" || options?.onOutput === undefined || failure !== undefined) return;
      try {
        options.onOutput(text, context, { stream });
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        fail(new ExecutionError("callback_error", cause.message, cause));
      }
    };
    const spill = new Spill(options?.spill, async () => {
      const created = await this.tempFile("pi-output-", ".log");
      if (!created.ok) throw created.error;
      return created.value;
    });

    const timer =
      options?.timeout === undefined
        ? undefined
        : setTimeout(() => {
            stopped ??= "timeout";
            interrupt();
          }, options.timeout * 1000);
    const onAbort = () => {
      stopped ??= "aborted";
      interrupt();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();

    const pumped = (async () => {
      for await (const chunk of run.output) {
        if (settled) return;
        emit(decoders[chunk.stream].decode(chunk.data), chunk.stream);
        await spill.push(chunk.data);
      }
      emit(decoders.stdout.decode(), "stdout");
      emit(decoders.stderr.decode(), "stderr");
    })().catch((error: unknown) => {
      if (settled) return;
      const message = error instanceof Error ? error.message : String(error);
      fail(new ExecutionError("unknown", `Failed to preserve complete shell output: ${this.sandbox.mounts.hideHost(message)}`));
    });

    let exit: GuestExit | undefined;
    try {
      exit = await Promise.race([Promise.all([run.exit, pumped]).then(([ended]) => ended), interrupted]);
      if (exit === undefined) await run.kill();
    } finally {
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      running.delete(run);
      await spill.finish().catch(() => undefined);
    }

    if (failure?.code === "callback_error") return result(err(failure));
    if (stopped !== undefined) {
      const error = new ExecutionError(stopped, stopped === "timeout" ? `timeout:${options?.timeout}` : "aborted");
      if (spill.path !== undefined) error.spillPath = spill.path;
      return result(err(error));
    }
    if (failure !== undefined) return result(err(failure));
    if (exit === undefined) return result(err(new ExecutionError("unknown", "the command was interrupted")));
    if ("spawnError" in exit) return result(err(new ExecutionError("spawn_error", exit.spawnError)));
    if ("failed" in exit) return result(err(new ExecutionError("unknown", exit.failed)), true);
    return result(ok({ exitCode: exit.exitCode, ...(spill.path !== undefined && { spillPath: spill.path }) }));
  }

  async cleanup(): Promise<void> {
    // The sandbox's commands still running end; its VM stays for the next ones (the pool closes it when idle).
    await Promise.all([...this.sandbox.running].map((run) => run.kill()));
  }
}

/** The environment of `sandbox`, at `/workspace`. */
export function createSandboxEnv(sandbox: Sandbox): ExecutionEnv {
  return new GondolinExecutionEnv(sandbox, new NodeExecutionEnv({ cwd: WORKSPACE }));
}
