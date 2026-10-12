/**
 * An operator of settings-store, as the dashboard is: a change goes through its `PUT
 * /admin/api/settings/:component` route, with an operator's credential (`admin.auth`). The `settings`
 * contract has no operator side: it is the provider's own surface.
 */

import { type AppContext, type ComponentDefinition, defineComponent } from "@pikit/core";
import type { AdminAuth, HttpRoute, SettingsValue } from "@pikit/contracts";

const AUTH = "Bearer workerd-settings-operator";

export interface SettingsOperator {
  /** `admin.auth` for the operator, and what reaches the App's routes: add both to the App. */
  components: ComponentDefinition[];
  /** Stores `value` as `component`'s whole value through the route, in the App once it started; a refusal rejects. */
  operate(component: string, value: SettingsValue, ctx: AppContext): Promise<void>;
}

export function settingsOperator(): SettingsOperator {
  let routes: { get(key: string): HttpRoute | undefined } | undefined;
  return {
    components: [
      defineComponent({
        name: "operator-auth-test",
        setup: (pikit) => pikit.provide("admin.auth", { verify: async (request) => (request.headers.get("authorization") === AUTH ? { id: "ops" } : undefined) } satisfies AdminAuth),
      }),
      defineComponent({
        name: "operator-test",
        setup(pikit) {
          const handle = pikit.useKeyed("http.route");
          return { start: () => void (routes = handle) };
        },
      }),
    ],
    async operate(component, value, ctx) {
      const route = routes?.get("PUT /admin/api/settings/:component");
      if (route === undefined) throw new Error("settings-store's PUT route is not served");
      const request = new Request(`https://pikit.test/admin/api/settings/${encodeURIComponent(component)}`, {
        method: "PUT",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: JSON.stringify(value),
      });
      const response = await route(request, ctx);
      if (!response.ok) throw new Error(`settings-store's PUT answered ${response.status}: ${await response.text()}`);
    },
  };
}
