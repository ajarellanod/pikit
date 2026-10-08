/**
 * `settings` conformance: what every provider guarantees to the components that declare and read
 * settings, and to the operator who changes them (`../settings.ts`). Runner-independent:
 *
 *   for (const c of createSettingsConformance(() => myProviderFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * A case starts an App of the fixture's components and a consumer that declares in its `start`, as a
 * component does; "a restart" is a second App over the same storage. The schemas are plain JSON
 * Schema, as TypeBox builds them.
 */

import { type AppContext, type ComponentDefinition, defineApp, defineComponent, type Handle, type Logger, type Target } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import type { Operator } from "../admin.ts";
import type { Settings, SettingsSchema, SettingsValue } from "../settings.ts";
import { checker, expecter } from "./assert.ts";

/** A provider under test: one case's storage, which every App of the case shares. */
export interface SettingsFixture {
  /**
   * The components of one App, over the case's storage: called again for each App of the case (a
   * restart). `logger` is the App's: a provider whose store is in another App (an object) logs there.
   */
  components(logger: Logger): ComponentDefinition[];
  /** The Apps' config (a provider that caches across Apps reads through: its bound 0). */
  config?: Record<string, unknown>;
  /** The Apps' target; default `server`. */
  target?: Target;
  dispose?(): Promise<void>;
}

const GROUP = "settings";
const expect = expecter(GROUP);
const check = checker(GROUP);

const OPERATOR: Operator = { id: "operator-1" };
/** A value no log line may hold. */
const MARKER = "never-in-a-log-7f3a";

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

type Line = { level: string; message: string; fields?: Record<string, unknown> };

/** One App of a case: started, its consumer having declared `declarations` in its start. */
interface Running {
  settings: Settings;
  ctx: AppContext;
  lines: Line[];
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
  const app = await defineApp({
    components: [...fixture.components(logger), consumer],
    logger,
    ...(fixture.config !== undefined && { config: fixture.config }),
    ...(fixture.target !== undefined && { target: fixture.target }),
  }).create();
  await app.start();
  if (handle === undefined) throw new Error(`${GROUP}: the consumer did not set up`);
  return { settings: handle.get(), ctx: app.context(), lines, stop: () => app.stop() };
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
    appCase("a component that stored nothing gets its defaults", async ({ settings, ctx }) => {
      expect(await settings.get("alpha", ctx), MODE_DEFAULTS, "get before any set");
    }),

    appCase("set stores the whole value, and get reads it; what the value leaves out takes its default", async ({ settings, ctx }) => {
      const answered = await settings.set("alpha", { mode: "busy", prompt: "Be thorough." }, OPERATOR, ctx);
      expect(answered, { mode: "busy", prompt: "Be thorough.", limit: 3 }, "set's answer");
      expect(await settings.get("alpha", ctx), { mode: "busy", prompt: "Be thorough.", limit: 3 }, "get after set");

      await settings.set("alpha", { limit: 9 }, OPERATOR, ctx);
      expect(await settings.get("alpha", ctx), { mode: "calm", prompt: "Be brief.", limit: 9 }, "get after a second set, which left mode and prompt out");
    }),

    appCase("a value the schema refuses is invalid_value, and stores nothing", async ({ settings, ctx }) => {
      await settings.set("alpha", { mode: "busy" }, OPERATOR, ctx);
      expect(await codeOf(settings.set("alpha", { mode: "loud" }, OPERATOR, ctx)), "invalid_value", "a mode outside the enum");
      expect(await codeOf(settings.set("alpha", { limit: 0 }, OPERATOR, ctx)), "invalid_value", "a limit under its minimum");
      expect(await codeOf(settings.set("alpha", { mode: "busy", extra: 1 }, OPERATOR, ctx)), "invalid_value", "a key the schema does not have");
      expect(await settings.get("alpha", ctx), { mode: "busy", prompt: "Be brief.", limit: 3 }, "get after the refusals");
    }),

    appCase("a component that declared nothing is unknown_component, to get and to set", async ({ settings, ctx }) => {
      expect(await codeOf(settings.get("gamma", ctx)), "unknown_component", "get");
      expect(await codeOf(settings.set("gamma", { on: true }, OPERATOR, ctx)), "unknown_component", "set");
    }),

    appCase("each component's value is its own", async ({ settings, ctx }) => {
      await settings.set("beta", { on: true }, OPERATOR, ctx);
      expect(await settings.get("alpha", ctx), MODE_DEFAULTS, "alpha after beta's set");
      expect(await settings.get("beta", ctx), { on: true }, "beta");
    }),

    appCase("sections lists every declared component by name, with its schema, defaults and value", async ({ settings, ctx }) => {
      await settings.set("beta", { on: true }, OPERATOR, ctx);
      expect(
        await settings.sections(ctx),
        [
          { component: "alpha", schema: MODE, defaults: MODE_DEFAULTS, value: MODE_DEFAULTS },
          { component: "beta", schema: OTHER, defaults: OTHER_DEFAULTS, value: { on: true } },
        ],
        "sections()",
      );
    }),

    appCase("an answer is a copy: changing it changes nothing stored", async ({ settings, ctx }) => {
      const read = (await settings.get("alpha", ctx)) as Record<string, unknown>;
      read.mode = "busy";
      const sections = await settings.sections(ctx);
      (sections[0]?.value as Record<string, unknown>).limit = 100;
      expect(await settings.get("alpha", ctx), MODE_DEFAULTS, "get after changing earlier answers");
    }),

    appCase("set is logged with the operator and the component, never the value", async ({ settings, ctx, lines }) => {
      await settings.set("alpha", { prompt: MARKER }, OPERATOR, ctx);
      const logged = JSON.stringify(lines);
      check(!logged.includes(MARKER), "no log line to hold the value set");
      check(
        lines.some((line) => JSON.stringify(line.fields ?? {}).includes(OPERATOR.id) && JSON.stringify(line).includes("alpha")),
        "a log line naming the operator and the component",
      );
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

    settingsCase("a value outlives a restart", async (fixture) => {
      const first = await boot(fixture, BOTH);
      await first.settings.set("alpha", { mode: "busy" }, OPERATOR, first.ctx);
      await first.stop();
      const second = await boot(fixture, BOTH);
      try {
        expect(await second.settings.get("alpha", second.ctx), { mode: "busy", prompt: "Be brief.", limit: 3 }, "get in the next App");
      } finally {
        await second.stop();
      }
    }),

    settingsCase("a stored key the schema no longer accepts takes its default; the others stay", async (fixture) => {
      const first = await boot(fixture, BOTH);
      await first.settings.set("alpha", { mode: "busy", prompt: "Kept." }, OPERATOR, first.ctx);
      await first.stop();
      // A deploy took "busy" out of the enum.
      const narrower: SettingsSchema = { ...MODE, properties: { ...MODE.properties, mode: { type: "string", enum: ["calm"] } } };
      const second = await boot(fixture, { ...BOTH, alpha: { schema: narrower, defaults: MODE_DEFAULTS } });
      try {
        expect(await second.settings.get("alpha", second.ctx), { mode: "calm", prompt: "Kept.", limit: 3 }, "get under the narrower schema");
      } finally {
        await second.stop();
      }
    }),

    // A provider that caches across Apps is configured by its fixture to read through (its bound 0).
    settingsCase("a change made in one App is what the next get of another App reads", async (fixture) => {
      const one = await boot(fixture, BOTH);
      const two = await boot(fixture, BOTH);
      try {
        expect(await two.settings.get("beta", two.ctx), OTHER_DEFAULTS, "the second App's get before the change");
        await one.settings.set("beta", { on: true }, OPERATOR, one.ctx);
        expect(await two.settings.get("beta", two.ctx), { on: true }, "the second App's get after the first one's set");
      } finally {
        await one.stop();
        await two.stop();
      }
    }),
  ];
}
