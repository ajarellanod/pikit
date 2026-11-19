/**
 * A Durable Object's cold start on local workerd (`wrangler dev`), measured: the script start (the
 * bundle evaluated) apart from the Apps' starts, a fresh owner key's first call, the fixed owners
 * cold in series, and a fresh conversation's first message, with the objects each started on the way
 * (features/object-composition.md, "Measurement"; docs/benchmarks/object-start.md has how to read it).
 *
 * Each side is a kit checkout: `--head` (default: this one, its working tree) and, with `--base`, a
 * revision (a `git worktree` of it, `bun install`ed) or another checkout's directory. For each, its own
 * CLI makes a project (`scripts/bench/project.ts`) in a temporary directory, then `wrangler dev` runs
 * it, restarted between rounds; every process started is stopped at the end, on error and on Ctrl-C.
 * Prints a Markdown table and writes it with every sample as JSON to `.bench/` (gitignored). Timings
 * are not asserted: nothing fails on a slow number.
 *
 *   bun scripts/bench-object-start.ts [--base <rev|dir>] [--head <dir>] [--rounds 3] [--fresh 30]
 *     [--conversations 5] [--model-ms 400] [--port 8799] [--keep]
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { stopAll, stopOnSignals, run } from "./bench/process.ts";
import { makeProject } from "./bench/project.ts";
import { table } from "./bench/report.ts";
import { measureSide, type SideResult } from "./bench/scenarios.ts";

const ROOT = resolve(import.meta.dir, "..");
const { values } = parseArgs({
  options: {
    base: { type: "string" },
    head: { type: "string", default: ROOT },
    rounds: { type: "string", default: "3" },
    fresh: { type: "string", default: "30" },
    conversations: { type: "string", default: "5" },
    "model-ms": { type: "string", default: "400" },
    port: { type: "string", default: "8799" },
    keep: { type: "boolean", default: false },
  },
});
const count = (name: string, value: string) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`bench: --${name} is a whole number, not "${value}"`);
  return number;
};
const options = {
  rounds: Math.max(1, count("rounds", values.rounds)),
  fresh: count("fresh", values.fresh),
  conversations: count("conversations", values.conversations),
  port: count("port", values.port),
  inspectorPort: count("port", values.port) + 500,
};
const modelMs = count("model-ms", values["model-ms"]);
const log = (line: string) => console.error(`· ${line}`);

const git = async (dir: string, ...args: string[]) => (await run(["git", "-C", dir, ...args], dir)).trim();
/** The checkout's commit, `+dirty` when its working tree differs from it. */
async function commitOf(dir: string): Promise<string> {
  const head = await git(dir, "rev-parse", "HEAD");
  return (await git(dir, "status", "--porcelain")) === "" ? head : `${head}+dirty`;
}

const worktrees: string[] = [];
/** A kit directory for `spec`: a directory as it is, or a revision checked out in `.bench/kits/`. */
async function kitFor(spec: string): Promise<string> {
  if (existsSync(spec) && statSync(spec).isDirectory()) return realpathSync(spec);
  const sha = await git(ROOT, "rev-parse", "--verify", `${spec}^{commit}`);
  mkdirSync(join(ROOT, ".bench", "kits"), { recursive: true });
  const dir = join(realpathSync(join(ROOT, ".bench", "kits")), sha.slice(0, 12));
  if (!existsSync(dir)) {
    log(`git worktree of ${spec} (${sha.slice(0, 12)}) in ${dir}`);
    await git(ROOT, "worktree", "add", "--detach", dir, sha);
    worktrees.push(dir);
  }
  log(`bun install in ${dir}`);
  await run([process.execPath, "install", "--frozen-lockfile"], dir);
  return dir;
}

stopOnSignals();
const parent = mkdtempSync(join(realpathSync(tmpdir()), "pikit-bench-object-start-"));
const sides: SideResult[] = [];
try {
  const specs: [string, string][] = [...(values.base !== undefined ? [["base", values.base] as [string, string]] : []), ["head", values.head]];
  for (const [label, spec] of specs) {
    const kit = await kitFor(spec);
    const project = await makeProject(kit, parent, `bench-${label}`, log);
    sides.push(await measureSide(project, label, kit, await commitOf(kit), options, log));
  }
  const report = table(sides, modelMs);
  console.info(report);
  const out = join(ROOT, ".bench");
  mkdirSync(out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(out, `object-start-${stamp}.json`), JSON.stringify({ options: { ...options, modelMs }, sides }, null, 2));
  writeFileSync(join(out, `object-start-${stamp}.md`), report);
  log(`written: .bench/object-start-${stamp}.{json,md}`);
} finally {
  await stopAll();
  if (values.keep) log(`kept: ${parent}${worktrees.length > 0 ? ` and ${worktrees.join(", ")}` : ""}`);
  else {
    rmSync(parent, { recursive: true, force: true });
    for (const dir of worktrees) await git(ROOT, "worktree", "remove", "--force", dir).catch((error: unknown) => log(`could not remove the worktree ${dir}: ${String(error)}`));
  }
}
