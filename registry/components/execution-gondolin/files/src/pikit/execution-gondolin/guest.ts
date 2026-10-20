/**
 * What execution-gondolin asks of a micro-VM: boot one with mounts, a network policy and secrets, run
 * commands in it, close it. `gondolin.ts` is the real one (Gondolin over QEMU); the tests use a fake
 * (`fake-guest.test-support.ts`) to drive the pool and the environment without QEMU.
 */

/** A secret the guest may use: `$name` holds a placeholder, which the host replaces in requests to `hosts` only. */
export type GuestSecret = { name: string; hosts: readonly string[]; value: string };

/**
 * Where the guest reaches the proposals repository: a host that exists only in the guest's network, its
 * requests answered by the host process itself (`GuestProposals.serve`), never sent anywhere.
 */
export const PROPOSALS_HOST = "proposals.pikit.internal";
export const PROPOSALS_URL = `http://${PROPOSALS_HOST}/project.git`;

/**
 * The proposals repository (`proposals.remote()`, a `path` remote), read when it is used: at boot, for
 * the guest's git (`file://<path>` is `PROPOSALS_URL` there), and at each request to `PROPOSALS_HOST`.
 * `undefined` while there is none (not set up yet, or not a repository on this machine).
 */
export interface GuestProposals {
  remote(): Promise<{ path: string; serve(request: Request): Promise<Response> } | undefined>;
}

export interface GuestSpec {
  /** The VM's label in `gondolin list` (no secret, no host path). */
  label: string;
  /** Guest path to host directory: the guest reads and writes the host's files there (Gondolin's `RealFSProvider`). */
  mounts: Readonly<Record<string, string>>;
  /** The hosts the guest may reach over HTTP and HTTPS: none when empty. */
  allowedHosts: readonly string[];
  /** The secrets set at boot. One not set then is left out until the next boot. */
  secrets: readonly GuestSecret[];
  /** QEMU memory size (`"1G"`) and CPU count. */
  memory: string;
  cpus: number;
  /**
   * Alpine packages added to Gondolin's image: once, with the Alpine mirror the only host that boot
   * reaches, then kept as a checkpoint in `imageDir` that every VM starts from. None: the image as is.
   */
  packages: readonly string[];
  imageDir: string;
  /** The proposals repository, when `proposals` is installed. */
  proposals?: GuestProposals;
}

export interface GuestCommand {
  /** A shell string (run by the guest's bash, else sh), or an argv, run with its arguments unparsed. Never empty. */
  command: string | readonly string[];
  /** Absolute guest path to start in. */
  cwd: string;
  /** Variables added to the guest's own (`inheritEnv`), or the only ones (`!inheritEnv`). */
  env: Readonly<Record<string, string>>;
  inheritEnv: boolean;
}

/** How a command ended: its exit code, it never started (no such directory or program), or the VM failed under it. */
export type GuestExit = { exitCode: number } | { spawnError: string } | { failed: string };

export interface GuestRun {
  /** Raw output chunks as they come, each with its stream. Ends when the command ended. */
  output: AsyncIterable<{ stream: "stdout" | "stderr"; data: Uint8Array }>;
  /** Settles once the command ended; never rejects. */
  exit: Promise<GuestExit>;
  /** Stops the command and every process it started. Resolves when that is done or given up (bounded). */
  kill(): Promise<void>;
}

export interface Guest {
  run(command: GuestCommand): GuestRun;
  /**
   * Makes the guest see what the host changed in `directories` (guest paths) since it last looked:
   * Gondolin's mount caches entries and attributes (about a second, in the guest) and directory listings
   * (five seconds and more, in the host), and only the guest's own changes clear them. Best effort,
   * never throws.
   */
  sync(directories: readonly string[]): Promise<void>;
  /**
   * The secrets' current values, read at each use: a changed value replaces the one sent from then on
   * (requests that carry the old one are refused); one no longer set is removed until the next boot.
   */
  refreshSecrets(values: Readonly<Record<string, string | undefined>>): void;
  close(): Promise<void>;
}

export interface GuestLauncher {
  /** Why no VM can boot on this machine (no QEMU), or `undefined`. Checked at start. */
  check(): string | undefined;
  /** What makes VMs slow here (no KVM on Linux), or `undefined`: a warning at start, never a refusal. */
  warning(): string | undefined;
  boot(spec: GuestSpec): Promise<Guest>;
}
