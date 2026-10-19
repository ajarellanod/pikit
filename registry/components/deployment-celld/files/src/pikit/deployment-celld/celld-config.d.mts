/** The types of `celld-config.mjs`, plain JavaScript so that Node runs it in a CI deploy without pikit. */

/** A parsed `wrangler.jsonc`: the keys deployment-celld reads; the rest passes through as it is. */
export type ProjectConfig = Record<string, unknown> & {
  name?: unknown;
  vars?: unknown;
  rules?: unknown;
  build?: { command?: unknown; watch_dir?: unknown };
};

export const PROJECT_CONFIG: "wrangler.jsonc";
export const GENERATED_CONFIG: "wrangler.celld.jsonc";
export const DEPLOYMENT_VAR: "PIKIT_DEPLOYMENT";
export const CLOUDFLARE_ONLY: Readonly<Record<"build" | "observability" | "version_metadata", string>>;

export function parseJsonc(text: string): unknown;
export function readProjectConfig(cwd: string): ProjectConfig;
export function scriptName(cwd: string, project?: ProjectConfig): string;
export function celldRules(rules: unknown): { type: unknown; globs: string[] }[];
export function celldConfig(project: ProjectConfig, options: { name: string; secrets?: Readonly<Record<string, string>>; deployment: string }): Record<string, unknown>;
export function isMachineVariable(name: string): boolean;
export function workerSecrets(entries: Readonly<Record<string, string | undefined>>): Record<string, string>;
export function readDotEnv(cwd: string): Record<string, string | undefined>;
export function exampleNames(cwd: string): string[];
export function writePrivate(path: string, text: string): void;
export function writeGeneratedConfig(cwd: string, config: Record<string, unknown>): string;
export function dotenvText(entries: Readonly<Record<string, string>>, header?: string): string;
export function buildCommand(project: ProjectConfig): string | undefined;
