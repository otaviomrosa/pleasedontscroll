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

# Files that live in the repo but nothing in the extension loads. Excluded
# from the package only, never deleted from the repo. Checked by hand against
# the extension's import graph and every src/href/url() in its HTML and CSS,
# and the import/reference check below fails the build if any of these ever
# becomes needed, so this list can't silently rot into a broken upload.
#   popup-painting.png       2.3MB, ~89% of the whole package, unreferenced
#   logo-black-bg.svg        unreferenced
#   web-app-manifest-*.png   PWA icons, and site.webmanifest that points at
#                            them: an extension is not a PWA
#   assets/icons/favicon.ico duplicate of favicon/favicon.ico, unreferenced
#   core/sync/account.js     dashboard-only (delete account)
#   core/sync/billing.js     dashboard-only (Stripe checkout/portal)
#   core/types/index.js      JSDoc typedefs only, nothing imports it
UNUSED=(
  "extension/assets/images/popup-painting.png"
  "extension/assets/images/logo-black-bg.svg"
  "extension/assets/icons/favicon/web-app-manifest-192x192.png"
  "extension/assets/icons/favicon/web-app-manifest-512x512.png"
  "extension/assets/icons/favicon/site.webmanifest"
  "extension/assets/icons/favicon.ico"
  "core/sync/account.js"
  "core/sync/billing.js"
  "core/types/index.js"
)
for f in "${UNUSED[@]}"; do rm -f "$STAGE_DIR/$f"; done

# The repo's manifest.json also serves "Load unpacked" during local dev, so it
# carries a localhost origin the published extension must not have. It is
# stripped from the STAGED copy only; the source manifest is untouched.
python3 - "$STAGE_DIR" << 'EOF'
import json, os, sys
path = os.path.join(sys.argv[1], "manifest.json")
m = json.load(open(path))
ec = m.get("externally_connectable", {})
before = ec.get("matches", [])
ec["matches"] = [u for u in before if "localhost" not in u and "127.0.0.1" not in u]
if not ec["matches"]:
    m.pop("externally_connectable", None)
json.dump(m, open(path, "w"), indent=2)
open(path, "a").write("\n")
print(f"Stripped {len(before) - len(ec['matches'])} dev-only origin(s) from the packaged manifest.")
EOF

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

# Second sanity check, the one that makes the exclusions above safe: every
# relative import in the packaged JS, and every src/href in the packaged HTML
# and url() in the packaged CSS, must resolve to a file that is in the
# package. Also refuses to ship a localhost origin or a service_role key.
python3 - "$STAGE_DIR" << 'EOF'
import os, re, sys

stage = sys.argv[1]
problems = []
imp = re.compile(r"""(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^import\s+['"]([^'"]+)['"]""", re.M)
ref = re.compile(r"""(?:src|href)=["']([^"'#?]+)["']|url\(["']?([^)"'#?]+)["']?\)""")

def check(base, target, where):
    if re.match(r"^(https?:|data:|mailto:|chrome-extension:|//)", target):
        return
    full = os.path.normpath(os.path.join(base, target))
    if not os.path.exists(full):
        problems.append(f"{where}: {target} -> missing from package")

for root, _, files in os.walk(stage):
    for f in files:
        path = os.path.join(root, f)
        rel = os.path.relpath(path, stage)
        if f.endswith(".js"):
            src = open(path, encoding="utf-8").read()
            for m in imp.finditer(src):
                t = next(g for g in m.groups() if g)
                if t.startswith("."):
                    check(root, t, rel)
            if "service_role" in src.replace("Never put a service_role key", ""):
                problems.append(f"{rel}: mentions service_role")
        elif f.endswith((".html", ".css")):
            src = open(path, encoding="utf-8").read()
            for m in ref.finditer(src):
                t = next(g for g in m.groups() if g)
                check(root, t, rel)
        elif f == "manifest.json":
            if "localhost" in open(path).read():
                problems.append("manifest.json: still contains a localhost origin")

if problems:
    print("ERROR: package check failed:")
    for p in problems:
        print("  - " + p)
    sys.exit(1)
print("Import/reference check OK (every file the package loads is in the package).")
EOF

( cd "$STAGE_DIR" && zip -r -X -q "$ZIP_PATH" . -x "*.DS_Store" )

echo "Done: $ZIP_PATH"
echo "Upload this file directly to the Chrome Web Store Developer Dashboard."
