/**
 * The Cloudflare preset's Worker, measured: `pikit new --target durable --preset telegram-cloudflare`
 * in a temporary directory, then the project's own `wrangler deploy --dry-run --outdir`, named as `pikit
 * up` names it (`--name`, package.json's `name`: the generated wrangler.jsonc has none, and wrangler
 * guesses one only when it detects an AI agent running it, never on CI). Exits 1 when
 * the uncompressed bundle (wrangler's "Total Upload") is over Cloudflare's limit. The gzip size is
 * printed for information only: Cloudflare has no compressed limit. Nothing is deployed and no account
 * is needed. CI runs it in the workerd job.
 *
 * The constraint a growing bundle meets first is the Worker's startup time (1 s for the global scope,
 * the same page), which this does not measure.
 *
 *   bun scripts/bundle-size.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRESET = "telegram-cloudflare";
const KIB = 1024;
/**
 * Cloudflare's limit on a Worker's size: 64 MiB uncompressed, on the Free and Paid plans alike, with
 * no compressed limit (https://developers.cloudflare.com/workers/platform/limits/#worker-size).
 */
const WORKER_SIZE_LIMIT_BYTES = 64 * 1024 * KIB;

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}\n${out}${err}`);
  return out + err;
}

const parent = mkdtempSync(join(tmpdir(), "pikit-bundle-size-"));
try {
  const project = join(parent, "bundle-size");
  await run([process.execPath, join(import.meta.dir, "..", "packages", "cli", "src", "main.ts"), "new", "bundle-size", "--target", "durable", "--preset", PRESET], parent);
  const output = await run([join(project, "node_modules", ".bin", "wrangler"), "deploy", "--dry-run", "--name", "bundle-size", "--outdir", join(parent, "dist")], project);
  const sizes = /Total Upload: ([\d.]+) KiB \/ gzip: ([\d.]+) KiB/.exec(output);
  if (!sizes) throw new Error(`wrangler printed no "Total Upload: … / gzip: …" line:\n${output}`);
  const total = Number(sizes[1]) * KIB;
  const kib = (bytes: number) => `${(bytes / KIB).toFixed(2)} KiB`;
  console.info(`${PRESET}'s Worker: ${kib(total)} uncompressed (limit ${kib(WORKER_SIZE_LIMIT_BYTES)}); gzip ${sizes[2]} KiB, for information`);
  if (total > WORKER_SIZE_LIMIT_BYTES) {
    console.error(`✗ the bundle is over Cloudflare's ${kib(WORKER_SIZE_LIMIT_BYTES)} limit`);
    process.exitCode = 1;
  }
} finally {
  rmSync(parent, { recursive: true, force: true });
}
