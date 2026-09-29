/**
 * deployment-cloudflare's real `Conversation` class, a second time, over the Apps that
 * platform-cloudflare's tests compose (`src/worker.ts` exports it as `PlatformConversation`, bound as
 * `PLATFORM_CONVERSATION`). Its object App is what the running test last passed to `composeObjects`
 * (the tests and the objects share one isolate): the entrypoint reads the definition's components and
 * config when an object starts its App, on its first event.
 *
 * An object composes its App once, as on Cloudflare, and never stops it (K6). So the tests' `resetObjects`
 * (`test/host.ts`) resets every object's instance: the next event starts a new one, which composes what
 * the test composed since.
 */

import { type AppDefinition, type ComponentDefinition, defineApp, silentLogger } from "@pikit/core";
import { createEntrypoint } from "../../../registry/components/deployment-cloudflare/files/src/pikit/deployment-cloudflare/entrypoint.ts";

/** platform-cloudflare's `binding` in these Apps: the class below. */
export const PLATFORM_BINDING = "PLATFORM_CONVERSATION";

let composed: { components: ComponentDefinition[]; config: Record<string, unknown> } | undefined;

/**
 * What the objects' Apps are made of from now on, with platform-cloudflare's `binding` set to this
 * class. An object whose App already started keeps it until `resetObjects`.
 */
export function composeObjects(components: ComponentDefinition[], config: Record<string, unknown> = {}): void {
  const platform = (config["platform-cloudflare"] ?? {}) as Record<string, unknown>;
  composed = { components, config: { ...config, "platform-cloudflare": { binding: PLATFORM_BINDING, ...platform } } };
}

/** Forgets the composition: an object that starts before the next `composeObjects` fails to. */
export function forgetComposition(): void {
  composed = undefined;
}

const current = () => {
  if (composed === undefined) throw new Error("workerd lane: no composeObjects() for PlatformConversation");
  return composed;
};

/** The object App's definition, read when an object starts: what the test composed then. */
const objectApp: AppDefinition = {
  get components() {
    return current().components;
  },
  get config() {
    return current().config;
  },
  create: () => defineApp({ components: current().components, config: current().config, target: "cloudflare", logger: silentLogger }).create(),
};

export const platformEntrypoint = createEntrypoint(objectApp, undefined, { logger: silentLogger });
