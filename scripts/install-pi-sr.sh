#!/usr/bin/env bash
# pi-sr installer (Node). Hyper-smooth download animation: braille spinner + eased progress.
set -euo pipefail

REPO="duggal1/pi-self-recursive"
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
BIN_DIR="${HOME}/.bun/bin"
mkdir -p "$BIN_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

frames=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
animate() {
  local label="$1"
  while true; do
    for f in "${frames[@]}"; do printf "\r%s pi-sr %s" "$f" "$label"; sleep 0.08; done
  done &
  ANIMATE_PID=$!
}
stop_animate() {
  kill "$ANIMATE_PID" 2>/dev/null || true
  wait "$ANIMATE_PID" 2>/dev/null || true
  printf "\r"
}

URL="https://github.com/${REPO}/releases/latest/download/pi-sr-${PLAT}.tar.gz"
animate "downloading $PLAT"
if curl -fSL -o "$TMP/pi-sr.tar.gz" "$URL" 2>/dev/null; then
  stop_animate
  printf "✓ pi-sr %s [███████████] 100%%\n" "$PLAT"
  tar -xzf "$TMP/pi-sr.tar.gz" -C "$TMP"
  if [ -x "$TMP/pi-sr" ]; then install -m 0755 "$TMP/pi-sr" "$BIN_DIR/pi-sr";
  elif [ -x "$TMP/pi-sr/pi-sr" ]; then install -m 0755 "$TMP/pi-sr/pi-sr" "$BIN_DIR/pi-sr";
  else echo "binary not found in archive" >&2; ls -R "$TMP" >&2; exit 1; fi
else
  stop_animate
  echo "no prebuilt release yet — building from source (Bun, slower but works)"
fi

if [ ! -x "$BIN_DIR/pi-sr" ]; then
  APP_DIR="${HOME}/.pi-sr-app"
  animate "building with Node (first time)"
  git clone --depth 1 "https://github.com/${REPO}.git" "$TMP/src" >/dev/null 2>&1
  ( cd "$TMP/src" && npm ci --ignore-scripts >/dev/null 2>&1 && npm run build >/dev/null 2>&1 )
  mkdir -p "$APP_DIR/bundle"
  cp -R "$TMP/src/packages/coding-agent/dist/bundle" "$APP_DIR/"
  cat > "$BIN_DIR/pi-sr" << EOF
#!/usr/bin/env sh
exec node "$APP_DIR/bundle/cli.js" "\$@"
EOF
  chmod +x "$BIN_DIR/pi-sr"
  stop_animate
  printf "✓ pi-sr built [███████████] 100%%\n"
fi
"$BIN_DIR/pi-sr" --version >/dev/null 2>&1 || true
echo "Installed: $BIN_DIR/pi-sr"
echo "Run: pi-sr"
