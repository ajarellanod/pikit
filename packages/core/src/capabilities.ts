/**
 * Capabilities are named services (SPEC §4.5). A capability is either:
 *
 * - **single**: exactly one provider is used. When several installed components provide it,
 *   `config.capabilities` must select one by component name.
 * - **keyed**: every provider contributes one or more implementations, each under a distinct
 *   key (`channel.transport` keyed by channel name). Consumers see all of them. Selection does
 *   not apply.
 *
 * The mode is fixed by how the capability is provided (`provide` or `provideKeyed`); mixing
 * both for one name is an error. This mirrors Chord's singleton and keyed services, with keys
 * fixed at setup instead of spawned at runtime.
 *
 * The registry does not know component manifests; the harness derives the dependency graph
 * from what each setup provides and uses. The registry owns every selection rule: which
 * provider a single capability resolves to, and why none does (`resolveProvider`,
 * `validateSelection`). `config.ts` checks only the shape of the selection.
 */

/**
 * Typed map of single capabilities: name → service type. Extended by declaration merging like
 * `HarnessEvents`. Contracts are added by the module that defines them.
 */
// biome-ignore lint/suspicious/noEmptyInterface: extended by declaration merging
export interface HarnessCapabilities {}

/** Typed map of keyed capabilities: name → type of each keyed implementation. */
// biome-ignore lint/suspicious/noEmptyInterface: extended by declaration merging
export interface HarnessKeyedCapabilities {}

/** Every implementation of a keyed capability, by key. */
export interface Keyed<T> {
  /** The implementation for `key`, or `undefined` when no component provides that key. */
  get(key: string): T | undefined;
  /** Every provided key, in registration order. */
  keys(): string[];
}

export type CapabilityMode = "single" | "keyed";

export interface CapabilityRegistry<Caps extends object, KeyedCaps extends object = object> {
  /** Register `impl` as `provider`'s implementation of the single capability `name`. */
  provide<K extends keyof Caps & string>(name: K, impl: Caps[K], provider: string): void;
  /** Register `impl` as `provider`'s implementation of the keyed capability `name` under `key`. */
  provideKeyed<K extends keyof KeyedCaps & string>(name: K, key: string, impl: KeyedCaps[K], provider: string): void;
  /** Resolve the single provider of `name`. Throws when there is none or the choice is ambiguous. */
  require<K extends keyof Caps & string>(name: K): Caps[K];
  /** Every implementation of the keyed capability `name`; empty when nothing provides it. */
  keyed<K extends keyof KeyedCaps & string>(name: K): Keyed<KeyedCaps[K]>;
  /** Single: `require(name)` would succeed. Keyed: at least one key is provided. */
  has(name: string): boolean;
  /** How `name` is provided, or `undefined` if nothing provides it. */
  mode(name: string): CapabilityMode | undefined;
  /** Provider component names for `name`, unique, in registration order. */
  providers(name: string): string[];
  /** The single provider `require(name)` would use, or `undefined` if it would throw. */
  selected(name: string): string | undefined;
  /** The single provider `require(name)` would use, or the error it would throw. */
  resolveProvider(name: string): string | Error;
  /**
   * Throws unless every selected capability is single and provided by the selected component.
   * Call it once every provider is registered.
   */
  validateSelection(): void;
  /** Keyed capabilities only: key → provider component name. */
  keys(name: string): Record<string, string>;
  /** Every capability with at least one provider. */
  names(): string[];
}

interface Entry {
  provider: string;
  impl: unknown;
  /** Present exactly when the capability is keyed. */
  key?: string;
}

export function createCapabilityRegistry<Caps extends object, KeyedCaps extends object = object>(
  /** `config.capabilities`: capability name → chosen component name. */
  selection: Readonly<Record<string, string>> = {},
): CapabilityRegistry<Caps, KeyedCaps> {
  const entries = new Map<string, Entry[]>();

  function modeOf(name: string): CapabilityMode | undefined {
    const first = entries.get(name)?.[0];
    if (first === undefined) return undefined;
    return first.key === undefined ? "single" : "keyed";
  }

  function add(name: string, entry: Entry): void {
    const mode = modeOf(name);
    const wanted: CapabilityMode = entry.key === undefined ? "single" : "keyed";
    if (mode !== undefined && mode !== wanted) {
      const others = unique((entries.get(name) ?? []).map((e) => e.provider)).join(", ");
      throw new Error(
        `capability "${name}" is ${mode} (provided by ${others}); component "${entry.provider}" ` +
          (wanted === "keyed" ? "provides it with a key" : "provides it without a key"),
      );
    }
    const list = entries.get(name) ?? [];
    if (entry.key === undefined && list.some((e) => e.provider === entry.provider)) {
      throw new Error(`capability "${name}": component "${entry.provider}" provided it twice`);
    }
    const clash = entry.key === undefined ? undefined : list.find((e) => e.key === entry.key);
    if (clash) {
      throw new Error(
        `capability "${name}": key "${entry.key}" is provided by both "${clash.provider}" and "${entry.provider}"`,
      );
    }
    list.push(entry);
    entries.set(name, list);
  }

  /** The single provider of `name`, or why there is none. The only place selection is applied. */
  function resolve(name: string): Entry | Error {
    if (modeOf(name) === "keyed") {
      return new Error(`capability "${name}" is keyed; use it with useKeyed()`);
    }
    const list = entries.get(name) ?? [];
    const chosen = selection[name];
    if (chosen !== undefined) {
      const match = list.find((entry) => entry.provider === chosen);
      return (
        match ??
        new Error(
          `config.capabilities["${name}"] selects "${chosen}", which does not provide it` +
            (list.length ? ` (provided by ${list.map((e) => e.provider).join(", ")})` : ""),
        )
      );
    }
    if (list.length === 1) return list[0] as Entry;
    if (list.length === 0) return new Error(`capability "${name}" is required but no installed component provides it`);
    return new Error(
      `capability "${name}" has several providers (${list.map((e) => e.provider).join(", ")}); ` +
        `select one with config.capabilities["${name}"]`,
    );
  }

  return {
    provide(name, impl, provider) {
      add(name, { provider, impl });
    },

    provideKeyed(name, key, impl, provider) {
      if (key.length === 0) throw new Error(`capability "${name}": component "${provider}" provided an empty key`);
      add(name, { provider, impl, key });
    },

    require(name) {
      const result = resolve(name);
      if (result instanceof Error) throw result;
      return result.impl as Caps[typeof name];
    },

    keyed(name) {
      if (modeOf(name) === "single") throw new Error(`capability "${name}" is not keyed; use it with use()`);
      const list = entries.get(name) ?? [];
      return {
        get: (key) => list.find((entry) => entry.key === key)?.impl as KeyedCaps[typeof name] | undefined,
        keys: () => list.map((entry) => entry.key as string),
      };
    },

    has(name) {
      if (modeOf(name) === "keyed") return true;
      return !(resolve(name) instanceof Error);
    },

    mode: modeOf,

    selected(name) {
      const result = resolve(name);
      return result instanceof Error ? undefined : result.provider;
    },

    resolveProvider(name) {
      const result = resolve(name);
      return result instanceof Error ? result : result.provider;
    },

    validateSelection() {
      for (const name of Object.keys(selection)) {
        if (modeOf(name) === "keyed") {
          throw new Error(
            `config.capabilities["${name}"] cannot select a provider: "${name}" is keyed and every provider is used`,
          );
        }
        const result = resolve(name);
        if (result instanceof Error) throw result;
      }
    },

    providers(name) {
      return unique((entries.get(name) ?? []).map((entry) => entry.provider));
    },

    keys(name) {
      if (modeOf(name) !== "keyed") return {};
      return Object.fromEntries((entries.get(name) ?? []).map((entry) => [entry.key as string, entry.provider]));
    },

    names() {
      return [...entries.keys()];
    },
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
