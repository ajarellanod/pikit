/**
 * The sandbox hosts execution-remote's tests reach: `vitest.config.ts` sends this outbound service
 * every request to `SANDBOX_HOST` or `RENDER_SANDBOX_HOST`, and it forwards them to that host's real
 * execution-serve (each its own process and token), started once, on
 * the first request, as its own Bun process (`registry/components/execution-remote/sandbox-host.test-support.ts`:
 * server-bun, execution-serve, a provider keyed as execution-gondolin's over execution-local in a temporary directory), on a
 * free port of 127.0.0.1. So the client runs in a Durable Object, its requests go through workerd's
 * real `fetch`, and the commands are real processes. No network: the host listens on loopback only.
 *
 * The host stops when Vitest exits (its stdin closes, and the process is killed on exit).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { RENDER_SANDBOX_HOST, RENDER_SANDBOX_TOKEN, SANDBOX_HOST, SANDBOX_TOKEN } from "./sandbox-host.ts";

const SCRIPT = decodeURIComponent(new URL("../../../registry/components/execution-remote/sandbox-host.test-support.ts", import.meta.url).pathname);

/** Each host's token, by the name the tests reach it at. */
const TOKENS = new Map([
  [SANDBOX_HOST, SANDBOX_TOKEN],
  [RENDER_SANDBOX_HOST, RENDER_SANDBOX_TOKEN],
]);
const started = new Map<string, Promise<URL>>();
const children: ChildProcess[] = [];

function startHost(token: string): Promise<URL> {
  return new Promise((resolve, reject) => {
    const process_ = spawn("bun", [SCRIPT, token], { stdio: ["pipe", "pipe", "inherit"] });
    children.push(process_);
    let output = "";
    process_.stdout?.setEncoding("utf8");
    process_.stdout?.on("data", (text: string) => {
      output += text;
      const line = output.split("\n")[0];
      if (output.includes("\n") && line !== undefined) resolve(new URL(line.trim()));
    });
    process_.on("error", reject);
    process_.on("exit", (code) => reject(new Error(`workerd lane: the sandbox host exited (${code}) before it listened`)));
    // Vitest exits when its tests are done, not when the host is: the host stops when its stdin closes.
    process_.unref();
    for (const pipe of [process_.stdin, process_.stdout]) (pipe as { unref?(): void } | null)?.unref?.();
  });
}

process.on("exit", () => {
  for (const child of children) child.kill();
});

export function isSandboxRequest(request: Request): boolean {
  return TOKENS.has(new URL(request.url).hostname);
}

export async function sandboxOutbound(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = TOKENS.get(url.hostname) as string;
  let base = started.get(url.hostname);
  if (base === undefined) {
    base = startHost(token);
    started.set(url.hostname, base);
  }
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  return fetch(new URL(`${url.pathname}${url.search}`, await base), { method: request.method, headers: request.headers, ...(body !== undefined && { body }) });
}
