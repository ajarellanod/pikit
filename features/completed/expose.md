# Expose: a public URL for a server project

**Public appeal:** —

**Status:** built. `pikit expose` is an installed component's command (`expose-cloudflare-tunnel`), on
[component commands](../component-commands.md). The former SPEC §11 listed `pikit expose  # cloudflare
tunnel / caddy helper (server)`; the CLI kept the name until then.

**Needed by:** the webhook channels on a server: [channel-google-chat](../channel-google-chat.md), the
WhatsApp Cloud API ([channel-whatsapp](../channel-whatsapp.md)), a Telegram webhook on a server.

## What it gives
A server project (`deployment-docker`) listens on `127.0.0.1:3000` only, on purpose (its
`compose.yaml`). A platform that posts webhooks needs a stable public HTTPS URL. `pikit expose` gives
one, and publishes only the paths that must be public, so the dashboard stays private.

On Cloudflare (`durable`) there is nothing to do: the Worker is public, and a channel's webhook is a
route of it.

| Case | What happens |
|---|---|
| Trying a webhook channel on a laptop, with `pikit dev` | `pikit expose quick`: a temporary tunnel (`https://<random>.trycloudflare.com`), no account, closed with Ctrl-C. The URL changes each time: for a test, never for a platform's console |
| A VPS with Docker, the domain on Cloudflare | `pikit expose` creates a named tunnel and `bot.example.com` once; `pikit up` runs it beside the app. No open port, survives reboots |
| A laptop or home server behind NAT, the domain on Cloudflare | The same as the VPS: the tunnel dials out |
| No domain on Cloudflare | Another component of the same kind when someone needs it: `expose-tailscale` (Funnel, `<machine>.<tailnet>.ts.net`), `expose-caddy` (own domain, ports 80 and 443 open) |
| A project on Cloudflare | The component is `server` only: nothing to install |
| Exposing nothing again | `pikit expose delete` (tunnel and DNS record), `pikit down`, then `pikit remove expose-cloudflare-tunnel` |

## How it fits pikit
- **No runtime contract.** Nothing in `@pikit/contracts`, `@pikit/core` or `@pikit/pi-adapter`
  changed, nor `http.route`, `server-bun` or any channel. Like `deployment-*`, the component is not an
  app component (no default export, not in `pikit.config.ts`): it runs on the machine that runs the
  CLI, and as a container beside the app.
- **The kind `expose`**, in `KINDS` (`packages/cli/src/registry/manifest.ts`). One component per
  mechanism, never a switch: `expose-cloudflare-tunnel` first; Tailscale and Caddy when a user needs
  them.
- **The command is a component command**: `expose-cloudflare-tunnel` declares
  `"commands": { "expose": { "file": "expose.ts", … } }`; `expose` left `LATER` (`main.ts`) and
  `BUILT_IN_COMMANDS`. "One owner per name" keeps one `expose-*` installed at a time, with no rule of
  its own. No `ExposeModule` protocol in the CLI (the alternative, as `DeploymentModule` is for
  `deployment-*`): component commands already generalise it. Without one installed, `expose` is an
  unknown command.

  ```
  pikit expose                  create or reconcile the tunnel, its routes and its DNS record; print the URL
  pikit expose status           the tunnel's state, GET <url>/health through it
  pikit expose quick [port]     a temporary tunnel to this machine's app, until Ctrl-C (pikit dev)
  pikit expose delete [--yes]   the DNS record and the tunnel, after a confirmation
  ```

- **Its values are non-secret variables**, declared in `environment` (`pikit configure` asks them,
  `pikit doctor` requires them): `CLOUDFLARE_TUNNEL_HOSTNAME` and `PIKIT_EXPOSE_PATHS` (comma separated,
  exact paths or `/prefix/*`). Not config in `pikit.config.ts`: `defineApp` refuses a key of a
  component that is not in the App (`additionalProperties: false`). The account comes from the zone of
  the hostname, so it is never asked.
- **The URL** is `PIKIT_PUBLIC_URL` in `.env`, written by `pikit expose`. Read by the CLI side only:
  `deployment-docker`'s `up`. No App reads it. If a channel ever needs its own public URL at runtime,
  that is a contract added with that channel (contract rule 1), read from configuration, never from a
  request's `Host`. Google Chat does not need it: its JWT audience can be the project number.
- **`deployment-docker` runs `afterDeploy` hooks**, as `deployment-cloudflare` does, once the containers
  are healthy, with `url = PIKIT_PUBLIC_URL`; without one it runs none and says which it skipped. Same
  `AfterDeployIO` shape. A Telegram webhook on a server would `setWebhook` there; Google Chat, which
  has no API for its endpoint, would print the URL to paste in its console.
- **The tunnel runs beside the app**: `component.json`'s `compose` (new, a Compose file of the
  component's own) is recorded in `pikit.json`, and `deployment-docker` adds every recorded one after
  its compose.yaml (`-f compose.yaml -f <it>`) for `up`, `down`, `restart`, `logs` and `status`. The
  service, `cloudflare/cloudflared` pinned, `restart: unless-stopped`, starts once the app is healthy
  and reaches `http://app:3000` on compose's network, with no published port. Chosen over a
  convention (any `src/pikit/<name>/compose.yaml` included) because a file whose mere presence changes
  behaviour is magic; over `COMPOSE_FILE` or `compose.override.yaml` because those have one owner and
  collide with the user's. `pikit expose quick` runs `cloudflared` on this machine instead, as a child.
- **Only the listed paths are public**: one ingress rule per path (`hostname`, `path` as an anchored Go
  regular expression, `service: http://app:3000`) and a catch-all `http_status:404`. `/health` is
  always public. `/admin/*` only when listed, knowing its token is then its only lock.
- **Credentials never reach the app.** compose.yaml gives the whole `.env` to the app's container
  (`env_file`), and `execution-local`'s variable allowlist is not a sandbox: what is in `.env` is
  readable by the agent's commands.
  - The Cloudflare API token (Account > Cloudflare Tunnel > Edit; Zone > DNS > Edit) is read from the
    shell's `CLOUDFLARE_API_TOKEN` or asked without echo, and never written. `pikit expose` and its
    `doctor` step refuse it in `.env`.
  - The tunnel's token goes to `.env.cloudflared` (`0600`), which only the `cloudflared` service reads
    (`env_file`); `.env.*` is out of git and of the image already.

### What `pikit expose` does on Cloudflare
Every step is idempotent, so running it again repairs drift:
1. Finds the zone holding the hostname (the longest suffix that is a zone of the token's account).
2. Reads the tunnel (`pikit-<hostname>`) and the hostname's DNS records. A record it did not make
   (its comment is `pikit expose: pikit-<hostname>`, or it is a CNAME to the tunnel) stops it here,
   before any write.
3. Creates the tunnel when missing, `config_src: "cloudflare"` (remotely managed).
4. Puts its ingress rules when they differ.
5. Creates or updates the proxied `CNAME` to `<tunnel id>.cfargotunnel.com`: its own record still
   pointing at a tunnel deleted since moves to the new one.
6. Writes the tunnel's token to `.env.cloudflared` when it differs, and `PIKIT_PUBLIC_URL`.

`pikit expose quick` runs `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port>` and prints
the `trycloudflare.com` URL it announces. Cloudflare's limits for these: about 200 requests in flight,
no Server-Sent Events, no uptime guarantee, a new URL each run, and no ingress rules, so every path is
public while it runs: it says so before it starts. It writes nothing.

`pikit expose delete` (asked, or `--yes`) deletes its own DNS records only, ends the tunnel's
connections then deletes it, and removes `.env.cloudflared` and `PIKIT_PUBLIC_URL`.

## Guarantees
- A path not listed answers 404 from Cloudflare, never from the app.
- No Cloudflare credential is in `.env`, in the app's environment, in a log line or in printed output.
- `pikit expose` changes only the tunnel and the DNS record it owns; a conflict stops it, naming the
  record, before any write.
- Running it twice changes nothing; running it after a change converges.
- `pikit expose status` tells a tunnel with no connector (530) from routes that are not this project's
  (404) and from an app that does not answer.

## Pi first
Nothing in Pi: exposing a process to the internet is the deployment's, not the agent's.

## Where it is
- `registry/components/expose-cloudflare-tunnel/`: `expose.ts` (the command), `cloudflare.ts` (the API
  calls, plain `fetch`), `project.ts` (values, ingress rules, `.env` and `.env.cloudflared`),
  `prompt.ts`, `doctor.ts`, `compose.yaml`; README.
- `registry/components/deployment-docker/files/src/pikit/deployment-docker/commands.ts`: `fileArgs`,
  `runAfterDeployHooks`.
- The CLI: `compose` in `manifest.ts` (schema, `KINDS`), `pikit-json.ts`, `add.ts`, `upgrade.ts`,
  `registry/commands.ts` (`checkComposeFile`).
- Tests: `expose-cloudflare-tunnel.test.ts` against `fake-cloudflare.test-support.ts` (a local stand-in
  of Cloudflare's API that counts writes) and a fake `cloudflared`, checked against a component broken
  on purpose (no DNS guard, a token in `.env`); `deployment-docker`'s `commands.test.ts`;
  `packages/cli/src/commands/component-compose.test.ts`. The Compose files were merged by a real
  `docker compose config` (the app gets no `TUNNEL_TOKEN`). Not covered: a run against a real Cloudflare
  account and a real `cloudflared` connector.

## Open questions
1. **`pikit remove` leaves the tunnel and the record** in Cloudflare: no code runs at removal. The README
   says `pikit expose delete` first; a `beforeRemove` hook when a second component needs one.
2. **A stable URL while developing**: a second tunnel (`bot-dev.example.com`) that `pikit expose quick`
   could use instead, with ingress rules, for a platform's development app (Google Chat's console wants
   a fixed URL). A second connector on the production tunnel would share its traffic: never that.
3. **Proposing the paths**: `pikit configure` could offer `/health` and the installed channels'
   `http.route` keys (`app.describe()`) instead of asking for the list.
4. **Cloudflare Access** in front of `/admin/*`, when an operator wants the dashboard from anywhere.
5. **`deployment-systemd`** (not built) would run `cloudflared` as a unit, not a compose service.
