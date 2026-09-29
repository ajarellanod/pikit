#!/bin/sh
# pikit installer: puts the `pikit` CLI on this machine.
#
#   curl -fsSL https://raw.githubusercontent.com/ajarellanod/pikit/main/installer/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/ajarellanod/pikit/main/installer/install.sh | sh -s -- --yes --install-docker
#   curl -fsSL https://raw.githubusercontent.com/ajarellanod/pikit/main/installer/install.sh | sh -s -- --cloudflare
#
# What it does, in order, and it says so as it goes:
#   1. checks git, curl and (Linux) unzip; installs the missing ones with apt-get, after asking;
#   2. checks Bun is in the supported range (>= 1.4.0, < 2.0.0); installs the pinned Bun (1.4.2) with
#      Bun's own installer when there is none (in ~/.bun, no sudo), and over one outside the range
#      after asking;
#   3. fetches pikit with git into ~/.pikit/pikit, at a ref, and runs `bun install` there;
#   4. writes ~/.pikit/bin/pikit and prints the PATH line to add (it edits no shell file);
#   5. checks Docker, which only `pikit up` on a server needs. On Linux it offers Docker's official
#      script and the docker group, and does either only with your consent (--install-docker, or "y"
#      at the prompt); on macOS it points to Docker Desktop. With --cloudflare it skips Docker and
#      checks Node.js >= 22 instead, which wrangler (Cloudflare's CLI, in each project) runs on;
#   6. on a terminal, runs `pikit new`, which asks everything and starts your first agent; with
#      --cloudflare, `pikit new --target cloudflare --preset telegram-cloudflare`, a Telegram bot on
#      Cloudflare, which asks its name, `pikit configure`'s questions, then deploys it with `pikit up`
#      (PIKIT_NO_WIZARD=1 skips it; Ctrl-C stops it, and `pikit new` continues later).
# Running it again updates pikit and changes nothing else. It never runs sudo without saying so
# first and asking, and it never runs as a side effect what it did not print.
#
# Settings (environment):
#   PIKIT_HOME            where pikit lives (default ~/.pikit)
#   PIKIT_REPO            the Git repository (default https://github.com/ajarellanod/pikit.git)
#   PIKIT_REF             the branch, tag or commit to install (default main; HEAD with PIKIT_SOURCE).
#                         pikit has no release tags yet, so main is the default; once tags exist the
#                         default becomes the latest release tag, and main is opt-in.
#   PIKIT_SOURCE          a local checkout to install from instead of PIKIT_REPO (tests, development)
#   PIKIT_BUN_VERSION     the Bun this installs when it needs one (default 1.4.2; "1.4.2" or "bun-v1.4.2");
#                         it must be in the supported range
#   PIKIT_YES=1           answer yes to installing git, curl, unzip, and to replacing a Bun outside the
#                         supported range with PIKIT_BUN_VERSION (not Docker)
#   PIKIT_INSTALL_DOCKER=1  consent to Docker's official install script on Linux
#   PIKIT_CLOUDFLARE=1    the Cloudflare path, as --cloudflare: no Docker, and `pikit new` makes a
#                         Telegram bot on Cloudflare

set -eu

# The Bun range pikit supports: BUN_MINIMUM included (older Bun never fires some of pikit's stop
# deadlines), BUN_BELOW excluded (a new major may break pikit). BUN_PINNED is what this installs.
BUN_MINIMUM="1.4.0"
BUN_BELOW="2.0.0"
BUN_PINNED="${PIKIT_BUN_VERSION:-1.4.2}"
BUN_PINNED="${BUN_PINNED#bun-v}"
BUN_PINNED="${BUN_PINNED#v}"
PIKIT_HOME="${PIKIT_HOME:-$HOME/.pikit}"
PIKIT_REPO="${PIKIT_REPO:-https://github.com/ajarellanod/pikit.git}"
PIKIT_SOURCE="${PIKIT_SOURCE:-}"
PIKIT_YES="${PIKIT_YES:-}"
PIKIT_INSTALL_DOCKER="${PIKIT_INSTALL_DOCKER:-}"
PIKIT_CLOUDFLARE="${PIKIT_CLOUDFLARE:-}"
if [ -n "$PIKIT_SOURCE" ]; then
  PIKIT_REF="${PIKIT_REF:-HEAD}"
else
  # No release tags yet: main. Once pikit tags releases, this default becomes the latest tag.
  PIKIT_REF="${PIKIT_REF:-main}"
fi

for arg in "$@"; do
  case "$arg" in
    --yes | -y) PIKIT_YES=1 ;;
    --install-docker) PIKIT_INSTALL_DOCKER=1 ;;
    --cloudflare) PIKIT_CLOUDFLARE=1 ;;
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

# 2. Bun, in the supported range. The version is compared in sh, so a broken or ancient Bun is only
# asked for `--version`.
BUN_RANGE=">= $BUN_MINIMUM, < $BUN_BELOW"
# Succeeds when version $1 (x.y.z, any -suffix ignored) is in [BUN_MINIMUM, BUN_BELOW).
bun_supported() {
  awk -v v="$1" -v lo="$BUN_MINIMUM" -v hi="$BUN_BELOW" '
    function key(s, p) { sub(/[-+].*/, "", s); if (s !~ /^[0-9]+\.[0-9]+\.[0-9]+$/) return -1; split(s, p, "."); return (p[1] * 1000 + p[2]) * 1000 + p[3] }
    BEGIN { k = key(v); exit !(k >= key(lo) && k < key(hi)) }'
}
bun_version() { "$1" --version 2>/dev/null || true; }
install_bun() {
  say "running Bun's own installer (https://bun.sh/install) for Bun $BUN_PINNED into ~/.bun, no sudo."
  say "  It adds ~/.bun/bin to your shell's startup file; pikit itself does not need that."
  has bash || fail "the Bun installer needs bash; install bash, then run this again"
  curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_PINNED"
  BUN="$HOME/.bun/bin/bun"
  [ -x "$BUN" ] || fail "Bun's installer did not leave $BUN"
}
bun_supported "$BUN_PINNED" || fail "PIKIT_BUN_VERSION=$BUN_PINNED is outside the Bun range pikit supports ($BUN_RANGE)"
# The Bun on the PATH, else the one in ~/.bun: the first in the range is used as it is.
BUN=""
FOUND=""
for candidate in "$(command -v bun 2>/dev/null || true)" "$HOME/.bun/bin/bun"; do
  if [ -z "$candidate" ] || [ ! -x "$candidate" ]; then continue; fi
  version="$(bun_version "$candidate")"
  if bun_supported "$version"; then BUN="$candidate"; break; fi
  [ -n "$FOUND" ] || FOUND="Bun ${version:-of unknown version} at $candidate"
done
if [ -z "$BUN" ] && [ -z "$FOUND" ]; then
  say "Bun is not installed."
  install_bun
elif [ -z "$BUN" ]; then
  # Never `bun upgrade`: it installs the latest Bun, which may be a major pikit does not support yet.
  say "$FOUND is outside the range pikit supports ($BUN_RANGE)."
  if ask "Install Bun $BUN_PINNED into ~/.bun for pikit (PIKIT_YES=1 or --yes to consent)?" "$PIKIT_YES"; then
    install_bun
  else
    fail "pikit needs Bun $BUN_RANGE; found $FOUND. Rerun with --yes to install Bun $BUN_PINNED into ~/.bun, or install it yourself: curl -fsSL https://bun.sh/install | bash -s bun-v$BUN_PINNED"
  fi
fi
bun_supported "$(bun_version "$BUN")" || fail "pikit needs Bun $BUN_RANGE; found $(bun_version "$BUN") at $BUN"
say "Bun $(bun_version "$BUN") at $BUN"

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

# 5. Docker, for `pikit up` on a server only. Without root, using it needs the docker group, which a
# running shell only gets after `newgrp docker` or a new login: the closing lines say so. On
# Cloudflare there is no Docker: wrangler deploys, and it runs on Node.js, which is only checked.
NEWGRP=""
join_docker_group() {
  as_root usermod -aG docker "$(id -un)"
  NEWGRP=1
}
if [ -n "$PIKIT_CLOUDFLARE" ]; then
  say "Cloudflare: no Docker needed. Each project deploys with its own wrangler, which runs on Node.js >= 22."
  NODE_VERSION="$(node --version 2>/dev/null || true)"
  NODE_MAJOR="${NODE_VERSION#v}"
  NODE_MAJOR="${NODE_MAJOR%%.*}"
  case "$NODE_MAJOR" in
    '' | *[!0-9]*) NODE_MAJOR=0 ;;
  esac
  if [ "$NODE_MAJOR" -ge 22 ]; then
    say "Node.js $NODE_VERSION found: wrangler can run"
  else
    warn "wrangler needs Node.js >= 22 (found: ${NODE_VERSION:-none}): pikit up and pikit logs fail without it. Install it (https://nodejs.org/en/download; on macOS: brew install node), then pikit up."
  fi
elif has docker && docker compose version >/dev/null 2>&1; then
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
  if ask "Install Docker with its official script (https://get.docker.com, runs as root), and add you to the docker group (PIKIT_INSTALL_DOCKER=1 or --install-docker to consent; on Cloudflare no Docker is needed: answer N)?" "$PIKIT_INSTALL_DOCKER"; then
    curl -fsSL https://get.docker.com -o "$PIKIT_HOME/get-docker.sh"
    as_root sh "$PIKIT_HOME/get-docker.sh"
    rm -f "$PIKIT_HOME/get-docker.sh"
    if [ "$(id -u)" != "0" ]; then join_docker_group; fi
  else
    say "  Later: https://docs.docker.com/engine/install/ (or rerun this with --install-docker)"
  fi
fi

# 6. The first agent, step by step: `pikit new` with no arguments asks everything (its name, where it
# runs, where to talk to it, the channel's setup, the model's login) and starts it. With --cloudflare,
# its flags answer where it runs and the preset: a Telegram bot on Cloudflare. Only on a terminal;
# Ctrl-C stops it, and `pikit new` continues later. With a new docker group, `sg` gives it that group
# now, since this shell only gets it at the next login.
if [ -n "$PIKIT_CLOUDFLARE" ]; then
  set -- new --target cloudflare --preset telegram-cloudflare
else
  set -- new
fi
if [ -t 1 ] && (: </dev/tty) 2>/dev/null && [ -z "${PIKIT_NO_WIZARD:-}" ]; then
  say "installed. Now your first agent, step by step:"
  if [ -n "$NEWGRP" ] && has sg; then
    sg docker -c "exec '$BIN_DIR/pikit' new" </dev/tty || true
  else
    "$BIN_DIR/pikit" "$@" </dev/tty || true
  fi
  printf '\n'
fi

# Done: what this shell still needs. The PATH line comes first: `newgrp` starts a new shell that
# keeps this environment.
LINES=""
# shellcheck disable=SC2016 # $PATH is meant literally: it is the line to paste
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) LINES="$(printf '  export PATH="%s:$PATH"    # add this line to ~/.profile too' "$BIN_DIR")" ;;
esac
if [ -n "$NEWGRP" ]; then
  LINES="$LINES${LINES:+
}  newgrp docker    # this shell joins the docker group (or log in again)"
fi
if [ -n "$LINES" ]; then
  say "to use pikit in this shell, paste:"
  printf '\n%s\n\n' "$LINES"
fi
if [ -n "$PIKIT_CLOUDFLARE" ]; then
  say "pikit $* starts another Telegram bot on Cloudflare, step by step; pikit --help lists the rest."
else
  say "pikit new starts a new agent step by step; pikit --help lists the rest."
fi
