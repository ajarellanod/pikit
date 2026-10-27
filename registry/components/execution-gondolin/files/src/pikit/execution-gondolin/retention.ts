/**
 * Retention (`retentionDays`): a chat's sandboxes, every agent's in it (`<root>/chats/<chat>/`, and
 * their temporary files), are deleted once nothing has worked in them for that many days. The
 * workspaces of `workspace: "agent"` (`<root>/agents/`) and `execution`'s own (`default`) are never
 * looked at: they are an agent's long-lived files.
 *
 * - **Used** means resolved: the runtime resolves the workspace for every tool call (a command, a file
 *   read or written), and execution-serve for every request of a sandbox. `use` notes it at once in
 *   memory, and in a marker, `<root>/.execution-gondolin-used/<chat>`, holding the time on the app's
 *   clock: written at most once an hour per chat, it outlives a restart, is out of every guest's
 *   reach (a guest could change its directory's times), and is the app's clock, not the
 *   filesystem's. A chat with no marker (made before retention was set) starts its count when a
 *   sweep first sees it.
 * - **Swept** at start and every hour on the app's clock (`start`; `stop` ends it, waiting for a
 *   sweep in progress).
 * - **Never in use.** A chat is retired only when this process has not used it within the period and
 *   none of its sandboxes is `live` (a VM up, a command or a file operation running). That check and
 *   the retirement's mark are one synchronous step, and `use` notes its use and reads the mark in one
 *   too: so a use either comes first (the chat is kept) or waits for the retirement, which moves the
 *   directories away (a rename), and then gets a fresh empty workspace. Never a half-deleted one.
 * - **Moved, then deleted**: renamed into `<root>/.execution-gondolin-tmp/retired/`, measured and
 *   removed there, out of the way of any use. That directory is emptied at start too, so a crash in
 *   the middle of a removal leaves nothing behind.
 * - **Logged** as counts and bytes: how many chats, how many bytes; never a chat's key or a file's name.
 *
 * The live state is this process's: two processes sharing a `root` would not see each other's uses
 * within the hour a marker may lag.
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "@pikit/core";

const SECOND = 1_000;
export const HOUR = 3_600 * SECOND;
export const DAY = 24 * HOUR;

/** A chat's directory: the hex SHA-256 of its key. Anything else under `chats/` is not a chat's, and stays. */
const CHAT = /^[0-9a-f]{64}$/;

export interface RetentionLog {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface RetentionOptions {
  /** The chats' directories (`<root>/chats`), each holding its agents' workspaces. */
  chats: string;
  /** Their temporary directories (`<root>/.execution-gondolin-tmp/chats`). */
  tmp: string;
  /** Where each chat's marker is (`<root>/.execution-gondolin-used`). */
  markers: string;
  /** Where a retired chat's directories go before they are removed: on the same filesystem as `chats` and `tmp`. */
  trash: string;
  days: number;
  clock: Clock;
  /** Whether a sandbox of `chat` (its directory's name) is in use now: a VM up, a command or a file operation running. */
  live(chat: string): boolean;
  log: RetentionLog;
}

/** An error's code (`ENOENT`), or its message when it has none: never a path inside a workspace. */
const reason = (error: unknown) =>
  typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : error instanceof Error ? error.message : String(error);

const missing = (error: unknown) => (error as { code?: string })?.code === "ENOENT";

/** The bytes of the files under `path` (itself included); links are counted as themselves, never followed. */
async function sizeOf(path: string): Promise<number> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined) return 0;
  if (!info.isDirectory()) return info.size;
  let bytes = 0;
  for (const name of await readdir(path).catch(() => [])) bytes += await sizeOf(join(path, name));
  return bytes;
}

export class Retention {
  /** The last use of each chat in this process, on the app's clock. */
  private readonly used = new Map<string, number>();
  /** When this process last wrote each chat's marker. */
  private readonly marked = new Map<string, number>();
  /** The chats being retired: a use waits for the move. */
  private readonly retiring = new Map<string, Promise<void>>();
  private stopped = false;
  private wake: () => void = () => {};
  private loop: Promise<void> | undefined;

  constructor(private readonly options: RetentionOptions) {}

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
      this.options.log.warn("execution-gondolin: retention could not note a chat's use", { error: reason(error) });
    }
  }

  private async write(chat: string, at: number): Promise<void> {
    await mkdir(this.options.markers, { recursive: true });
    await writeFile(join(this.options.markers, chat), String(at));
  }

  /** The time in `chat`'s marker, or `undefined` when it has none (or one that holds no time). */
  private async markedAt(chat: string): Promise<number | undefined> {
    try {
      const at = Number(await readFile(join(this.options.markers, chat), "utf8"));
      return Number.isFinite(at) && at > 0 ? at : undefined;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  /** Retires every chat unused for the period and not in use. */
  async sweep(): Promise<{ chats: number; bytes: number }> {
    const { clock, days, log } = this.options;
    const cutoff = clock.now() - days * DAY;
    // What memory holds is only needed while it is recent.
    for (const [chat, at] of this.used) if (at <= cutoff) this.used.delete(chat);
    for (const [chat, at] of this.marked) if (clock.now() - at >= HOUR) this.marked.delete(chat);
    let names: string[];
    try {
      names = await readdir(this.options.chats);
    } catch (error) {
      if (!missing(error)) throw error;
      names = [];
    }
    const swept = { chats: 0, bytes: 0 };
    for (const chat of names) {
      if (this.stopped) break;
      if (!CHAT.test(chat)) continue;
      try {
        // A link or a file in `chats/` is no chat's directory: left alone.
        if (!(await lstat(join(this.options.chats, chat))).isDirectory()) continue;
        const at = await this.markedAt(chat);
        if (at === undefined) {
          // Never noted (made before retention was set): its count starts now.
          await this.write(chat, clock.now());
          continue;
        }
        if (at > cutoff) continue;
        const retired = this.retire(chat, cutoff);
        if (retired === undefined) continue;
        swept.bytes += await retired;
        swept.chats++;
      } catch (error) {
        if (missing(error)) continue;
        log.warn("execution-gondolin: retention could not delete a chat's sandboxes; it tries again at the next sweep", { error: reason(error) });
      }
    }
    log.debug("execution-gondolin: retention swept", swept);
    if (swept.chats > 0) log.info(`execution-gondolin: deleted the sandboxes of chats unused for ${days} days (retentionDays)`, swept);
    return swept;
  }

  /**
   * Retires `chat` unless it was used after `cutoff` or is in use: checked and marked in one
   * synchronous step, so no use starts between the two. Resolves with the bytes removed;
   * `undefined` when it is kept.
   */
  retire(chat: string, cutoff: number): Promise<number> | undefined {
    if ((this.used.get(chat) ?? Number.NEGATIVE_INFINITY) > cutoff || this.retiring.has(chat) || this.options.live(chat)) return undefined;
    const moved = this.move(chat);
    const gate = moved.then(
      () => undefined,
      () => undefined,
    );
    this.retiring.set(chat, gate);
    return moved
      .finally(() => {
        if (this.retiring.get(chat) === gate) this.retiring.delete(chat);
      })
      .then(async (paths) => {
        let bytes = 0;
        for (const path of paths) {
          bytes += await sizeOf(path);
          await rm(path, { recursive: true, force: true });
        }
        return bytes;
      });
  }

  /** Moves the chat's directories into the trash, then forgets its marker: the paths to remove. */
  private async move(chat: string): Promise<string[]> {
    await mkdir(this.options.trash, { recursive: true });
    const paths: string[] = [];
    for (const from of [join(this.options.chats, chat), join(this.options.tmp, chat)]) {
      const to = join(this.options.trash, randomUUID());
      try {
        await rename(from, to);
        paths.push(to);
      } catch (error) {
        // Its temporary directory may never have been made. The workspace not moved: nothing is deleted.
        // Its temporary directory not moved: it stays until the next start empties the temporary area.
        if (!missing(error) && paths.length === 0) throw error;
      }
    }
    // A use waiting for this writes a new marker; without one, the next sweep would start a new count.
    this.marked.delete(chat);
    await rm(join(this.options.markers, chat), { force: true });
    return paths;
  }

  /** Sweeps now, then every hour on the app's clock, until `stop`. */
  start(): void {
    const { clock, log } = this.options;
    this.loop = (async () => {
      let next = clock.now();
      while (!this.stopped) {
        if (clock.now() >= next) {
          await this.sweep().catch((error: unknown) => log.warn("execution-gondolin: retention's sweep failed; it runs again in an hour", { error: reason(error) }));
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
