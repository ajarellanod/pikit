# installer

`install.sh` puts the `pikit` CLI on a machine (ROADMAP M1): a clean Debian/Ubuntu VPS or macOS.

```sh
curl -fsSL https://raw.githubusercontent.com/ajarellanod/pikit/main/installer/install.sh | sh                                 # asks before anything with sudo
curl -fsSL https://raw.githubusercontent.com/ajarellanod/pikit/main/installer/install.sh | sh -s -- --yes --install-docker    # a script's consent
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
  `main` because pikit has no release tags yet; once it tags releases, the default becomes the latest
  tag.
- `~/.pikit/bin/pikit`: a two-line shim that runs the checkout's CLI with that Bun. The installer
  prints the `PATH` line to add; it edits no shell file.
- Docker: only `pikit up` needs it. On Linux the official script (`get.docker.com`) runs only with
  `--install-docker` / `PIKIT_INSTALL_DOCKER=1` or a "y", and with the same consent adds you to the
  `docker` group; on macOS it points to Docker Desktop.
- Then, on a terminal, it runs `pikit new`: the guided path asks the agent's name, where to talk to it
  (Telegram, HTTP…), sets that up, logs in to the model and starts it. Ctrl-C stops it; `pikit new`
  continues later. `PIKIT_NO_WIZARD=1` skips it. It ends with the lines this shell still needs
  (`PATH`, `newgrp docker`).

M1 installs from Git because `@pikit/*` are not published yet; `pikit new` vendors them from this
checkout into each project (SPEC §10.5).

## Tests

- `install.test.ts`: always, `sh -n`, shellcheck (when installed), and how Bun is chosen (pin, range,
  `PIKIT_BUN_VERSION`) with stand-ins for `bun`, `curl` and `git`, without network; with
  `PIKIT_INSTALLER_TEST=1`, a real install of this repository's committed `HEAD` into a temporary
  `HOME`, twice, then `pikit --version`. CI (`.github/workflows/ci.yml`) runs the first part on every
  pull request; the nightly workflow (`.github/workflows/nightly.yml`) runs it with
  `PIKIT_INSTALLER_TEST=1`.
- On a clean Debian, by hand (Docker; the repository mounted read-only, the container removed):

  ```sh
  docker run --rm -v "$PWD:/src:ro" -e PIKIT_SOURCE=/src -e PIKIT_YES=1 debian:bookworm-slim \
    sh -c 'apt-get update -qq && apt-get install -y -qq curl >/dev/null && sh /src/installer/install.sh'
  ```
