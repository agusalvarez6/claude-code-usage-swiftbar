#!/usr/bin/env bash
# Install the plugin in SwiftBar's configured plugin folder and refresh it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PLUGIN="$ROOT/cc-usage.2m.js"

chmod +x "$PLUGIN"

# SwiftBar stores its plugin folder in its preferences.
DIR="$(defaults read com.ambar.SwiftBar PluginDirectory 2>/dev/null || true)"
DIR="${DIR%/}" # Remove a trailing slash for the directory comparison.
if [ -z "$DIR" ]; then
  echo "SwiftBar's plugin folder is not set." >&2
  echo "Open SwiftBar, pick a Plugin Folder, then re-run ./install.sh." >&2
  exit 1
fi

mkdir -p "$DIR"
# Preserve the installed filename because it defines SwiftBar's refresh interval.
# Nullglob leaves the array empty when no plugin is installed.
shopt -s nullglob
INSTALLED=("$DIR"/cc-usage.*m.js)
shopt -u nullglob
NAME="$(basename "${INSTALLED[0]:-$PLUGIN}")"

# Skip the copy when the repository is already SwiftBar's plugin folder.
if [ "$ROOT" = "$DIR" ]; then
  echo "Already in SwiftBar's plugin folder; refreshing $NAME in place."
else
  rm -f "$DIR"/cc-usage.*m.js
  cp "$PLUGIN" "$DIR/$NAME"
  chmod +x "$DIR/$NAME"
  echo "Copied $NAME to $DIR"
fi

# Ask SwiftBar to reload its plugins.
open "swiftbar://refreshallplugins" 2>/dev/null || true
echo "SwiftBar refreshed."
