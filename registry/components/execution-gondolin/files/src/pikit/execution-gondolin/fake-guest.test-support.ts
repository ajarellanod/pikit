/**
 * A `GuestLauncher` with no QEMU, for execution-gondolin's tests: it records every boot's spec, every
 * command and every secrets refresh, and answers commands as a test says (`respond`). A command that
 * hangs ends only when killed (exit 137) or when its VM closes (`failed`).
 */

import type { Guest, GuestCommand, GuestExit, GuestLauncher, GuestRun, GuestSpec } from "./guest.ts";

/** What a fake command does: output chunks then an exit, never started, its VM failing, or hang until killed. */
export type FakeBehaviour =
  | { chunks?: readonly ["stdout" | "stderr", string | Uint8Array][]; exitCode?: number }
  | { spawnError: string }
  | { failed: string }
  | { hang: true; chunks?: readonly ["stdout" | "stderr", string | Uint8Array][] };

const encoder = new TextEncoder();

export class FakeGuest implements Guest {
  closed = false;
  readonly commands: GuestCommand[] = [];
  readonly refreshes: Record<string, string | undefined>[] = [];
  kills = 0;
  private readonly hanging = new Set<(exit: GuestExit) => void>();

  constructor(
    readonly spec: GuestSpec,
    private readonly respond: (command: GuestCommand) => FakeBehaviour,
  ) {}

  /** Commands running now. */
  get running(): number {
    return this.hanging.size;
  }

  /** Each `sync`'s directories, sorted. */
  readonly syncs: string[][] = [];

  async sync(directories: readonly string[]): Promise<void> {
    if (directories.length > 0) this.syncs.push([...directories].sort());
  }

  refreshSecrets(values: Readonly<Record<string, string | undefined>>): void {
    this.refreshes.push({ ...values });
  }

  run(command: GuestCommand): GuestRun {
    if (this.closed) throw new Error("fake guest: run after close");
    this.commands.push(command);
    const behaviour = this.respond(command);
    const chunks = "spawnError" in behaviour || "failed" in behaviour ? [] : (behaviour.chunks ?? []);
    let finish: (exit: GuestExit) => void = () => {};
    const exit = new Promise<GuestExit>((resolve) => {
      finish = resolve;
    });
    const end = (ended: GuestExit) => {
      this.hanging.delete(end);
      finish(ended);
    };
    if ("spawnError" in behaviour) finish({ spawnError: behaviour.spawnError });
    else if ("failed" in behaviour) finish({ failed: behaviour.failed });
    else if ("hang" in behaviour) this.hanging.add(end);
    else finish({ exitCode: behaviour.exitCode ?? 0 });
    return {
      output: (async function* () {
        for (const [stream, data] of chunks) {
          await Promise.resolve();
          yield { stream, data: typeof data === "string" ? encoder.encode(data) : data };
        }
        await exit;
      })(),
      exit,
      kill: async () => {
        this.kills++;
        if (this.hanging.has(end)) end({ exitCode: 137 });
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const end of this.hanging) end({ failed: "the VM was closed" });
  }
}

export class FakeLauncher implements GuestLauncher {
  readonly guests: FakeGuest[] = [];
  /** What `check` and `warning` answer. */
  problem: string | undefined;
  slow: string | undefined;
  /** When set, every boot fails with it. */
  bootError: Error | undefined;
  /** When set, a boot waits for it. */
  bootGate: Promise<void> | undefined;
  respond: (command: GuestCommand) => FakeBehaviour = () => ({});

  check(): string | undefined {
    return this.problem;
  }

  warning(): string | undefined {
    return this.slow;
  }

  async boot(spec: GuestSpec): Promise<Guest> {
    await this.bootGate;
    if (this.bootError !== undefined) throw this.bootError;
    const guest = new FakeGuest(spec, (command) => this.respond(command));
    this.guests.push(guest);
    return guest;
  }

  /** The VMs not closed. */
  get live(): FakeGuest[] {
    return this.guests.filter((guest) => !guest.closed);
  }
}
