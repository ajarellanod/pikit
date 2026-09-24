# installer

`install.sh` puts the `pikit` CLI on a machine (ROADMAP M1): a clean Debian/Ubuntu VPS or macOS.

```sh
curl -fsSL <url>/install.sh | sh                                 # asks before anything with sudo
curl -fsSL <url>/install.sh | sh -s -- --yes --install-docker    # a script's consent
```

It is POSIX sh (`set -eu`), idempotent (running it again updates pikit), and says what it does
before doing it. The steps and settings are at the top of the script.

- `git`, `curl`, `unzip`: installed with `apt-get` only after a "y" (or `--yes` / `PIKIT_YES=1`).
- Bun ≥ 1.4: installed with Bun's own installer into `~/.bun` when missing; no sudo.
- pikit: `git clone` of `PIKIT_REPO` (or `PIKIT_SOURCE`, a local checkout) at `PIKIT_REF` into
  `~/.pikit/pikit`, then `bun install --frozen-lockfile --production` there.
- `~/.pikit/bin/pikit`: a two-line shim that runs the checkout's CLI with that Bun. The installer
  prints the `PATH` line to add; it edits no shell file.
- Docker: only `pikit up` needs it. On Linux the official script (`get.docker.com`) runs only with
  `--install-docker` / `PIKIT_INSTALL_DOCKER=1` or a "y"; on macOS it points to Docker Desktop.

M1 installs from Git because `@pikit/*` are not published yet; `pikit new` vendors them from this
checkout into each project (SPEC §10.5).

## Tests

- `install.test.ts`: `sh -n` and shellcheck (when installed) always; with `PIKIT_INSTALLER_TEST=1`,
  a real install of this repository's committed `HEAD` into a temporary `HOME`, twice, then
  `pikit --version`.
- On a clean Debian, by hand (Docker; the repository mounted read-only, the container removed):

  ```sh
  docker run --rm -v "$PWD:/src:ro" -e PIKIT_SOURCE=/src -e PIKIT_YES=1 debian:bookworm-slim \
    sh -c 'apt-get update -qq && apt-get install -y -qq curl >/dev/null && sh /src/installer/install.sh'
  ```
