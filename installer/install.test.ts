/**
 * The installer. Always: it is POSIX sh that parses, shellcheck finds nothing when it
 * is installed, and it chooses Bun by its pin and supported range (with stand-ins for `bun`, `curl`
 * and `git`: no network, and it stops before fetching pikit). With `PIKIT_INSTALLER_TEST=1`: it installs this repository's committed HEAD
 * (`PIKIT_SOURCE`) into a temporary HOME, twice (it is idempotent), and `pikit --version` runs.
 * Bun is taken from the PATH, so no network is needed but for `bun install`'s cache misses.
 *
 * The run on a clean Debian is manual (Docker): see installer/README.md.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Runs install.sh with a `bun` that reports `found` (none when null), a `curl` that serves a stand-in of
 * Bun's installer (it records its argument and leaves a `bun` of that version in ~/.bun/bin), and a
 * `git` that fails, so the run stops right after choosing Bun.
 */
function chooseBun(found: string | null, env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "pikit-install-bun-"));
  homes.push(home);
  const bin = join(home, "fake-bin");
  mkdirSync(bin);
  const script = (path: string, body: string) => writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  if (found !== null) script(join(bin, "bun"), `echo ${found}`);
  const bunInstaller = [
    'echo "$1" > "$HOME/bun-installer-arg"',
    'mkdir -p "$HOME/.bun/bin"',
    `printf '#!/bin/sh\\necho %s\\n' "\${1#bun-v}" > "$HOME/.bun/bin/bun"`,
    'chmod 755 "$HOME/.bun/bin/bun"',
  ].join("\n");
  script(join(bin, "curl"), `cat <<'EOF'\n${bunInstaller}\nEOF`);
  script(join(bin, "git"), "exit 1");
  script(join(bin, "unzip"), "exit 0");
  const run = Bun.spawnSync(["sh", SCRIPT], {
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: tmpdir(), ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const argFile = join(home, "bun-installer-arg");
  return {
    home,
    bin,
    out: run.stdout.toString(),
    err: run.stderr.toString(),
    installerArg: existsSync(argFile) ? readFileSync(argFile, "utf8").trim() : null,
  };
}

test("a Bun in the supported range is used as it is", () => {
  const run = chooseBun("1.4.7");
  expect(run.out).toContain(`Bun 1.4.7 at ${run.bin}/bun`);
  expect(run.installerArg).toBeNull();
});

test("without Bun, the pinned Bun is installed, and PIKIT_BUN_VERSION changes the pin", () => {
  const pinned = chooseBun(null);
  expect(pinned.installerArg).toBe("bun-v1.4.2");
  expect(pinned.out).toContain(`Bun 1.4.2 at ${pinned.home}/.bun/bin/bun`);
  const chosen = chooseBun(null, { PIKIT_BUN_VERSION: "bun-v1.5.1" });
  expect(chosen.installerArg).toBe("bun-v1.5.1");
});

test("a Bun below the minimum or of the next major is replaced by the pinned one, with consent", () => {
  for (const found of ["1.3.9", "2.0.0"]) {
    const run = chooseBun(found, { PIKIT_YES: "1" });
    expect(run.out).toContain(`Bun ${found} at ${run.bin}/bun is outside the range pikit supports (>= 1.4.0, < 2.0.0)`);
    expect(run.installerArg).toBe("bun-v1.4.2");
    expect(run.out).toContain(`Bun 1.4.2 at ${run.home}/.bun/bin/bun`);
  }
});

/**
 * Runs install.sh past pikit's install with stand-ins: a `bun` of a supported version that does
 * nothing else, a `git` that "clones" an empty directory, and a `node` of `nodeVersion`. No network,
 * no terminal (so no `pikit new`): it stops after Docker's step, or Cloudflare's.
 */
function install(args: string[], nodeVersion: string, env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "pikit-install-path-"));
  homes.push(home);
  const bin = join(home, "fake-bin");
  mkdirSync(bin);
  const script = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  script("bun", 'if [ "$1" = "--version" ]; then echo 1.4.7; fi');
  script("git", 'for a; do last="$a"; done\ncase " $* " in *" clone "*) mkdir -p "$last" ;; *" rev-parse "*) echo abc1234 ;; esac');
  script("node", `echo ${nodeVersion}`);
  script("unzip", "exit 0");
  const run = Bun.spawnSync(["sh", SCRIPT, ...args], {
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: tmpdir(), ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString(), home };
}

test("--cloudflare skips Docker, checks the Node.js wrangler runs on, and hands over to the Cloudflare bot", () => {
  const run = install(["--cloudflare"], "v22.11.0");
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).toContain("Cloudflare: no Docker needed");
  expect(run.out).toContain("Node.js v22.11.0 found: wrangler can run");
  expect(run.out).not.toMatch(/Docker is not installed|Docker with Compose found|docker group/);
  expect(run.out).toContain("pikit new --target durable --preset telegram-cloudflare starts another Telegram bot on Cloudflare");
  expect(existsSync(join(run.home, ".pikit", "bin", "pikit"))).toBe(true);

  // PIKIT_CLOUDFLARE=1 is the same; an old Node.js is named, and the install still completes.
  const old = install([], "v20.9.0", { PIKIT_CLOUDFLARE: "1" });
  expect(old.code).toBe(0);
  expect(old.err).toContain("wrangler needs Node.js >= 22 (found: v20.9.0)");
  expect(old.out).not.toMatch(/Docker is not installed|Docker with Compose found/);
});

test("without --cloudflare, Docker is checked as before and pikit new asks everything", () => {
  const run = install([], "v22.11.0");
  expect(run.code).toBe(0);
  expect(run.out).toMatch(/Docker is not installed|Docker with Compose found/);
  expect(run.out).not.toContain("Cloudflare: no Docker needed");
  expect(run.out).toContain("pikit new starts a new agent step by step");
  expect(install(["--cloud"], "v22.11.0").err).toContain("unknown option --cloud");
});

test("a pin outside the supported range is refused before anything is installed", () => {
  const run = chooseBun(null, { PIKIT_BUN_VERSION: "2.0.0" });
  expect(run.err).toContain("PIKIT_BUN_VERSION=2.0.0 is outside the Bun range pikit supports (>= 1.4.0, < 2.0.0)");
  expect(run.installerArg).toBeNull();
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
