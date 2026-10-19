/** The types of `rollout.mjs`, plain JavaScript so that Node runs it in a CI deploy without pikit. */

import type { BucketStore, Unsupported } from "./bucket.mjs";
import type { ProjectConfig } from "./celld-config.mjs";

/** What a deploy deployed, and where it answers. */
export interface Deployed {
  /** The deployment's id (`PIKIT_DEPLOYMENT`), as `/health` reports it. */
  version: string;
  /** celld's own version of it: a hash of the bundle and its metadata. */
  celldVersion: string;
  /** The Worker's name in the bucket. */
  worker: string;
  /** Where celld wrote it: `s3://bucket/deploy/<worker>/<celld version>`. */
  location: string;
  /** Where `/health` is asked: the fleet's public URL. */
  url: string;
}

export type Outcome = { kind: "ok" } | { kind: "failing"; detail: string } | { kind: "timeout"; detail: string };

/** The deployment serving before a deploy, as `readPrevious` read it. */
export type Previous = { pointer: { version: string; prefix: string; script_name?: string }; body: string } | { none: true } | { error: string };

/** What `rollBack` did. */
export type Rollback =
  | { kind: "rolled-back"; to: string }
  /** This deploy changed the Durable Object classes: nothing was rolled back. */
  | { kind: "migration"; to: string; mark: string; previous: string }
  /** No earlier deployment in the bucket (a first deploy). */
  | { kind: "none" }
  /** Another deploy landed since: it stays. */
  | { kind: "superseded"; to: string; by: string }
  /** pikit cannot write this bucket (another scheme, no keys here). */
  | { kind: "unsupported"; detail: string }
  | { kind: "failed"; to?: string; detail: string };

/** Runs a command in the project's directory, with `env` over the process's own; with `capture`, resolves with its stdout. */
export type Run = (command: string[], options: { capture: boolean; env?: Record<string, string> }) => Promise<{ code: number; stdout: string }>;

export const FLEET_POINTER: string;
export function namedPointer(worker: string): string;
export function deploymentId(now?: Date): string;
export function esbuildPath(cwd: string, env: Readonly<Record<string, string | undefined>>): string | undefined;
export function celldBin(env: Readonly<Record<string, string | undefined>>): string;
export function runBuild(options: { project: ProjectConfig; run: Run }): Promise<void>;
export function readDeployOutput(stdout: string): { worker: string; celldVersion: string; location: string };
export function readPrevious(store: BucketStore | Unsupported): Promise<Previous>;
export function deploy(options: {
  cwd: string;
  project: ProjectConfig;
  secrets: Readonly<Record<string, string>>;
  deployment: string;
  url: string;
  env: Readonly<Record<string, string | undefined>>;
  run: Run;
}): Promise<Deployed>;
export function probeHealth(
  url: string,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<{ status: number | "unreachable"; ok?: boolean; version?: string | null; error?: string }>;
export const WAIT_MS: number;
export const INTERVAL_MS: number;
export function waitForVersion(deployed: Pick<Deployed, "version" | "url">, options?: { fetch?: typeof fetch | undefined; waitMs?: number | undefined; intervalMs?: number | undefined }): Promise<Outcome>;
export function healthFailure(deployed: Pick<Deployed, "version" | "url">, outcome: Exclude<Outcome, { kind: "ok" }>, waitMs?: number): string;
export function rollBack(options: { store: BucketStore | Unsupported; previous: Previous; deployed: Deployed }): Promise<Rollback>;
export function rollbackLine(deployed: Deployed, result: Rollback): string;
export { readProjectConfig } from "./celld-config.mjs";
