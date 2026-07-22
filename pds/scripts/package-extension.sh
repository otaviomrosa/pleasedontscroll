#!/usr/bin/env bash
# scripts/package-extension.sh
#
# Builds a Chrome Web Store-ready zip of the extension.
#
# Why this exists: manifest.json lives at the repo root (not inside
# /extension) so that "Load unpacked" during dev can resolve the background
# service worker's relative imports into /core — see docs/ARCHITECTURE.md §5/§7. That
# means the repo root is NOT what you want to upload to the Web Store as-is;
# it also contains /web, /supabase, pds-art/, etc. This script copies just
# the files the extension actually needs (manifest.json + /extension + /core)
# into a clean temp directory and zips that.
#
# Usage:
#   ./scripts/package-extension.sh
#
# Output:
#   dist/pds-extension-v<version>.zip   (version read from manifest.json)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
DIST_DIR="$REPO_ROOT/dist"
STAGE_DIR="$DIST_DIR/pds-extension-v$VERSION"
ZIP_PATH="$DIST_DIR/pds-extension-v$VERSION.zip"

echo "Packaging PDS extension v$VERSION..."

rm -rf "$STAGE_DIR" "$ZIP_PATH"
mkdir -p "$STAGE_DIR"

# Only what the extension actually loads at runtime.
cp manifest.json "$STAGE_DIR/"
cp -R extension "$STAGE_DIR/"
cp -R core "$STAGE_DIR/"

# Strip OS/editor cruft that sometimes sneaks into copied directories.
find "$STAGE_DIR" -name ".DS_Store" -delete
find "$STAGE_DIR" -name "*.swp" -delete

# Sanity check: every file manifest.json references should exist in the stage dir.
python3 - "$STAGE_DIR" << 'EOF'
import json, os, sys

stage = sys.argv[1]
manifest = json.load(open(os.path.join(stage, "manifest.json")))

paths = [
    manifest["background"]["service_worker"],
    manifest["action"]["default_popup"],
    *manifest["action"]["default_icon"].values(),
    *manifest["icons"].values(),
]

missing = [p for p in paths if not os.path.exists(os.path.join(stage, p))]
if missing:
    print("ERROR: manifest.json references files missing from the package:")
    for m in missing:
        print(f"  - {m}")
    sys.exit(1)

print(f"Manifest check OK ({len(paths)} referenced files present).")
EOF

( cd "$STAGE_DIR" && zip -r -X -q "$ZIP_PATH" . -x "*.DS_Store" )

echo "Done: $ZIP_PATH"
echo "Upload this file directly to the Chrome Web Store Developer Dashboard."
