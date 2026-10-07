/**
 * `pikit remove` and `pikit doctor` on what the capability graph does not show: a channel needs a
 * router (a `route.resolve` stage, which provides nothing) and `http.route`s need a server (which
 * only uses them). Run as a user runs them, on stand-ins from a registry of this test's own (no npm
 * dependencies, so no `bun install`), with `@pikit/core` linked as `bun install` would. The router's
 * stage id is not its name: who registered it is what counts, never a name.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKAGES_DIR } from "../paths.ts";
import { emptyManifest, writeProjectManifest } from "../project/pikit-json.ts";
import { kitSpecifier } from "../project/vendor.ts";
import { runCli } from "../testing/cli.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-serving-test-"));
  dirs.push(dir);
  return dir;
};

/** A server project whose kit is this CLI's, with `@pikit/core` linked: `add` needs no install. */
function project(): string {
  const dir = temp();
  writeProjectManifest(dir, emptyManifest(undefined, undefined, ["server"]));
  const contracts = kitSpecifier("@pikit/contracts");
  mkdirSync(join(dir, "vendor"));
  writeFileSync(join(dir, contracts.slice("file:".length)), "this CLI's kit");
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "serving", dependencies: { "@pikit/contracts": contracts } }, null, 2)}\n`);
  writeFileSync(join(dir, "pikit.config.ts"), 'import { defineApp } from "@pikit/core";\n\nexport const config = {};\n\nexport default defineApp({\n  components: [\n  ],\n  config,\n});\n');
  mkdirSync(join(dir, "node_modules", "@pikit"), { recursive: true });
  for (const kit of ["core", "contracts"]) symlinkSync(join(PACKAGES_DIR, kit), join(dir, "node_modules", "@pikit", kit));
  return dir;
}

const component = (name: string, setup: string) =>
  `import { defineComponent } from "@pikit/core";\n\nexport default defineComponent({\n  name: "${name}",\n  setup(pikit) {\n${setup}\n  },\n});\n`;

/**
 * - `conversations-fake` provides `conversations.registry`;
 * - `channel-fake` uses it (it admits messages) and provides an `http.route`;
 * - `router-fake` has a `route.resolve` stage, `server-fake` uses `http.route`s, `extra-fake` does nothing.
 */
function registry(): string {
  const root = temp();
  const components: Record<string, { manifest: Record<string, unknown>; setup: string }> = {
    "conversations-fake": { manifest: { provides: ["conversations.registry"] }, setup: '    pikit.provide("conversations.registry", {});' },
    "channel-fake": {
      manifest: { provides: ["http.route"], requires: { pikit: "0.0.0", capabilities: ["conversations.registry"] } },
      setup: '    pikit.use("conversations.registry");\n    pikit.provideKeyed("http.route", "POST /fake", () => new Response(null));',
    },
    "router-fake": { manifest: {}, setup: '    pikit.pipeline("route.resolve", (value) => value, { id: "rules" });' },
    "server-fake": { manifest: { optional: { capabilities: ["http.route"] } }, setup: '    pikit.useKeyed("http.route");' },
    "extra-fake": { manifest: {}, setup: "" },
  };
  const index: Record<string, unknown> = {};
  for (const [name, { manifest, setup }] of Object.entries(components)) {
    const dir = join(root, "components", name);
    mkdirSync(join(dir, "files", "src", "pikit", name), { recursive: true });
    writeFileSync(join(dir, "files", "src", "pikit", name, "index.ts"), component(name, setup));
    const full = {
      name, version: "0.0.0", description: name, targets: ["server"], requires: { pikit: "0.0.0", capabilities: [] },
      optional: { capabilities: [] }, provides: [], dependencies: {}, files: [{ source: "files/src", target: "src" }], ...manifest,
    };
    writeFileSync(join(dir, "component.json"), JSON.stringify(full));
    index[name] = { version: "0.0.0", description: name, targets: full.targets, path: `components/${name}` };
  }
  writeFileSync(join(root, "registry.json"), JSON.stringify({ version: 1, components: index }));
  return root;
}

const NO_ROUTER = "channel-fake admits messages, but no component has a route.resolve stage: no message would be answered. Add a router (a component with a route.resolve stage)";
const NO_SERVER = "channel-fake provides http.route, but no component serves it: no request would reach it. Add a server (a component that uses http.route)";
const installed = (dir: string) => Object.keys(JSON.parse(readFileSync(join(dir, "pikit.json"), "utf8")).components);

test("remove refuses to leave a channel without a router or routes without a server; --force removes, and doctor reports it", async () => {
  const dir = project();
  const from = registry();
  const add = (name: string) => runCli(["add", name, "--yes", "--registry", from], dir);

  // add prints doctor's notes: what it installed provides what nothing uses yet.
  const conversations = await add("conversations-fake");
  expect(conversations.code).toBe(0);
  expect(conversations.out).toContain("conversations-fake provides conversations.registry, which no component uses: `pikit remove conversations-fake` if you do not need it");
  for (const name of ["router-fake", "server-fake", "extra-fake", "channel-fake"]) expect((await add(name)).code).toBe(0);
  const green = await runCli(["doctor"], dir);
  expect(green.out).toContain("pikit doctor: green");
  const config = readFileSync(join(dir, "pikit.config.ts"), "utf8");

  // Refused before the first write, naming what would be left unanswered and the way out.
  const router = await runCli(["remove", "router-fake"], dir);
  expect(router.code).toBe(1);
  expect(router.err).toContain(`router-fake cannot be removed; the app would answer nobody:\n  ${NO_ROUTER}\nDo so first, or pass --force.`);
  const server = await runCli(["remove", "server-fake"], dir);
  expect(server.code).toBe(1);
  expect(server.err).toContain(`server-fake cannot be removed; the app would answer nobody:\n  ${NO_SERVER}\nDo so first, or pass --force.`);
  expect(readFileSync(join(dir, "pikit.config.ts"), "utf8")).toBe(config);
  expect(installed(dir)).toContain("server-fake");

  // --force removes it; doctor, run at the end, reports what is left unserved.
  const forced = await runCli(["remove", "server-fake", "--force"], dir);
  expect(forced.out).toContain("server-fake removed");
  expect(forced.err).toContain(NO_SERVER);
  expect(forced.code).toBe(1);
  expect(installed(dir)).not.toContain("server-fake");
  const doctor = await runCli(["doctor"], dir);
  expect(doctor.code).toBe(1);
  expect(doctor.err).toContain(NO_SERVER);

  // A gap the project has already does not hold up another removal: doctor still reports it.
  const extra = await runCli(["remove", "extra-fake"], dir);
  expect(extra.out).toContain("extra-fake removed");
  expect(extra.err).not.toContain("cannot be removed");
  expect(extra.code).toBe(1);
  // A new one still does.
  expect((await runCli(["remove", "router-fake"], dir)).err).toContain(`router-fake cannot be removed; the app would answer nobody:\n  ${NO_ROUTER}\n`);
  const both = await runCli(["remove", "router-fake", "--force"], dir);
  expect(both.err).toContain(NO_ROUTER);
  expect(both.err).toContain(NO_SERVER);

  // Without the channel there is nothing to answer: no refusal, and remove prints doctor's notes.
  const channel = await runCli(["remove", "channel-fake"], dir);
  expect(channel.code).toBe(0);
  expect(channel.out).toContain("conversations-fake provides conversations.registry, which no component uses");
  expect((await runCli(["doctor"], dir)).out).toContain("pikit doctor: green");
}, 120_000);
