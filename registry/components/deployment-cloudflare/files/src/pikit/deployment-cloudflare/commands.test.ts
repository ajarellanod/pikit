/**
 * The commands with a fake wrangler runner and a fake `fetch`: the exact argv, the secrets file, the
 * wait for the deployed version (C8), the rollback, and `status`'s parsing. No wrangler, no account.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Runner, deploySecrets, down, dev, logs, parseDeployments, status, up, workerName } from "./commands.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(env?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-cloudflare-commands-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my_bot.v2" }));
  if (env !== undefined) writeFileSync(join(dir, ".env"), env);
  return dir;
}

interface Call {
  command: readonly string[];
  capture: boolean;
  env?: Record<string, string>;
  /** The secrets file's content, read while wrangler "runs" (it is deleted after). */
  secrets?: Record<string, string>;
}

/** A wrangler that succeeds, reports `version` for a deploy, and prints `stdout` when captured. */
function fakeWrangler(options: { version?: string; code?: (command: readonly string[]) => number; stdout?: string } = {}) {
  const calls: Call[] = [];
  const run: Runner = async (command, { capture, env }) => {
    const call: Call = { command, capture, ...(env !== undefined && { env }) };
    const secretsAt = command.indexOf("--secrets-file");
    if (secretsAt !== -1) call.secrets = JSON.parse(readFileSync(command[secretsAt + 1] as string, "utf8")) as Record<string, string>;
    calls.push(call);
    const output = env?.WRANGLER_OUTPUT_FILE_PATH;
    if (command[1] === "deploy" && output !== undefined) {
      writeFileSync(output, `${JSON.stringify({ type: "wrangler-session" })}\n${JSON.stringify({ type: "deploy", version_id: options.version ?? "v2", targets: ["https://my-bot-v2.acme.workers.dev", "example.com/*"] })}\n`);
    }
    return { code: options.code?.(command) ?? 0, stdout: capture ? (options.stdout ?? "") : "" };
  };
  return { calls, run };
}

/** A `/health` that answers each body in turn, then the last one forever. */
function fakeHealth(...bodies: ({ ok: boolean; version: string | null; error?: string } | "down")[]) {
  const urls: string[] = [];
  const fetcher = (async (url: URL | string) => {
    urls.push(String(url));
    const body = bodies.length > 1 ? bodies.shift() : bodies[0];
    if (body === "down" || body === undefined) throw new TypeError("fetch failed");
    return Response.json(body, { status: body.ok ? 200 : 503 });
  }) as unknown as typeof fetch;
  return { urls, fetcher };
}

test("up deploys with .env's secrets but not wrangler's own, then waits until /health answers the new version", async () => {
  const cwd = project("ANTHROPIC_API_KEY=sk-1\nCLOUDFLARE_API_TOKEN=cf-token\nCLOUDFLARE_ACCOUNT_ID=acct\nEMPTY=\n# a comment\nPIKIT_HTTP_TOKEN=\"t o k\"\n");
  const wrangler = fakeWrangler({ version: "v2" });
  const health = fakeHealth({ ok: true, version: "v1" }, "down", { ok: true, version: "v2" });

  const deployed = await up({ cwd, run: wrangler.run, fetch: health.fetcher, intervalMs: 1 });

  expect(deployed).toEqual({ version: "v2", url: "https://my-bot-v2.acme.workers.dev" });
  const [deploy] = wrangler.calls;
  expect(deploy?.command.slice(0, 4)).toEqual(["wrangler", "deploy", "--name", "my-bot-v2"]);
  expect(deploy?.command[4]).toBe("--secrets-file");
  expect(deploy?.secrets).toEqual({ ANTHROPIC_API_KEY: "sk-1", PIKIT_HTTP_TOKEN: "t o k" });
  expect(deploy?.env?.WRANGLER_OUTPUT_FILE_PATH).toBeString();
  // The secrets file lives only while wrangler runs.
  expect(existsSync(deploy?.command[5] as string)).toBe(false);
  expect(wrangler.calls).toHaveLength(1);
  expect(health.urls).toEqual(Array(3).fill("https://my-bot-v2.acme.workers.dev/health"));
  // status finds the Worker from this record.
  expect(JSON.parse(readFileSync(join(cwd, ".pikit", "deployment-cloudflare.json"), "utf8"))).toEqual(deployed);
});

test("up passes no secrets file without a .env, and asks /health at the URL it is given", async () => {
  const cwd = project();
  const wrangler = fakeWrangler();
  const health = fakeHealth({ ok: true, version: "v2" });
  await up({ cwd, run: wrangler.run, fetch: health.fetcher, url: "https://bot.example.com/" });
  expect(wrangler.calls[0]?.command).toEqual(["wrangler", "deploy", "--name", "my-bot-v2"]);
  expect(health.urls).toEqual(["https://bot.example.com/health"]);
});

test("up rolls back a new version whose App does not start, and says so", async () => {
  const wrangler = fakeWrangler({ version: "v2" });
  const health = fakeHealth({ ok: false, version: "v2", error: "the object's App did not start" });
  const failure = up({ cwd: project(), run: wrangler.run, fetch: health.fetcher, intervalMs: 1 });
  await expect(failure).rejects.toThrow(/the new version v2 answers .* its App does not start \(the object's App did not start\); it was rolled back/);
  expect(wrangler.calls[1]?.command).toEqual(["wrangler", "rollback", "--name", "my-bot-v2", "--message", "pikit up: v2 failed /health", "--yes"]);
});

test("up without rollback leaves a failing version; one that never answers is left too, and named", async () => {
  const kept = fakeWrangler();
  await expect(
    up({ cwd: project(), run: kept.run, fetch: fakeHealth({ ok: false, version: "v2" }).fetcher, rollback: false }),
  ).rejects.toThrow(/it is still deployed/);
  expect(kept.calls).toHaveLength(1);

  const silent = fakeWrangler();
  await expect(
    up({ cwd: project(), run: silent.run, fetch: fakeHealth({ ok: true, version: "v1" }).fetcher, waitMs: 20, intervalMs: 5 }),
  ).rejects.toThrow(/did not answer .* within 0 s \(last: HTTP 200 from version v1\); it is deployed/);
  expect(silent.calls).toHaveLength(1);
});

test("up fails when wrangler deploy fails, before any probe", async () => {
  const wrangler = fakeWrangler({ code: () => 1 });
  const health = fakeHealth({ ok: true, version: "v2" });
  await expect(up({ cwd: project(), run: wrangler.run, fetch: health.fetcher })).rejects.toThrow(/`wrangler deploy --name my-bot-v2` exited with code 1/);
  expect(health.urls).toEqual([]);
});

test("down deletes the Worker only when a person is there to answer wrangler", async () => {
  const wrangler = fakeWrangler();
  await expect(down({ cwd: project(), run: wrangler.run, interactive: false })).rejects.toThrow(/deletes the Worker and every conversation's Durable Object/);
  expect(wrangler.calls).toEqual([]);

  await down({ cwd: project(), run: wrangler.run, interactive: true });
  expect(wrangler.calls).toEqual([{ command: ["wrangler", "delete", "--name", "my-bot-v2"], capture: false }]);
});

test("logs streams wrangler tail, and refuses --tail", async () => {
  const wrangler = fakeWrangler();
  await logs({ cwd: project(), run: wrangler.run, follow: true });
  expect(wrangler.calls).toEqual([{ command: ["wrangler", "tail", "my-bot-v2"], capture: false }]);
  await expect(logs({ cwd: project(), run: wrangler.run, tail: 10 })).rejects.toThrow(/replays nothing/);
});

test("dev runs wrangler dev and resolves with its exit code", async () => {
  const wrangler = fakeWrangler({ code: () => 130 });
  expect(await dev({ cwd: project(), run: wrangler.run })).toBe(130);
  expect(wrangler.calls).toEqual([{ command: ["wrangler", "dev", "--name", "my-bot-v2"], capture: false }]);
});

const DEPLOYMENTS = JSON.stringify([
  { id: "d1", created_on: "2026-09-01T10:00:00Z", annotations: {}, versions: [{ version_id: "v1", percentage: 100 }] },
  { id: "d2", created_on: "2026-09-02T10:00:00Z", annotations: { "workers/message": "fix" }, versions: [{ version_id: "v2", percentage: 100 }] },
]);

test("status lists the deployments and probes /health where the last up deployed", async () => {
  const cwd = project();
  const wrangler = fakeWrangler({ stdout: DEPLOYMENTS });
  expect(await status({ cwd, run: wrangler.run })).toEqual({ deployments: parseDeployments(DEPLOYMENTS), health: "unknown" });
  expect(wrangler.calls[0]).toEqual({ command: ["wrangler", "deployments", "list", "--name", "my-bot-v2", "--json"], capture: true });

  await up({ cwd, run: wrangler.run, fetch: fakeHealth({ ok: true, version: "v2" }).fetcher });
  const probed = await status({ cwd, run: wrangler.run, fetch: fakeHealth({ ok: true, version: "v2" }).fetcher });
  expect(probed).toMatchObject({ url: "https://my-bot-v2.acme.workers.dev", health: 200, version: "v2" });
  expect(await status({ cwd, run: wrangler.run, fetch: fakeHealth("down").fetcher })).toMatchObject({ health: "unreachable" });
});

test("parseDeployments reads wrangler's JSON, oldest first", () => {
  expect(parseDeployments(DEPLOYMENTS)).toEqual([
    { id: "d1", created: "2026-09-01T10:00:00Z", versions: [{ id: "v1", percentage: 100 }] },
    { id: "d2", created: "2026-09-02T10:00:00Z", message: "fix", versions: [{ id: "v2", percentage: 100 }] },
  ]);
  expect(parseDeployments("")).toEqual([]);
});

test("the Worker is named after package.json's name, in the letters Cloudflare accepts", () => {
  expect(workerName(project())).toBe("my-bot-v2");
  const unnamed = project();
  writeFileSync(join(unnamed, "package.json"), "{}");
  expect(() => workerName(unnamed)).toThrow(/package.json has no "name"/);
});

test("deploySecrets reads nothing without a .env", () => {
  expect(deploySecrets(project())).toEqual({});
});
