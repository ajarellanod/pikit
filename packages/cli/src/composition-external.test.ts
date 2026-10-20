/**
 * Composition in a registry that is not the kit's: deployments, consumers and requirements under
 * arbitrary names (`deployment-acme`, `tool-reviewer`, `acme.review-host`), checked by `registry
 * validate` and the preset plan with no list of names in the CLI (features/component-composition.md,
 * the external registry of its test matrix).
 *
 * - `deployment-acme` supports `services.compose` and `acme.review-host`, a protocol the kit has never
 *   heard of; `deployment-plain` supports nothing.
 * - `tool-reviewer` needs `acme.review-host` of its deployment; `expose-side` ships a Compose file,
 *   so it needs `services.compose` without saying so.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type CompositionIssue, formatCompositionIssue } from "./project/composition.ts";
import { resolvePresetPlan } from "./project/preset-plan.ts";
import { openRegistry } from "./project/registry-source.ts";
import { validate } from "./registry/commands.ts";
import { deploymentProblems } from "./registry/manifest.ts";
import { runCli } from "./testing/cli.ts";
import { compositionRegistry, editManifest, manifestOf, type ScratchComponent, scratchDir } from "./testing/composition-registry.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = scratchDir();
  dirs.push(dir);
  return dir;
};

const REVIEW_HOST = "acme.review-host";

const ACME: Record<string, ScratchComponent> = {
  "deployment-acme": { title: "Acme hosting", manifest: { deployment: { supports: ["services.compose", REVIEW_HOST] } } },
  "deployment-plain": { title: "Plain hosting", manifest: { deployment: { supports: [] } } },
  "tool-reviewer": { title: "Reviews on the host", manifest: { requires: { deployment: [REVIEW_HOST] } } },
  "expose-side": { title: "A side service", manifest: { compose: "compose.yaml" }, files: { "compose.yaml": "services:\n  side:\n    image: busybox\n" } },
};

/** The preset: Acme by default, or Plain; the reviewer offered as a feature. */
const REVIEW = "title: Review\ncomponents: [deployment-acme]\nchoose:\n  - kind: deployment\n    question: Where does it run?\nfeatures:\n  - components: [tool-reviewer]\n";

const unmet = (component: string, requirement: string, deployment: string, via: CompositionIssue["via"] = "requires"): string =>
  formatCompositionIssue({ code: "deployment_requirement_unmet", component, requirement, via, deployment });

test("registry validate accepts a preset whose feature only one of its deployments supports: offered with it, unavailable with the other", async () => {
  const root = await compositionRegistry(temp(), ACME, { review: REVIEW });

  // The public command, as a registry author runs it.
  const run = await runCli(["registry", "validate", root], root);
  expect(`${run.out}${run.err}`).not.toContain("presets/review.yaml");
  expect(run.code).toBe(0);

  const registry = openRegistry(root);
  const withAcme = resolvePresetPlan(registry, { preset: "review", targets: ["server"] });
  expect(withAcme.problems).toEqual([]);
  expect(withAcme.composition.deployment).toBe("deployment-acme");
  expect(withAcme.features.find((f) => f.name === "tool-reviewer")).toMatchObject({ available: true, unavailable: [] });

  const withPlain = resolvePresetPlan(registry, { preset: "review", targets: ["server"], choices: ["deployment-plain"] });
  expect(withPlain.problems).toEqual([]);
  const reviewer = withPlain.features.find((f) => f.name === "tool-reviewer");
  expect(reviewer?.available).toBe(false);
  expect(reviewer?.unavailable).toEqual([unmet("tool-reviewer", REVIEW_HOST, "deployment-plain")]);

  // Chosen anyway, the plan refuses it with the same reason.
  const forced = resolvePresetPlan(registry, { preset: "review", targets: ["server"], choices: ["deployment-plain", "tool-reviewer"] });
  expect(forced.problems.some((p) => p.includes(unmet("tool-reviewer", REVIEW_HOST, "deployment-plain")))).toBe(true);
}, 60_000);

test("a preset whose own components need what its deployment lacks is reported, Compose and ambiguity included", async () => {
  const root = await compositionRegistry(temp(), ACME, {
    review: REVIEW,
    plain: "components: [deployment-plain, tool-reviewer]\n",
    sided: "components: [expose-side, deployment-plain]\n",
    // Two deployments never add up what each supports.
    both: "components: [deployment-plain, deployment-acme, tool-reviewer]\n",
    nowhere: "components: [tool-reviewer]\n",
  });

  const problems = (await validate(root)).problems;

  expect(problems).toContain(`presets/plain.yaml: on server, ${unmet("tool-reviewer", REVIEW_HOST, "deployment-plain")}`);
  expect(problems).toContain(`presets/sided.yaml: on server, ${unmet("expose-side", "services.compose", "deployment-plain", "compose")}`);
  expect(problems).toContain(
    `presets/both.yaml: on server, ${formatCompositionIssue({ code: "deployment_ambiguous", deployments: ["deployment-acme", "deployment-plain"] })}`,
  );
  expect(problems).toContain(
    `presets/nowhere.yaml: on server, ${formatCompositionIssue({ code: "deployment_missing", component: "tool-reviewer", requirement: REVIEW_HOST, via: "requires" })}`,
  );
  // The preset that offers the alternatives is not one of them.
  expect(problems.filter((p) => p.startsWith("presets/review.yaml"))).toEqual([]);
}, 60_000);

test("the same composition under other names gets the same answer: no component's name decides it", async () => {
  const renamed: Record<string, ScratchComponent> = {
    "deployment-zeta": { title: "Zeta", manifest: { deployment: { supports: ["services.compose", REVIEW_HOST] } } },
    "deployment-bare": { title: "Bare", manifest: { deployment: { supports: [] } } },
    "tool-critic": { title: "Critic", manifest: { requires: { deployment: [REVIEW_HOST] } } },
  };
  const root = await compositionRegistry(temp(), renamed, {
    review: "components: [deployment-zeta]\nchoose:\n  - kind: deployment\nfeatures:\n  - components: [tool-critic]\n",
    plain: "components: [deployment-bare, tool-critic]\n",
  });

  const problems = (await validate(root)).problems;

  expect(problems).toEqual([`presets/plain.yaml: on server, ${unmet("tool-critic", REVIEW_HOST, "deployment-bare")}`]);
}, 60_000);

test("registry validate reports deployment fields where they do not belong, and accepts a requirement the kit has never heard of", async () => {
  const root = await compositionRegistry(temp(), {
    ...ACME,
    // What only a deployment says, on a tool.
    "tool-hosting": { title: "Hosting", manifest: { deployment: { supports: ["services.compose"] } } },
    // A deployment needs nothing of a deployment.
    "deployment-needy": { title: "Needy", manifest: { requires: { deployment: [REVIEW_HOST] } } },
    // A Compose file implies services.compose: written by hand it is redundant.
    "tool-composed": { title: "Composed", manifest: { requires: { deployment: ["services.compose"] } } },
    // Needs a protocol no deployment of this registry supports: that is a composition's problem, not the component's.
    "tool-orphan": { title: "Orphan", manifest: { requires: { deployment: ["zeta.unprovided"] } } },
  });

  const problems = (await validate(root)).problems;

  for (const name of ["tool-hosting", "deployment-needy", "tool-composed"]) {
    const expected = deploymentProblems(manifestOf(root, name));
    expect(expected.length).toBeGreaterThan(0);
    for (const problem of expected) expect(problems).toContain(`${name}: ${problem}`);
  }
  expect(problems.filter((p) => /^(tool-orphan|tool-reviewer|deployment-acme|deployment-plain|expose-side):/.test(p))).toEqual([]);
  expect(problems).toHaveLength(3);
}, 60_000);

test("registry validate reports drift of the generated extensions", async () => {
  const root = await compositionRegistry(temp(), {
    "extension-acme-notes": { title: "Notes", setup: 'pikit.provideKeyed("agent.extension", "acme-notes", {});' },
    "tool-reviewer": ACME["tool-reviewer"] as ScratchComponent,
  });
  expect(manifestOf(root, "extension-acme-notes").extensions).toEqual(["acme-notes"]);
  expect((await validate(root)).problems).toEqual([]);

  // Forgotten, and invented.
  editManifest(root, "extension-acme-notes", (manifest) => {
    delete manifest.extensions;
    return manifest;
  });
  editManifest(root, "tool-reviewer", (manifest) => ({ ...manifest, extensions: ["ghost"] }));

  const problems = (await validate(root)).problems;
  expect(problems.some((p) => p.startsWith("extension-acme-notes: extensions drifted from setup"))).toBe(true);
  expect(problems.some((p) => p.startsWith("tool-reviewer: extensions drifted from setup"))).toBe(true);
}, 60_000);

test("pikit new refuses a feature the chosen deployment does not support, before it writes anything", async () => {
  const root = await compositionRegistry(temp(), ACME, { review: REVIEW });
  const parent = temp();

  const run = await runCli(["new", "reviewing", "--registry", root, "--preset", "review", "--with", "deployment-plain", "--with", "tool-reviewer"], parent);

  expect(run.code).not.toBe(0);
  expect(`${run.out}${run.err}`).toContain(unmet("tool-reviewer", REVIEW_HOST, "deployment-plain"));
  expect(existsSync(join(parent, "reviewing"))).toBe(false);
}, 60_000);
