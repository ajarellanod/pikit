/**
 * The entrypoint in a real child process (SPEC §9.1): exit codes, signals and deadlines can only be
 * seen from outside the process. Each test runs `entrypoint-fixture.ts` (or `main.ts` in a
 * throwaway project) and reads its JSON-lines logs.
 */

import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const FIXTURE = join(import.meta.dir, "entrypoint-fixture.ts");

interface Line {
  level: string;
  msg: string;
  [field: string]: unknown;
}

interface Child {
  /** Resolves with the first log line whose `msg` is `msg`. */
  line(msg: string): Promise<Line>;
  lines: Line[];
  kill(signal: NodeJS.Signals): void;
  exited: Promise<number>;
}

function launch(args: string[], cwd = import.meta.dir): Child {
  const child = Bun.spawn([process.execPath, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const lines: Line[] = [];
  const waiting: { msg: string; resolve(line: Line): void }[] = [];
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of stream) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const text = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (text.trim() === "") continue;
        // Every line the entrypoint writes is one JSON object; `JSON.parse` fails the test otherwise.
        const line = JSON.parse(text) as Line;
        lines.push(line);
        for (const waiter of waiting.filter((w) => w.msg === line.msg)) waiter.resolve(line);
      }
    }
  };
  const reading = Promise.all([read(child.stdout), read(child.stderr)]);
  return {
    lines,
    line(msg) {
      const seen = lines.find((line) => line.msg === msg);
      if (seen !== undefined) return Promise.resolve(seen);
      return new Promise((resolve) => waiting.push({ msg, resolve }));
    },
    kill: (signal) => child.kill(signal),
    exited: child.exited.then(async (code) => {
      await reading;
      return code;
    }),
  };
}

const messages = (child: Child) => child.lines.map((line) => line.msg);

test("a start that fails exits 1 and says why", async () => {
  const child = launch([FIXTURE, "start-fails"]);

  expect(await child.exited).toBe(1);
  const failure = await child.line("pikit: the app failed to start");
  expect(failure.level).toBe("error");
  expect(JSON.stringify(failure.error)).toContain("the start failed on purpose");
});

test("a start past its deadline is abandoned and exits 1", async () => {
  const started = Date.now();
  const child = launch([FIXTURE, "start-hangs"]);

  expect(await child.exited).toBe(1);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(messages(child)).toContain("pikit: the app failed to start");
});

test("SIGTERM stops the app and exits 0", async () => {
  const child = launch([FIXTURE, "ok"]);
  await child.line("pikit: started");

  child.kill("SIGTERM");

  expect(await child.exited).toBe(0);
  expect(messages(child)).toEqual(["pikit: starting", "fixture: started", "pikit: started", "pikit: stopping", "fixture: stopped", "pikit: stopped"]);
  expect((await child.line("pikit: stopping")).signal).toBe("SIGTERM");
});

test("SIGINT (Ctrl-C) stops the app the same way", async () => {
  const child = launch([FIXTURE, "ok"]);
  await child.line("pikit: started");

  child.kill("SIGINT");

  expect(await child.exited).toBe(0);
  expect(messages(child)).toContain("fixture: stopped");
});

test("a stop that fails exits 1 and says why", async () => {
  const child = launch([FIXTURE, "stop-fails"]);
  await child.line("pikit: started");

  child.kill("SIGTERM");

  expect(await child.exited).toBe(1);
  const failure = await child.line("pikit: the app did not stop cleanly");
  expect(JSON.stringify(failure.error)).toContain("the stop failed on purpose");
});

test("a second signal during the stop exits at once", async () => {
  const child = launch([FIXTURE, "stop-hangs"]);
  await child.line("pikit: started");
  child.kill("SIGTERM");
  await child.line("pikit: stopping");

  const second = Date.now();
  child.kill("SIGTERM");

  // The stop deadline is 60 s in this mode: only the second signal can end it this soon.
  expect(await child.exited).toBe(1);
  expect(Date.now() - second).toBeLessThan(5_000);
  expect(messages(child)).toContain("pikit: second signal, exiting now");
  expect(messages(child)).not.toContain("pikit: stopped");
});

test("a signal during the start cancels it, and the process exits 0 once it rolled back", async () => {
  const child = launch([FIXTURE, "start-waits"]);
  await child.line("pikit: starting");

  child.kill("SIGTERM");

  expect(await child.exited).toBe(0);
  expect(messages(child)).toContain("pikit: stopped");
  expect(messages(child)).not.toContain("pikit: the app failed to start");
});

test("main.ts runs the project's pikit.config.ts, from src/pikit/deployment-docker/", async () => {
  // A throwaway project: its own composition root, and this component where `pikit add` puts it.
  const project = mkdtempSync(join(tmpdir(), "pikit-deployment-docker-"));
  try {
    const installed = join(project, "src", "pikit", "deployment-docker");
    mkdirSync(installed, { recursive: true });
    for (const file of ["main.ts", "entrypoint.ts", "logger.ts"]) copyFileSync(join(import.meta.dir, file), join(installed, file));
    symlinkSync(nodeModules(), join(project, "node_modules"), "dir");
    writeFileSync(
      join(project, "pikit.config.ts"),
      [
        'import { defineApp, defineComponent } from "@pikit/core";',
        "const project = defineComponent({",
        '  name: "project",',
        "  setup() {",
        "    let timer: ReturnType<typeof setInterval> | undefined;",
        "    return {",
        '      start: (ctx) => { timer = setInterval(() => {}, 60_000); ctx.logger.info("project: started"); },',
        "      stop: () => clearInterval(timer),",
        "    };",
        "  },",
        "});",
        "export default defineApp({ components: [project] });",
        "",
      ].join("\n"),
    );

    const child = launch([join(installed, "main.ts")], project);
    await child.line("project: started");
    child.kill("SIGTERM");

    expect(await child.exited).toBe(0);
    expect(messages(child)).toContain("pikit: stopped");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

/** The `node_modules` this test resolves `@pikit/core` from: the project's (or the monorepo's). */
function nodeModules(): string {
  for (let dir = import.meta.dir; dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", "@pikit", "core"))) return join(dir, "node_modules");
  }
  throw new Error("no node_modules with @pikit/core above this test");
}
