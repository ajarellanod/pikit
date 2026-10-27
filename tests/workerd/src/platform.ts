/**
 * deployment-cloudflare's real `Conversation` class, a second time, over the Apps that
 * actors-do's tests compose (`src/worker.ts` exports it as `PlatformConversation`, bound as
 * `PLATFORM_CONVERSATION`). Its object App is what the running test last passed to `composeObjects`
 * (the tests and the objects share one isolate): the entrypoint reads the definition's components and
 * config when an object starts its App, on its first event.
 *
 * An object composes its App once, as on Cloudflare, and never stops it (K6). So the tests' `resetObjects`
 * (`test/host.ts`) resets every object's instance: the next event starts a new one, which composes what
 * the test composed since.
 */

import { type AppDefinition, type Clock, type ComponentDefinition, defineApp, silentLogger, systemClock } from "@pikit/core";
import { createEntrypoint } from "../../../registry/components/deployment-cloudflare/files/src/pikit/deployment-cloudflare/entrypoint.ts";

/** actors-do's `binding` in these Apps: the class below. */
export const PLATFORM_BINDING = "PLATFORM_CONVERSATION";

let composed: { components: ComponentDefinition[]; config: Record<string, unknown>; clock?: Clock } | undefined;

/**
 * What the objects' Apps are made of from now on, with actors-do's `binding` set to this
 * class, on `clock` when given (a suite's manual clock, shared with the Apps it starts: the objects
 * share the tests' isolate). An object whose App already started keeps it until `resetObjects`.
 */
export function composeObjects(components: ComponentDefinition[], config: Record<string, unknown> = {}, options: { clock?: Clock } = {}): void {
  const platform = (config["actors-do"] ?? {}) as Record<string, unknown>;
  composed = { components, config: { ...config, "actors-do": { binding: PLATFORM_BINDING, ...platform } }, ...(options.clock !== undefined && { clock: options.clock }) };
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
  create: () => defineApp({ components: current().components, config: current().config, target: "durable", logger: silentLogger, clock }).create(),
};

/** The composition's clock when it has one, else the system's: read on every call, as the entrypoint keeps one for its life. */
const clock: Clock = {
  now: () => (composed?.clock ?? systemClock).now(),
  sleep: (ms) => (composed?.clock ?? systemClock).sleep(ms),
};

export const platformEntrypoint = createEntrypoint(objectApp, undefined, { logger: silentLogger, clock });
