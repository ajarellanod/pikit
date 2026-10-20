/**
 * What a composition needs of its deployment, checked in one place: the planner every command uses
 * (`new`, the wizard, `add`, `remove`, `upgrade`, `ui`, `doctor`, the checks before `dev` and `up`,
 * and `registry validate`), so the same set of components gets the same answer everywhere.
 *
 * A project has one deployment: its `deployment-*` component (a kind, as every kind is: never a
 * component's name). It supports some protocols (`deployment.supports`); a component may need some
 * (`requires.deployment`), and a component with a `compose` file needs `services.compose`. Those are
 * names of protocols, never of components, and an open set: a registry may name its own.
 *
 * - Exactly one deployment is checked: several are a problem of their own, never a union of what each
 *   supports. None is fine while nothing needs one, and a problem as soon as something does.
 * - Pure: it reads no file, imports no component, runs nothing. Its input is what the manifests (a
 *   registry's) or the install records (`pikit.json`'s, which hold the same fields) say.
 * - It is not the runtime's capability graph: what an App provides and uses is still checked by
 *   composing it. This is what the deployment does beside the App (Compose services, a deployer).
 */

import { COMPOSE_SERVICES, kindOf } from "../registry/manifest.ts";

/** What the planner reads of a component: a manifest (with its name) and an install record both fit. */
export interface DeploymentFacts {
  name: string;
  compose?: string | undefined;
  deployment?: { supports: readonly string[] } | undefined;
  requires?: { deployment?: readonly string[] | undefined } | undefined;
}

export type CompositionIssueCode = "deployment_missing" | "deployment_ambiguous" | "deployment_requirement_unmet";

/** One problem of a composition, identified by its fields, never by its wording. */
export interface CompositionIssue {
  code: CompositionIssueCode;
  /** Who needs it (`deployment_missing`, `deployment_requirement_unmet`). */
  component?: string;
  /** What it needs (`deployment_missing`, `deployment_requirement_unmet`). */
  requirement?: string;
  /** Why it needs it: declared in `requires.deployment`, or implied by its `compose` file. */
  via?: "requires" | "compose";
  /** The deployment that does not support it (`deployment_requirement_unmet`). */
  deployment?: string;
  /** The deployments installed together (`deployment_ambiguous`), sorted. */
  deployments?: readonly string[];
}

export interface CompositionPlan {
  /** The one deployment, when there is exactly one. */
  deployment?: string;
  /** Sorted, without repeats: the same composition always gives the same list. */
  issues: readonly CompositionIssue[];
}

/** The deployments among `names`: the components of kind `deployment`, sorted. */
export function deploymentsOf(names: readonly string[]): string[] {
  return [...new Set(names.filter((name) => kindOf(name) === "deployment"))].sort();
}

/** What `component` needs of the deployment, with why, sorted: its `requires.deployment`, and `services.compose` for a `compose` file. */
export function deploymentRequirements(component: DeploymentFacts): { requirement: string; via: "requires" | "compose" }[] {
  const needs = new Map<string, "requires" | "compose">();
  for (const requirement of component.requires?.deployment ?? []) needs.set(requirement, "requires");
  if (typeof component.compose === "string" && !needs.has(COMPOSE_SERVICES)) needs.set(COMPOSE_SERVICES, "compose");
  return [...needs].sort(([a], [b]) => a.localeCompare(b)).map(([requirement, via]) => ({ requirement, via }));
}

/** The composition's deployment and its problems. `components`: every component of it, the deployment included. */
export function planComposition(components: readonly DeploymentFacts[]): CompositionPlan {
  const byName = new Map(components.map((component) => [component.name, component]));
  const deployments = deploymentsOf([...byName.keys()]);
  const issues: CompositionIssue[] = [];
  if (deployments.length > 1) {
    issues.push({ code: "deployment_ambiguous", deployments });
    return { issues };
  }
  const deployment = deployments[0];
  const supported = new Set(deployment === undefined ? [] : (byName.get(deployment)?.deployment?.supports ?? []));
  for (const component of [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (component.name === deployment) continue;
    for (const { requirement, via } of deploymentRequirements(component)) {
      if (deployment === undefined) issues.push({ code: "deployment_missing", component: component.name, requirement, via });
      else if (!supported.has(requirement)) issues.push({ code: "deployment_requirement_unmet", component: component.name, requirement, via, deployment });
    }
  }
  return { ...(deployment !== undefined && { deployment }), issues: issues.sort(compareIssues) };
}

/** An issue's identity: its code and fields, never its wording. */
export function issueKey(issue: CompositionIssue): string {
  return [issue.code, issue.component ?? "", issue.requirement ?? "", issue.deployment ?? "", (issue.deployments ?? []).join(",")].join("|");
}

/** The issues of `after` that `before` did not have: what an operation would introduce. */
export function introducedIssues(before: CompositionPlan, after: CompositionPlan): readonly CompositionIssue[] {
  const known = new Set(before.issues.map(issueKey));
  return after.issues.filter((issue) => !known.has(issueKey(issue)));
}

/** One line for a person: what is wrong, and what would make it right. */
export function formatCompositionIssue(issue: CompositionIssue): string {
  const why = issue.via === "compose" ? " (it ships a Compose file, which only a deployment that runs them can start)" : "";
  switch (issue.code) {
    case "deployment_ambiguous":
      return `several deployments are installed (${(issue.deployments ?? []).join(", ")}): a project has exactly one; remove all but one`;
    case "deployment_missing":
      return `${issue.component} needs its deployment to support "${issue.requirement}"${why}, and no deployment-* component is installed: add one that supports it`;
    case "deployment_requirement_unmet":
      return `${issue.component} needs its deployment to support "${issue.requirement}"${why}, which ${issue.deployment} does not: use a deployment that supports it, or remove ${issue.component}`;
  }
}

function compareIssues(a: CompositionIssue, b: CompositionIssue): number {
  return issueKey(a).localeCompare(issueKey(b));
}
