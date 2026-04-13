#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/bambu_bridge.py"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_PATH="$MANIFEST_DIR/com.genesisframeworks.bambu_bridge.json"
EXTENSION_ID="efcicfljpkpmgmackiblgojcpnnkjhah"

mkdir -p "$MANIFEST_DIR"
chmod +x "$HOST_SCRIPT"

cat > "$MANIFEST_PATH" <<EOF
{
  "name": "com.genesisframeworks.bambu_bridge",
  "description": "Genesis Image Tools bridge for opening Bambu Studio projects on macOS",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

echo "Installed Native Messaging host:"
echo "  $MANIFEST_PATH"
