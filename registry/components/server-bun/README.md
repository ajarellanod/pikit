# server-bun

The HTTP server of the server target: Hono on `Bun.serve`.

- **Provides:** nothing. It serves every `http.route` other components provide.
- **Uses:** `http.route` (keyed by `"METHOD /path"`).
- **Target:** `server` (it uses `Bun.serve`).
- **Installs to:** `src/pikit/server-bun/`.
- **npm dependencies:** `hono` (exact version, `4.13.9`), `typebox`.

## What it does

Channels and admin components provide routes as standard fetch handlers,
`(request: Request, ctx: AppContext) => Response`. They never see Hono, and the same handlers run
on Cloudflare. Hono only does the routing: `"POST /v1/conversations/:id/reset"` matches one
segment for `:id`, and the handler reads it from `request.url`.

Two routes are the server's own:
- `GET /health` answers `200` as long as the process can answer at all. A supervisor restarts the
  process when it stops answering.
- `GET /ready` answers `200` only after every component has started (`runtime.ready`). Before that,
  and from the moment the app starts stopping, it answers `503`. A load balancer sends traffic only
  while it is `200`.

Each request gets a context of its own, never the one `start` received. Its cancellation fires when
the client goes away or when the server stops. Stopping cancels every request in flight, so a
handler that is waiting (a channel waiting for the agent's answer) answers at once, and the stop
does not have to wait for it. Past the stop deadline, the remaining connections are closed.

A route that throws becomes a `500 {"error":"internal"}`, and the log says why. A request no route
matches is a `404`. A body larger than `maxRequestBodyBytes` is refused with `413`.

It refuses to start when its port is taken, when a route key is not `"METHOD /path"`, or when a
route claims `/health` or `/ready`.

## Config

```ts
"server-bun": {
  port: 3000,                  // default; 0 picks a free port
  hostname: "0.0.0.0",         // default
  maxRequestBodyBytes: 1048576, // default
  idleTimeoutSeconds: 255,     // default, Bun's maximum
}
```

`idleTimeoutSeconds` matters for channels that wait for the agent. Bun closes a connection that
stays idle for about twice this long, even while its handler is still working. Keep it above your
channel's reply timeout (`channel-http` waits up to 120 s by default).

## Tests

`server-bun.test.ts` is copied with the component and runs in your project, on 127.0.0.1 and a free
port. It covers:
- the `http.route` conformance suite from `@pikit/core/testing`;
- the lifecycle conformance suite, including a stopped server that no longer answers;
- `/health` and `/ready` while starting, running and stopping;
- the start failures above, and the body limit.

`component.json` is generated from `setup` by the CLI and is not written by hand. Until the CLI
exists, the test "what setup declares" pins it.
