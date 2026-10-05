/**
 * `admin.auth` conformance: what every provider guarantees to the admin routes that ask it
 * (`../admin.ts`). Runner-independent:
 *
 *   for (const c of createAdminAuthConformance(() => myProviderFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The cases of browser sessions run when the provider has them (`AdminAuth.sessions`), and pass
 * trivially when it does not.
 */

import { type AppContext, type ComponentDefinition, defineApp, defineComponent, type Handle, silentLogger } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import { ADMIN_CLIENT_HEADER, type AdminAuth, type AdminSessions } from "../admin.ts";
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

  /** A case of browser sessions: skipped (passing) when the provider has none. */
  const sessionCase = (name: string, run: (sessions: AdminSessions, auth: AdminAuth, fixture: AdminAuthFixture, ctx: AppContext) => Promise<void>): ConformanceCase =>
    authCase(`sessions: ${name}`, async (auth, fixture, ctx) => {
      if (auth.sessions === undefined) return;
      await run(auth.sessions, auth, fixture, ctx);
    });
  /** A request carrying only the session cookie of `setCookie` (`name=value; …`), and the client's header when `client`. */
  const withCookie = (setCookie: string, method = "GET", client = true) => {
    const pair = setCookie.split(";")[0] ?? "";
    return new Request("https://pikit.test/admin/api/conversations/x/abort", {
      method,
      headers: { cookie: `other=1; ${pair}`, ...(client && { [ADMIN_CLIENT_HEADER]: "1" }) },
    });
  };
  const attributes = (setCookie: string) => setCookie.split(";").slice(1).map((part) => part.trim().toLowerCase());
  const opened = async (sessions: AdminSessions, fixture: AdminAuthFixture, ctx: AppContext) => {
    const session = await sessions.open(request(fixture.operator, "{}"), ctx);
    if (session === undefined) throw new Error(`${GROUP}: sessions.open() of the operator's request opened none`);
    return session;
  };

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

    sessionCase("the operator's credential opens one; its cookie is that operator, holds no credential, and is HttpOnly, SameSite=Strict and Secure over https", async (sessions, auth, fixture, ctx) => {
      const session = await opened(sessions, fixture, ctx);
      const operator = await auth.verify(request(fixture.operator), ctx);

      check(session.operator.id === operator?.id, `the session's operator to be the credential's, got ${JSON.stringify(session.operator)}`);
      check(!session.cookie.includes(fixture.credential), "the credential not to appear in the cookie");
      for (const attribute of ["httponly", "samesite=strict", "secure"]) check(attributes(session.cookie).includes(attribute), `the cookie to be ${attribute}, got ${session.cookie}`);
      check(attributes(session.cookie).some((each) => each.startsWith("max-age=") || each.startsWith("expires=")), `the cookie to expire, got ${session.cookie}`);
      expect((await auth.verify(withCookie(session.cookie), ctx))?.id, operator?.id, "verify() of a GET with the session's cookie");
      expect((await auth.verify(withCookie(session.cookie, "POST"), ctx))?.id, operator?.id, `verify() of a POST with the session's cookie and ${ADMIN_CLIENT_HEADER}`);
    }),

    sessionCase(`a session's cookie on a request that changes something, without ${ADMIN_CLIENT_HEADER}, is not an operator (CSRF)`, async (sessions, auth, fixture, ctx) => {
      const session = await opened(sessions, fixture, ctx);

      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(await auth.verify(withCookie(session.cookie, method, false), ctx), undefined, `verify() of a ${method} with the cookie alone`);
    }),

    sessionCase("no credential, a wrong one, or a session's cookie opens none", async (sessions, _auth, fixture, ctx) => {
      expect(await sessions.open(request({}, "{}"), ctx), undefined, "sessions.open() of a request with no credential");
      for (const headers of fixture.intruders) expect(await sessions.open(request(headers, "{}"), ctx), undefined, `sessions.open() of ${JSON.stringify(headers)}`);
      const session = await opened(sessions, fixture, ctx);
      expect(await sessions.open(withCookie(session.cookie, "POST"), ctx), undefined, "sessions.open() of a request with a session's cookie only");
    }),

    sessionCase("a cookie changed by a byte is not an operator; close() expires it", async (sessions, auth, fixture, ctx) => {
      const session = await opened(sessions, fixture, ctx);
      const pair = session.cookie.split(";")[0] ?? "";
      const name = pair.slice(0, pair.indexOf("=") + 1);
      const value = pair.slice(name.length);
      /** `value` with its character at `at` replaced by another. */
      const changed = (at: number) => `${name}${value.slice(0, at)}${value[at] === "A" ? "B" : "A"}${value.slice(at + 1)}`;

      for (const at of [0, Math.floor(value.length / 2)]) expect(await auth.verify(withCookie(changed(at)), ctx), undefined, `verify() of the cookie changed at ${at}`);
      expect(await auth.verify(withCookie(`${pair.split("=")[0]}=`), ctx), undefined, "verify() of an empty cookie");
      const closed = sessions.close(withCookie(session.cookie));
      check(closed.split("=")[0] === pair.split("=")[0], `close() to name the session's cookie, got ${closed}`);
      check(attributes(closed).includes("max-age=0") || attributes(closed).some((each) => each.startsWith("expires=thu, 01 jan 1970")), `close() to expire it, got ${closed}`);
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
