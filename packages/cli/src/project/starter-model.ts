/**
 * The starter agent's model and whether a set of components installs its provider. `pikit new` refuses,
 * before writing, a project whose runtime would name a provider nothing installs; `registry validate`
 * reports the same for every preset, so a registry author sees it before a user runs `pikit new`.
 */
import { modelProvider } from "./references.ts";
import type { Registry } from "./registry-source.ts";

/**
 * The starter agent's model, by the project's target, when the preset declares none: one whose provider
 * runs there. On a server, Anthropic's (`provider-anthropic`, which the server presets install). On
 * `durable` (Cloudflare), OpenRouter's (`provider-openrouter`, with an API key): `provider-anthropic` is
 * server-only.
 */
export const STARTER_MODEL: Record<string, string> = {
  server: "anthropic/claude-sonnet-4-6",
  durable: "openrouter/z-ai/glm-5.3-flash",
};

export function starterModel(target = "server"): string {
  return STARTER_MODEL[target] ?? (STARTER_MODEL.server as string);
}

/**
 * The starter agent's model names its provider by key (`anthropic/…`, `references.ts`). When a component
 * being installed reads it (uses `model.provider`, as the runtime does), one being installed must provide
 * that key. Returns why not, naming the registry's components that provide it, or `undefined`.
 */
export function starterModelProblem(registry: Registry, components: readonly string[], target: string, model: string, preset: string | undefined): string | undefined {
  const key = modelProvider(model);
  const uses = components.some((c) => {
    const { requires, optional } = registry.manifest(c);
    return [...requires.capabilities, ...optional.capabilities].includes("model.provider");
  });
  if (key === undefined || !uses) return undefined;
  const provides = (c: string) => registry.manifest(c).modelProviders?.includes(key) === true;
  // A provider with no keys recorded (a manifest from before `modelProviders`, or keys only its config
  // gives) may provide it: that is doctor's to say, once it composes.
  const unknown = (c: string) => registry.manifest(c).provides.includes("model.provider") && registry.manifest(c).modelProviders === undefined;
  if (components.some((c) => provides(c) || unknown(c))) return undefined;
  const providers = registry.names().filter((c) => provides(c) && registry.manifest(c).targets.includes(target));
  const fix =
    providers.length > 0
      ? `${providers.join(" or ")} provides it: list it in the preset's components, or give the preset a \`model\` whose provider it installs`
      : `no component of the registry ${registry.root} provides it on ${target}: give the preset a \`model\` whose provider it installs`;
  return `the starter agent's model "${model}" needs the model provider "${key}", which no component of the preset "${preset}" provides; ${fix}`;
}
