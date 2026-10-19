/**
 * The VMs: at most one per sandbox, booted at its first command, closed after `idleMs` with no command
 * running, at most `maxVms` at once. When the limit is reached a new boot closes the VM idle the
 * longest; when every VM is running a command it waits (a queue, in no promised order) until one is
 * idle or closed, at most `queueMs`, then fails with a message that says so. `stop` closes every VM and
 * refuses new boots. A boot that fails is not kept: the next command tries again.
 */

import type { Guest, GuestLauncher, GuestSpec } from "./guest.ts";

/** What the pool reports (a logger's subset). Never given a secret's value. */
export interface PoolLog {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface PoolOptions {
  launcher: GuestLauncher;
  maxVms: number;
  idleMs: number;
  queueMs: number;
  log: PoolLog;
  /** Current values of the configured secrets, read at each use (`undefined`: not set). */
  secrets(): Promise<Record<string, string | undefined>>;
}

/** Why a command found no VM: the pool's own words, for the error the command gets. */
export class PoolError extends Error {
  constructor(
    readonly reason: "boot" | "busy" | "stopped" | "aborted",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** `promise`, or a `PoolError` as soon as `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new PoolError("aborted", "the command was cancelled before its VM was ready"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** One sandbox's VM slot. */
export class Slot {
  /** The VM, booting or booted; `undefined` when none. */
  guest: Promise<Guest> | undefined;
  /** Commands holding the VM (booting counts). */
  busy = 0;
  lastUsed = 0;
  idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly name: string,
    /** The spec of its next boot (mounts, network, secrets as they are then). */
    readonly spec: (secrets: Record<string, string | undefined>) => GuestSpec,
  ) {}
}

export class Pool {
  private readonly slots = new Set<Slot>();
  private waiters = new Set<() => void>();
  private stopped = false;

  constructor(private readonly options: PoolOptions) {}

  /** How many VMs are booting or booted. */
  get live(): number {
    let count = 0;
    for (const slot of this.slots) if (slot.guest !== undefined) count++;
    return count;
  }

  /**
   * Runs `work` on `slot`'s VM, booting it first when needed; the VM is held (never closed for idleness
   * nor evicted) until `work` settles. Throws a `PoolError` when no VM can be had.
   */
  async use<T>(slot: Slot, signal: AbortSignal | undefined, work: (guest: Guest) => Promise<T>): Promise<T> {
    const guest = await this.acquire(slot, signal);
    try {
      return await work(guest);
    } finally {
      this.release(slot);
    }
  }

  /**
   * Closes `slot`'s VM when it is still `guest`: it failed under a command (QEMU died), so the next
   * command boots a new one rather than fail on it until it idles out.
   */
  async discard(slot: Slot, guest: Guest): Promise<void> {
    if (slot.guest === undefined || (await slot.guest.catch(() => undefined)) !== guest) return;
    this.options.log.warn("execution-gondolin: a VM failed under a command; the next command starts a new one", { sandbox: slot.name });
    await this.close(slot);
  }

  /** Closes every VM and refuses new ones. Commands running in them end (their VM is gone). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wake();
    const closing: Promise<void>[] = [];
    for (const slot of this.slots) closing.push(this.close(slot));
    await Promise.all(closing);
  }

  private async acquire(slot: Slot, signal: AbortSignal | undefined): Promise<Guest> {
    const deadline = Date.now() + this.options.queueMs;
    for (;;) {
      if (this.stopped) throw new PoolError("stopped", "execution-gondolin is stopped: no VM can start");
      if (signal?.aborted === true) throw new PoolError("aborted", "the command was cancelled before its VM was ready");
      if (slot.guest === undefined && this.live >= this.options.maxVms) {
        const victim = this.idlest();
        if (victim !== undefined) {
          this.options.log.info("execution-gondolin: closing the VM idle the longest, for another sandbox", { closed: victim.name, for: slot.name });
          void this.close(victim);
        }
      }
      if (slot.guest !== undefined || this.live < this.options.maxVms) break;
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new PoolError(
          "busy",
          `execution-gondolin: all ${this.options.maxVms} VMs (maxVms) are running commands, and none was free within ${this.options.queueMs / 1000} s (queueSeconds): try again later, or raise maxVms`,
        );
      }
      await this.waitForChange(left, signal);
    }

    if (slot.idleTimer !== undefined) clearTimeout(slot.idleTimer);
    slot.idleTimer = undefined;
    slot.busy++;
    if (slot.guest === undefined) this.boot(slot);
    try {
      // The boot goes on when the call is cancelled: the VM serves the sandbox's next command.
      const guest = await abortable(slot.guest as Promise<Guest>, signal);
      guest.refreshSecrets(await this.options.secrets());
      return guest;
    } catch (error) {
      this.release(slot);
      if (error instanceof PoolError) throw error;
      throw new PoolError("boot", `execution-gondolin: the VM did not start: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  private boot(slot: Slot): void {
    this.slots.add(slot);
    const started = Date.now();
    const booting = this.options.secrets().then((secrets) => this.options.launcher.boot(slot.spec(secrets)));
    slot.guest = booting;
    booting.then(
      () => {
        // Closed while booting (stopped, evicted): `close` closes it once it is up.
        if (slot.guest === booting) this.options.log.info("execution-gondolin: VM started", { sandbox: slot.name, ms: Date.now() - started });
      },
      (error: unknown) => {
        if (slot.guest === booting) slot.guest = undefined;
        this.options.log.warn("execution-gondolin: VM failed to start", { sandbox: slot.name, error: error instanceof Error ? error.message : String(error) });
        this.wake();
      },
    );
  }

  private release(slot: Slot): void {
    slot.busy--;
    slot.lastUsed = Date.now();
    if (slot.busy === 0 && slot.guest !== undefined && !this.stopped) {
      slot.idleTimer = setTimeout(() => {
        slot.idleTimer = undefined;
        if (slot.busy === 0) {
          this.options.log.info("execution-gondolin: closing an idle VM", { sandbox: slot.name });
          void this.close(slot);
        }
      }, this.options.idleMs);
      // An idle VM never keeps the process alive.
      (slot.idleTimer as { unref?: () => void }).unref?.();
    }
    this.wake();
  }

  /** The booted VM with no command running and unused the longest, or `undefined`. */
  private idlest(): Slot | undefined {
    let found: Slot | undefined;
    for (const slot of this.slots) {
      if (slot.guest === undefined || slot.busy > 0) continue;
      if (found === undefined || slot.lastUsed < found.lastUsed) found = slot;
    }
    return found;
  }

  /** Closes `slot`'s VM (its files stay on the host); the slot boots again at its next command. */
  private async close(slot: Slot): Promise<void> {
    if (slot.idleTimer !== undefined) clearTimeout(slot.idleTimer);
    slot.idleTimer = undefined;
    const guest = slot.guest;
    slot.guest = undefined;
    this.slots.delete(slot);
    this.wake();
    if (guest === undefined) return;
    try {
      await (await guest).close();
    } catch (error) {
      // A boot that failed was reported where it failed; a close that failed leaves nothing to retry.
      if (!(await guest.then(() => false, () => true))) {
        this.options.log.warn("execution-gondolin: a VM failed to close", { sandbox: slot.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private wake(): void {
    const waiting = this.waiters;
    this.waiters = new Set();
    for (const resolve of waiting) resolve();
  }

  /** Resolves when a VM may have become free, after `ms`, or when `signal` aborts. */
  private waitForChange(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      this.waiters.add(done);
    });
  }
}
