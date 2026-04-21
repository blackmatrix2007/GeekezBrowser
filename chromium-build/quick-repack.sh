#!/bin/bash
# =============================================================================
# GeekezBrowser - Quick Repack Script
# =============================================================================
# ALTERNATIVE to full build: Download pre-built fingerprint-chromium and
# repackage it with GeekezBrowser metadata for your own GitHub release.
#
# This is MUCH faster than building from source (5 minutes vs 5 hours).
# The binary already has all necessary anti-detect patches.
#
# Usage:
#   export GITHUB_TOKEN="ghp_xxxxxxxxxxxx"
#   export GITHUB_REPO="your-username/geekez-chromium"
#   bash quick-repack.sh
# =============================================================================

set -euo pipefail

GITHUB_TOKEN="${GITHUB_TOKEN:-}"
GITHUB_REPO="${GITHUB_REPO:-}"
PLATFORM="${1:-$(uname -s | tr '[:upper:]' '[:lower:]')}"  # linux, darwin, windows

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; NC='\033[0m'

log()  { echo -e "${BLUE}[$(date '+%H:%M:%S')]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

WORK_DIR=$(mktemp -d)
trap "rm -rf $WORK_DIR" EXIT

# ─── Fetch latest fingerprint-chromium release ────────────────────────────────
log "Fetching fingerprint-chromium release info..."

API_HEADERS=(-H "Accept: application/vnd.github.v3+json")
[[ -n "$GITHUB_TOKEN" ]] && API_HEADERS+=(-H "Authorization: token $GITHUB_TOKEN")

RELEASE_JSON=$(curl -s "${API_HEADERS[@]}" \
    "https://api.github.com/repos/adryfish/fingerprint-chromium/releases/latest")

VERSION=$(echo "$RELEASE_JSON" | python3 -c "
import sys, json, re
data = json.load(sys.stdin)
tag = data.get('tag_name', '')
match = re.search(r'(\d+\.\d+\.\d+\.\d+)', tag)
if match:
    print(match.group(1))
else:
    print(tag.lstrip('v'))
" 2>/dev/null)

log "Found version: $VERSION"

# Find appropriate asset for platform
case "$PLATFORM" in
    linux)   ASSET_PATTERN="linux_x64\|linux-x64" ;;
    darwin)  ASSET_PATTERN="mac\|darwin" ;;
    windows) ASSET_PATTERN="windows_x64\|win-x64" ;;
    *)       err "Unknown platform: $PLATFORM" ;;
esac

ASSET_URL=$(echo "$RELEASE_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
pattern = '$ASSET_PATTERN'
for asset in data.get('assets', []):
    name = asset.get('name', '').lower()
    if 'zip' in name and any(p in name for p in pattern.split('\\\|')):
        print(asset.get('browser_download_url', ''))
        break
" 2>/dev/null)

ASSET_NAME=$(echo "$RELEASE_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
pattern = '$ASSET_PATTERN'
for asset in data.get('assets', []):
    name = asset.get('name', '').lower()
    if 'zip' in name and any(p in name for p in pattern.split('\\\|')):
        print(asset.get('name', ''))
        break
" 2>/dev/null)

if [[ -z "$ASSET_URL" ]]; then
    warn "No $PLATFORM asset found. Available assets:"
    echo "$RELEASE_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for a in data.get('assets', []):
    print(' -', a.get('name', ''))
"
    err "Please set PLATFORM to one of: linux, darwin, windows"
fi

ok "Found asset: $ASSET_NAME"
log "Download URL: $ASSET_URL"

# ─── Download ─────────────────────────────────────────────────────────────────
DOWNLOAD_PATH="$WORK_DIR/$ASSET_NAME"
log "Downloading $ASSET_NAME..."

curl -L --progress-bar \
    "${API_HEADERS[@]}" \
    -o "$DOWNLOAD_PATH" \
    "$ASSET_URL"

ok "Downloaded: $DOWNLOAD_PATH ($(du -sh $DOWNLOAD_PATH | cut -f1))"

# ─── Extract & verify ─────────────────────────────────────────────────────────
EXTRACT_DIR="$WORK_DIR/extracted"
mkdir -p "$EXTRACT_DIR"

log "Extracting..."
unzip -q "$DOWNLOAD_PATH" -d "$EXTRACT_DIR"

# Find chrome binary
CHROME_BIN=$(find "$EXTRACT_DIR" -name "chrome" -o -name "chrome.exe" | head -1)
if [[ -z "$CHROME_BIN" ]]; then
    err "Chrome binary not found in archive"
fi

ok "Chrome binary: $CHROME_BIN"
log "Binary size: $(du -sh $CHROME_BIN | cut -f1)"

# ─── Add GeekezBrowser metadata ───────────────────────────────────────────────
CHROME_DIR=$(dirname "$CHROME_BIN")

cat > "$CHROME_DIR/fp-meta.json" << EOF
{
    "version": "$VERSION",
    "downloadedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "source": "fingerprint-chromium",
    "platform": "$PLATFORM",
    "patches": [
        "ungoogled-chromium",
        "fingerprint-chromium (adryfish)"
    ],
    "antiDetectFeatures": [
        "navigator.webdriver = false",
        "canvas-noise-seed-based",
        "webgl-spoofing",
        "audio-context-noise",
        "automation-traces-removed"
    ],
    "repackedBy": "GeekezBrowser",
    "repackDate": "$(date -u +%Y-%m-%d)"
}
EOF

# ─── Repackage ────────────────────────────────────────────────────────────────
OUTPUT_NAME="geekez-chromium-${VERSION}-${PLATFORM}-x64.zip"
OUTPUT_PATH="$WORK_DIR/$OUTPUT_NAME"

log "Repackaging as $OUTPUT_NAME..."
cd "$EXTRACT_DIR"
zip -r "$OUTPUT_PATH" . -q

ok "Package: $OUTPUT_NAME ($(du -sh $OUTPUT_PATH | cut -f1))"

# ─── Upload to GitHub Releases ────────────────────────────────────────────────
if [[ -n "$GITHUB_REPO" && -n "$GITHUB_TOKEN" ]]; then
    log "Uploading to GitHub: $GITHUB_REPO"
    export GH_TOKEN="$GITHUB_TOKEN"

    RELEASE_TAG="v${VERSION}"

    # Create or update release
    if ! gh release view "$RELEASE_TAG" --repo "$GITHUB_REPO" &>/dev/null; then
        log "Creating release $RELEASE_TAG..."
        gh release create "$RELEASE_TAG" \
            --repo "$GITHUB_REPO" \
            --title "GeekezBrowser Chromium $VERSION" \
            --notes "$(cat << 'NOTES'
## GeekezBrowser Custom Chromium

Pre-packaged fingerprint-chromium build for use with GeekezBrowser.

### Anti-detect Features (C++ Level)
- `navigator.webdriver` always returns `false`
- Canvas fingerprint noise (seed-based)
- WebGL vendor/renderer spoofing via `--webgl-vendor` / `--webgl-renderer`
- AudioContext fingerprint noise
- CDP automation markers removed

### Usage in GeekezBrowser
1. Download the zip for your platform
2. Extract to `~/Library/Application Support/GeekEZ Browser/fingerprint-chromium/` (macOS)
   or `%APPDATA%\GeekEZ Browser\fingerprint-chromium\` (Windows)
3. GeekezBrowser will auto-detect and use it

### Command Line Flags (Anti-detect)
\`\`\`
--canvas-noise-seed=<number>      # Profile-specific canvas noise
--audio-noise-seed=<number>       # Profile-specific audio noise
--webgl-vendor="Intel Inc."       # WebGL vendor string
--webgl-renderer="Intel HD 630"   # WebGL renderer string
\`\`\`

> Built from [adryfish/fingerprint-chromium](https://github.com/adryfish/fingerprint-chromium)
NOTES
)"
    fi

    # Upload asset
    log "Uploading $OUTPUT_NAME..."
    gh release upload "$RELEASE_TAG" "$OUTPUT_PATH" \
        --repo "$GITHUB_REPO" \
        --clobber

    RELEASE_URL="https://github.com/${GITHUB_REPO}/releases/tag/${RELEASE_TAG}"
    ok "Uploaded successfully!"
    echo ""
    echo -e "${GREEN}Release URL: ${RELEASE_URL}${NC}"
    echo ""
    echo "Update GeekezBrowser main.js to use your repo:"
    echo "  Change: 'adryfish/fingerprint-chromium'"
    echo "  To:     '${GITHUB_REPO}'"

else
    # Save locally
    FINAL_PATH="$(pwd)/$OUTPUT_NAME"
    cp "$OUTPUT_PATH" "$FINAL_PATH"
    ok "Saved locally: $FINAL_PATH"
    echo ""
    echo "To upload to your own repo, set:"
    echo "  export GITHUB_TOKEN=ghp_xxx"
    echo "  export GITHUB_REPO=username/geekez-chromium"
    echo "  bash quick-repack.sh"
fi
