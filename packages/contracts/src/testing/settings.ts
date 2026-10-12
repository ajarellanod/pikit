/**
 * `settings` conformance: what every provider guarantees to the components that declare and read
 * settings (`../settings.ts`). Runner-independent:
 *
 *   for (const c of createSettingsConformance(() => myProviderFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * A case starts an App of the fixture's components and a consumer that declares in its `start`, as a
 * component does; "a restart" is a second App over the same storage. An operator's change comes
 * through the fixture's operator side (`operate`), which the provider implements over its own
 * operator surface: how that surface validates, answers and logs is the provider's to test. The
 * schemas are plain JSON Schema, as TypeBox builds them.
 */

import { type AppContext, type ComponentDefinition, defineApp, defineComponent, type Handle, type Logger, type Target } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import { SECRET_NAME_PATTERN } from "../secrets.ts";
import type { Settings, SettingsSchema, SettingsValue } from "../settings.ts";
import { checker, expecter } from "./assert.ts";

/** One App of a case: its components, and its operator side. */
export interface SettingsFixtureApp {
  components: ComponentDefinition[];
  /**
   * Stores `value` as `component`'s whole value, as an operator does through the provider's own
   * operator surface (settings-store: its dashboard route), in this App once it started (`ctx` is
   * its). A refusal rejects, with the provider's message (the suite asks for one: a value holding a
   * credential, which the rejection must not echo).
   */
  operate(component: string, value: SettingsValue, ctx: AppContext): Promise<void>;
}

/** A provider under test: one case's storage, which every App of the case shares. */
export interface SettingsFixture {
  /**
   * One App over the case's storage: called again for each App of the case (a restart). `logger` is
   * the App's: a provider whose store is in another App (an object) logs there.
   */
  app(logger: Logger): SettingsFixtureApp;
  /** The Apps' config (a provider that caches across Apps reads through: its bound 0). */
  config?: Record<string, unknown>;
  /** The Apps' target; default `server`. */
  target?: Target;
  dispose?(): Promise<void>;
}

const GROUP = "settings";
const expect = expecter(GROUP);
const check = checker(GROUP);

const MODE = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["calm", "busy"], title: "Mode" },
    prompt: { type: "string" },
    limit: { type: "integer", minimum: 1 },
  },
  required: ["mode", "prompt", "limit"],
  additionalProperties: false,
};
const MODE_DEFAULTS: SettingsValue = { mode: "calm", prompt: "Be brief.", limit: 3 };
const OTHER: SettingsSchema = { type: "object", properties: { on: { type: "boolean" } }, required: ["on"], additionalProperties: false };
const OTHER_DEFAULTS: SettingsValue = { on: false };

type Declarations = Record<string, { schema: SettingsSchema; defaults: SettingsValue }>;
const BOTH: Declarations = { alpha: { schema: MODE, defaults: MODE_DEFAULTS }, beta: { schema: OTHER, defaults: OTHER_DEFAULTS } };
/** A key in the shape of Anthropic's: what no setting may hold, and no refusal or log line may echo. */
const CREDENTIAL = "sk-ant-api03-conformance0123456789abcdefghij";

type Line = { level: string; message: string; fields?: Record<string, unknown> };

/** One App of a case: started, its consumer having declared `declarations` in its start. */
interface Running {
  settings: Settings;
  ctx: AppContext;
  lines: Line[];
  /** The fixture's operator, in this App. */
  operate(component: string, value: SettingsValue): Promise<void>;
  stop(): Promise<void>;
}

async function boot(fixture: SettingsFixture, declarations: Declarations): Promise<Running> {
  const lines: Line[] = [];
  const record = (level: string) => (message: string, fields?: Record<string, unknown>) => void lines.push({ level, message, ...(fields !== undefined && { fields }) });
  const logger: Logger = { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
  let handle: Handle<Settings> | undefined;
  const consumer = defineComponent({
    name: "settings-conformance",
    setup(pikit) {
      handle = pikit.use("settings");
      return {
        start() {
          for (const [component, { schema, defaults }] of Object.entries(declarations)) handle?.get().declare(component, schema, defaults);
        },
      };
    },
  });
  const built = fixture.app(logger);
  const app = await defineApp({
    components: [...built.components, consumer],
    logger,
    ...(fixture.config !== undefined && { config: fixture.config }),
    ...(fixture.target !== undefined && { target: fixture.target }),
  }).create();
  await app.start();
  if (handle === undefined) throw new Error(`${GROUP}: the consumer did not set up`);
  const ctx = app.context();
  return { settings: handle.get(), ctx, lines, operate: (component, value) => built.operate(component, value, ctx), stop: () => app.stop() };
}

/** `work`'s rejection code (a `SettingsError`'s), or `undefined` when it resolved. */
async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : `not a SettingsError: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function createSettingsConformance(factory: () => SettingsFixture | Promise<SettingsFixture>): readonly ConformanceCase[] {
  /** A case over one fixture, whose Apps it boots itself. */
  const settingsCase = (name: string, run: (fixture: SettingsFixture) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      try {
        await run(fixture);
      } finally {
        await fixture.dispose?.();
      }
    },
  });
  /** A case over one App of the fixture, with `BOTH` declared. */
  const appCase = (name: string, run: (app: Running) => Promise<void>): ConformanceCase =>
    settingsCase(name, async (fixture) => {
      const app = await boot(fixture, BOTH);
      try {
        await run(app);
      } finally {
        await app.stop().catch(() => {});
      }
    });

  return [
    appCase("a component nothing was stored for gets its defaults", async ({ settings, ctx }) => {
      expect(await settings.get("alpha", ctx), MODE_DEFAULTS, "get before any change");
    }),

    appCase("get reads what an operator stored, whole: what the value leaves out takes its default", async ({ settings, ctx, operate }) => {
      await operate("alpha", { mode: "busy", prompt: "Be thorough." });
      expect(await settings.get("alpha", ctx), { mode: "busy", prompt: "Be thorough.", limit: 3 }, "get after a change");

      await operate("alpha", { limit: 9 });
      expect(await settings.get("alpha", ctx), { mode: "calm", prompt: "Be brief.", limit: 9 }, "get after a second change, which left mode and prompt out");
    }),

    appCase("a component that declared nothing is unknown_component to get", async ({ settings, ctx }) => {
      expect(await codeOf(settings.get("gamma", ctx)), "unknown_component", "get");
    }),

    appCase("each component's value is its own", async ({ settings, ctx, operate }) => {
      await operate("beta", { on: true });
      expect(await settings.get("alpha", ctx), MODE_DEFAULTS, "alpha after beta's change");
      expect(await settings.get("beta", ctx), { on: true }, "beta");
    }),

    appCase("an answer is a copy: changing it changes nothing stored", async ({ settings, ctx, operate }) => {
      const read = (await settings.get("alpha", ctx)) as Record<string, unknown>;
      read.mode = "busy";
      expect(await settings.get("alpha", ctx), MODE_DEFAULTS, "get after changing an answer of the defaults");
      await operate("beta", { on: true });
      const stored = (await settings.get("beta", ctx)) as Record<string, unknown>;
      stored.on = false;
      expect(await settings.get("beta", ctx), { on: true }, "get after changing an answer of a stored value");
    }),

    appCase("declare refuses defaults its schema does not accept, and a component declared twice", async ({ settings }) => {
      let threw = false;
      try {
        settings.declare("gamma", OTHER, { on: "yes" });
      } catch {
        threw = true;
      }
      check(threw, "declare to throw for defaults the schema refuses");
      threw = false;
      try {
        settings.declare("alpha", MODE, MODE_DEFAULTS);
      } catch {
        threw = true;
      }
      check(threw, "declare to throw for a component declared already");
    }),

    appCase("a setting is never a secret: declare refuses a schema whose secret-named string is free, and defaults holding a credential; naming a secret is fine", async ({ settings }) => {
      const refuses = (component: string, schema: SettingsSchema, defaults: SettingsValue, what: string) => {
        let threw: unknown;
        try {
          settings.declare(component, schema, defaults);
        } catch (error) {
          threw = error;
        }
        check(threw !== undefined, `declare to throw for ${what}`);
        check(!String(threw instanceof Error ? threw.message : threw).includes(CREDENTIAL), `declare's refusal of ${what} not to echo the credential`);
      };
      refuses("gamma", { type: "object", properties: { apiKey: { type: "string" } } }, {}, "a free string under `apiKey`");
      refuses("delta", { type: "object", properties: { prompt: { type: "string" } } }, { prompt: `call it with ${CREDENTIAL}` }, "defaults holding a credential");
      settings.declare("epsilon", { type: "object", properties: { tokenSecret: { type: "string", pattern: SECRET_NAME_PATTERN } } }, { tokenSecret: "GITHUB_TOKEN" });
    }),

    appCase("a setting is never a secret: an operator's change holding a credential is refused, stores nothing, and nothing echoes it", async ({ settings, ctx, operate, lines }) => {
      let refused: unknown;
      try {
        await operate("alpha", { mode: "busy", prompt: `Use ${CREDENTIAL} for the API.` });
      } catch (error) {
        refused = error;
      }
      check(refused !== undefined, "an operator's change holding a credential to be refused");
      check(!String(refused instanceof Error ? refused.message : refused).includes(CREDENTIAL), "the refusal not to echo the credential");
      expect(await settings.get("alpha", ctx), MODE_DEFAULTS, "get after the refused change");
      check(!JSON.stringify(lines).includes(CREDENTIAL), "no log line to hold the credential");
    }),

    settingsCase("a value outlives a restart", async (fixture) => {
      const first = await boot(fixture, BOTH);
      await first.operate("alpha", { mode: "busy" });
      await first.stop();
      const second = await boot(fixture, BOTH);
      try {
        expect(await second.settings.get("alpha", second.ctx), { mode: "busy", prompt: "Be brief.", limit: 3 }, "get in the next App");
      } finally {
        await second.stop();
      }
    }),

    settingsCase("a stored key the schema no longer accepts takes its default, logged; the others stay", async (fixture) => {
      const first = await boot(fixture, BOTH);
      await first.operate("alpha", { mode: "busy", prompt: "Kept." });
      await first.stop();
      // A deploy took "busy" out of the enum.
      const narrower: SettingsSchema = { ...MODE, properties: { ...MODE.properties, mode: { type: "string", enum: ["calm"] } } };
      const second = await boot(fixture, { ...BOTH, alpha: { schema: narrower, defaults: MODE_DEFAULTS } });
      try {
        expect(await second.settings.get("alpha", second.ctx), { mode: "calm", prompt: "Kept.", limit: 3 }, "get under the narrower schema");
        check(
          second.lines.some((line) => line.level === "warn" && JSON.stringify(line).includes("alpha")),
          "a warning naming the component whose stored key was left out",
        );
      } finally {
        await second.stop();
      }
    }),

    // A provider that caches across Apps is configured by its fixture to read through (its bound 0).
    settingsCase("an operator's change made in one App is what the next get of another App reads", async (fixture) => {
      const one = await boot(fixture, BOTH);
      const two = await boot(fixture, BOTH);
      try {
        expect(await two.settings.get("beta", two.ctx), OTHER_DEFAULTS, "the second App's get before the change");
        await one.operate("beta", { on: true });
        expect(await two.settings.get("beta", two.ctx), { on: true }, "the second App's get after the change in the first one");
      } finally {
        await one.stop();
        await two.stop();
      }
    }),
  ];
}
