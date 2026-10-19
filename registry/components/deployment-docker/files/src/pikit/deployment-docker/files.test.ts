/**
 * The project-root files this component installs: `Dockerfile`, `compose.yaml`, `.dockerignore`.
 * They sit three directories above this test, both in the registry (`files/` mirrors the project)
 * and in your project, so these checks keep holding after you edit them.
 *
 * The checks read the text: pikit parses no YAML here, and a line-level check is enough for the
 * invariants that matter (no secret in the image, a stop that fits in Docker's grace period).
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { START_DEADLINE_MS, STOP_DEADLINE_MS } from "./entrypoint.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const read = (name: string): string => readFileSync(join(ROOT, name), "utf8");
/** The file's lines without comments and blank lines. */
const lines = (name: string): string[] =>
  read(name)
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "").trimEnd())
    .filter((line) => line.trim() !== "");

/** A Compose duration (`20s`, `1m30s`, `500ms`) in milliseconds. */
function duration(text: string): number {
  const units: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+)(ms|s|m|h)/g)) total += Number(amount) * (units[unit ?? ""] ?? Number.NaN);
  return total;
}

/** The value of `key:` in compose.yaml (the first one). */
function composeValue(key: string): string {
  const line = lines("compose.yaml").find((l) => l.trimStart().startsWith(`${key}:`));
  if (line === undefined) throw new Error(`compose.yaml has no ${key}`);
  return line.slice(line.indexOf(":") + 1).trim();
}

test("Dockerfile: Bun >= 1.4, a production install from the lockfile, and the entrypoint", () => {
  const dockerfile = lines("Dockerfile");
  const from = dockerfile.find((line) => line.startsWith("FROM "));
  const [, major, minor] = from?.match(/oven\/bun:(\d+)\.(\d+)/) ?? [];
  expect(Number(major) * 100 + Number(minor)).toBeGreaterThanOrEqual(104);

  expect(dockerfile).toContain("RUN bun install --frozen-lockfile --production");
  expect(dockerfile.at(-1)).toBe('CMD ["bun", "src/pikit/deployment-docker/main.ts"]');
  expect(existsSync(join(ROOT, "src", "pikit", "deployment-docker", "main.ts"))).toBe(true);
});

test("Dockerfile: the vendored @pikit/* tarballs are in place before the install (M1)", () => {
  const dockerfile = lines("Dockerfile");
  const vendor = dockerfile.findIndex((line) => /^COPY\s+vendor\/?\s/.test(line));
  const install = dockerfile.findIndex((line) => line.startsWith("RUN bun install"));

  expect(vendor).toBeGreaterThan(-1);
  expect(vendor).toBeLessThan(install);
  expect(lines(".dockerignore").some((line) => /^\/?vendor\b/.test(line))).toBe(false);
});

test("Dockerfile: the app runs as a user that is not root, and owns .pikit/", () => {
  const dockerfile = lines("Dockerfile");
  const users = dockerfile.filter((line) => line.startsWith("USER "));
  expect(users.length).toBeGreaterThan(0);
  expect(users.at(-1)).not.toMatch(/^USER (root|0)(:|$)/);
  expect(dockerfile.some((line) => /chown\s+\S+\s+\.pikit/.test(line))).toBe(true);
});

test("Dockerfile: no secret is baked in", () => {
  const dockerfile = lines("Dockerfile");
  expect(dockerfile.filter((line) => /^(ENV|ARG)\s.*(TOKEN|KEY|SECRET|PASSWORD)/i.test(line))).toEqual([]);
  expect(dockerfile.filter((line) => /^(COPY|ADD)\s.*\.env\b/.test(line))).toEqual([]);
});

test(".dockerignore keeps secrets, state and node_modules out of the build", () => {
  const ignored = lines(".dockerignore");
  expect(ignored).toContain(".env");
  expect(ignored).toContain(".pikit");
  expect(ignored).toContain("node_modules");
  // Each UI project's too (src/dashboard/node_modules), and its local build: the image makes its own.
  expect(ignored).toContain("**/node_modules");
  expect(ignored).toContain("src/*/dist");
});

test("Dockerfile: the UI projects are built in their own stage, and only their modules reach the app, after its files", () => {
  const dockerfile = lines("Dockerfile");
  const stage = dockerfile.findIndex((line) => /^FROM\s.*\sAS ui$/.test(line));
  const app = dockerfile.findLastIndex((line) => line.startsWith("FROM "));

  expect(stage).toBeGreaterThan(-1);
  expect(stage).toBeLessThan(app);
  expect(dockerfile.slice(stage, app).join("\n")).toContain("bun install --frozen-lockfile");
  const copy = dockerfile.slice(app).indexOf("COPY --from=ui /build/out/ ./");
  expect(copy).toBeGreaterThan(dockerfile.slice(app).indexOf("COPY . ."));
});

/** The `ui` stage's RUN, as the image's shell runs it in its WORKDIR (Docker joins the `\` lines). */
function uiStage(): string {
  const text = read("Dockerfile");
  const stage = text.slice(text.search(/^FROM\s.*\sAS ui$/m));
  const run = /^RUN ((?:.*\\\n)*.*)$/m.exec(stage)?.[1];
  if (run === undefined) throw new Error("the ui stage has no RUN");
  return run.replaceAll("\\\n", "");
}

/** A UI project at `src/<name>/` whose build writes `text` as `src/pikit/<component>/<name>-files.ts`, or fails. */
const uiProject = (name: string, component: string, text: string | undefined): Record<string, string> => ({
  [`src/${name}/package.json`]: JSON.stringify({ name, private: true, scripts: { build: "bun build.ts" } }),
  [`src/${name}/build.ts`]:
    text === undefined ? 'console.error("vite: broken"); process.exit(3);\n' : `await Bun.write("../pikit/${component}/${name}-files.ts", ${JSON.stringify(text)});\n`,
  // What the repository holds: an old build, which the image must not ship.
  [`src/pikit/${component}/${name}-files.ts`]: "OLD\n",
});

/** The `ui` stage run on a build context of `files`: its exit code and the files of `out/`. */
async function runUiStage(files: Record<string, string>): Promise<{ code: number; out: Record<string, string>; stderr: string }> {
  const build = mkdtempSync(join(tmpdir(), "pikit-docker-ui-"));
  try {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(build, file)), { recursive: true });
      writeFileSync(join(build, file), text);
    }
    const child = Bun.spawn(["sh", "-c", uiStage()], {
      cwd: build,
      env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const out: Record<string, string> = {};
    for (const file of new Bun.Glob("**/*").scanSync({ cwd: join(build, "out"), dot: true })) out[file] = readFileSync(join(build, "out", file), "utf8");
    return { code, out, stderr };
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
}

test("Dockerfile's ui stage builds every UI project, the dashboard and a component's, and puts only their modules in out/", async () => {
  const { code, out, stderr } = await runUiStage({
    ...uiProject("dashboard", "admin-api", "DASHBOARD_BUILD\n"),
    ...uiProject("chat", "channel-web", "CHAT_BUILD\n"),
    // A component's own files, and a folder of src/ that is no UI project: never in out/.
    "src/pikit/channel-web/index.ts": "export default {};\n",
    "src/notes/todo.md": "mine\n",
  });
  expect({ code, stderr }).toEqual({ code: 0, stderr: expect.any(String) });
  expect(out).toEqual({ "src/pikit/admin-api/dashboard-files.ts": "DASHBOARD_BUILD\n", "src/pikit/channel-web/chat-files.ts": "CHAT_BUILD\n" });
}, 60_000);

test("Dockerfile's ui stage: nothing to build leaves out/ empty; a build that fails stops the image", async () => {
  expect(await runUiStage({ "src/pikit/tool-read/index.ts": "export default {};\n" })).toEqual({ code: 0, out: {}, stderr: "" });

  const failed = await runUiStage({ ...uiProject("dashboard", "admin-api", "DASHBOARD_BUILD\n"), ...uiProject("chat", "channel-web", undefined) });
  expect(failed.code).not.toBe(0);
  expect(failed.stderr).toContain("vite: broken");
}, 60_000);

test("compose.yaml: a 503 from /health (the app is down) stops PID 1, so Docker restarts the process; nothing else does", () => {
  const check = lines("compose.yaml").find((line) => line.trimStart().startsWith("test:")) ?? "";
  expect(check).toContain("r.status === 503) process.kill(1, 'SIGTERM')");
  expect(lines("compose.yaml").join("\n")).toMatch(/restart: unless-stopped/);
});

test("compose.yaml: a stop grace period longer than the entrypoint's stop deadline", () => {
  const grace = duration(composeValue("stop_grace_period"));
  expect(grace).toBeGreaterThan(STOP_DEADLINE_MS);
  // Room for the process to exit after its last stop hook gave up.
  expect(grace - STOP_DEADLINE_MS).toBeGreaterThanOrEqual(5_000);
});

test("compose.yaml: a healthcheck on GET /health, patient enough for the start deadline", () => {
  expect(lines("compose.yaml").join("\n")).toMatch(/healthcheck:\n\s+test: \[.*http:\/\/127\.0\.0\.1:3000\/health/);
  expect(duration(composeValue("start_period"))).toBeGreaterThanOrEqual(START_DEADLINE_MS);
});

test("compose.yaml: restarts, secrets from .env at run time, .pikit/ on a volume, the port", () => {
  const compose = lines("compose.yaml");
  expect(composeValue("restart")).toBe("unless-stopped");
  expect(composeValue("init")).toBe("true");
  expect(compose.join("\n")).toMatch(/env_file:\n\s+- \.env$/m);
  expect(compose.some((line) => /^\s+- [\w-]+:\/app\/\.pikit$/.test(line))).toBe(true);
  expect(compose.some((line) => /^\s+- "127\.0\.0\.1:3000:3000"$/.test(line))).toBe(true);
  expect(compose.filter((line) => /(TOKEN|API_KEY|SECRET)\s*[:=]/.test(line))).toEqual([]);
});

test("compose.yaml: only the deployer has the Docker socket, off behind its profile (only a Compose file added after this one turns it on); the app never does", () => {
  const compose = lines("compose.yaml");
  const deployer = compose.findIndex((line) => line === "  deployer:");
  expect(deployer).toBeGreaterThan(-1);
  const socket = compose.findIndex((line) => line.includes("/var/run/docker.sock"));
  expect(socket).toBeGreaterThan(deployer);
  expect(compose.filter((line) => line.includes("docker.sock"))).toHaveLength(1);
  const service = compose.slice(deployer, compose.findIndex((line, i) => i > deployer && /^\S/.test(line)));
  expect(service.join("\n")).toContain('profiles: ["self-improvement"]');
  expect(service.join("\n")).toContain("target: deployer");
  for (const mount of ["- .:/project", "- pikit-state:/state", "- pikit-checks:/checks"]) expect(service.map((line) => line.trim())).toContain(mount);
});

test("the deployer's image has only this folder, no package: what deployer-main.ts loads, transitively, is this folder's files and node:*", () => {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const dir = join(ROOT, "src", "pikit", "deployment-docker");
  const seen = new Set<string>();
  const outside: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    // What Bun runs: type-only imports are erased.
    for (const { path } of transpiler.scan(readFileSync(join(dir, file), "utf8")).imports) {
      if (path.startsWith("./") && !path.slice(2).includes("/")) visit(path.slice(2));
      else if (!path.startsWith("node:")) outside.push(`${file}: ${path}`);
    }
  };
  visit("deployer-main.ts");
  expect(outside).toEqual([]);
  expect([...seen].sort()).toEqual(["commands.ts", "deployer-main.ts", "deployer.ts"]);
  expect(lines("Dockerfile")).toContain("COPY src/pikit/deployment-docker/ ./src/pikit/deployment-docker/");
});

test("Dockerfile: git in the stage the app and the deployer share, the app the last stage, the deployer its own", () => {
  const dockerfile = lines("Dockerfile");
  const base = dockerfile.findIndex((line) => /^FROM oven\/bun:\S+ AS base$/.test(line));
  expect(base).toBeGreaterThan(-1);
  expect(dockerfile.slice(base).join("\n")).toMatch(/apt-get install --yes --no-install-recommends git/);
  expect(dockerfile.findLast((line) => line.startsWith("FROM "))).toBe("FROM base");
  const deployer = dockerfile.findIndex((line) => line === "FROM base AS deployer");
  expect(deployer).toBeGreaterThan(base);
  expect(dockerfile.slice(deployer).find((line) => line.startsWith("CMD"))).toBe('CMD ["bun", "src/pikit/deployment-docker/deployer-main.ts"]');
});
