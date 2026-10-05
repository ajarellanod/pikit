# health-registry

What is up, degraded or down in the App. Components report their own state (a channel whose poller
keeps failing, a lost connection); the dashboard shows it, and server-bun's `GET /health` answers
`503` when an essential component stays down, so the supervisor restarts the process.

- **Provides:** `health` (`@pikit/contracts`' `health.ts`), and `http.route`: `GET /admin/api/health-registry`,
  its view's data.
- **Requires:** nothing. **Uses, if installed:** `admin.auth` (without it, its route answers nobody).
- **View:** `view/`, the dashboard's Health page (SPEC §5): installed to
  `src/dashboard/src/views/health-registry/` when the project has a UI. It is the reference for a
  component with a view (the `pikit-view` skill).
- **Targets:** `server` and `durable`: plain code. On Cloudflare each object's App has its own.
- **Installs to:** `src/pikit/health-registry/`.

Without it nothing changes: components report through `useOptional("health")`, and `/health`
answers `200` while the process can answer at all.

## Its view

`GET /admin/api/health-registry` answers an operator (`admin.auth`, else `401`) the snapshot, the
`essential` names and `graceMs` it follows, and `now` (the App's clock): `HealthView` in `index.ts`.
The view shows the App's status, each component's status, reason and since when, polled every 5 s.

## Configure

```ts
"health-registry": {
  essential: ["channel-telegram"], // default []: no component can make the App down
  graceMs: 30000,                  // default: how long an essential component is down before the App is
}
```

Names are what components report as, matched exactly: a component's name (`channel-telegram`), or
`<name>:<part>` for a part that fails on its own (`channel-telegram:ops`, a second bot). Which are
essential is a deployment's choice: a bot nobody can reach is worth a restart on a VPS, maybe not in
`pikit dev`.

## The policy

| Reports | The App |
|---|---|
| none, or every component `up` | `up` |
| a component `degraded`, or a non-essential one `down` | `degraded` |
| an essential component `down` for less than `graceMs` | `degraded` (a blip restarts nothing) |
| an essential component `down` for `graceMs` or more | `down`: `/health` answers `503` |

A component's state is its last report; `since` is when it entered that status. A component that
never reported is not listed. State is in memory, on purpose: health is this process's, and after a
restart every component reports again.

## Report from a component

```ts
const health = pikit.useOptional("health");
// in start:
const reporter = health.get()?.reporter("my-component");
reporter?.up();
reporter?.degraded("retrying: 502");
reporter?.down("connection lost 5 times: ECONNRESET");
```

A reason is short operator text: never a secret, a token, a URL holding one, or a person's message.
It is cut at 200 characters.

## Read it

`health.get().snapshot()` returns `{ status, components: [{ name, status, reason?, since, essential }] }`
(JSON, sorted by name). The admin API reads it for the dashboard; `/health` shows only the status.

## Guarantees

Its tests run `createHealthConformance` (`@pikit/contracts/testing`) on a manual clock: a component
is listed once it reports, its last report wins and `since` moves only when its status changes; the
policy above, the grace to the millisecond, and that it starts over when the component comes back;
the snapshot is JSON and a copy. Its own tests pin the defaults (nothing essential, 30 s), the cut
reason and the config check.

## Replace it

Another provider (one that also logs each change, or keeps a history for the dashboard) is another
component that provides `health` and passes the same suite. Reporters and `/health` do not change.
