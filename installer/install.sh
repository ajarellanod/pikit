#!/bin/sh
# pikit installer (ROADMAP M1): puts the `pikit` CLI on this machine.
#
#   curl -fsSL https://raw.githubusercontent.com/ajarellanod/pikit/main/installer/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/ajarellanod/pikit/main/installer/install.sh | sh -s -- --yes --install-docker
#
# What it does, in order, and it says so as it goes:
#   1. checks git, curl and (Linux) unzip; installs the missing ones with apt-get, after asking;
#   2. checks Bun >= 1.4; installs it from bun.sh when missing (in ~/.bun, no sudo);
#   3. fetches pikit with git into ~/.pikit/pikit, at a ref, and runs `bun install` there;
#   4. writes ~/.pikit/bin/pikit and prints the PATH line to add (it edits no shell file);
#   5. checks Docker, which only `pikit up` needs. On Linux it offers Docker's official script and
#      the docker group, and does either only with your consent (--install-docker, or "y" at the
#      prompt); on macOS it points to Docker Desktop.
# Running it again updates pikit and changes nothing else. It never runs sudo without saying so
# first and asking, and it never runs as a side effect what it did not print.
#
# Settings (environment):
#   PIKIT_HOME            where pikit lives (default ~/.pikit)
#   PIKIT_REPO            the Git repository (default https://github.com/ajarellanod/pikit.git)
#   PIKIT_REF             the branch, tag or commit (default main; HEAD with PIKIT_SOURCE)
#   PIKIT_SOURCE          a local checkout to install from instead of PIKIT_REPO (tests, development)
#   PIKIT_YES=1           answer yes to installing git, curl, unzip, and to upgrading Bun (not Docker)
#   PIKIT_INSTALL_DOCKER=1  consent to Docker's official install script on Linux

set -eu

BUN_MINIMUM="1.4.0"
PIKIT_HOME="${PIKIT_HOME:-$HOME/.pikit}"
PIKIT_REPO="${PIKIT_REPO:-https://github.com/ajarellanod/pikit.git}"
PIKIT_SOURCE="${PIKIT_SOURCE:-}"
PIKIT_YES="${PIKIT_YES:-}"
PIKIT_INSTALL_DOCKER="${PIKIT_INSTALL_DOCKER:-}"
if [ -n "$PIKIT_SOURCE" ]; then
  PIKIT_REF="${PIKIT_REF:-HEAD}"
else
  PIKIT_REF="${PIKIT_REF:-main}"
fi

for arg in "$@"; do
  case "$arg" in
    --yes | -y) PIKIT_YES=1 ;;
    --install-docker) PIKIT_INSTALL_DOCKER=1 ;;
    *) printf 'pikit install: unknown option %s\n' "$arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1mpikit:\033[0m %s\n' "$*"; }
warn() { printf 'pikit: warning: %s\n' "$*" >&2; }
fail() { printf 'pikit: error: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

# Asks on the terminal, even when the script itself arrives on stdin (curl | sh).
# $1: the question; $2: "yes" when the answer is already given by a flag.
ask() {
  if [ "${2:-}" = "1" ]; then return 0; fi
  # A subshell: in dash, a failed redirection on a special builtin would exit the whole script.
  if ! (: </dev/tty) 2>/dev/null; then
    say "$1 No terminal to ask on: rerun with the flag named above to consent."
    return 1
  fi
  printf '%s [y/N] ' "$1" >/dev/tty
  read -r answer </dev/tty || answer=""
  case "$answer" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

# Runs a command as root: directly when already root, through sudo otherwise, printed first.
as_root() {
  if [ "$(id -u)" = "0" ]; then
    say "running: $*"
    "$@"
  elif has sudo; then
    say "running: sudo $*"
    sudo "$@"
  else
    fail "this needs root and sudo is not installed: run as root: $*"
  fi
}

OS="$(uname -s)"
case "$OS" in
  Linux | Darwin) ;;
  *) fail "pikit installs on Linux and macOS; this is $OS" ;;
esac

# 1. System tools.
missing=""
for tool in git curl; do has "$tool" || missing="$missing $tool"; done
if [ "$OS" = "Linux" ] && ! has unzip; then missing="$missing unzip"; fi # the Bun installer needs it
if [ -n "$missing" ]; then
  if [ "$OS" = "Linux" ] && has apt-get; then
    if ask "Install$missing with apt-get (PIKIT_YES=1 or --yes to consent)?" "$PIKIT_YES"; then
      as_root apt-get update -qq
      # shellcheck disable=SC2086 # one word per package
      as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates $missing
    else
      fail "pikit needs:$missing. Install them, then run this again."
    fi
  else
    fail "pikit needs:$missing. Install them (on macOS: xcode-select --install), then run this again."
  fi
fi

# 2. Bun >= 1.4 (older Bun never fires some of pikit's stop deadlines).
bun_ok() { "$1" -e "process.exit(Bun.semver.satisfies(Bun.version, '>=$BUN_MINIMUM') ? 0 : 1)" >/dev/null 2>&1; }
BUN=""
if has bun; then BUN="$(command -v bun)"; elif [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun"; fi
if [ -z "$BUN" ]; then
  say "Bun is not installed: running Bun's own installer (https://bun.sh/install) into ~/.bun, no sudo."
  say "  It adds ~/.bun/bin to your shell's startup file; pikit itself does not need that."
  has bash || fail "the Bun installer needs bash; install bash, then run this again"
  curl -fsSL https://bun.sh/install | bash
  BUN="$HOME/.bun/bin/bun"
  [ -x "$BUN" ] || fail "Bun's installer did not leave $BUN"
fi
if ! bun_ok "$BUN"; then
  if ask "Bun $("$BUN" --version) is older than $BUN_MINIMUM. Run \`bun upgrade\` (PIKIT_YES=1 or --yes to consent)?" "$PIKIT_YES"; then
    "$BUN" upgrade
  fi
  bun_ok "$BUN" || fail "pikit needs Bun >= $BUN_MINIMUM; found $("$BUN" --version) at $BUN"
fi
say "Bun $("$BUN" --version) at $BUN"

# 3. pikit itself.
SOURCE="${PIKIT_SOURCE:-$PIKIT_REPO}"
CHECKOUT="$PIKIT_HOME/pikit"
mkdir -p "$PIKIT_HOME"
# A read-only or foreign-owned local source (a mounted checkout) is still safe to read from.
git_() { git -c safe.directory='*' -c advice.detachedHead=false "$@"; }
if [ -d "$CHECKOUT/.git" ]; then
  say "updating $CHECKOUT from $SOURCE ($PIKIT_REF)"
  git_ -C "$CHECKOUT" remote set-url origin "$SOURCE"
else
  say "fetching pikit from $SOURCE ($PIKIT_REF) into $CHECKOUT"
  git_ clone --quiet --no-checkout "$SOURCE" "$CHECKOUT"
fi
git_ -C "$CHECKOUT" fetch --quiet origin "$PIKIT_REF"
git_ -C "$CHECKOUT" checkout --quiet --force --detach FETCH_HEAD
say "pikit at $(git_ -C "$CHECKOUT" rev-parse --short HEAD); installing its dependencies"
(cd "$CHECKOUT" && "$BUN" install --frozen-lockfile --production >/dev/null)

# 4. The command, and PATH.
BIN_DIR="$PIKIT_HOME/bin"
mkdir -p "$BIN_DIR"
cat >"$BIN_DIR/pikit" <<EOF
#!/bin/sh
# Written by pikit's installer: runs the CLI of the checkout in $CHECKOUT with Bun.
exec "$BUN" "$CHECKOUT/packages/cli/src/main.ts" "\$@"
EOF
chmod 755 "$BIN_DIR/pikit"
"$BIN_DIR/pikit" --version >/dev/null || fail "$BIN_DIR/pikit does not run"
say "installed $("$BIN_DIR/pikit" --version) as $BIN_DIR/pikit"

# 5. Docker, for `pikit up` only. Without root, using it needs the docker group, which a running shell
# only gets after `newgrp docker` or a new login: the closing lines say so.
NEWGRP=""
join_docker_group() {
  as_root usermod -aG docker "$(id -un)"
  NEWGRP=1
}
if has docker && docker compose version >/dev/null 2>&1; then
  say "Docker with Compose found: pikit up can run your project in a container"
  if [ "$OS" = "Linux" ] && [ "$(id -u)" != "0" ] && ! docker info >/dev/null 2>&1; then
    # `id -nG` alone: this shell's groups; with the user: the groups a new login gets.
    if id -nG | tr ' ' '\n' | grep -qx docker; then
      warn "docker info fails although this shell is in the docker group: is the daemon running? (sudo systemctl start docker)"
    elif id -nG "$(id -un)" | tr ' ' '\n' | grep -qx docker; then
      NEWGRP=1
    elif ask "Docker needs root here. Add you to the docker group, so pikit can use it without sudo (--install-docker to consent)?" "$PIKIT_INSTALL_DOCKER"; then
      join_docker_group
    else
      say "  pikit up and pikit configure's login for it need Docker: sudo usermod -aG docker \"\$USER\", then log in again."
    fi
  fi
elif [ "$OS" = "Darwin" ]; then
  say "Docker is not installed. pikit up needs it; pikit dev does not."
  say "  Install Docker Desktop: https://docs.docker.com/desktop/setup/install/mac-install/"
else
  say "Docker is not installed. pikit up needs it; pikit dev does not."
  if ask "Install Docker with its official script (https://get.docker.com, runs as root), and add you to the docker group (PIKIT_INSTALL_DOCKER=1 or --install-docker to consent)?" "$PIKIT_INSTALL_DOCKER"; then
    curl -fsSL https://get.docker.com -o "$PIKIT_HOME/get-docker.sh"
    as_root sh "$PIKIT_HOME/get-docker.sh"
    rm -f "$PIKIT_HOME/get-docker.sh"
    if [ "$(id -u)" != "0" ]; then join_docker_group; fi
  else
    say "  Later: https://docs.docker.com/engine/install/ (or rerun this with --install-docker)"
  fi
fi

# Done: the lines to paste, in order. The PATH line comes first: `newgrp` starts a new shell that
# keeps this environment.
say "done. Now paste:"
printf '\n'
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  # shellcheck disable=SC2016 # $PATH is meant literally: it is the line to paste
  *) printf '  export PATH="%s:$PATH"    # add this line to ~/.profile too\n' "$BIN_DIR" ;;
esac
if [ -n "$NEWGRP" ]; then printf '  newgrp docker    # this shell joins the docker group (or log in again)\n'; fi
printf '  pikit new my-agent --preset http && cd my-agent && pikit configure && pikit up\n\n'
