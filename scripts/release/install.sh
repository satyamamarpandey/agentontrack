#!/bin/sh
# Installs AgentOnTrack for this user, with no administrator rights and nothing else required.
# Usage: curl -fsSL https://pandeysatyam.com/agentontrack/install.sh | sh
#        sh install.sh [--version 1.0.0] [--from <folder with release files>] [--no-path]
set -eu

REPO="satyamamarpandey/agentontrack"
VERSION=""
FROM=""
ADD_PATH=1
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --from) FROM="$2"; shift 2 ;;
    --no-path) ADD_PATH=0; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

fail() { echo "AgentOnTrack install failed: $1" >&2; exit 1; }

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=macos ;;
  *) fail "this script is for Linux and macOS. On Windows, use install.ps1." ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) fail "no build for $(uname -m). Supported: x64, arm64." ;;
esac
if [ "$OS" = linux ] && ldd --version 2>&1 | grep -qi musl; then
  fail "Alpine and other musl systems are not supported: the bundled Node needs glibc."
fi

command -v tar >/dev/null 2>&1 || fail "tar is required."
if command -v sha256sum >/dev/null 2>&1; then HASH="sha256sum"
elif command -v shasum >/dev/null 2>&1; then HASH="shasum -a 256"
else fail "sha256sum or shasum is required, so the download can be checked."; fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

fetch() { # relative name, destination
  if [ -n "$FROM" ]; then cp "$FROM/$1" "$2" || fail "$1 is not in $FROM"; return; fi
  command -v curl >/dev/null 2>&1 || fail "curl is required."
  if [ -n "$VERSION" ]; then URL="https://github.com/$REPO/releases/download/v$VERSION/$1"
  else URL="https://github.com/$REPO/releases/latest/download/$1"; fi
  curl -fsSL --retry 3 -o "$2" "$URL" || fail "could not download $URL. See https://github.com/$REPO/releases"
}

fetch SHA256SUMS "$TMP/SHA256SUMS"
LINE=$(grep -E "agentontrack-.*-$OS-$ARCH\.tar\.gz\$" "$TMP/SHA256SUMS" | { if [ -n "$VERSION" ]; then grep -F -- "-$VERSION-"; else cat; fi; } | head -n 1)
[ -n "$LINE" ] || fail "this release has no build for $OS-$ARCH."
WANT=$(echo "$LINE" | awk '{print $1}')
FILE=$(echo "$LINE" | awk '{print $2}')
fetch "$FILE" "$TMP/$FILE"
GOT=$($HASH "$TMP/$FILE" | awk '{print $1}')
[ "$WANT" = "$GOT" ] || fail "checksum mismatch for $FILE: expected $WANT, got $GOT. Nothing was installed."
echo "Checksum verified: $FILE"

VER=$(echo "$FILE" | sed -E "s/^agentontrack-(.*)-$OS-$ARCH\.tar\.gz\$/\1/")
HOME_DIR="${AGENTONTRACK_HOME:-$HOME/.agentontrack}"
APP="$HOME_DIR/app"
mkdir -p "$APP/versions" "$TMP/x"
tar -xzf "$TMP/$FILE" -C "$TMP/x"
rm -rf "${APP:?}/versions/$VER"
mv "$TMP/x/${FILE%.tar.gz}" "$APP/versions/$VER"
AGENTONTRACK_HOME="$HOME_DIR" "$APP/versions/$VER/node/bin/node" "$APP/versions/$VER/lib/cli.mjs" self activate --version "$VER" >/dev/null \
  || fail "the bundled program would not start on this system."

BIN="$APP/bin"
case "$BIN" in
  *\"*|*\$*|*\`*|*\\*) echo "The install path has characters a shell profile cannot hold, so add this to PATH yourself: $BIN"; ADD_PATH=0 ;;
esac
if [ "$ADD_PATH" = 1 ]; then
  LINE="export PATH=\"$BIN:\$PATH\" # agentontrack path"
  # A stock macOS user has zsh and may have no ~/.zshrc yet.
  if [ "$OS" = macos ] || [ "${SHELL:-}" = /bin/zsh ]; then [ -e "$HOME/.zshrc" ] || : > "$HOME/.zshrc" || true; fi
  for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [ -f "$rc" ] || [ "$rc" = "$HOME/.profile" ]; then
      grep -qs "# agentontrack path" "$rc" || printf '\n%s\n' "$LINE" >> "$rc" || echo "Could not update $rc. Add this to PATH yourself: $BIN"
    fi
  done
fi

"$BIN/agentontrack" --version >/dev/null || fail "installed, but the program did not start."
echo "AgentOnTrack $VER is installed in $APP"
if [ "$ADD_PATH" = 1 ]; then echo "Open a new terminal, or run: export PATH=\"$BIN:\$PATH\""; else echo "Add this to your PATH: $BIN"; fi
echo "Then, in a project folder: agentontrack setup"
