/**
 * The composition planner: one deployment, checked against what every other component needs of it,
 * by protocol names and kinds, never by a component's name.
 */

import { expect, test } from "bun:test";
import {
  type CompositionIssue,
  type CompositionPlan,
  type DeploymentFacts,
  deploymentRequirements,
  deploymentsOf,
  formatCompositionIssue,
  introducedIssues,
  issueKey,
  planComposition,
} from "./composition.ts";
import type { InstalledComponent } from "./pikit-json.ts";

const docker: DeploymentFacts = { name: "deployment-docker", deployment: { supports: ["services.compose", "proposals.deployer"] } };
const local: DeploymentFacts = { name: "deployment-local" };
const proposals: DeploymentFacts = { name: "proposals-local", compose: "compose.yaml", requires: { deployment: ["proposals.deployer"] } };
const tunnel: DeploymentFacts = { name: "expose-cloudflare-tunnel", compose: "compose.yaml" };
const plain: DeploymentFacts = { name: "channel-telegram" };

test("a compose file implies services.compose; requires.deployment is what it declares, sorted, each once", () => {
  expect(deploymentRequirements(tunnel)).toEqual([{ requirement: "services.compose", via: "compose" }]);
  expect(deploymentRequirements(proposals)).toEqual([
    { requirement: "proposals.deployer", via: "requires" },
    { requirement: "services.compose", via: "compose" },
  ]);
  expect(deploymentRequirements({ name: "x-y", requires: { deployment: ["zeta.b", "alpha.a", "zeta.b"] } })).toEqual([
    { requirement: "alpha.a", via: "requires" },
    { requirement: "zeta.b", via: "requires" },
  ]);
  // Declared by hand too (which a manifest may not do), it is still one requirement, the declared one.
  expect(deploymentRequirements({ name: "x-y", compose: "c.yaml", requires: { deployment: ["services.compose"] } })).toEqual([
    { requirement: "services.compose", via: "requires" },
  ]);
  expect(deploymentRequirements(plain)).toEqual([]);
  expect(deploymentRequirements({ name: "x-y", requires: {} })).toEqual([]);
});

test("deploymentsOf: the components of kind deployment, by kind alone, sorted, each once", () => {
  expect(deploymentsOf(["proposals-local", "deployment-zeta", "deployment-alpha", "deployment-zeta", "deploymentish-x", "my-deployment"])).toEqual([
    "deployment-alpha",
    "deployment-zeta",
  ]);
  expect(deploymentsOf([])).toEqual([]);
});

test("a deployment that supports what everything needs: no issue, and it is the plan's deployment", () => {
  expect(planComposition([docker, proposals, tunnel, plain])).toEqual({ deployment: "deployment-docker", issues: [] });
});

test("a deployment that does not support a compose file's services is an unmet requirement via compose", () => {
  expect(planComposition([local, tunnel, plain])).toEqual({
    deployment: "deployment-local",
    issues: [{ code: "deployment_requirement_unmet", component: "expose-cloudflare-tunnel", requirement: "services.compose", via: "compose", deployment: "deployment-local" }],
  });
});

test("local with proposals-local: both of its needs are unmet, each its own issue with its reason", () => {
  expect(planComposition([local, proposals]).issues).toEqual([
    { code: "deployment_requirement_unmet", component: "proposals-local", requirement: "proposals.deployer", via: "requires", deployment: "deployment-local" },
    { code: "deployment_requirement_unmet", component: "proposals-local", requirement: "services.compose", via: "compose", deployment: "deployment-local" },
  ]);
});

test("a declared requirement only partly supported reports only what is missing", () => {
  const composeOnly: DeploymentFacts = { name: "deployment-compose", deployment: { supports: ["services.compose"] } };
  expect(planComposition([composeOnly, proposals])).toEqual({
    deployment: "deployment-compose",
    issues: [{ code: "deployment_requirement_unmet", component: "proposals-local", requirement: "proposals.deployer", via: "requires", deployment: "deployment-compose" }],
  });
});

test("no deployment: fine while nothing needs one, a missing deployment for each requirement otherwise", () => {
  expect(planComposition([plain, { name: "tool-bash" }])).toEqual({ issues: [] });
  expect(planComposition([])).toEqual({ issues: [] });
  expect(planComposition([plain, proposals])).toEqual({
    issues: [
      { code: "deployment_missing", component: "proposals-local", requirement: "proposals.deployer", via: "requires" },
      { code: "deployment_missing", component: "proposals-local", requirement: "services.compose", via: "compose" },
    ],
  });
});

test("two deployments are ambiguous, their supports are never added up, and each is still checked alone", () => {
  // Only the second supports what the consumer needs: it must not pass through the first.
  const first: DeploymentFacts = { name: "deployment-alpha", deployment: { supports: [] } };
  const second: DeploymentFacts = { name: "deployment-beta", deployment: { supports: ["acme.review-host"] } };
  const consumer: DeploymentFacts = { name: "review-acme", requires: { deployment: ["acme.review-host"] } };
  const plan = planComposition([second, consumer, first]);
  expect(plan).toEqual({
    issues: [
      { code: "deployment_ambiguous", deployments: ["deployment-alpha", "deployment-beta"] },
      { code: "deployment_requirement_unmet", component: "review-acme", requirement: "acme.review-host", via: "requires", deployment: "deployment-alpha" },
    ],
  });
  expect(plan.deployment).toBeUndefined();
  // The ambiguity never hides a new need neither supports: adding one to an already ambiguous project is new.
  const needsY: DeploymentFacts = { name: "widget-y", requires: { deployment: ["acme.y"] } };
  expect(introducedIssues(planComposition([first, second]), planComposition([first, second, needsY])).map((issue) => [issue.code, issue.deployment])).toEqual([
    ["deployment_requirement_unmet", "deployment-alpha"],
    ["deployment_requirement_unmet", "deployment-beta"],
  ]);
  // Even when each would satisfy everything on its own.
  expect(planComposition([docker, { ...docker, name: "deployment-other" }, proposals])).toEqual({
    issues: [{ code: "deployment_ambiguous", deployments: ["deployment-docker", "deployment-other"] }],
  });
});

test("the deployment's own facts are never checked against itself", () => {
  // Even a (malformed) deployment that needs what it does not support, or ships a compose file.
  const odd: DeploymentFacts = { name: "deployment-odd", compose: "c.yaml", requires: { deployment: ["acme.thing"] }, deployment: { supports: [] } };
  expect(planComposition([odd, plain])).toEqual({ deployment: "deployment-odd", issues: [] });
});

test("the same composition gives the same plan whatever the order of its components", () => {
  const consumers: DeploymentFacts[] = [
    { name: "zeta-consumer", compose: "c.yaml", requires: { deployment: ["b.two", "a.one"] } },
    { name: "alpha-consumer", requires: { deployment: ["c.three"] } },
    { name: "mid-consumer", requires: { deployment: ["a.one"] } },
  ];
  const forward = planComposition([local, ...consumers]);
  const backward = planComposition([...consumers].reverse().concat(local));
  expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
  expect(forward.issues.map((issue) => `${issue.component}:${issue.requirement}`)).toEqual([
    "alpha-consumer:c.three",
    "mid-consumer:a.one",
    "zeta-consumer:a.one",
    "zeta-consumer:b.two",
    "zeta-consumer:services.compose",
  ]);
});

test("a component listed twice, or a requirement twice, is reported once", () => {
  const twice: DeploymentFacts = { name: "acme-widget", requires: { deployment: ["acme.review-host", "acme.review-host"] } };
  expect(planComposition([local, twice, twice]).issues).toEqual([
    { code: "deployment_requirement_unmet", component: "acme-widget", requirement: "acme.review-host", via: "requires", deployment: "deployment-local" },
  ]);
  // A deployment listed twice is still one deployment, not an ambiguity.
  expect(planComposition([docker, docker, proposals])).toEqual({ deployment: "deployment-docker", issues: [] });
});

test("arbitrary names and a registry's own requirement: matched by protocol, never by a component's name", () => {
  const host: DeploymentFacts = { name: "deployment-acme-cloud", deployment: { supports: ["acme.review-host"] } };
  const consumer: DeploymentFacts = { name: "reviewer-acme", requires: { deployment: ["acme.review-host"] } };
  expect(planComposition([host, consumer])).toEqual({ deployment: "deployment-acme-cloud", issues: [] });
  // The same consumer with docker, which supports other things.
  expect(planComposition([docker, consumer]).issues).toEqual([
    { code: "deployment_requirement_unmet", component: "reviewer-acme", requirement: "acme.review-host", via: "requires", deployment: "deployment-docker" },
  ]);
  // The kit's own names give no special treatment: a host named like docker with no supports supports nothing.
  expect(planComposition([{ name: "deployment-docker" }, tunnel]).issues).toHaveLength(1);
});

test("install records of pikit.json, with their names, are planned as manifests are", () => {
  const record = (fields: Partial<InstalledComponent>): InstalledComponent => ({
    registry: "default", version: "0.0.1", requires: { pikit: "0.0.1" }, files: {}, dependencies: {}, addedDependencies: [], environment: [], ...fields,
  });
  const components: Record<string, InstalledComponent> = {
    "deployment-local": record({}),
    "proposals-local": record({ requires: { pikit: "0.0.1", deployment: ["proposals.deployer"] }, compose: "src/pikit/proposals-local/compose.yaml" }),
    "channel-telegram": record({}),
  };
  const facts: DeploymentFacts[] = Object.entries(components).map(([name, installed]) => ({ name, ...installed }));
  expect(planComposition(facts)).toEqual(planComposition([local, proposals, plain]));
  const withDocker = { ...components, "deployment-local": undefined, "deployment-docker": record({ deployment: { supports: ["services.compose", "proposals.deployer"] } }) };
  const dockerFacts = Object.entries(withDocker).flatMap(([name, installed]) => (installed === undefined ? [] : [{ name, ...installed }]));
  expect(planComposition(dockerFacts)).toEqual({ deployment: "deployment-docker", issues: [] });
});

test("introducedIssues: only the issues the new plan has and the old one did not, by identity", () => {
  const before = planComposition([local, tunnel]);
  const after = planComposition([local, tunnel, proposals]);
  expect(introducedIssues(before, after)).toEqual([
    { code: "deployment_requirement_unmet", component: "proposals-local", requirement: "proposals.deployer", via: "requires", deployment: "deployment-local" },
    { code: "deployment_requirement_unmet", component: "proposals-local", requirement: "services.compose", via: "compose", deployment: "deployment-local" },
  ]);
  // Repairing (removing a consumer) introduces nothing, though issues remain.
  expect(introducedIssues(after, before)).toEqual([]);
  expect(before.issues).toHaveLength(1);
  expect(introducedIssues(after, after)).toEqual([]);
  // A need already unmet stays the same problem when the deployment failing it changes (another that
  // does not support it either, or none): nothing is made worse, so a repair step by step stays possible.
  const otherLocal = planComposition([{ name: "deployment-native" }, tunnel]);
  expect(introducedIssues(before, otherLocal)).toEqual([]);
  expect(introducedIssues(before, planComposition([tunnel]))).toEqual([]);
  // A need that was met and no longer is, is new: swapping a deployment that supports it for one that does not.
  expect(introducedIssues(planComposition([docker, tunnel]), otherLocal)).toEqual([
    { code: "deployment_requirement_unmet", component: "expose-cloudflare-tunnel", requirement: "services.compose", via: "compose", deployment: "deployment-native" },
  ]);
  // A second deployment, removing the only one: new issues of their own.
  const empty: CompositionPlan = { issues: [] };
  expect(introducedIssues(empty, planComposition([docker, local])).map((issue) => issue.code)).toEqual(["deployment_ambiguous"]);
  expect(introducedIssues(planComposition([docker, proposals]), planComposition([proposals])).map((issue) => issue.code)).toEqual([
    "deployment_missing",
    "deployment_missing",
  ]);
});

test("issueKey: the code and fields, never the wording; each field tells issues apart", () => {
  const issue: CompositionIssue = { code: "deployment_requirement_unmet", component: "a-b", requirement: "x.y", via: "requires", deployment: "deployment-c" };
  expect(issueKey(issue)).toBe(issueKey({ ...issue }));
  const variants: CompositionIssue[] = [
    { ...issue, code: "deployment_missing" },
    { ...issue, component: "a-c" },
    { ...issue, requirement: "x.z" },
    { ...issue, deployment: "deployment-d" },
    { code: "deployment_ambiguous", deployments: ["deployment-a", "deployment-b"] },
    { code: "deployment_ambiguous", deployments: ["deployment-a", "deployment-c"] },
  ];
  expect(new Set([issue, ...variants].map(issueKey)).size).toBe(variants.length + 1);
});

test("formatCompositionIssue names who needs what, of which deployment, why, and what to do", () => {
  const [unmetCompose, unmetDeclared] = [
    planComposition([local, tunnel]).issues[0] as CompositionIssue,
    planComposition([local, { name: "reviewer-acme", requires: { deployment: ["acme.review-host"] } }]).issues[0] as CompositionIssue,
  ];
  expect(formatCompositionIssue(unmetCompose)).toBe(
    'expose-cloudflare-tunnel needs its deployment to support "services.compose" (it ships a Compose file, which only a deployment that runs them can start), which deployment-local does not: use a deployment that supports it, or remove expose-cloudflare-tunnel',
  );
  expect(formatCompositionIssue(unmetDeclared)).toBe(
    'reviewer-acme needs its deployment to support "acme.review-host", which deployment-local does not: use a deployment that supports it, or remove reviewer-acme',
  );
  expect(formatCompositionIssue(planComposition([proposals]).issues[0] as CompositionIssue)).toBe(
    'proposals-local needs its deployment to support "proposals.deployer", and no deployment-* component is installed: add one that supports it',
  );
  expect(formatCompositionIssue(planComposition([docker, local]).issues[0] as CompositionIssue)).toBe(
    "several deployments are installed (deployment-docker, deployment-local): a project has exactly one; remove all but one",
  );
});
