/**
 * `secrets` conformance (SPEC §4.5, §13, §14): what every `SecretStore` must do, wherever the
 * secrets live. Runner-independent, like the lifecycle suite:
 *
 *   for (const c of createSecretStoreConformance((secrets) => myFixture(secrets)))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The suite chooses the secrets; the fixture seeds its store with them (environment variables, a
 * vault's test namespace) and gives back the components that provide `secrets`.
 */

import { type ComponentDefinition, defineApp, defineComponent } from "../app.ts";
import type { SecretStore } from "../contracts/secrets.ts";
import type { Logger } from "../contracts/logger.ts";
import { checker, expecter } from "./assert.ts";
import type { ConformanceCase } from "./lifecycle.ts";

/** A store seeded with the suite's secrets, built for one case. */
export interface SecretStoreFixture {
  /** The component providing `secrets`, and anything it uses. */
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  /** Release what the fixture holds. */
  dispose?(): Promise<void>;
}

const GROUP = "secrets";
const expect = expecter(GROUP);
const check = checker(GROUP);

/** Values chosen to catch trimming, splitting and encoding bugs. Each is unique, so a leak is findable. */
const SEEDED: Readonly<Record<string, string>> = {
  PIKIT_CONFORMANCE_PLAIN: "pikit-conformance-plain-5f3a",
  PIKIT_CONFORMANCE_SPACES: "  pikit-conformance spaces 7c1e  ",
  PIKIT_CONFORMANCE_SYMBOLS: "pikit-conformance=a;b&c\"d'e$f#9d2b",
  PIKIT_CONFORMANCE_UNICODE: "pikit-conformance-ñandú-✓-4b8e",
  PIKIT_CONFORMANCE_LONG: `pikit-conformance-long-${"x".repeat(4096)}`,
  PIKIT_CONFORMANCE_EMPTY: "",
};
const NOT_SET = "PIKIT_CONFORMANCE_NOT_SET";

export function createSecretStoreConformance(
  factory: (secrets: Readonly<Record<string, string>>) => SecretStoreFixture | Promise<SecretStoreFixture>,
): readonly ConformanceCase[] {
  const secretCase = (name: string, run: (subject: Subject) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory(SEEDED);
      const subject = await createSubject(fixture);
      try {
        await run(subject);
      } finally {
        await subject.stop();
        await fixture.dispose?.();
      }
    },
  });

  return [
    secretCase("a secret reads back exactly as it was set", async ({ secrets }) => {
      for (const [name, value] of Object.entries(SEEDED)) {
        if (value === "") continue;
        expect(await secrets.get(name), value, `secrets.get("${name}")`);
      }
    }),

    secretCase("a secret that is not set reads undefined", async ({ secrets }) => {
      expect(await secrets.get(NOT_SET), undefined, `secrets.get("${NOT_SET}")`);
    }),

    secretCase("an empty secret reads undefined: it is not set", async ({ secrets }) => {
      expect(await secrets.get("PIKIT_CONFORMANCE_EMPTY"), undefined, 'secrets.get("PIKIT_CONFORMANCE_EMPTY")');
    }),

    secretCase("no secret reaches the app's description or its logs", async (s) => {
      for (const name of Object.keys(SEEDED)) await s.secrets.get(name);
      await s.stop();

      const visible = [JSON.stringify(s.description()), ...s.logs()].join("\n");
      for (const [name, value] of Object.entries(SEEDED)) {
        if (value === "") continue;
        check(!visible.includes(value.trim()), `the value of ${name} not to appear in describe() or in a log line`);
      }
    }),
  ];
}

interface Subject {
  secrets: SecretStore;
  description(): unknown;
  logs(): string[];
  stop(): Promise<void>;
}

async function createSubject(fixture: SecretStoreFixture): Promise<Subject> {
  const lines: string[] = [];
  const capture =
    (level: string) =>
    (message: string, fields?: Record<string, unknown>): void => {
      lines.push(`${level} ${message} ${fields === undefined ? "" : JSON.stringify(fields, stringifyErrors)}`);
    };
  const logger: Logger = { debug: capture("debug"), info: capture("info"), warn: capture("warn"), error: capture("error") };

  let store: SecretStore | undefined;
  const reader = defineComponent({
    name: "secrets-conformance",
    setup(pikit) {
      const handle = pikit.use("secrets");
      return {
        start() {
          store = handle.get();
        },
      };
    },
  });
  const app = await defineApp({
    components: [...fixture.components, reader],
    ...(fixture.config !== undefined && { config: fixture.config }),
    logger,
  }).create();
  await app.start();
  if (store === undefined) throw new Error(`${GROUP}: secrets was not resolved`);

  return {
    secrets: store,
    description: () => app.describe(),
    logs: () => [...lines],
    stop: () => app.stop(),
  };
}

/** Errors in log fields are logged with their message; a secret inside one must be caught too. */
function stringifyErrors(_key: string, value: unknown): unknown {
  return value instanceof Error ? { message: value.message, cause: value.cause } : value;
}
