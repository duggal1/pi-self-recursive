#!/usr/bin/env bash
# pi-sr installer (Bun). Hyper-smooth download animation: braille spinner + eased progress.
set -euo pipefail

REPO="duggal1/pi-self-recursive"
VERSION="${PI_SR_VERSION:-latest}"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *) echo "unsupported arch $ARCH" >&2; exit 1 ;;
esac
case "$OS" in
  darwin) PLAT="darwin-$ARCH" ;;
  linux) PLAT="linux-$ARCH" ;;
  *) echo "unsupported os $OS (use the Bun binary build)" >&2; exit 1 ;;
esac
ASSET="pi-sr-${PLAT}.tar.gz"
URL="https://github.com/${REPO}/releases/${VERSION}/download/${ASSET}"
if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
fi
BIN_DIR="${HOME}/.bun/bin"
mkdir -p "$BIN_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- smooth animation: eased progress + braille spinner ---
frames=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
# download in background, animate until done
( curl -fSL --progress-bar -o "$TMP/$ASSET" "$URL" ) &
CURL_PID=$!
i=0
while kill -0 "$CURL_PID" 2>/dev/null; do
  # eased fake progress: sinusoidal ease toward 90% until done
  step=$(( (i * 37) % 90 + 5 ))
  printf "\r%s pi-sr %s [%s] %s%%" "${frames[$((i % 10))]}" "$PLAT" "███████░░░░" "$step"
  sleep 0.08
  i=$((i+1))
done
wait "$CURL_PID"
printf "\r✓ pi-sr %s [███████] 100%%\n" "$PLAT"

tar -xzf "$TMP/$ASSET" -C "$TMP"
# binary is named pi-sr inside the archive (or pi-sr/pi-sr)
if [ -x "$TMP/pi-sr" ]; then install -m 0755 "$TMP/pi-sr" "$BIN_DIR/pi-sr";
elif [ -x "$TMP/pi-sr/pi-sr" ]; then install -m 0755 "$TMP/pi-sr/pi-sr" "$BIN_DIR/pi-sr";
else echo "binary not found in archive" >&2; ls -R "$TMP" >&2; exit 1; fi
"$BIN_DIR/pi-sr" --version >/dev/null 2>&1 || true
echo "Installed: $BIN_DIR/pi-sr"
echo "Run: pi-sr"
# Optional Bun global link note (fastest path, no download):
echo "Bun alternative: bun add -g github:duggal1/pi-self-recursive/packages/coding-agent && pi-sr"
