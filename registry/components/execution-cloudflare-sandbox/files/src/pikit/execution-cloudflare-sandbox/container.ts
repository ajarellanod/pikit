/**
 * The container, as this component uses it: Cloudflare's native Container API (`ctx.container` of a
 * Durable Object with a `containers` entry in `wrangler.jsonc`), typed structurally by what is used of
 * it, so the sandbox's logic runs under `bun test` against a fake (`fake-container.test-support.ts`) as
 * well as in workerd. `@cloudflare/sandbox` 1.x has no `getSandbox` any more (0.x had it): a sandbox is a
 * Durable Object that starts and runs its own container.
 *
 * - **Every call has its own deadline** (`within`): past the account's container limit a container may
 *   never start, and a call on it never answer, so no request waits on the platform without bound.
 * - **One helper**, `/usr/local/bin/pikit-sandbox` (`images/pikit-sandbox`, Node): each file operation
 *   is one short process printing one JSON answer (`helper`).
 */

import type { WireError } from "./protocol.ts";

/** What is used of a native `ExecProcess`. */
export interface ContainerProcess {
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exitCode: Promise<number>;
  kill(signal?: number): void;
}

export interface ContainerExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: ReadableStream<Uint8Array>;
  stdout?: "pipe" | "ignore";
  stderr?: "pipe" | "ignore";
}

export interface ContainerStart {
  image: string;
  enableInternet: boolean;
  instance?: string;
  labels?: Record<string, string>;
}

/** What is used of a Durable Object's native `Container` (`ctx.container`). */
export interface SandboxContainer {
  readonly running: boolean;
  /** The images `wrangler.jsonc` names for this class (`containers[].images`), name → image reference. */
  readonly images: Record<string, string>;
  start(options: ContainerStart): void;
  exec(cmd: string[], options?: ContainerExecOptions): Promise<ContainerProcess>;
  destroy(error?: unknown): Promise<void>;
  setInactivityTimeout(durationMs: number): Promise<void>;
}

/** Where the images install the helper. */
export const HELPER = "/usr/local/bin/pikit-sandbox";
export const SIGTERM = 15;
export const SIGKILL = 9;

/** A container call that passed its deadline. */
export class ContainerTimeout extends Error {
  constructor(what: string, ms: number) {
    super(`execution-cloudflare-sandbox: ${what} did not answer within ${ms} ms (the container may not have started: the account's container limit reached, or the platform slow)`);
  }
}

/** `promise`, or `ContainerTimeout` after `ms`; `onTimeout` runs then (kill what was started). */
export async function within<T>(promise: Promise<T>, ms: number, what: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new ContainerTimeout(what, ms));
    }, ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** All of a stream's bytes, or `undefined` past `maxBytes` (the stream is cancelled). */
export async function collect(stream: ReadableStream<Uint8Array> | null, maxBytes = Number.POSITIVE_INFINITY): Promise<Uint8Array | undefined> {
  if (stream === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return concat(chunks, size);
}

export function concat(chunks: readonly Uint8Array[], size = chunks.reduce((total, chunk) => total + chunk.length, 0)): Uint8Array {
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/** A stream of `bytes`, for a process's stdin. */
export function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** A helper's answer: its value, or the `FileError` it reports. */
export type HelperAnswer<T> = { ok: true; value: T } | { ok: false; error: WireError };

/**
 * Runs `pikit-sandbox <operation> <json>` in `container` within `ms`, with `stdin` as its input when
 * given. A helper that does not answer, exits non-zero or prints no JSON is an `unknown` error.
 */
export async function helper<T>(container: SandboxContainer, operation: string, args: Record<string, unknown>, ms: number, stdin?: Uint8Array): Promise<HelperAnswer<T>> {
  let process: ContainerProcess | undefined;
  const run = async (): Promise<HelperAnswer<T>> => {
    process = await container.exec([HELPER, operation, JSON.stringify(args)], { stdout: "pipe", stderr: "pipe", ...(stdin !== undefined && { stdin: streamOf(stdin) }) });
    const [out, err, exitCode] = await Promise.all([collect(process.stdout), collect(process.stderr), process.exitCode]);
    const text = new TextDecoder().decode(out);
    if (exitCode !== 0) return unknown(`pikit-sandbox ${operation} exited ${exitCode}: ${new TextDecoder().decode(err).trim().slice(0, 500)}`);
    try {
      return JSON.parse(text) as HelperAnswer<T>;
    } catch {
      return unknown(`pikit-sandbox ${operation} answered no JSON: ${text.slice(0, 200)}`);
    }
  };
  try {
    return await within(run(), ms, `pikit-sandbox ${operation}`, () => process?.kill(SIGKILL));
  } catch (error) {
    return unknown(error instanceof Error ? error.message : String(error));
  }
}

function unknown(message: string): { ok: false; error: WireError } {
  return { ok: false, error: { code: "unknown", message } };
}
