/**
 * Retention (`retentionDays`): a chat's directories, every agent's (`<root>/<agent>/_chats/<chat>/`),
 * are deleted once nothing has worked in them for that many days. An agent's own directory
 * (`per: "agent"`) and a channel's (`per: "channel"`) are never looked at: only `_chats/`.
 *
 * Everything goes through `execution` (its files), never the host's filesystem directly.
 *
 * - **Used** means resolved: the runtime resolves the workspace for every tool call (a command, a file
 *   read or written), and execution-serve for every request of a sandbox. `use` notes it at once in
 *   memory, and in a marker, `<root>/.workspace-local-used/<chat>`, holding the time on the app's
 *   clock: written at most once an hour per chat, it outlives a restart, and is the app's clock, not
 *   the filesystem's. A chat with no marker (made before retention was set) starts its count when a
 *   sweep first sees it.
 * - **Swept** at start and every hour on the app's clock (`start`; `stop` ends it, waiting for a
 *   sweep in progress).
 * - **Never in use.** A chat is retired only when this process has not used it within the period and
 *   no call of an environment given for it is running (`track`: a command, a file operation). That
 *   check and the retirement's mark are one synchronous step, and `use` notes its use and reads the
 *   mark in one too: so a use either comes first (the chat is kept) or waits for the retirement,
 *   which moves the directories away (a rename), and then gets a fresh empty directory.
 * - **Moved, then deleted**: renamed into `<root>/.workspace-local-retired/`, measured and removed
 *   there, out of the way of any use; what a crash left there is removed at the next sweep.
 * - **Logged** as counts and bytes: how many chats, how many bytes; never a chat's key or a file's name.
 */

import { randomUUID } from "node:crypto";
import type { Clock } from "@pikit/core";
import { BACKGROUND_CONTEXT, type ExecutionEnv, type FileError } from "@pikit/pi-adapter/execution";

const SECOND = 1_000;
export const HOUR = 3_600 * SECOND;
export const DAY = 24 * HOUR;

/** A chat's directory: the hex SHA-256 of its key. Anything else under `_chats/` is not a chat's, and stays. */
const CHAT = /^[0-9a-f]{64}$/;

/** Under `root`: the markers, and where retired directories wait for their removal. Never an agent's name (they start with a letter or `_`). */
export const USED_DIR = ".workspace-local-used";
export const RETIRED_DIR = ".workspace-local-retired";

const ctx = BACKGROUND_CONTEXT;

export interface RetentionLog {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface RetentionOptions {
  /** `execution`, read at each use. */
  env(): ExecutionEnv;
  /** The agents' directories: relative to `execution`'s working directory, or absolute. */
  root: string;
  /** Where an agent's chats' directories are, inside its own (`_chats`). */
  chatsDir: string;
  days: number;
  clock: Clock;
  log: RetentionLog;
}

const notFound = (error: FileError) => error.code === "not_found";

export class Retention {
  /** The last use of each chat in this process, on the app's clock. */
  private readonly used = new Map<string, number>();
  /** When this process last wrote each chat's marker. */
  private readonly marked = new Map<string, number>();
  /** Calls running in an environment given for each chat. */
  private readonly active = new Map<string, number>();
  /** The chats being retired: a use waits for the move. */
  private readonly retiring = new Map<string, Promise<void>>();
  private stopped = false;
  private wake: () => void = () => {};
  private loop: Promise<void> | undefined;

  constructor(private readonly options: RetentionOptions) {}

  private marker(chat: string): string {
    return `${this.options.root}/${USED_DIR}/${chat}`;
  }

  /**
   * Notes that `chat` is used now. Call it before anything awaits, and await it before working in the
   * chat: it resolves once a retirement in progress has moved the old directories away, and the
   * marker is written (at most once an hour).
   */
  use(chat: string): Promise<void> {
    const now = this.options.clock.now();
    this.used.set(chat, now);
    return this.mark(chat, now, this.retiring.get(chat));
  }

  private async mark(chat: string, now: number, retiring: Promise<void> | undefined): Promise<void> {
    await retiring;
    if (now - (this.marked.get(chat) ?? Number.NEGATIVE_INFINITY) < HOUR) return;
    this.marked.set(chat, now);
    try {
      await this.write(chat, now);
    } catch (error) {
      // The use still counts in memory; the next one tries again.
      this.marked.delete(chat);
      this.options.log.warn("workspace-local: retention could not note a chat's use", { error: (error as FileError).code ?? String(error) });
    }
  }

  private async write(chat: string, at: number): Promise<void> {
    const env = this.options.env();
    const made = await env.createDir(`${this.options.root}/${USED_DIR}`, { recursive: true }, ctx);
    if (!made.ok) throw made.error;
    const written = await env.writeFile(this.marker(chat), String(at), ctx);
    if (!written.ok) throw written.error;
  }

  /** The time in `chat`'s marker, or `undefined` when it has none (or one that holds no time). */
  private async markedAt(chat: string): Promise<number | undefined> {
    const read = await this.options.env().readTextFile(this.marker(chat), ctx);
    if (!read.ok) {
      if (notFound(read.error)) return undefined;
      throw read.error;
    }
    const at = Number(read.value);
    return Number.isFinite(at) && at > 0 ? at : undefined;
  }

  /** The directories of `path` (none when it does not exist), by name. */
  private async directories(path: string): Promise<string[]> {
    const listed = await this.options.env().listDir(path, ctx);
    if (!listed.ok) {
      if (notFound(listed.error)) return [];
      throw listed.error;
    }
    return listed.value.filter((entry) => entry.kind === "directory").map((entry) => entry.name);
  }

  /**
   * `env`, each call counted as `chat`'s while it runs (a command until it ends, a file operation):
   * a sweep never retires a chat with one.
   */
  track(chat: string, env: ExecutionEnv): ExecutionEnv {
    const active = this.active;
    const done = () => {
      const left = (active.get(chat) ?? 1) - 1;
      if (left > 0) active.set(chat, left);
      else active.delete(chat);
    };
    return new Proxy(env, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return function (this: unknown, ...args: unknown[]) {
          active.set(chat, (active.get(chat) ?? 0) + 1);
          let result: unknown;
          try {
            result = Reflect.apply(value, this, args);
          } catch (error) {
            done();
            throw error;
          }
          if (result instanceof Promise) return result.finally(done);
          done();
          return result;
        };
      },
    });
  }

  /** Retires every chat unused for the period and not in use. */
  async sweep(): Promise<{ chats: number; bytes: number }> {
    const { clock, days, log, root, chatsDir } = this.options;
    const cutoff = clock.now() - days * DAY;
    // What memory holds is only needed while it is recent.
    for (const [chat, at] of this.used) if (at <= cutoff) this.used.delete(chat);
    for (const [chat, at] of this.marked) if (clock.now() - at >= HOUR) this.marked.delete(chat);
    // What an earlier sweep left behind (a crash during a removal).
    for (const left of await this.directories(`${root}/${RETIRED_DIR}`)) await this.remove(`${root}/${RETIRED_DIR}/${left}`);

    // Each chat's directories, every agent's.
    const chats = new Map<string, string[]>();
    for (const agent of await this.directories(root)) {
      if (agent.startsWith(".")) continue;
      for (const chat of await this.directories(`${root}/${agent}/${chatsDir}`)) {
        if (!CHAT.test(chat)) continue;
        chats.set(chat, [...(chats.get(chat) ?? []), `${root}/${agent}/${chatsDir}/${chat}`]);
      }
    }
    const swept = { chats: 0, bytes: 0 };
    for (const [chat, paths] of chats) {
      if (this.stopped) break;
      try {
        const at = await this.markedAt(chat);
        if (at === undefined) {
          // Never noted (made before retention was set): its count starts now.
          await this.write(chat, clock.now());
          continue;
        }
        if (at > cutoff) continue;
        const retired = this.retire(chat, cutoff, paths);
        if (retired === undefined) continue;
        swept.bytes += await retired;
        swept.chats++;
      } catch (error) {
        log.warn("workspace-local: retention could not delete a chat's directories; it tries again at the next sweep", { error: (error as FileError).code ?? String(error) });
      }
    }
    log.debug("workspace-local: retention swept", swept);
    if (swept.chats > 0) log.info(`workspace-local: deleted the directories of chats unused for ${days} days (retentionDays)`, swept);
    return swept;
  }

  /**
   * Retires `chat` (its directories `paths`) unless it was used after `cutoff` or a call is running in
   * it: checked and marked in one synchronous step, so no use starts between the two. Resolves with
   * the bytes removed; `undefined` when it is kept.
   */
  retire(chat: string, cutoff: number, paths: readonly string[]): Promise<number> | undefined {
    if ((this.used.get(chat) ?? Number.NEGATIVE_INFINITY) > cutoff || this.retiring.has(chat) || this.active.has(chat)) return undefined;
    const moved = this.move(chat, paths);
    const gate = moved.then(
      () => undefined,
      () => undefined,
    );
    this.retiring.set(chat, gate);
    return moved
      .finally(() => {
        if (this.retiring.get(chat) === gate) this.retiring.delete(chat);
      })
      .then(async (retired) => {
        let bytes = 0;
        for (const path of retired) bytes += await this.remove(path);
        return bytes;
      });
  }

  /** Moves the chat's directories into the retired area, then forgets its marker: the paths to remove. */
  private async move(chat: string, paths: readonly string[]): Promise<string[]> {
    const env = this.options.env();
    const trash = `${this.options.root}/${RETIRED_DIR}`;
    const made = await env.createDir(trash, { recursive: true }, ctx);
    if (!made.ok) throw made.error;
    const retired: string[] = [];
    for (const from of paths) {
      const to = `${trash}/${randomUUID()}`;
      const renamed = await env.renameFile(from, to, ctx);
      if (renamed.ok) retired.push(to);
      // Gone meanwhile: nothing to move. Not moved: that directory stays whole, and nothing is deleted when none moved.
      else if (!notFound(renamed.error) && retired.length === 0) throw renamed.error;
    }
    // A use waiting for this writes a new marker; without one, the next sweep would start a new count.
    this.marked.delete(chat);
    await env.remove(this.marker(chat), { force: true }, ctx);
    return retired;
  }

  /** Removes `path`, everything under it: the bytes of its files (links counted as themselves, never followed). */
  private async remove(path: string): Promise<number> {
    const env = this.options.env();
    const size = async (at: string): Promise<number> => {
      const listed = await env.listDir(at, ctx);
      if (!listed.ok) return 0;
      let bytes = 0;
      for (const entry of listed.value) bytes += entry.kind === "directory" ? await size(`${at}/${entry.name}`) : entry.size;
      return bytes;
    };
    const bytes = await size(path);
    const removed = await env.remove(path, { recursive: true, force: true }, ctx);
    if (!removed.ok) throw removed.error;
    return bytes;
  }

  /** Sweeps now, then every hour on the app's clock, until `stop`. */
  start(): void {
    const { clock, log } = this.options;
    this.loop = (async () => {
      let next = clock.now();
      while (!this.stopped) {
        if (clock.now() >= next) {
          await this.sweep().catch((error: unknown) =>
            log.warn("workspace-local: retention's sweep failed; it runs again in an hour", { error: (error as FileError).code ?? String(error) }),
          );
          next = clock.now() + HOUR;
        }
        // Short sleeps: a clock that jumps (a machine that slept) is noticed, and stop is never held up.
        const woken = new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        await Promise.race([woken, clock.sleep(Math.max(0, Math.min(SECOND, next - clock.now())))]);
      }
    })();
  }

  /** Ends the sweeps, after the one in progress stops at its next chat. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wake();
    await this.loop;
  }
}
