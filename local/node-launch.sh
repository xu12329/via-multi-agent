#!/bin/sh
set -eu

is_supported() {
  [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exitCode=major>22||major===22&&minor>=18?0:1'
}

via_node=${VIA_NODE:-}
if [ -n "$via_node" ]; then
  if ! is_supported "$via_node"; then
    echo "VIA_NODE must point to Node.js 22.18 or later." >&2
    exit 1
  fi
else
  for candidate in "$(command -v node || true)" /opt/homebrew/bin/node /usr/local/bin/node \
    /opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@24/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
    if is_supported "$candidate"; then
      via_node=$candidate
      break
    fi
  done
fi

if [ -z "$via_node" ]; then
  echo "Install Node.js 22.18 or later, or set VIA_NODE to its executable." >&2
  exit 1
fi
if [ "${1:-}" = "--print-node" ]; then
  printf '%s\n' "$via_node"
else
  exec "$via_node" "$@"
fi
