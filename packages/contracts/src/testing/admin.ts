/**
 * `admin.auth` conformance: what every provider guarantees to the admin routes that ask it
 * (`../admin.ts`). Runner-independent:
 *
 *   for (const c of createAdminAuthConformance(() => myProviderFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 */

import { type AppContext, type ComponentDefinition, defineApp, defineComponent, type Handle, silentLogger } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import type { AdminAuth } from "../admin.ts";
import { checker, expecter } from "./assert.ts";

/** A provider under test, built for one case. */
export interface AdminAuthFixture {
  /** The component that provides `admin.auth`, configured, and what it uses (`secrets`). */
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  /** The headers an operator sends: its credential. */
  operator: Record<string, string>;
  /** The credential itself, as it appears in `operator`: the suite checks it never leaks. */
  credential: string;
  /** Headers that must not pass: a wrong credential, a malformed one, another scheme. */
  intruders: Record<string, string>[];
  /** The same provider with its secret not set: its start must fail. Omit when it has none. */
  unconfigured?: { components: ComponentDefinition[]; config?: Record<string, unknown> };
  dispose?(): Promise<void>;
}

const GROUP = "admin.auth";
const expect = expecter(GROUP);
const check = checker(GROUP);

export function createAdminAuthConformance(factory: () => AdminAuthFixture | Promise<AdminAuthFixture>): readonly ConformanceCase[] {
  /** A case over a started app whose consumer holds `admin.auth`. */
  const authCase = (name: string, run: (auth: AdminAuth, fixture: AdminAuthFixture, ctx: AppContext) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      const { app, handle } = await started(fixture.components, fixture.config);
      try {
        await run(handle.get(), fixture, app.context());
      } finally {
        await app.stop().catch(() => {});
        await fixture.dispose?.();
      }
    },
  });

  const request = (headers: Record<string, string> = {}, body?: string) =>
    new Request("https://pikit.test/admin/api/conversations", { method: body === undefined ? "GET" : "POST", headers, ...(body !== undefined && { body }) });

  return [
    authCase("a request with the operator's credential is an operator, named without the credential", async (auth, fixture, ctx) => {
      const operator = await auth.verify(request(fixture.operator), ctx);

      check(operator !== undefined, "the operator's request to be verified");
      check(typeof operator?.id === "string" && operator.id !== "", "the operator to have an id");
      check(!JSON.stringify(operator).includes(fixture.credential), "the credential not to appear in the operator");
    }),

    authCase("a request without a credential is not an operator", async (auth, _fixture, ctx) => {
      expect(await auth.verify(request(), ctx), undefined, "verify() of a request with no credential");
    }),

    authCase("a wrong or malformed credential is not an operator, and verify does not throw", async (auth, fixture, ctx) => {
      for (const headers of fixture.intruders) {
        const verdict = await auth.verify(request(headers), ctx).then(
          (operator) => operator,
          (error: unknown) => {
            throw new Error(`${GROUP}: verify() threw for ${JSON.stringify(Object.keys(headers))}: ${String(error)}`);
          },
        );
        expect(verdict, undefined, `verify() of ${JSON.stringify(headers)}`);
      }
    }),

    authCase("verify leaves the body for the route", async (auth, fixture, ctx) => {
      const posted = request(fixture.operator, '{"text":"still here"}');
      await auth.verify(posted, ctx);

      expect(posted.bodyUsed, false, "the request's bodyUsed after verify()");
      expect(await posted.text(), '{"text":"still here"}', "the body the route reads");
    }),

    {
      group: GROUP,
      name: "a provider that could verify nobody (its secret is not set) fails the start",
      run: async () => {
        const fixture = await factory();
        try {
          if (fixture.unconfigured === undefined) return;
          const { app } = await composed(fixture.unconfigured.components, fixture.unconfigured.config);
          const failed = await app.start().then(
            () => false,
            () => true,
          );
          await app.stop().catch(() => {});
          check(failed, "start() to reject without the provider's secret");
        } finally {
          await fixture.dispose?.();
        }
      },
    },
  ];
}

async function composed(components: ComponentDefinition[], config: Record<string, unknown> | undefined) {
  let handle: Handle<AdminAuth> | undefined;
  const consumer = defineComponent({
    name: "admin-auth-conformance",
    setup(pikit) {
      handle = pikit.use("admin.auth");
    },
  });
  const app = await defineApp({ components: [...components, consumer], ...(config !== undefined && { config }), logger: silentLogger }).create();
  if (handle === undefined) throw new Error(`${GROUP}: the consumer did not set up`);
  return { app, handle };
}

async function started(components: ComponentDefinition[], config: Record<string, unknown> | undefined) {
  const { app, handle } = await composed(components, config);
  await app.start();
  return { app, handle };
}
