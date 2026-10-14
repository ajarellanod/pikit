# expose-cloudflare-tunnel

A public HTTPS URL for a server project, by a Cloudflare Tunnel: what a platform that posts webhooks
(Google Chat, WhatsApp's Cloud API) needs. Only the paths you list are public; the dashboard stays on
this machine. The design note is [features/completed/expose.md](https://github.com/ajarellanod/pikit/blob/main/features/completed/expose.md).

- **Provides:** no capability. It is not an app component (nothing of it runs in the app, so it is not
  in `pikit.config.ts`): it adds the command `pikit expose`, a `cloudflared` service beside the app, and
  a step of `pikit doctor`.
- **Requires:** `deployment-docker` (its `up` runs the service), a domain on your Cloudflare account,
  and a Cloudflare API token when you create, change or delete the tunnel.
- **Target:** `server`. On Cloudflare (`durable`) the Worker is public already.
- **Installs to:** `src/pikit/expose-cloudflare-tunnel/`.
- **npm dependencies:** none.
- **Environment** (`pikit configure` asks for both; neither is a secret):
  - `CLOUDFLARE_TUNNEL_HOSTNAME` (required): the public hostname, on a zone of your account
    (`bot.example.com`).
  - `PIKIT_EXPOSE_PATHS` (required): the paths the internet may reach, separated by commas. A path is
    exact (`/googlechat`) or a prefix (`/hooks/*`: `/hooks` and anything under it). `/health` is always
    public. Anything else answers 404 from Cloudflare, never from the app.
- **Writes:** `.env.cloudflared` (the tunnel's token, `0600`) and `PIKIT_PUBLIC_URL` in `.env`. Both
  `.env` and `.env.*` stay out of git and out of the image.

## Set it up

1. In Cloudflare, *My Profile > API Tokens > Create Token > Custom token*, with **Account > Cloudflare
   Tunnel > Edit** and **Zone > DNS > Edit**, the zone limited to your bot's domain. An expiry is a
   good idea: you need it only to create, change or delete the tunnel.
2. `pikit add expose-cloudflare-tunnel`, then `pikit configure` (the hostname and the paths).
3. `pikit expose`. It asks for the token without echo, or reads it from the shell
   (`CLOUDFLARE_API_TOKEN=… pikit expose`, `op run -- pikit expose`), and prints the URL.
4. `pikit up`: the app and `cloudflared` beside it. `pikit expose status` checks it from outside.

```
$ pikit expose
Cloudflare API token (…; not stored): ****************
created the tunnel pikit-bot.example.com
routes: /health, /googlechat to the app; anything else answers 404
DNS: bot.example.com to the tunnel
.env.cloudflared: the tunnel's token, for the cloudflared service only
https://bot.example.com
```

## The command

| | What it does | API token |
|---|---|---|
| `pikit expose` | Creates or reconciles the tunnel `pikit-<hostname>`, its routes, the DNS record and `.env.cloudflared`; writes `PIKIT_PUBLIC_URL`. Writes only what differs: run it after changing the paths, or to repair drift | yes |
| `pikit expose status` | The URL, the public paths, the tunnel's state (when `CLOUDFLARE_API_TOKEN` is in the shell; never asked), and `GET <url>/health` through Cloudflare: no connector (530), routes not this project's (404), or the app's answer. Exits 1 unless it answers 200 | no |
| `pikit expose quick [port]` | A temporary tunnel to this machine's app (default port 3000) while `pikit dev` runs, until Ctrl-C: `https://<random>.trycloudflare.com`. No account, no routes (every path is public while it runs), a new URL each time, no uptime: for a try, never for a platform's settings. Needs `cloudflared` here (`brew install cloudflared`); writes nothing | no |
| `pikit expose delete [--yes]` | After a confirmation: its DNS record (only one it made), the tunnel's connections and the tunnel, `.env.cloudflared` and `PIKIT_PUBLIC_URL` | yes |

## What it guarantees

- **Only the listed paths are public.** The tunnel's routes are one rule per path (`hostname`, `path`
  as an anchored Go regular expression, to `http://app:3000`) and a catch-all `http_status:404`.
- **No Cloudflare credential reaches the app.** compose.yaml gives the whole `.env` to the app's
  container, where the agent runs, and `execution-local`'s variable allowlist is not a sandbox. So the
  API token is never written anywhere, and `pikit expose` and `pikit doctor` refuse a
  `CLOUDFLARE_API_TOKEN` in `.env`; the tunnel's token is in `.env.cloudflared`, which only the
  `cloudflared` service reads (`env_file`). Neither is ever printed or logged.
- **It changes only what is its own.** A DNS record of the hostname that it did not make (its comment
  says `pikit expose: pikit-<hostname>`) stops it before any write, naming the record. Its own record
  still pointing at a tunnel deleted since is moved to the new one.
- **Idempotent.** A second run makes no write; a changed path changes the routes only.
- **The URL survives reboots.** The tunnel is remotely managed (its routes are in Cloudflare), and
  `cloudflared` is a compose service with `restart: unless-stopped`, started once the app is healthy.

## How it runs beside the app

`component.json` declares `"compose": "compose.yaml"`. `pikit add` records it in `pikit.json`, and
`deployment-docker` adds it after its own compose.yaml for `up`, `down`, `restart`, `logs` and
`status` (`docker compose -f compose.yaml -f src/pikit/expose-cloudflare-tunnel/compose.yaml …`). The
service (`cloudflare/cloudflared`, pinned) runs `tunnel run` with `TUNNEL_TOKEN` from
`.env.cloudflared`, and reaches the app on compose's network: no port is published. Before
`pikit expose` ran, `.env.cloudflared` is missing and `pikit up` fails (`pikit doctor` notes it).

Once the containers are healthy, `deployment-docker`'s `up` runs the components' `afterDeploy` hooks
with `PIKIT_PUBLIC_URL`: what registers a webhook gets the public URL.

## Removing it

`pikit remove` runs no code of the component, so the tunnel and its DNS record would stay in
Cloudflare. First `pikit expose delete`, then `pikit down` (the `cloudflared` container), then
`pikit remove expose-cloudflare-tunnel`.

## Tests

`expose-cloudflare-tunnel.test.ts` runs against `fake-cloudflare.test-support.ts`, a local stand-in of
Cloudflare's API (zones, remotely managed tunnels, DNS records, its envelope and its 403) that counts
every write, and a fake `cloudflared`: no account, no network, no Docker. It covers the first run and a
second one that writes nothing, changed paths, a DNS record of someone else's (no write at all), its own
record moved to a new tunnel, a refused token, a hostname on no zone, no token, a token in `.env`
refused before anything is asked, no token in what it says or in `.env`, the paths' patterns and the
values' checks, each answer of `status`, `delete` (asked, declined, without a terminal, connections
first, other records kept), `quick` (the URL, the port, `cloudflared` missing), the subcommands, and
the `doctor` step. `deployment-docker`'s tests cover the compose file in its commands and the
`afterDeploy` hooks.
