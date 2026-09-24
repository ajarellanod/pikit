/**
 * The installer (ROADMAP M1). Always: it is POSIX sh that parses, and shellcheck finds nothing when
 * it is installed. With `PIKIT_INSTALLER_TEST=1`: it installs this repository's committed HEAD
 * (`PIKIT_SOURCE`) into a temporary HOME, twice (it is idempotent), and `pikit --version` runs.
 * Bun is taken from the PATH, so no network is needed but for `bun install`'s cache misses.
 *
 * The run on a clean Debian is manual (Docker): see installer/README.md.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = join(import.meta.dir, "install.sh");
const REPO = join(import.meta.dir, "..");
const homes: string[] = [];
afterAll(() => homes.forEach((home) => rmSync(home, { recursive: true, force: true })));

test("install.sh is POSIX sh that parses, and passes shellcheck when it is installed", () => {
  expect(Bun.spawnSync(["sh", "-n", SCRIPT]).exitCode).toBe(0);
  const shellcheck = Bun.which("shellcheck");
  if (shellcheck === null) return;
  const run = Bun.spawnSync([shellcheck, "-s", "sh", SCRIPT], { stdout: "pipe" });
  expect(run.stdout.toString()).toBe("");
  expect(run.exitCode).toBe(0);
});

test.skipIf(process.env.PIKIT_INSTALLER_TEST !== "1")(
  "installs from a local checkout into a fresh HOME, twice, and pikit runs",
  () => {
    const home = mkdtempSync(join(tmpdir(), "pikit-install-home-"));
    homes.push(home);
    const env = {
      HOME: home,
      // Bun from this test's own process; the system's git and curl; no Docker on the PATH.
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      PIKIT_SOURCE: REPO,
      TMPDIR: tmpdir(),
    };
    const head = Bun.spawnSync(["git", "-C", REPO, "rev-parse", "--short", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();

    for (let run = 0; run < 2; run++) {
      const install = Bun.spawnSync(["sh", SCRIPT], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      expect(install.stderr.toString()).toBe("");
      expect(install.exitCode).toBe(0);
      expect(install.stdout.toString()).toContain(`export PATH="${home}/.pikit/bin:$PATH"`);
    }
    const pikit = join(home, ".pikit", "bin", "pikit");
    expect(existsSync(pikit)).toBe(true);
    const version = Bun.spawnSync([pikit, "--version"], { env, stdout: "pipe" });
    expect(version.stdout.toString().trim()).toBe(`pikit 0.0.0 (${head})`);
  },
  300_000,
);
