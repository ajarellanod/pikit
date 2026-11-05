/**
 * The boat VMs of this gateway: one per workspace (a chat and an agent), found by its labels, created
 * on first use, stopped when idle, resumed by the next use, deleted after `retentionDays` stopped.
 *
 * - **Found by labels, not kept here.** Each VM carries `pikit-gateway: <gateway>`, `pikit-workspace:
 *   <hex SHA-256 of "<chat key>\n<agent>">` and `pikit-agent: <agent>`: a restarted gateway finds its
 *   VMs again (`GET /sandboxes?label=...`), and adopts the ones it left running (stopped once idle).
 * - **In use** is a file operation or a command in flight (`busy`): such a VM is never stopped,
 *   evicted or deleted. A use that arrives while the VM stops (or is being deleted) waits for that,
 *   then resumes it (or gets a new one). Each check and the mark of the change that follows it are one
 *   synchronous step: never a stop during a command.
 * - **Idle**: no use for `idleMs` (on the app's clock) and nothing a command left running in the VM
 *   (`probe`: processes carrying the commands' marker). Then it is exported (with `snapshots`) and
 *   stopped: boat keeps its disk, billing stops. The next use resumes it (the time it took is logged).
 * - **Bounded**: at most `maxVms` up at once, every agent's together. A new one stops the VM idle the
 *   longest; when all are in use, the use waits `queueMs`, then fails saying so. A create or a resume
 *   that is not ready within `startMs` fails (`shell_unavailable`), and the next use tries again.
 * - **boat's own auto-stop** (`ttlSeconds`, `autoStopSeconds`) is the safety net: a gateway that died
 *   leaves nothing billed for long. It is pushed forward while a VM is in use.
 * - **Retention**: a VM stopped for `retentionMs` (boat's `stoppedAt`, so it outlives a restart) is
 *   deleted; with `snapshots`, only once its latest state is in `storage.blob` (exported, or resumed
 *   and exported first): the VM is the truth until then.
 */

import type { Clock } from "@pikit/core";
import { type BoatApi, BoatError, READY_STATES, type Sandbox, type Size, STARTING_STATES } from "./api.ts";

export const GATEWAY_LABEL = "pikit-gateway";
export const WORKSPACE_LABEL = "pikit-workspace";
export const AGENT_LABEL = "pikit-agent";

/** What a VM is made with: its size and, optionally, a saved snapshot it starts from. */
export interface Machine {
  size: Size;
  template?: string;
}

export interface VmLog {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** The snapshot steps of a VM's life, with `snapshots` (`index.ts`). */
export interface VmSnapshots {
  /** The latest snapshot's time, or `undefined` when the workspace has none. */
  latest(vm: Vm): Promise<number | undefined>;
  /** Exports the running VM `id`'s workspace; throws when it could not be saved and verified. */
  save(vm: Vm, id: string): Promise<void>;
  /** Restores the workspace's snapshot, if it has one, into the new, running VM `id`. */
  restore(vm: Vm, id: string): Promise<void>;
}

/** A use that could not get a VM: `busy` when all `maxVms` are in use, `unavailable` otherwise. */
export class VmError extends Error {
  constructor(
    readonly code: "busy" | "unavailable" | "aborted",
    message: string,
  ) {
    super(message);
  }
}

export interface VmsOptions {
  api: BoatApi;
  clock: Clock;
  gateway: string;
  maxVms: number;
  queueMs: number;
  idleMs: number;
  startMs: number;
  retentionMs: number;
  autoStopSeconds: number;
  /** The base machine: an adopted VM's until a use resolves its profile. */
  base: Machine;
  /** How often a create or resume is polled until ready (real time). */
  pollMs: number;
  /** Counts the processes a command left running in the VM `id`. */
  probe(id: string): Promise<number>;
  snapshots?: VmSnapshots;
  log: VmLog;
}

export class Vm {
  id: string | undefined;
  /** `running` once ready; `stopped`; `unknown` until looked up (or after a failure). */
  state: "unknown" | "running" | "stopped" = "unknown";
  /** Holds one of the `maxVms`: up, or coming up. */
  slot = false;
  busy = 0;
  lastUse: number;
  extendedAt = 0;
  /** A start, a stop or a deletion in progress: uses wait for it. */
  transition: Promise<void> | undefined;
  transitionKind: "start" | "stop" | "delete" | undefined;

  constructor(
    /** The workspace: hex SHA-256 of `"<chat key>\n<agent>"`. */
    readonly key: string,
    readonly agent: string,
    /** The profile's, as last resolved (an adopted VM's is the base until then). */
    public machine: Machine,
    now: number,
  ) {
    this.lastUse = now;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Vms {
  readonly all = new Map<string, Vm>();
  private waiters = new Set<() => void>();
  private closed = false;

  constructor(private readonly options: VmsOptions) {}

  /** The VM record of workspace `key` (made on first ask; nothing is called). */
  vm(key: string, agent: string, machine: Machine): Vm {
    let vm = this.all.get(key);
    if (vm === undefined) {
      vm = new Vm(key, agent, machine, this.options.clock.now());
      this.all.set(key, vm);
    }
    vm.machine = machine;
    return vm;
  }

  /** Runs `work` on the VM, up: in use from the call to its end. */
  async use<T>(vm: Vm, signal: AbortSignal | undefined, work: (id: string) => Promise<T>): Promise<T> {
    vm.busy++;
    vm.lastUse = this.options.clock.now();
    try {
      await this.up(vm, signal);
      return await work(vm.id as string);
    } finally {
      vm.busy--;
      vm.lastUse = this.options.clock.now();
      this.notify();
    }
  }

  private notify(): void {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  private begin(vm: Vm, kind: "start" | "stop" | "delete", run: () => Promise<void>): Promise<void> {
    const transition = run().finally(() => {
      if (vm.transition === transition) {
        vm.transition = undefined;
        vm.transitionKind = undefined;
      }
      this.notify();
    });
    vm.transition = transition;
    vm.transitionKind = kind;
    transition.catch(() => {});
    return transition;
  }

  private async up(vm: Vm, signal: AbortSignal | undefined): Promise<void> {
    while (vm.state !== "running") {
      if (this.closed) throw new VmError("unavailable", "execution-boat is stopping");
      if (signal?.aborted === true) throw new VmError("aborted", "cancelled");
      if (vm.transition === undefined) {
        await this.begin(vm, "start", () => this.start(vm, signal));
        return;
      }
      await vm.transition.catch(() => {});
    }
  }

  private running(): number {
    let count = 0;
    for (const vm of this.all.values()) if (vm.slot) count++;
    return count;
  }

  /** Takes one of the `maxVms` for `vm`: free, or freed by stopping the idlest, or waited for. */
  private async reserve(vm: Vm, signal: AbortSignal | undefined): Promise<void> {
    const deadline = Date.now() + this.options.queueMs;
    for (;;) {
      if (vm.slot || this.running() < this.options.maxVms) {
        vm.slot = true;
        return;
      }
      let idlest: Vm | undefined;
      for (const other of this.all.values()) {
        if (other === vm || !other.slot || other.busy > 0 || other.transition !== undefined || other.state !== "running") continue;
        if (idlest === undefined || other.lastUse < idlest.lastUse) idlest = other;
      }
      if (idlest !== undefined) {
        await this.stop(idlest, "to make room (maxVms)").catch(() => {});
        continue;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new VmError("busy", `execution-boat: all ${this.options.maxVms} VMs (maxVms) are in use: none freed within ${this.options.queueMs / 1000} s (queueSeconds); raise maxVms or queueSeconds`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        this.waiters.add(wake);
        signal?.addEventListener("abort", wake, { once: true });
      });
      if (signal?.aborted === true) throw new VmError("aborted", "cancelled");
    }
  }

  /** Brings the VM up: found (resumed if stopped) or created (and restored, with `snapshots`). */
  private async start(vm: Vm, signal: AbortSignal | undefined): Promise<void> {
    await this.reserve(vm, signal);
    const { api } = this.options;
    try {
      let sandbox = vm.id === undefined ? await this.find(vm.key, signal) : await api.get(vm.id, signal);
      if (sandbox !== undefined && (sandbox.state === "cancelled" || sandbox.labels[GATEWAY_LABEL] !== this.options.gateway)) sandbox = undefined;
      const began = Date.now();
      if (sandbox === undefined) {
        const created = await api.create(
          {
            type: vm.machine.size,
            ttlSeconds: this.options.autoStopSeconds,
            labels: { [GATEWAY_LABEL]: this.options.gateway, [WORKSPACE_LABEL]: vm.key, [AGENT_LABEL]: vm.agent },
            name: `pikit-${vm.agent}-${vm.key.slice(0, 12)}`.slice(0, 120),
            ...(vm.machine.template !== undefined && { from: vm.machine.template }),
            idempotencyKey: crypto.randomUUID(),
          },
          signal,
        );
        vm.id = created.id;
        await this.ready(created.id, signal);
        this.options.log.info("execution-boat: VM created", { agent: vm.agent, size: vm.machine.size, ...(vm.machine.template !== undefined && { template: vm.machine.template }), ms: Date.now() - began });
        if (this.options.snapshots !== undefined) {
          try {
            await this.options.snapshots.restore(vm, created.id);
          } catch (error) {
            // An empty VM must never replace the snapshot: it goes, and the use fails.
            await api.remove(created.id).catch(() => {});
            vm.id = undefined;
            throw new VmError("unavailable", `execution-boat: the workspace's snapshot could not be restored, so no VM was kept: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } else {
        vm.id = sandbox.id;
        if (!READY_STATES.has(sandbox.state)) {
          if (sandbox.state === "archiving") sandbox = await this.settle(sandbox.id, signal);
          if (sandbox.state === "archived" || sandbox.state === "error") {
            await api.resume(sandbox.id, { type: vm.machine.size, ttlSeconds: this.options.autoStopSeconds }, signal);
          }
          await this.ready(sandbox.id, signal);
          this.options.log.info("execution-boat: VM resumed", { agent: vm.agent, ms: Date.now() - began });
        }
      }
      vm.state = "running";
      vm.extendedAt = this.options.clock.now();
    } catch (error) {
      vm.slot = false;
      if (vm.state !== "stopped") vm.state = "unknown";
      if (error instanceof VmError) throw error;
      if (error instanceof BoatError && error.code === "aborted") throw new VmError("aborted", "cancelled");
      throw new VmError("unavailable", `execution-boat: the VM could not be brought up: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async find(key: string, signal: AbortSignal | undefined): Promise<Sandbox | undefined> {
    const found = await this.options.api.list({ [GATEWAY_LABEL]: this.options.gateway, [WORKSPACE_LABEL]: key }, signal);
    const live = found.filter((sandbox) => sandbox.state !== "cancelled");
    live.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    return live[0];
  }

  /** Waits until `id` is past `archiving`. */
  private async settle(id: string, signal: AbortSignal | undefined): Promise<Sandbox> {
    const deadline = Date.now() + this.options.startMs;
    for (;;) {
      const sandbox = await this.options.api.get(id, signal);
      if (sandbox === undefined) throw new VmError("unavailable", "execution-boat: the VM disappeared while it stopped");
      if (sandbox.state !== "archiving") return sandbox;
      if (Date.now() >= deadline) throw new VmError("unavailable", `execution-boat: the VM was still stopping after ${this.options.startMs / 1000} s (startSeconds)`);
      await sleep(this.options.pollMs);
    }
  }

  /** Waits until `id` serves commands, at most `startMs`. */
  private async ready(id: string, signal: AbortSignal | undefined): Promise<void> {
    const deadline = Date.now() + this.options.startMs;
    for (;;) {
      const sandbox = await this.options.api.get(id, signal);
      if (sandbox === undefined) throw new VmError("unavailable", "execution-boat: the VM disappeared while it started");
      if (READY_STATES.has(sandbox.state)) return;
      if (!STARTING_STATES.has(sandbox.state) && sandbox.state !== "archived" && sandbox.state !== "archiving") {
        throw new VmError("unavailable", `execution-boat: the VM is ${sandbox.state}${sandbox.error === undefined ? "" : `: ${this.options.api.redact(sandbox.error).slice(0, 200)}`}`);
      }
      if (Date.now() >= deadline) throw new VmError("unavailable", `execution-boat: the VM was not ready within ${this.options.startMs / 1000} s (startSeconds)`);
      if (signal?.aborted === true) throw new VmError("aborted", "cancelled");
      await sleep(this.options.pollMs);
    }
  }

  /** Exports (with `snapshots`) and stops a running VM nobody uses; marked at once, so no use starts on it meanwhile. */
  stop(vm: Vm, why: string): Promise<void> {
    if (vm.busy > 0 || vm.transition !== undefined || vm.state !== "running" || vm.id === undefined) return Promise.resolve();
    const id = vm.id;
    return this.begin(vm, "stop", async () => {
      if (this.options.snapshots !== undefined) {
        try {
          await this.options.snapshots.save(vm, id);
        } catch (error) {
          // Stopped anyway: boat keeps the disk, and retention exports it before any deletion.
          this.options.log.warn("execution-boat: the workspace could not be exported before its VM stopped (kept in the VM)", { agent: vm.agent, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      try {
        await this.options.api.stop(id);
      } catch (error) {
        this.options.log.warn("execution-boat: the VM could not be stopped (it stays up; tried again when idle)", { agent: vm.agent, reason: error instanceof Error ? error.message : String(error) });
        return;
      }
      vm.state = "stopped";
      vm.slot = false;
      this.options.log.info("execution-boat: VM stopped", { agent: vm.agent, why });
    });
  }

  /** The idle check: stops VMs unused for `idleMs` with nothing left running; keeps boat's auto-stop ahead of the busy ones. */
  async idleTick(): Promise<void> {
    const now = this.options.clock.now();
    for (const vm of [...this.all.values()]) {
      if (vm.state !== "running" || vm.id === undefined || vm.transition !== undefined) continue;
      const id = vm.id;
      const idle = vm.busy === 0 && now - vm.lastUse >= this.options.idleMs;
      let keep = !idle;
      if (idle) {
        const seen = vm.lastUse;
        let left = 0;
        try {
          left = await this.options.probe(id);
        } catch (error) {
          // Unknown is not idle: tried again at the next tick.
          this.options.log.warn("execution-boat: could not check the VM for processes left running; not stopped", { agent: vm.agent, reason: error instanceof Error ? error.message : String(error) });
          continue;
        }
        if (left > 0) {
          keep = true;
          this.options.log.debug("execution-boat: VM idle but a command left processes running; kept", { agent: vm.agent, processes: left });
        } else if (vm.busy === 0 && vm.lastUse === seen) {
          await this.stop(vm, "idle");
          continue;
        }
      }
      if (keep && now - vm.extendedAt >= (this.options.autoStopSeconds * 1000) / 2) {
        vm.extendedAt = now;
        await this.options.api.extend(id, this.options.autoStopSeconds).catch((error: unknown) => {
          this.options.log.warn("execution-boat: could not push boat's auto-stop forward", { agent: vm.agent, reason: error instanceof Error ? error.message : String(error) });
        });
      }
    }
  }

  /**
   * The retention sweep, and adoption: every VM of this gateway is listed; one up that this process
   * does not hold is adopted (stopped once idle), one stopped for `retentionMs` is deleted, never one
   * in use, and with `snapshots` only once its latest state is saved.
   */
  async sweep(): Promise<{ deleted: number; adopted: number }> {
    const { api, clock } = this.options;
    const listed = await api.list({ [GATEWAY_LABEL]: this.options.gateway });
    let deleted = 0;
    let adopted = 0;
    for (const sandbox of listed) {
      const key = sandbox.labels[WORKSPACE_LABEL];
      const agent = sandbox.labels[AGENT_LABEL];
      if (key === undefined || !/^[0-9a-f]{64}$/.test(key) || agent === undefined) continue;
      const known = this.all.get(key);
      if (known !== undefined && known.id !== undefined && known.id !== sandbox.id) continue;
      if (READY_STATES.has(sandbox.state)) {
        if (known !== undefined && known.state === "running") continue;
        if (known !== undefined && known.transition !== undefined) continue;
        const vm = known ?? this.adopt(key, agent);
        vm.id = sandbox.id;
        vm.state = "running";
        vm.slot = true;
        vm.lastUse = clock.now();
        adopted++;
        continue;
      }
      if (sandbox.state !== "archived" || sandbox.stoppedAt === undefined || clock.now() - sandbox.stoppedAt < this.options.retentionMs) continue;
      if (known !== undefined && (known.busy > 0 || known.transition !== undefined || known.state === "running")) continue;
      const vm = known ?? this.adopt(key, agent);
      vm.id = sandbox.id;
      vm.state = "stopped";
      // Marked before any await: a use now waits for the deletion, then gets a new VM.
      const retired = await this.begin(vm, "delete", () => this.retire(vm, sandbox)).then(
        () => true,
        (error: unknown) => {
          this.options.log.warn("execution-boat: a VM past retentionDays was kept", { agent, reason: error instanceof Error ? error.message : String(error) });
          return false;
        },
      );
      if (retired) deleted++;
    }
    if (deleted > 0) this.options.log.info("execution-boat: deleted VMs unused for retentionDays", { vms: deleted });
    this.options.log.debug("execution-boat: retention sweep", { listed: listed.length, deleted, adopted });
    return { deleted, adopted };
  }

  private async retire(vm: Vm, sandbox: Sandbox): Promise<void> {
    const { api, snapshots } = this.options;
    if (snapshots !== undefined) {
      const latest = await snapshots.latest(vm);
      // Saved after this VM last came up (created, or resumed: boat's `hydratedAt`): nothing newer is in it.
      const since = Math.max(sandbox.createdAt ?? Number.POSITIVE_INFINITY, sandbox.hydratedAt ?? 0);
      if (latest === undefined || latest < since) {
        // Its own size: an adopted VM's profile is not known here.
        await api.resume(sandbox.id, { ttlSeconds: this.options.autoStopSeconds });
        await this.ready(sandbox.id, undefined);
        try {
          await snapshots.save(vm, sandbox.id);
        } catch (error) {
          await api.stop(sandbox.id).catch(() => {});
          throw new Error(`its workspace could not be exported, so it stays: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    await api.remove(sandbox.id);
    // The record stays: a use waiting for this deletion gets a new VM through it, never a second record.
    vm.id = undefined;
    vm.state = "unknown";
    vm.slot = false;
  }

  /** A record for a VM this process did not make (found by the sweep): the base machine until a use resolves it. */
  private adopt(key: string, agent: string): Vm {
    const vm = new Vm(key, agent, this.options.base, this.options.clock.now());
    this.all.set(key, vm);
    return vm;
  }

  /** Stops waiting and refuses new uses; VMs stay as they are (stopped once idle by the next gateway, or by boat's auto-stop). */
  close(): void {
    this.closed = true;
    this.notify();
  }
}
