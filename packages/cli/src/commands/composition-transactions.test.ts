/**
 * What a project's one deployment supports, checked by every mutation (`checkComposition` in
 * `add.ts`, `composition.ts`): `add`, `remove` and `upgrade` refuse, `--force` or not, a result whose
 * deployment could not run it, before anything is written, and allow what removes problems. Run as a
 * user runs them, on a registry of this test's own whose names mean nothing to the CLI (`acme.review-host`
 * is a protocol no builtin component knows): only `kind` (`deployment-*`) and the declared fields count.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PIKIT_ROOT } from "../paths.ts";
import { OPERATION_MARKER } from "../project/operation.ts";
import { emptyManifest, writeProjectManifest } from "../project/pikit-json.ts";
import { runCli } from "../testing/cli.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-composition-tx-test-"));
  dirs.push(dir);
  return dir;
};

/** Where tool-reviewer's doctor hook would leave a trace: it never runs on a refusal. */
const HOOK_RAN = join(temp(), "hook-ran");

/** A deployment's entry: functions for the CLI, no default export (it is not listed in pikit.config.ts). */
const DEPLOYMENT_INDEX = "export async function up() {}\nexport async function down() {}\nexport async function logs() {}\nexport async function status() {\n  return { lines: [] };\n}\n";
const REVIEWER_INDEX = 'import { defineComponent } from "@pikit/core";\n\nexport default defineComponent({\n  name: "tool-reviewer",\n  setup() {},\n});\n';
const SIDE_INDEX = 'export const service = "sidecar";\n';
const SIDE_COMPOSE = "services:\n  sidecar:\n    image: busybox\n";

type Published = { version: string; files: Record<string, string>; fields: Record<string, unknown> };

/** The registry at `root` with these components (name → version, own files, manifest fields), replacing what it had. */
function publish(root: string, components: Record<string, Published>): void {
  const index: Record<string, unknown> = {};
  for (const [name, { version, files, fields }] of Object.entries(components)) {
    const dir = join(root, "components", name);
    rmSync(dir, { recursive: true, force: true });
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(dir, "files", "src", "pikit", name, file, ".."), { recursive: true });
      writeFileSync(join(dir, "files", "src", "pikit", name, file), text);
    }
    const manifest = {
      name, version, description: name, targets: ["server"], requires: { pikit: "0.0.1", capabilities: [] },
      optional: { capabilities: [] }, provides: [], dependencies: {}, files: [{ source: "files/src", target: "src" }], ...fields,
    };
    writeFileSync(join(dir, "component.json"), JSON.stringify(manifest));
    index[name] = { version, description: name, targets: ["server"], path: `components/${name}` };
  }
  writeFileSync(join(root, "registry.json"), JSON.stringify({ version: 1, components: index }));
}

const acme = (version: string, supports: string[]): Published => ({ version, files: { "index.ts": DEPLOYMENT_INDEX }, fields: { deployment: { supports } } });
const reviewer = (version: string, needs: string[]): Published => ({
  version,
  files: { "index.ts": REVIEWER_INDEX, "doctor.ts": `import { writeFileSync } from "node:fs";\n\nexport function doctor() {\n  writeFileSync(${JSON.stringify(HOOK_RAN)}, "ran");\n  return [];\n}\n` },
  fields: { requires: { pikit: "0.0.1", capabilities: [], deployment: needs }, hooks: { doctor: "doctor.ts" } },
});

/** The registry as first published: acme supports Compose and its own review host; plain supports nothing. */
const BASE: Record<string, Published> = {
  "deployment-acme": acme("0.1.0", ["services.compose", "acme.review-host"]),
  "deployment-plain": { version: "0.1.0", files: { "index.ts": DEPLOYMENT_INDEX }, fields: { deployment: { supports: [] } } },
  "tool-reviewer": reviewer("0.1.0", ["acme.review-host"]),
  "expose-side": { version: "0.1.0", files: { "index.ts": SIDE_INDEX, "compose.yaml": SIDE_COMPOSE }, fields: { compose: "compose.yaml" } },
};

function registry(): string {
  const root = temp();
  publish(root, BASE);
  return root;
}

/** A project the commands run to the end in: `@pikit/core` linked, no kit to install; a lockfile and vendor/ of its own, which a refusal leaves alone. */
function project(): string {
  const dir = temp();
  writeProjectManifest(dir, emptyManifest());
  writeFileSync(join(dir, "package.json"), '{ "name": "composed", "dependencies": {} }\n');
  writeFileSync(join(dir, "bun.lock"), '{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "composed",\n    },\n  },\n  "packages": {},\n}\n');
  writeFileSync(join(dir, ".env.example"), "# the project's own\n");
  mkdirSync(join(dir, "vendor"));
  writeFileSync(join(dir, "vendor", "keep.txt"), "the project's own\n");
  writeFileSync(
    join(dir, "pikit.config.ts"),
    'import { defineApp } from "@pikit/core";\n\nexport const config = {};\n\nexport default defineApp({\n  components: [\n  ],\n  config,\n});\n',
  );
  mkdirSync(join(dir, "node_modules", "@pikit"), { recursive: true });
  symlinkSync(join(PIKIT_ROOT, "packages", "core"), join(dir, "node_modules", "@pikit", "core"));
  return dir;
}

/** Every file under `dir` (node_modules aside) → its content: pikit.json, package.json, pikit.config.ts, .env.example, bun.lock, pikit-bases/, vendor/, src/. */
function snapshot(dir: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(join(dir, prefix)).sort()) {
    const relative = `${prefix}${entry}`;
    if (relative === "node_modules") continue;
    if (statSync(join(dir, relative)).isDirectory()) {
      files[`${relative}/`] = "";
      Object.assign(files, snapshot(dir, `${relative}/`));
    } else files[relative] = readFileSync(join(dir, relative), "latin1");
  }
  return files;
}

const components = (dir: string) => JSON.parse(readFileSync(join(dir, "pikit.json"), "utf8")).components;

/** Runs `pikit <args>`, expects it refused with code 1 and every `says`, and the project byte for byte as it was. */
async function refused(dir: string, args: string[], says: string[]): Promise<string> {
  const before = snapshot(dir);
  const run = await runCli(args, dir);
  expect(run.code).toBe(1);
  for (const text of says) expect(run.err).toContain(text);
  expect(snapshot(dir)).toEqual(before);
  expect(existsSync(join(dir, OPERATION_MARKER))).toBe(false);
  expect(existsSync(HOOK_RAN)).toBe(false);
  return run.err;
}

const ok = async (dir: string, args: string[]) => {
  const run = await runCli(args, dir);
  expect({ code: run.code, err: run.err }).toEqual({ code: 0, err: expect.any(String) });
  return run;
};

test("add refuses, before anything is written or asked, what the one deployment does not support", async () => {
  const dir = project();
  const from = registry();
  // No deployment yet: one that needs something of it would be stuck.
  await refused(dir, ["add", "tool-reviewer", "--registry", from, "--yes"], ["pikit add tool-reviewer is refused", 'tool-reviewer needs its deployment to support "acme.review-host"', "no deployment-* component is installed"]);

  await ok(dir, ["add", "deployment-plain", "--registry", from, "--yes"]);
  expect(components(dir)["deployment-plain"].deployment).toEqual({ supports: [] });
  for (const force of [[], ["--force"]]) {
    await refused(dir, ["add", "tool-reviewer", "--registry", from, "--yes", ...force], [
      'tool-reviewer needs its deployment to support "acme.review-host", which deployment-plain does not',
      "--force does not change it",
    ]);
  }
  expect(existsSync(join(dir, "src/pikit/tool-reviewer"))).toBe(false);
  // Without --yes and without a terminal: the refusal comes before the confirmation would be asked for.
  const unasked = await refused(dir, ["add", "tool-reviewer", "--registry", from], ["which deployment-plain does not"]);
  expect(unasked).not.toContain("pass --yes");
  // A Compose file implies `services.compose`, without being declared.
  await refused(dir, ["add", "expose-side", "--registry", from, "--yes"], ['expose-side needs its deployment to support "services.compose" (it ships a Compose file']);
  // One of several names is enough to refuse them all.
  await refused(dir, ["add", "expose-side", "tool-reviewer", "--registry", from, "--yes"], ["expose-side needs", "tool-reviewer needs"]);
}, 120_000);

test("with a deployment that supports them, add records what each needs and supports; a second deployment, its removal and an upgrade that drops support are refused", async () => {
  const dir = project();
  const from = registry();
  await ok(dir, ["add", "deployment-acme", "--registry", from, "--yes"]);
  await ok(dir, ["add", "tool-reviewer", "expose-side", "--registry", from, "--yes"]);
  const installed = components(dir);
  expect(installed["deployment-acme"].deployment).toEqual({ supports: ["services.compose", "acme.review-host"] });
  expect(installed["tool-reviewer"].requires.deployment).toEqual(["acme.review-host"]);
  expect(installed["expose-side"].compose).toBe("src/pikit/expose-side/compose.yaml");
  expect(installed["expose-side"].requires.deployment).toBeUndefined();

  // Never two deployments: their supports are not added together.
  await refused(dir, ["add", "deployment-plain", "--registry", from, "--yes", "--force"], ["several deployments are installed (deployment-acme, deployment-plain)"]);
  // Its only deployment goes after what needs it.
  for (const force of [[], ["--force"]]) {
    await refused(dir, ["remove", "deployment-acme", ...force], [
      "pikit remove deployment-acme is refused",
      'tool-reviewer needs its deployment to support "acme.review-host"',
      "Remove expose-side, tool-reviewer first",
    ]);
  }

  // A new acme that no longer supports the review host: refused, forced or not; --dry-run says why.
  publish(from, { ...BASE, "deployment-acme": acme("0.2.0", ["services.compose"]) });
  for (const force of [[], ["--force"]]) {
    await refused(dir, ["upgrade", "deployment-acme", "--yes", ...force], ['tool-reviewer needs its deployment to support "acme.review-host", which deployment-acme does not']);
  }
  await refused(dir, ["upgrade", "deployment-acme", "--dry-run"], ["pikit upgrade deployment-acme is refused", "which deployment-acme does not"]);

  // Together with a tool-reviewer that needs what the new acme supports, the set is fine: never checked one at a time.
  publish(from, { ...BASE, "deployment-acme": acme("0.2.0", ["services.compose", "acme.v2"]), "tool-reviewer": reviewer("0.2.0", ["acme.v2"]) });
  await refused(dir, ["upgrade", "deployment-acme", "--yes"], ['"acme.review-host", which deployment-acme does not']);
  await refused(dir, ["upgrade", "tool-reviewer", "--yes"], ['"acme.v2", which deployment-acme does not']);
  await ok(dir, ["upgrade", "deployment-acme", "tool-reviewer", "--yes"]);
  expect(components(dir)["deployment-acme"].deployment).toEqual({ supports: ["services.compose", "acme.v2"] });
  expect(components(dir)["tool-reviewer"].requires.deployment).toEqual(["acme.v2"]);

  // Only what it says of the deployment changes, under the same version: still an upgrade.
  publish(from, { ...BASE, "deployment-acme": acme("0.2.0", ["services.compose", "acme.v2", "acme.extra"]), "tool-reviewer": reviewer("0.2.0", ["acme.v2"]) });
  const metadata = await ok(dir, ["upgrade", "deployment-acme", "--yes"]);
  expect(metadata.out).toContain("deployment-acme upgraded: 0.2.0 → 0.2.0");
  expect(components(dir)["deployment-acme"].deployment).toEqual({ supports: ["services.compose", "acme.v2", "acme.extra"] });

  // What needs it first, then the deployment.
  await ok(dir, ["remove", "tool-reviewer"]);
  await ok(dir, ["remove", "expose-side"]);
  await ok(dir, ["remove", "deployment-acme"]);
  expect(Object.keys(components(dir))).toEqual([]);
  expect(existsSync(HOOK_RAN)).toBe(false);
}, 240_000);

test("a project already wrong (pikit.json edited by hand) can still be repaired: the consumer whose need is unmet is removed", async () => {
  const dir = project();
  const from = registry();
  await ok(dir, ["add", "deployment-acme", "--registry", from, "--yes"]);
  await ok(dir, ["add", "tool-reviewer", "--registry", from, "--yes"]);
  // acme no longer says it supports the review host: tool-reviewer's need is unmet.
  const manifest = JSON.parse(readFileSync(join(dir, "pikit.json"), "utf8"));
  manifest.components["deployment-acme"].deployment = { supports: ["services.compose"] };
  writeFileSync(join(dir, "pikit.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  // Removing the consumer repairs it.
  await ok(dir, ["remove", "tool-reviewer"]);
  expect(components(dir)["tool-reviewer"]).toBeUndefined();
  await ok(dir, ["remove", "deployment-acme"]);
}, 120_000);

test("a deployment that cannot run what is installed may be removed (to swap it), and doctor keeps saying what is missing", async () => {
  const dir = project();
  const from = registry();
  await ok(dir, ["add", "deployment-acme", "--registry", from, "--yes"]);
  await ok(dir, ["add", "tool-reviewer", "--registry", from, "--yes"]);
  // acme no longer says it supports the review host: tool-reviewer's need is unmet already.
  const manifest = JSON.parse(readFileSync(join(dir, "pikit.json"), "utf8"));
  manifest.components["deployment-acme"].deployment = { supports: ["services.compose"] };
  writeFileSync(join(dir, "pikit.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  // Removing it makes nothing worse: the same need stays unmet, with no deployment now. It is removed,
  // and the doctor that follows says what is still missing (exit 1: never green while it is).
  const removed = await runCli(["remove", "deployment-acme"], dir);
  expect(components(dir)["deployment-acme"]).toBeUndefined();
  expect(removed.code).toBe(1);
  expect(removed.err).toContain("tool-reviewer needs its deployment to support \"acme.review-host\", and no deployment-* component is installed");
  const doctor = await runCli(["doctor"], dir);
  expect(doctor.code).toBe(1);
  expect(doctor.out + doctor.err).toContain("no deployment-* component is installed");
  // A deployment that still does not support it may come in its place: installed, and still reported.
  const plain = await runCli(["add", "deployment-plain", "--registry", from, "--yes"], dir);
  expect(components(dir)["deployment-plain"]).toBeDefined();
  expect(plain.err).toContain("which deployment-plain does not");
}, 120_000);

test("a registry's deployment fields that the schema does not check are refused at add, named", async () => {
  const dir = project();
  const from = temp();
  publish(from, {
    "tool-reviewer": { ...reviewer("0.1.0", []), fields: { requires: { pikit: "0.0.1", capabilities: [], deployment: ["services.compose"] } } },
    "tool-hosted": { version: "0.1.0", files: { "index.ts": SIDE_INDEX }, fields: { deployment: { supports: ["acme.review-host"] } } },
  });
  await refused(dir, ["add", "tool-reviewer", "--registry", from, "--yes"], ["tool-reviewer's component.json:", '"services.compose"']);
  await refused(dir, ["add", "tool-hosted", "--registry", from, "--yes"], ["tool-hosted's component.json:", "only a deployment-* component has it"]);
}, 60_000);

/** A component providing `capability` (`provides`), or using it (`requires.capabilities`), with a default export so the App composes. */
const appComponent = (name: string, setup: string): string =>
  `import { defineComponent } from "@pikit/core";\n\nexport default defineComponent({\n  name: ${JSON.stringify(name)},\n  setup(pikit) {\n    ${setup}\n  },\n});\n`;

test("add refuses what an offered provider would bring that the deployment cannot run, after the offer is accepted and before anything is written", async () => {
  const dir = project();
  const from = temp();
  publish(from, {
    ...BASE,
    // The registry's own capability, offered: its only provider needs the review host of its deployment.
    "outbound-acme": {
      version: "0.1.0",
      files: { "index.ts": appComponent("outbound-acme", 'pikit.provide("acme.queue" as never, {} as never);') },
      fields: {
        provides: ["acme.queue"],
        declares: { capabilities: { "acme.queue": { mode: "single", stability: "experimental", summary: "Acme's queue of reviews.", offer: true } } },
        requires: { pikit: "0.0.1", capabilities: [], deployment: ["acme.review-host"] },
      },
    },
    // Needs nothing of the deployment itself: only what it brings does.
    "tool-queuer": {
      version: "0.1.0",
      files: { "index.ts": appComponent("tool-queuer", 'pikit.use("acme.queue" as never);') },
      fields: { requires: { pikit: "0.0.1", capabilities: ["acme.queue"] } },
    },
  });
  await ok(dir, ["add", "deployment-plain", "--registry", from, "--yes"]);
  // The named component passes the first check; the offer accepted (`--yes`) is what the second refuses.
  await refused(dir, ["add", "tool-queuer", "--registry", from, "--yes"], [
    'outbound-acme needs its deployment to support "acme.review-host"',
    "which deployment-plain does not",
  ]);
  expect(components(dir)["tool-queuer"]).toBeUndefined();
  expect(components(dir)["outbound-acme"]).toBeUndefined();
  // With a deployment that runs it, the same add brings the offer and succeeds.
  await ok(dir, ["remove", "deployment-plain"]);
  await ok(dir, ["add", "deployment-acme", "--registry", from, "--yes"]);
  await ok(dir, ["add", "tool-queuer", "--registry", from, "--yes"]);
  expect(components(dir)["outbound-acme"]?.installedFor).toEqual(["tool-queuer"]);
}, 120_000);

test("ui on refuses a dashboard whose components the deployment cannot run, before anything is written", async () => {
  const from = temp();
  publish(from, {
    ...BASE,
    // A registry's own dashboard component, under any name: it needs the review host of its deployment.
    "panel-acme": {
      version: "0.1.0",
      files: { "index.ts": appComponent("panel-acme", "") },
      fields: { requires: { pikit: "0.0.1", capabilities: [], deployment: ["acme.review-host"] } },
    },
  });
  mkdirSync(join(from, "dashboard", "files"), { recursive: true });
  writeFileSync(join(from, "dashboard", "files", "README.md"), "# A dashboard\n");
  writeFileSync(join(from, "dashboard", "dashboard.json"), JSON.stringify({ components: ["panel-acme"], defaultFor: {} }));
  // The project's own registry is this one: `ui on` reads the dashboard of the project's default registry.
  const dir = project();
  writeProjectManifest(dir, emptyManifest(from));
  await ok(dir, ["add", "deployment-plain", "--yes"]);
  await refused(dir, ["ui", "on", "--yes"], ['panel-acme needs its deployment to support "acme.review-host"', "which deployment-plain does not"]);
  expect(existsSync(join(dir, "src", "dashboard"))).toBe(false);
}, 120_000);
