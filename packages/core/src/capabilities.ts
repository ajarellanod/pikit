/**
 * Capabilities are named services with exactly one provider (SPEC §4.5).
 *
 * Several installed components may declare the same capability; then `config.capabilities`
 * must select one by component name. `require` resolves at call time so a consumer's `setup`
 * can call it as long as the provider's `setup` ran first (the harness orders setup so that
 * it always does).
 *
 * The registry does not know component manifests. The harness checks that a component only
 * provides what its manifest declares and that a selection names a real provider.
 */

/**
 * Typed capability map: name → service type. Extended by declaration merging like
 * `HarnessEvents`. Contracts are added by the module that defines them.
 */
// biome-ignore lint/suspicious/noEmptyInterface: extended by declaration merging
export interface HarnessCapabilities {}

export interface CapabilityRegistry<Caps extends object> {
  /** Register `impl` as `provider`'s implementation of `name`. */
  provide<K extends keyof Caps & string>(name: K, impl: Caps[K], provider: string): void;
  /** Resolve the single provider of `name`. Throws when there is none or the choice is ambiguous. */
  require<K extends keyof Caps & string>(name: K): Caps[K];
  /** True when `require(name)` would succeed. For optional capabilities (`outbound.queue`). */
  has(name: string): boolean;
  /** Provider component names registered for `name`, in registration order. */
  providers(name: string): string[];
  /** The provider `require(name)` would use, or `undefined` if it would throw. */
  selected(name: string): string | undefined;
  /** Every capability with at least one provider. */
  names(): string[];
}

export function createCapabilityRegistry<Caps extends object>(
  /** `config.capabilities`: capability name → chosen component name. */
  selection: Readonly<Record<string, string>> = {},
): CapabilityRegistry<Caps> {
  const providers = new Map<string, { provider: string; impl: unknown }[]>();

  function resolve(name: string): { provider: string; impl: unknown } | Error {
    const list = providers.get(name) ?? [];
    const chosen = selection[name];
    if (chosen !== undefined) {
      const match = list.find((entry) => entry.provider === chosen);
      return (
        match ??
        new Error(
          `capability "${name}": config selects "${chosen}" but it is not provided by that component` +
            (list.length ? ` (provided by ${list.map((e) => e.provider).join(", ")})` : ""),
        )
      );
    }
    if (list.length === 1) return list[0] as { provider: string; impl: unknown };
    if (list.length === 0) return new Error(`capability "${name}" is required but no installed component provides it`);
    return new Error(
      `capability "${name}" has several providers (${list.map((e) => e.provider).join(", ")}); ` +
        `select one with config.capabilities["${name}"]`,
    );
  }

  return {
    provide(name, impl, provider) {
      const list = providers.get(name) ?? [];
      if (list.some((entry) => entry.provider === provider)) {
        throw new Error(`capability "${name}": component "${provider}" provided it twice`);
      }
      list.push({ provider, impl });
      providers.set(name, list);
    },

    require(name) {
      const result = resolve(name);
      if (result instanceof Error) throw result;
      return result.impl as Caps[typeof name];
    },

    has(name) {
      return !(resolve(name) instanceof Error);
    },

    selected(name) {
      const result = resolve(name);
      return result instanceof Error ? undefined : result.provider;
    },

    providers(name) {
      return (providers.get(name) ?? []).map((entry) => entry.provider);
    },

    names() {
      return [...providers.keys()];
    },
  };
}
