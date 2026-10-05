/**
 * The Cloudflare preset's Worker, measured: `pikit new --target durable --preset telegram-cloudflare`
 * in a temporary directory, then the project's own `wrangler deploy --dry-run --outdir`. Exits 1 when
 * the bundle is over the platform's limit or over the kit's gzip budget. Nothing is deployed and no
 * account is needed. CI runs it in the workerd job.
 *
 *   bun scripts/bundle-size.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRESET = "telegram-cloudflare";
const KIB = 1024;
const MIB = 1024 * KIB;
/**
 * Cloudflare's limit on a Worker's size: 64 MiB uncompressed, on the Free and Paid plans alike. The
 * page says there is no compressed limit (https://developers.cloudflare.com/workers/platform/limits/#worker-size).
 */
const PLATFORM_LIMIT_BYTES = 64 * MIB;
/**
 * The kit's own budget for the bundle, gzip: 3 MB, the Workers Free plan's compressed limit before
 * Cloudflare removed it (https://developers.cloudflare.com/workers/platform/limits/). Kept because a
 * larger Worker starts slower (the same page: 1 s of startup time on every plan), and this preset
 * already bundles the heaviest stack (execution-do: just-bash, isomorphic-git, QuickJS).
 */
const GZIP_BUDGET_BYTES = 3 * MIB;

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
  const output = await run([join(project, "node_modules", ".bin", "wrangler"), "deploy", "--dry-run", "--outdir", join(parent, "dist")], project);
  const sizes = /Total Upload: ([\d.]+) KiB \/ gzip: ([\d.]+) KiB/.exec(output);
  if (!sizes) throw new Error(`wrangler printed no "Total Upload: … / gzip: …" line:\n${output}`);
  const total = Number(sizes[1]) * KIB;
  const gzip = Number(sizes[2]) * KIB;
  const kib = (bytes: number) => `${(bytes / KIB).toFixed(2)} KiB`;
  console.info(`${PRESET}'s Worker: ${kib(total)} (limit ${kib(PLATFORM_LIMIT_BYTES)}), gzip ${kib(gzip)} (budget ${kib(GZIP_BUDGET_BYTES)})`);
  const over = [
    total > PLATFORM_LIMIT_BYTES && `over Cloudflare's ${kib(PLATFORM_LIMIT_BYTES)} limit`,
    gzip > GZIP_BUDGET_BYTES && `over the kit's ${kib(GZIP_BUDGET_BYTES)} gzip budget`,
  ].filter(Boolean);
  if (over.length > 0) {
    console.error(`✗ the bundle is ${over.join(" and ")}`);
    process.exitCode = 1;
  }
} finally {
  rmSync(parent, { recursive: true, force: true });
}
