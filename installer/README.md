# installer

`install.sh` puts the `pikit` CLI on a machine: a clean Debian/Ubuntu VPS or macOS.

```sh
curl -fsSL https://raw.githubusercontent.com/ajarellanod/pikit/main/installer/install.sh | sh                                 # asks before anything with sudo
curl -fsSL https://raw.githubusercontent.com/ajarellanod/pikit/main/installer/install.sh | sh -s -- --yes --install-docker    # a script's consent
curl -fsSL https://raw.githubusercontent.com/ajarellanod/pikit/main/installer/install.sh | sh -s -- --durable                 # a dashboard assistant on Cloudflare
```

It is POSIX sh (`set -eu`), idempotent (running it again updates pikit), and says what it does
before doing it. The steps and settings are at the top of the script.

- `git`, `curl`, `unzip`: installed with `apt-get` only after a "y" (or `--yes` / `PIKIT_YES=1`).
- Bun, pinned: an existing Bun is used only within the supported range, `>= 1.4.0` and `< 2.0.0`
  (a new major may break pikit). When there is none, Bun's own installer puts the pinned version
  (`PIKIT_BUN_VERSION`, default `1.4.2`) into `~/.bun`; no sudo. A Bun outside the range is replaced
  by the pinned one in `~/.bun` only after a "y" (or `--yes` / `PIKIT_YES=1`); a Bun elsewhere, such
  as Homebrew's, is left alone. It never runs `bun upgrade`, which would install the latest Bun.
- pikit: `git clone` of `PIKIT_REPO` (or `PIKIT_SOURCE`, a local checkout) at `PIKIT_REF` into
  `~/.pikit/pikit`, then `bun install --frozen-lockfile --production` there. `PIKIT_REF` defaults to
  the latest release: the highest `vMAJOR.MINOR.PATCH` tag of `PIKIT_REPO` (`git ls-remote --tags`,
  compared as numbers; pre-releases and other tags are not releases), or `main` when there is none.
  `PIKIT_REF=main` installs the development branch; any branch, tag or commit works. With
  `PIKIT_SOURCE` it defaults to that checkout's `HEAD`: what you are working on.
- `~/.pikit/bin/pikit`: a two-line shim that runs the checkout's CLI with that Bun. The installer
  prints the `PATH` line to add; it edits no shell file.
- Docker: only `pikit up` on a server with `deployment-docker` (the default) needs it. `pikit new` asks
  how it should run: in Docker, or as a service of this machine (`deployment-local`: a systemd user
  unit on Linux, a launchd agent on macOS), which needs no Docker. On Linux the official script
  (`get.docker.com`) runs only with `--install-docker` / `PIKIT_INSTALL_DOCKER=1` or a "y", and with
  the same consent adds you to the `docker` group; on macOS it points to Docker Desktop. Without it,
  both say to answer "This machine's service". With `--durable` it is skipped.
- Then, on a terminal, it runs `pikit new`: the guided path asks the project's name, where it runs,
  its channels, whether you will use one agent or several, and its optional features (routing rules,
  MCP tools, health...). Full presets include the dashboard; several agents chooses the feature the
  preset names (`agents-folders` in the kit's). A feature the chosen deployment cannot run is shown
  disabled with the reason (Self-improvement on deployment-local); the wizard never switches the
  deployment for you.
  It sets that up, logs in to the
  model and starts it. Ctrl-C stops it; `pikit new` continues later. `PIKIT_NO_WIZARD=1` skips it. It ends
  with the lines this shell still needs (`PATH`, `newgrp docker`). The wizard reads from the actual
  terminal device (such as `/dev/ttys004` or `/dev/pts/0`), not the installer's pipe or `/dev/tty`:
  Bun 1.4.2 on macOS otherwise draws the name prompt but never receives keystrokes.

## Cloudflare in one line

```sh
curl -fsSL https://raw.githubusercontent.com/ajarellanod/pikit/main/installer/install.sh | sh -s -- --durable
```

`--durable` (or `PIKIT_DURABLE=1`) changes two steps, and nothing else:

- **No Docker.** Nothing runs on this machine once the assistant is deployed, so Docker is neither checked
  nor offered. Instead it checks **Node.js >= 22**, which wrangler (Cloudflare's CLI, a dev dependency
  of each project) runs on, and says how to install it when it is missing or older; it does not
  install it.
- **`pikit new --target durable --preset cloudflare`** instead of `pikit new`: an assistant on
  Cloudflare Workers, with a dashboard and a Durable Object per conversation. It asks:
  1. the project's name, optional external channels (none is fine), one agent or several, and
     optional features. It writes the project and runs `bun install`. Steward is the first agent;
     several agents adds `agents-folders` and an initial generated registry;
  2. "Configure it now?": the admin token for `/admin/`, the OpenRouter key, and an optional Brave
     Search key. No Telegram token, allowlist or webhook is needed unless Telegram was selected;
  3. "Start it?", "On Cloudflare": `pikit up`. If wrangler is not logged in, it offers `wrangler
     login`, which opens your browser (sign up there if you have no account). On the account's first
     deploy, wrangler asks for its `workers.dev` subdomain. It deploys and waits until the new
     version answers. Open `/admin/` at the Worker's URL and sign in with `PIKIT_ADMIN_TOKEN`.

Without the flag, choose the durable target and the Cloudflare preset in `pikit new` (on Linux
without Docker, the installer asks about Docker first: answer N). By hand:

```sh
pikit new my-agent --target durable --preset cloudflare
cd my-agent
pikit configure
pikit up
```

For Telegram, add `--with channel-telegram-webhook` to creation, or install it later with
`pikit add channel-telegram-webhook`. The dashboard works independently of that channel.

**Costs.** Cloudflare's Workers Free plan is enough (100,000 requests a day, 5 GB of Durable Object
storage; the Paid plan, $5 a month, raises them). What you pay for is the model's tokens (OpenRouter),
per message. On a machine without a browser, use an API token from the "Edit Cloudflare Workers"
template as `CLOUDFLARE_API_TOKEN` instead of `wrangler login`; see deployment-cloudflare's README.

It installs from Git because `@pikit/*` are not on npm: a release is a tag of this repository, and
`pikit new` vendors the kit from this checkout into each project. No 0.0.x release promises
compatibility with the one before.

## Tests

- `install.test.ts`: always, `sh -n`, shellcheck (when installed), and how Bun is chosen (pin, range,
  `PIKIT_BUN_VERSION`) with stand-ins for `bun`, `curl` and `git`, without network, and the
  Cloudflare path (`--durable`: no Docker, Node.js checked, the `pikit new` it hands over to) and the
  ref it installs (the highest release tag, else `main`; `PIKIT_REF` first) with stand-ins for `bun`,
  `git` and `node`. Real pseudo-terminal tests feed the installer through a pipe and check the real
  wizard accepts its name and Ctrl-C on the server, Cloudflare and `sg docker` paths, and that
  `PIKIT_NO_WIZARD=1` skips it. These use fake installation commands: no network, sudo or deploy.
  With `PIKIT_INSTALLER_TEST=1`, a real install of this repository's committed `HEAD` into a temporary
  `HOME`, twice, then `pikit --version`. CI (`.github/workflows/ci.yml`) runs the first part on Linux
  and macOS on every pull request; the nightly workflow (`.github/workflows/nightly.yml`) runs it with
  `PIKIT_INSTALLER_TEST=1`.
- On a clean Debian, by hand (Docker; the repository mounted read-only, the container removed):

  ```sh
  docker run --rm -v "$PWD:/src:ro" -e PIKIT_SOURCE=/src -e PIKIT_YES=1 debian:bookworm-slim \
    sh -c 'apt-get update -qq && apt-get install -y -qq curl >/dev/null && sh /src/installer/install.sh'
  ```
