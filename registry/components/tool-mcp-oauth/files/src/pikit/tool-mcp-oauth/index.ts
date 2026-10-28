/**
 * tool-mcp-oauth: OAuth logins for remote MCP servers (`mcp.auth`, by server name), which tool-mcp
 * uses for a server whose config says `auth: "oauth"`.
 *
 * - **One copy of each login**, the owner's (`OWNER_KEY`, `owner.ts`): on a server the App itself
 *   (mailbox-local), on Cloudflare one Durable Object of the conversations' class, never a
 *   conversation. It keeps each server's login in its `storage.sql`, by server name, for the URL it
 *   was made for. Every App reaches it through `actor.mailbox`.
 * - **Only the owner refreshes, once per server at a time** (`owner.ts`): a conversation that gets a
 *   401 names the token it sent, and the owner refreshes only when that token is still current.
 *   Refresh tokens rotate, so a second refresher would revoke the first one's tokens.
 * - **Few subrequests** (`remote.ts`): each App keeps the token it got until a minute before it
 *   expires.
 * - **Logged in from the operator's machine** (`login.ts`, `pikit tool-mcp-oauth login <server>`):
 *   the browser login (dynamic client registration with the server's `clientName`, PKCE) runs there,
 *   and the login is uploaded to the App's route (`routes.ts`, behind `admin.auth`; on Cloudflare the
 *   Worker's half, `worker.ts`), which hands it to the owner. Nothing is kept on the machine: a
 *   second copy refreshing would revoke the deployed one's tokens.
 * - **Not logged in is not down**: the server's tools fail their calls with "log in again: `pikit
 *   tool-mcp-oauth login <server>`", the rest of the App works, and `health` (if installed) reports
 *   `tool-mcp-oauth:<server>` degraded.
 *
 * No token, refresh token or client secret is ever logged, put in an error, or answered by a route.
 *
 * Targets: `server` and `durable`.
 */

import { type AppContext, BACKGROUND_CONTEXT, defineComponent } from "@pikit/core";
import type { HealthReporter } from "@pikit/contracts";
import Type, { type Static } from "typebox";
import { loginCommand, OWNER_KEY, SERVER_NAME } from "./calls.ts";
import { answerCalls, createOwner } from "./owner.ts";
import { createMcpAuth } from "./remote.ts";
import { provideRoutes } from "./routes.ts";

export { OWNER_KEY } from "./calls.ts";
export { McpLoginRequiredError } from "./remote.ts";
export { ROUTE } from "./routes.ts";
export { worker, WORKER_NAME } from "./worker.ts";

/** The `client_name` dynamic client registration sends when a server's config gives none. */
export const DEFAULT_CLIENT_NAME = "pikit";

const Server = Type.Object(
  {
    url: Type.String({ minLength: 1, description: "The server's Streamable HTTP endpoint: the same as tool-mcp's server of this name. A login is used only for it." }),
    clientName: Type.Optional(
      Type.String({
        minLength: 1,
        description: `The client_name the login registers with (dynamic client registration). Default: "${DEFAULT_CLIENT_NAME}". Some servers accept only the names in their catalogue.`,
      }),
    ),
  },
  { additionalProperties: false },
);

const Config = Type.Object(
  {
    /** Server name (tool-mcp's) → its endpoint, and how the login introduces itself. */
    servers: Type.Record(Type.String(), Server, { default: {} }),
  },
  { examples: [{ servers: { linear: { url: "https://mcp.linear.app/mcp" } } }] },
);

export type OAuthServerConfig = Static<typeof Server>;

export default defineComponent({
  name: "tool-mcp-oauth",
  config: Config,
  setup(pikit, config) {
    const sql = pikit.use("storage.sql");
    const inbox = pikit.use("actor.inbox");
    const mailbox = pikit.use("actor.mailbox");
    // Its routes answer operators only; without a provider, nobody.
    const auth = pikit.useOptional("admin.auth");
    const health = pikit.useOptional("health");
    let context: AppContext | undefined;
    const reporters = new Map<string, HealthReporter>();
    const reporter = (server: string): HealthReporter | undefined => {
      const registry = health.get();
      if (registry === undefined) return undefined;
      let found = reporters.get(server);
      if (found === undefined) {
        found = registry.reporter(`tool-mcp-oauth:${server}`);
        reporters.set(server, found);
      }
      return found;
    };

    for (const [server, settings] of Object.entries(config.servers)) {
      if (!SERVER_NAME.test(server)) throw new Error(`tool-mcp-oauth: the server name "${server}" may hold only letters, digits, "_" and "-": it is tool-mcp's server name`);
      if (!URL.canParse(settings.url)) throw new Error(`tool-mcp-oauth: the URL of the MCP server "${server}" is not a URL`);
      pikit.provideKeyed(
        "mcp.auth",
        server,
        createMcpAuth({ server, url: settings.url, mailbox: () => mailbox.get(), context: () => context, clock: pikit.clock, health: () => reporter(server) }),
      );
    }
    const owner = createOwner({ sql: () => sql.get(), clock: pikit.clock, servers: config.servers });
    provideRoutes(pikit, { auth, ask: (type, message, ctx) => mailbox.get().call(OWNER_KEY, type, message, ctx) });

    return {
      async start(ctx) {
        context = ctx.derive(() => BACKGROUND_CONTEXT);
        const calls = inbox.get();
        answerCalls(calls, owner);
        // Every key's actor (a server): this App is the owner, and says at once which servers need a login.
        if (calls.scope === "all" && health.get() !== undefined) {
          for (const status of await owner.list()) {
            if (status.loggedIn) reporter(status.server)?.up();
            else reporter(status.server)?.degraded(`the MCP server "${status.server}" is not logged in (${status.reason ?? "no login"}): log in again: \`${loginCommand(status.server)}\``);
          }
        }
      },
      stop() {
        context = undefined;
      },
    };
  },
});
