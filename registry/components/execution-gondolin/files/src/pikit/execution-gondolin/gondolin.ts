/**
 * The real `GuestLauncher`: a Gondolin micro-VM (QEMU, Alpine Linux) per boot.
 *
 * - **Files**: each mount is Gondolin's `RealFSProvider` over a host directory, which refuses the
 *   guest's links that lead outside it.
 * - **Network**: `createHttpHooks` with `allowedHosts` exactly as given (an empty list denies every
 *   host: Gondolin answers 403), and each secret as a placeholder in `$NAME`, replaced by the host in
 *   the headers of requests to that secret's hosts only. Gondolin passes only HTTP and TLS, through its
 *   own stack, and blocks private ranges; DNS is synthetic. No SSH, no raw TCP.
 * - **Commands**: each runs under a small launcher (`LAUNCH`) that checks its working directory and,
 *   for an argv, its program (a failure is written to a status file and is a `spawnError`: Gondolin's
 *   own exec cannot tell them from an exit code 127), writes its PID there, and execs it in a session
 *   of its own (`setsid`). `kill` reads that PID and kills the whole process group: Gondolin's abort
 *   only stops waiting, the guest process would go on.
 *
 * Nothing here logs: a secret's value never leaves `createHttpHooks`.
 */

import { createHttpHooks, RealFSProvider, type SecretManager, VM } from "@earendil-works/gondolin";
import type { Guest, GuestCommand, GuestExit, GuestLauncher, GuestRun, GuestSpec } from "./guest.ts";
import { kvmWarning, qemuProblem } from "./qemu.ts";

/** Where the launcher writes each command's status (`cwd`, `program`, or its PID): a tmpfs in the guest. */
const STATUS_DIR = "/run/pikit";

/** At boot: the status directory, the tools the launcher needs, and the shell for string commands. */
const PROBE = [
  `mkdir -p ${STATUS_DIR} || exit 3`,
  "command -v setsid >/dev/null 2>&1 || exit 3",
  "[ -x /usr/bin/env ] || exit 3",
  "if [ -x /bin/bash ]; then echo /bin/bash; else echo /bin/sh; fi",
].join("\n");

/** `sh -c LAUNCH pikit-exec <status file> <cwd> <program to check, or ""> <argv...>` */
const LAUNCH = [
  "f=$1 d=$2 p=$3",
  "shift 3",
  'if ! cd -- "$d" 2>/dev/null; then echo cwd > "$f"; exit 127; fi',
  'if [ -n "$p" ] && ! command -v -- "$p" >/dev/null 2>&1; then echo program > "$f"; exit 127; fi',
  'echo $$ > "$f"',
  'exec setsid "$@"',
].join("\n");

/** `sh -c KILL pikit-kill <status file>`: kills the command's process group once its PID is written (2 s at most). */
const KILL = [
  "f=$1 i=0",
  "while [ $i -lt 40 ]; do",
  '  p=$(cat "$f" 2>/dev/null)',
  "  case $p in",
  "    cwd|program) exit 0 ;;",
  "    ''|*[!0-9]*) ;;",
  '    *) kill -KILL -- "-$p" 2>/dev/null; kill -KILL -- "$p" 2>/dev/null; exit 0 ;;',
  "  esac",
  "  sleep 0.05",
  "  i=$((i+1))",
  "done",
].join("\n");

/** How long `kill` waits for the kill script, then for the command's end, before it stops waiting. */
const KILL_WAIT_MS = 3_000;
const EXIT_WAIT_MS = 1_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

class GondolinGuest implements Guest {
  private commands = 0;
  /** Secrets removed since boot: Gondolin cannot bring one back, the next boot does. */
  private readonly removed = new Set<string>();

  constructor(
    private readonly vm: VM,
    private readonly shell: string,
    private readonly secrets: SecretManager,
    private readonly values: Map<string, string>,
  ) {}

  refreshSecrets(values: Readonly<Record<string, string | undefined>>): void {
    for (const [name, value] of this.values) {
      if (this.removed.has(name)) continue;
      const now = values[name];
      if (now === undefined || now === "") {
        this.secrets.deleteSecret(name);
        this.removed.add(name);
      } else if (now !== value) {
        this.secrets.updateSecret(name, { value: now });
        this.values.set(name, now);
      }
    }
  }

  run(command: GuestCommand): GuestRun {
    const status = `${STATUS_DIR}/exec-${++this.commands}`;
    const [program, ...args] = typeof command.command === "string" ? [this.shell, "-c", command.command] : command.command;
    const check = typeof command.command === "string" ? "" : (program as string);
    const variables = Object.entries(command.env).map(([name, value]) => `${name}=${value}`);
    const tail = command.inheritEnv ? [program as string, ...args] : ["/usr/bin/env", "-i", ...variables, program as string, ...args];
    const controller = new AbortController();
    // With inheritEnv, the variables are added to the VM's own (Gondolin merges them); without, `env -i` clears
    // them and the launcher only needs the command's PATH, to check its program as it will be found.
    const launcherEnv = command.inheritEnv ? { ...command.env } : command.env.PATH === undefined ? {} : { PATH: command.env.PATH };
    const proc = this.vm.exec(["/bin/sh", "-c", LAUNCH, "pikit-exec", status, command.cwd, check, ...tail], {
      env: launcherEnv,
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });

    const exit: Promise<GuestExit> = Promise.resolve(proc).then(
      async (result): Promise<GuestExit> => {
        if (result.exitCode === 127) {
          const why = await this.vm.fs.readFile(status, { encoding: "utf-8" }).then(
            (text) => text.trim(),
            () => "",
          );
          if (why === "cwd") return { spawnError: `Working directory does not exist: ${command.cwd}\nCannot execute bash commands.` };
          if (why === "program") return { spawnError: `${check}: command not found` };
        }
        return { exitCode: result.signal === undefined ? result.exitCode : 128 + result.signal };
      },
      (error: unknown): GuestExit => ({ failed: `the command's VM failed: ${message(error)}` }),
    );

    return {
      output: (async function* () {
        for await (const chunk of proc.output()) yield { stream: chunk.stream, data: chunk.data };
      })(),
      exit,
      kill: async () => {
        await Promise.race([Promise.resolve(this.vm.exec(["/bin/sh", "-c", KILL, "pikit-kill", status])).catch(() => undefined), sleep(KILL_WAIT_MS)]);
        await Promise.race([exit, sleep(EXIT_WAIT_MS)]);
        // Killed, or the VM no longer answers: stop waiting for it either way.
        controller.abort();
      },
    };
  }

  async close(): Promise<void> {
    await this.vm.close();
  }
}

export const gondolinLauncher: GuestLauncher = {
  check: () => qemuProblem(),
  warning: () => kvmWarning(),

  async boot(spec: GuestSpec): Promise<Guest> {
    const { httpHooks, env, secretManager } = createHttpHooks({
      allowedHosts: [...spec.allowedHosts],
      secrets: Object.fromEntries(spec.secrets.map((secret) => [secret.name, { hosts: [...secret.hosts], value: secret.value }])),
    });
    const vm = await VM.create({
      httpHooks,
      env,
      vfs: { mounts: Object.fromEntries(Object.entries(spec.mounts).map(([guest, host]) => [guest, new RealFSProvider(host)])) },
      memory: spec.memory,
      cpus: spec.cpus,
      sessionLabel: spec.label,
    });
    try {
      const probe = await vm.exec(["/bin/sh", "-c", PROBE]);
      if (probe.exitCode !== 0) throw new Error(`the guest image lacks what commands need (mkdir, setsid, /usr/bin/env): ${probe.stderr.trim() || `exit ${probe.exitCode}`}`);
      return new GondolinGuest(vm, probe.stdout.trim(), secretManager, new Map(spec.secrets.map((secret) => [secret.name, secret.value])));
    } catch (error) {
      await vm.close().catch(() => undefined);
      throw error;
    }
  },
};
