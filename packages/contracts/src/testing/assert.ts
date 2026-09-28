/**
 * Assertions shared by the conformance suites, so they depend on no test framework. Internal to
 * `@pikit/core/testing`; not exported.
 */

/** Deep equality on JSON-shaped values; `undefined` properties count as absent. */
export function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const keysB = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** An `expect` for one suite: failures name the suite (`group`) and what was checked. */
export function expecter(group: string) {
  return (actual: unknown, expected: unknown, what: string): void => {
    if (!equal(actual, expected)) {
      throw new Error(`${group}: ${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
}

/** A check that must hold; `what` says what was expected. */
export function checker(group: string) {
  return (condition: boolean, what: string): void => {
    if (!condition) throw new Error(`${group}: expected ${what}`);
  };
}
