/**
 * The installer. Always: it is POSIX sh that parses, shellcheck finds nothing when it
 * is installed, and it chooses Bun by its pin and supported range (with stand-ins for `bun`, `curl`
 * and `git`: no network, and it stops before fetching pikit), and which ref it installs (the latest
 * release tag, else main; PIKIT_REF first). Pseudo-terminal cases run the real wizard through the
 * installer's pipe, checking text input, cancellation and skipping it without network or a deploy.
 * With `PIKIT_INSTALLER_TEST=1`: it installs this repository's committed HEAD
 * (`PIKIT_SOURCE`) into a temporary HOME, twice (it is idempotent), and `pikit --version` runs.
 * Bun is taken from the PATH, so no network is needed but for `bun install`'s cache misses.
 *
 * The run on a clean Debian is manual (Docker): see installer/README.md.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";

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
 * nothing else, a `git` that "clones" an empty directory, lists `tags` as the repository's (`git
 * ls-remote --tags` output; null: listing fails) and records the ref it fetches, and a `node` of
 * `nodeVersion`. No network. Terminal tests replace the Bun stand-in with a proxy to the real CLI.
 */
function installFixture(nodeVersion: string, env: Record<string, string> = {}, tags: string[] | null = []) {
  const home = mkdtempSync(join(tmpdir(), "pikit-install-path-"));
  homes.push(home);
  const bin = join(home, "fake-bin");
  mkdirSync(bin);
  const script = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  script("bun", 'if [ "$1" = "--version" ]; then echo 1.4.7; fi');
  if (tags !== null) writeFileSync(join(home, "tags"), tags.map((tag) => `${"0".repeat(40)}\trefs/tags/${tag}\n`).join(""));
  script(
    "git",
    [
      'for a; do last="$a"; done',
      'case " $* " in',
      '  *" clone "*) mkdir -p "$last" ;;',
      '  *" rev-parse "*) echo abc1234 ;;',
      '  *" ls-remote "*) echo listed >> "$HOME/ls-remote"; cat "$HOME/tags" || exit 128 ;;',
      '  *" fetch "*) echo "$last" > "$HOME/fetched" ;;',
      "esac",
    ].join("\n"),
  );
  script("node", `echo ${nodeVersion}`);
  script("unzip", "exit 0");
  return { home, script, env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: tmpdir(), ...env } };
}

function install(args: string[], nodeVersion: string, env: Record<string, string> = {}, tags: string[] | null = []) {
  const fixture = installFixture(nodeVersion, env, tags);
  const { home } = fixture;
  const run = Bun.spawnSync(["sh", SCRIPT, ...args], {
    env: fixture.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const read = (file: string) => (existsSync(join(home, file)) ? readFileSync(join(home, file), "utf8").trim() : null);
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString(), home, fetched: read("fetched"), listed: read("ls-remote") !== null };
}

test("by default it installs the latest release: the highest vMAJOR.MINOR.PATCH tag, compared as numbers", () => {
  const ordered = install([], "v22.11.0", {}, ["v0.0.1", "v0.0.1^{}", "v0.1.0", "v0.0.10", "v0.0.9", "v0.0.2"]);
  expect(ordered.code).toBe(0);
  expect(ordered.fetched).toBe("v0.1.0");
  expect(ordered.out).toContain("the latest release is v0.1.0 (PIKIT_REF=main for the development branch)");
  expect(ordered.out).toContain("fetching pikit from https://github.com/ajarellanod/pikit.git (v0.1.0)");
  expect(install([], "v22.11.0", {}, ["v0.0.9", "v0.0.10", "v0.0.1"]).fetched).toBe("v0.0.10");
  expect(install([], "v22.11.0", {}, ["v0.9.9", "v1.0.0", "v0.10.0"]).fetched).toBe("v1.0.0");
  // Not releases: another tag that starts with v, a pre-release, a tag that is not three numbers.
  const others = ["v0-pre-durable", "v0.2.0-rc.1", "v0.3", "v0.4.0.1", "release-1.0.0", "0.5.0", "v0.6.x"];
  expect(install([], "v22.11.0", {}, ["v0.0.1", ...others]).fetched).toBe("v0.0.1");
});

test("without a release tag it installs main, and saying so", () => {
  for (const tags of [[], ["v0-pre-durable", "v0.1.0-rc.1"]]) {
    const run = install([], "v22.11.0", {}, tags);
    expect(run.code).toBe(0);
    expect(run.fetched).toBe("main");
    expect(run.out).toContain("https://github.com/ajarellanod/pikit.git has no release tags: installing main");
  }
});

test("PIKIT_REF wins over the latest release, without listing tags; a listing that fails stops the install", () => {
  const tags = ["v0.0.1", "v0.1.0"];
  for (const ref of ["main", "v0.0.1", "abc1234"]) {
    const run = install([], "v22.11.0", { PIKIT_REF: ref }, tags);
    expect(run.code).toBe(0);
    expect(run.fetched).toBe(ref);
    expect(run.listed).toBe(false);
  }
  // A local checkout installs what is checked out there, not its latest release.
  const source = install([], "v22.11.0", { PIKIT_SOURCE: join(tmpdir(), "a-checkout") }, tags);
  expect([source.fetched, source.listed]).toEqual(["HEAD", false]);
  const failed = install([], "v22.11.0", {}, null);
  expect(failed.code).toBe(1);
  expect(failed.err).toContain("could not list the tags of https://github.com/ajarellanod/pikit.git (PIKIT_REF=<branch, tag or commit> skips that)");
  expect(failed.fetched).toBeNull();
});

test("--durable skips Docker, checks the Node.js wrangler runs on, and selects the Cloudflare dashboard preset", () => {
  const run = install(["--durable"], "v22.11.0");
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).toContain("Cloudflare: no Docker needed");
  expect(run.out).toContain("Node.js v22.11.0 found: wrangler can run");
  expect(run.out).not.toMatch(/Docker is not installed|Docker with Compose found|docker group/);
  expect(run.out).toContain("pikit new --target durable --preset cloudflare starts another agent on Cloudflare with a dashboard");
  expect(run.out).not.toContain("Telegram");
  expect(readFileSync(SCRIPT, "utf8")).toContain("set -- new --target durable --preset cloudflare");
  expect(existsSync(join(run.home, ".pikit", "bin", "pikit"))).toBe(true);

  // PIKIT_DURABLE=1 is the same; an old Node.js is named, and the install still completes.
  const old = install([], "v20.9.0", { PIKIT_DURABLE: "1" });
  expect(old.code).toBe(0);
  expect(old.err).toContain("wrangler needs Node.js >= 22 (found: v20.9.0)");
  expect(old.out).not.toMatch(/Docker is not installed|Docker with Compose found/);
});

test("without --durable, Docker is checked as before and pikit new asks everything", () => {
  const run = install([], "v22.11.0");
  expect(run.code).toBe(0);
  expect(run.out).toMatch(/Docker is not installed|Docker with Compose found/);
  expect(run.out).not.toContain("Cloudflare: no Docker needed");
  expect(run.out).toContain("pikit new starts a new agent step by step");
  expect(run.out).not.toContain("Now your first agent, step by step:");
  expect(install(["--cloud"], "v22.11.0").err).toContain("unknown option --cloud");
});

test("a pin outside the supported range is refused before anything is installed", () => {
  const run = chooseBun(null, { PIKIT_BUN_VERSION: "2.0.0" });
  expect(run.err).toContain("PIKIT_BUN_VERSION=2.0.0 is outside the Bun range pikit supports (>= 1.4.0, < 2.0.0)");
  expect(run.installerArg).toBeNull();
});

/** The real wizard, reached through the installer's pipe, with no fetch, install, sudo or deploy. */
function terminalInstall(args: string[], dockerGroup = false, skipWizard = false) {
  const fixture = installFixture("v22.11.0");
  fixture.script(
    "bun",
    [
      'case "$1" in',
      '  --version) exec "$REAL_BUN" --version ;;',
      '  install) exit 0 ;;',
      '  *) shift; exec "$REAL_BUN" "$REAL_MAIN" "$@" ;;',
      "esac",
    ].join("\n"),
  );
  fixture.script("docker", dockerGroup ? 'case "$1" in compose) exit 0 ;; *) exit 1 ;; esac' : "exit 0");
  if (dockerGroup) {
    fixture.script("uname", "echo Linux");
    fixture.script("id", 'case "$*" in -u) echo 1000 ;; -un) echo tester ;; "-nG") echo users ;; "-nG tester") echo "users docker" ;; esac');
    fixture.script("sg", 'test "$1" = docker && test "$2" = -c || exit 1; echo called > "$HOME/sg-called"; exec sh -c "$3"');
  }
  let output = "";
  const decoder = new TextDecoder();
  const proc = Bun.spawn(["sh", "-c", 'installer=$1; shift; cat "$installer" | sh -s -- "$@"', "installer-tty", SCRIPT, ...args], {
    cwd: fixture.home,
    env: {
      ...fixture.env,
      REAL_BUN: process.execPath,
      REAL_MAIN: join(REPO, "packages", "cli", "src", "main.ts"),
      TERM: "xterm-256color",
      ...(skipWizard && { PIKIT_NO_WIZARD: "1" }),
    },
    terminal: { cols: 160, rows: 40, data: (_terminal, data) => void (output += decoder.decode(data, { stream: true })) },
  });
  const text = () => stripVTControlCharacters(output);
  return {
    home: fixture.home,
    proc,
    text,
    async waitFor(expected: string) {
      const deadline = Date.now() + 5_000;
      while (!text().includes(expected)) {
        if (proc.exitCode !== null || Date.now() > deadline) throw new Error(`never printed ${JSON.stringify(expected)}; printed:\n${text()}`);
        await Bun.sleep(20);
      }
    },
    async close() {
      proc.terminal?.close();
      if (proc.exitCode === null) proc.kill();
      await proc.exited;
    },
  };
}

for (const mode of ["server", "durable", "docker group"] as const) {
  test(`curl-pipe installer: the ${mode} wizard reads the name and Ctrl-C from its terminal`, async () => {
    const run = terminalInstall(mode === "durable" ? ["--durable"] : [], mode === "docker group");
    try {
      await run.waitFor("Name of your agent");
      run.proc.terminal?.write("tty-bot\r");
      await run.waitFor(mode === "durable" ? "Additional channels?" : "Where should it run?");
      run.proc.terminal?.write("\x03");
      await run.waitFor("Stopped. Run");
      await run.waitFor("pikit --help lists the rest.");
      expect(await run.proc.exited).toBe(0);
      expect(existsSync(join(run.home, "tty-bot"))).toBe(false);
      expect(existsSync(join(run.home, "sg-called"))).toBe(mode === "docker group");
    } finally {
      await run.close();
    }
  }, 15_000);
}

test("PIKIT_NO_WIZARD skips the wizard even on a terminal", async () => {
  const run = terminalInstall(["--durable"], false, true);
  try {
    await run.waitFor("pikit --help lists the rest.");
    expect(await run.proc.exited).toBe(0);
    expect(run.text()).not.toContain("Name of your agent");
  } finally {
    await run.close();
  }
}, 15_000);

test.skipIf(process.env.PIKIT_INSTALLER_TEST !== "1")(
  "installs from a local checkout into a fresh HOME, twice, and pikit runs",
  async () => {
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
      const install = Bun.spawn(["sh", SCRIPT], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(install.stdout).text(), new Response(install.stderr).text(), install.exited]);
      expect(err).toBe("");
      expect(code).toBe(0);
      expect(out).toContain(`export PATH="${home}/.pikit/bin:$PATH"`);
    }
    const pikit = join(home, ".pikit", "bin", "pikit");
    expect(existsSync(pikit)).toBe(true);
    const version = Bun.spawn([pikit, "--version"], { env, stdout: "pipe" });
    const [out, code] = await Promise.all([new Response(version.stdout).text(), version.exited]);
    expect(code).toBe(0);
    expect(out.trim()).toBe(`pikit 0.0.1 (${head})`);
  },
  300_000,
);
