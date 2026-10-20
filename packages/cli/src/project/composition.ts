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

/**
 * The planner's input from install records by name (`pikit.json`'s components): no registry needed,
 * so `doctor` and `remove` check a project whose registry is gone.
 */
export function compositionOf(records: Readonly<Record<string, Omit<DeploymentFacts, "name">>>): DeploymentFacts[] {
  return Object.entries(records).map(([name, record]) => ({ name, compose: record.compose, deployment: record.deployment, requires: record.requires }));
}

/** The composition's deployment and its problems. `components`: every component of it, the deployment included. */
export function planComposition(components: readonly DeploymentFacts[]): CompositionPlan {
  const byName = new Map(components.map((component) => [component.name, component]));
  const deployments = deploymentsOf([...byName.keys()]);
  const issues: CompositionIssue[] = [];
  // Several deployments are a problem of their own, and each is still checked alone: what one supports
  // never covers another's gap, and a need none of them supports is never hidden behind the ambiguity.
  if (deployments.length > 1) issues.push({ code: "deployment_ambiguous", deployments });
  const deploymentSet = new Set(deployments);
  for (const component of [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (deploymentSet.has(component.name)) continue;
    for (const { requirement, via } of deploymentRequirements(component)) {
      if (deployments.length === 0) issues.push({ code: "deployment_missing", component: component.name, requirement, via });
      for (const deployment of deployments) {
        if (!(byName.get(deployment)?.deployment?.supports ?? []).includes(requirement)) {
          issues.push({ code: "deployment_requirement_unmet", component: component.name, requirement, via, deployment });
        }
      }
    }
  }
  const deployment = deployments.length === 1 ? deployments[0] : undefined;
  return { ...(deployment !== undefined && { deployment }), issues: issues.sort(compareIssues) };
}

/** An issue's identity: its code and fields, never its wording. */
export function issueKey(issue: CompositionIssue): string {
  return [issue.code, issue.component ?? "", issue.requirement ?? "", issue.deployment ?? "", (issue.deployments ?? []).join(",")].join("|");
}

/**
 * What an issue holds unmet, for `introducedIssues`: a component's need, whichever deployment fails it
 * (none, this one or another), or the set of deployments installed together.
 */
function obligationKey(issue: CompositionIssue): string {
  return issue.code === "deployment_ambiguous" ? `ambiguous|${(issue.deployments ?? []).join(",")}` : `need|${issue.component ?? ""}|${issue.requirement ?? ""}`;
}

/**
 * The issues of `after` whose need `before` did not already leave unmet: what an operation would
 * introduce. A need unmet before stays a pre-existing problem when the deployment that fails it changes
 * (removed, or swapped for another that does not support it either): the operation made nothing worse,
 * and `doctor` keeps reporting it, so repairing a project step by step stays possible.
 */
export function introducedIssues(before: CompositionPlan, after: CompositionPlan): readonly CompositionIssue[] {
  const known = new Set(before.issues.map(obligationKey));
  return after.issues.filter((issue) => !known.has(obligationKey(issue)));
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
