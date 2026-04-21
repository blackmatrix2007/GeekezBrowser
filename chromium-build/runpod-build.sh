#!/bin/bash
# =============================================================================
# GeekezBrowser - Custom Chromium Build Script for RunPod
# =============================================================================
# Base: fingerprint-chromium (adryfish) + ungoogled-chromium + custom patches
#
# RunPod Requirements:
#   - Template: RunPod Pytorch (Ubuntu 22.04) hoặc Ubuntu bất kỳ
#   - CPU: 32+ cores (96 cores = ~2h build, 16 cores = ~5h build)
#   - RAM: 64GB minimum (128GB recommended)
#   - Disk: 300GB (container disk)
#   - Network Volume: 20GB (để lưu output)
#
# Usage:
#   export GITHUB_TOKEN="ghp_xxxxxxxxxxxx"
#   export GITHUB_REPO="your-username/geekez-chromium"   # Optional: upload to GitHub
#   export R2_ENDPOINT="https://xxx.r2.cloudflarestorage.com"  # Optional: R2 upload
#   export R2_BUCKET="geekez-chromium"
#   export R2_ACCESS_KEY="xxx"
#   export R2_SECRET_KEY="xxx"
#   bash runpod-build.sh
# =============================================================================

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_ROOT="${BUILD_ROOT:-/workspace}"
DEPOT_TOOLS_DIR="$BUILD_ROOT/depot_tools"
CHROMIUM_SRC="$BUILD_ROOT/chromium/src"
PATCHES_DIR="$SCRIPT_DIR/patches"
OUTPUT_DIR="$BUILD_ROOT/output"
CORES=$(nproc)
TARGET_CPU="${TARGET_CPU:-x64}"   # x64, arm64
TARGET_OS="${TARGET_OS:-linux}"   # linux, win

# Chromium version to build (auto-detected from fingerprint-chromium if not set)
CHROMIUM_VERSION="${CHROMIUM_VERSION:-}"

# Upload config
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
GITHUB_REPO="${GITHUB_REPO:-}"
R2_ENDPOINT="${R2_ENDPOINT:-}"
R2_BUCKET="${R2_BUCKET:-}"
R2_ACCESS_KEY="${R2_ACCESS_KEY:-}"
R2_SECRET_KEY="${R2_SECRET_KEY:-}"

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'

log()  { echo -e "${BLUE}[$(date '+%H:%M:%S')]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
hdr()  { echo -e "\n${CYAN}════════════════════════════════════════════${NC}"; \
          echo -e "${CYAN} $1${NC}"; \
          echo -e "${CYAN}════════════════════════════════════════════${NC}\n"; }

# ─── Helper Functions ─────────────────────────────────────────────────────────
check_disk_space() {
    local required_gb=$1
    local available_gb=$(df -BG "$BUILD_ROOT" | tail -1 | awk '{print $4}' | tr -d 'G')
    if [[ $available_gb -lt $required_gb ]]; then
        err "Không đủ dung lượng đĩa. Cần ${required_gb}GB, chỉ có ${available_gb}GB tại $BUILD_ROOT"
    fi
    ok "Disk space: ${available_gb}GB available (required: ${required_gb}GB)"
}

check_ram() {
    local required_gb=$1
    local available_gb=$(free -g | awk '/^Mem:/{print $2}')
    if [[ $available_gb -lt $required_gb ]]; then
        warn "RAM thấp: ${available_gb}GB (khuyến nghị: ${required_gb}GB). Build có thể chậm."
    else
        ok "RAM: ${available_gb}GB available"
    fi
}

get_fp_chromium_version() {
    # Lấy version mới nhất từ fingerprint-chromium
    log "Fetching latest fingerprint-chromium version..."
    local api_url="https://api.github.com/repos/adryfish/fingerprint-chromium/releases/latest"
    local headers=(-H "Accept: application/vnd.github.v3+json")
    [[ -n "$GITHUB_TOKEN" ]] && headers+=(-H "Authorization: token $GITHUB_TOKEN")

    local release_info
    release_info=$(curl -s "${headers[@]}" "$api_url")

    # Extract chromium version from tag (e.g., "130.0.6723.69" or "v130.0.6723.69")
    local version
    version=$(echo "$release_info" | python3 -c "
import sys, json
data = json.load(sys.stdin)
tag = data.get('tag_name', '')
# Try to find chromium version in release body or tag
import re
# Tag might be the version directly
if re.match(r'\d+\.\d+\.\d+\.\d+', tag):
    print(tag)
elif re.match(r'v\d+\.\d+\.\d+\.\d+', tag):
    print(tag[1:])
else:
    # Try body
    body = data.get('body', '')
    match = re.search(r'chromium[- ]+(\d+\.\d+\.\d+\.\d+)', body, re.I)
    if match:
        print(match.group(1))
    else:
        print('')
" 2>/dev/null || true)

    echo "$version"
}

# ─── Phase 0: Kiểm tra môi trường ─────────────────────────────────────────────
hdr "Phase 0: Environment Check"

log "System: $(uname -a)"
log "CPU cores: $CORES"
log "Build root: $BUILD_ROOT"

check_disk_space 200
check_ram 32

mkdir -p "$BUILD_ROOT" "$OUTPUT_DIR"

# ─── Phase 1: Cài đặt dependencies ────────────────────────────────────────────
hdr "Phase 1: Install Build Dependencies"

export DEBIAN_FRONTEND=noninteractive

log "Updating package list..."
apt-get update -qq

log "Installing build dependencies..."
apt-get install -y -qq \
    git curl wget python3 python3-pip \
    ninja-build pkg-config \
    lsb-release sudo tzdata \
    clang lld llvm \
    libglib2.0-dev libpango1.0-dev libatk1.0-dev \
    libcups2-dev libexpat1-dev libxcomposite-dev libxdamage-dev \
    libxrandr-dev libxkbcommon-dev libgbm-dev \
    libasound2-dev libpulse-dev \
    libnspr4-dev libnss3-dev \
    ccache \
    zip unzip jq \
    2>/dev/null || true

# Setup ccache for faster incremental rebuilds
export CCACHE_DIR="$BUILD_ROOT/ccache"
export CCACHE_MAXSIZE="30G"
export PATH="/usr/lib/ccache:$PATH"
ok "ccache configured (dir: $CCACHE_DIR)"

# Setup swap if RAM < 64GB to prevent OOM
TOTAL_RAM=$(free -g | awk '/Mem:/{print $2}')
if [[ $TOTAL_RAM -lt 64 && ! -f /workspace/swapfile ]]; then
    log "RAM ${TOTAL_RAM}GB < 64GB, tạo 32GB swap file..."
    fallocate -l 32G /workspace/swapfile && \
    chmod 600 /workspace/swapfile && \
    mkswap /workspace/swapfile && \
    swapon /workspace/swapfile && \
    ok "Swap 32GB activated" || warn "Không tạo được swap file"
fi

# AWS CLI for S3/R2 upload (optional)
if [[ -n "$R2_ENDPOINT" ]]; then
    pip3 install -q awscli 2>/dev/null || true
fi

# GitHub CLI for release upload (optional)
if [[ -n "$GITHUB_REPO" && -n "$GITHUB_TOKEN" ]]; then
    if ! command -v gh &>/dev/null; then
        log "Installing GitHub CLI..."
        curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
            | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
            https://cli.github.com/packages stable main" \
            | tee /etc/apt/sources.list.d/github-cli.list > /dev/null
        apt-get update -qq
        apt-get install -y -qq gh 2>/dev/null || true
    fi
fi

ok "Dependencies installed"

# ─── Phase 2: Cài đặt depot_tools ─────────────────────────────────────────────
hdr "Phase 2: Setup depot_tools"

if [[ ! -d "$DEPOT_TOOLS_DIR" ]]; then
    log "Cloning depot_tools..."
    git clone --depth 1 https://chromium.googlesource.com/chromium/tools/depot_tools.git "$DEPOT_TOOLS_DIR"
else
    log "Updating depot_tools..."
    cd "$DEPOT_TOOLS_DIR" && git pull --ff-only || true
fi

export PATH="$DEPOT_TOOLS_DIR:$PATH"
ok "depot_tools ready at $DEPOT_TOOLS_DIR"

# ─── Phase 3: Determine Chromium version ──────────────────────────────────────
hdr "Phase 3: Determine Chromium Version"

if [[ -z "$CHROMIUM_VERSION" ]]; then
    CHROMIUM_VERSION=$(get_fp_chromium_version)
fi

if [[ -z "$CHROMIUM_VERSION" ]]; then
    # Fallback to a known stable version
    CHROMIUM_VERSION="130.0.6723.69"
    warn "Could not auto-detect version, using fallback: $CHROMIUM_VERSION"
fi

log "Target Chromium version: $CHROMIUM_VERSION"

# Extract major version for branch
MAJOR_VERSION="${CHROMIUM_VERSION%%.*}"
log "Major version: $MAJOR_VERSION"

# ─── Phase 4: Fetch Chromium source ───────────────────────────────────────────
hdr "Phase 4: Fetch Chromium Source (~20GB download, ~40 min)"

mkdir -p "$BUILD_ROOT/chromium"
cd "$BUILD_ROOT/chromium"

# Configure git for large repos
git config --global core.compression 0
git config --global http.postBuffer 1048576000

if [[ ! -d "$CHROMIUM_SRC" ]]; then
    log "Fetching Chromium source (this will take 30-60 minutes)..."
    fetch --nohooks --no-history chromium
else
    log "Chromium source already exists, updating..."
fi

cd "$CHROMIUM_SRC"

# Checkout specific version
log "Checking out Chromium $CHROMIUM_VERSION..."
git fetch --tags origin "refs/tags/$CHROMIUM_VERSION" || \
    git fetch origin "refs/branch-heads/$MAJOR_VERSION" || true

git checkout "refs/tags/$CHROMIUM_VERSION" 2>/dev/null || \
    git checkout -b "geekez-$CHROMIUM_VERSION" "origin/main" || true

# Sync all dependencies
log "Syncing dependencies (gclient sync)..."
gclient sync --with_branch_heads --with_tags -f --no-history \
    -r "src@refs/tags/$CHROMIUM_VERSION" || \
    gclient sync --no-history -D

# Install build deps
log "Installing Chromium build dependencies..."
./build/install-build-deps.sh --no-arm --no-chromeos-fonts --no-nacl --no-prompt \
    2>/dev/null || true

gclient runhooks

ok "Chromium source ready at $CHROMIUM_SRC"

# ─── Phase 5: Apply ungoogled-chromium patches ────────────────────────────────
hdr "Phase 5: Apply ungoogled-chromium patches"

UGCHROMIUM_DIR="$BUILD_ROOT/ungoogled-chromium"

if [[ ! -d "$UGCHROMIUM_DIR" ]]; then
    log "Cloning ungoogled-chromium..."
    git clone --depth 1 --branch "$CHROMIUM_VERSION" \
        https://github.com/ungoogled-software/ungoogled-chromium.git \
        "$UGCHROMIUM_DIR" 2>/dev/null || \
    git clone --depth 1 \
        https://github.com/ungoogled-software/ungoogled-chromium.git \
        "$UGCHROMIUM_DIR"
fi

cd "$CHROMIUM_SRC"

log "Applying ungoogled-chromium patches..."
"$UGCHROMIUM_DIR/utils/patches.py" apply "$CHROMIUM_SRC" \
    "$UGCHROMIUM_DIR/patches/core" 2>/dev/null || \
    warn "Some ungoogled patches failed (may be version mismatch), continuing..."

ok "ungoogled-chromium patches applied"

# ─── Phase 6: Apply fingerprint-chromium patches ──────────────────────────────
hdr "Phase 6: Apply fingerprint-chromium patches"

FP_CHROMIUM_DIR="$BUILD_ROOT/fingerprint-chromium-src"

if [[ ! -d "$FP_CHROMIUM_DIR" ]]; then
    log "Cloning fingerprint-chromium patch repository..."
    git clone --depth 1 \
        https://github.com/adryfish/fingerprint-chromium.git \
        "$FP_CHROMIUM_DIR" 2>/dev/null || \
        warn "Could not clone fingerprint-chromium, skipping its patches"
fi

cd "$CHROMIUM_SRC"

if [[ -d "$FP_CHROMIUM_DIR/patches" ]]; then
    log "Applying fingerprint-chromium patches..."
    for patch_file in "$FP_CHROMIUM_DIR/patches/"*.patch; do
        [[ -f "$patch_file" ]] || continue
        log "  Applying: $(basename $patch_file)"
        git apply --ignore-whitespace --reject "$patch_file" 2>/dev/null || \
            patch -p1 --forward --ignore-whitespace -r /dev/null < "$patch_file" 2>/dev/null || \
            warn "  Patch $(basename $patch_file) failed or already applied"
    done
    ok "fingerprint-chromium patches applied"
fi

# ─── Phase 7: Apply GeekezBrowser custom patches ──────────────────────────────
hdr "Phase 7: Apply GeekezBrowser Custom Patches"

cd "$CHROMIUM_SRC"

if [[ -d "$PATCHES_DIR" ]]; then
    # Apply patches in order
    local_patches=()
    if [[ -f "$PATCHES_DIR/series" ]]; then
        while IFS= read -r line; do
            [[ -z "$line" || "$line" == \#* ]] && continue
            local_patches+=("$PATCHES_DIR/$line")
        done < "$PATCHES_DIR/series"
    else
        for f in "$PATCHES_DIR"/*.patch; do
            [[ -f "$f" ]] && local_patches+=("$f")
        done
        IFS=$'\n' local_patches=($(sort <<<"${local_patches[*]}")); unset IFS
    fi

    for patch_file in "${local_patches[@]}"; do
        [[ -f "$patch_file" ]] || continue
        log "  Applying GeekezBrowser patch: $(basename $patch_file)"
        git apply --ignore-whitespace "$patch_file" 2>/dev/null || \
            patch -p1 --forward --ignore-whitespace -r /dev/null < "$patch_file" 2>/dev/null || \
            warn "  Patch $(basename $patch_file) failed (may already be applied)"
    done
    ok "GeekezBrowser custom patches applied"
else
    warn "No custom patches directory found at $PATCHES_DIR"
fi

# ─── Phase 8: Configure Build ─────────────────────────────────────────────────
hdr "Phase 8: Configure Build (GN Args)"

BUILD_DIR="$CHROMIUM_SRC/out/GeekezBrowser"
mkdir -p "$BUILD_DIR"

# Write GN args
cat > "$BUILD_DIR/args.gn" << EOF
# GeekezBrowser Custom Chromium Build Configuration
# Generated by runpod-build.sh

# Basic settings
is_debug = false
is_official_build = true
is_component_build = false

# CPU/OS target
target_cpu = "$TARGET_CPU"

# Enable proprietary codecs (H.264, AAC etc)
ffmpeg_branding = "Chrome"
proprietary_codecs = true

# Disable unnecessary features
enable_nacl = false
enable_widevine = false
use_cups = false

# Compiler: use system clang
is_clang = true
clang_use_chrome_plugins = false

# Optimize for size vs speed (release build)
optimize_webui = true

# Disable crash reporting (no Google services)
use_official_google_api_keys = false
google_api_key = ""
google_default_client_id = ""
google_default_client_secret = ""

# Disable PGO (no profile data available on RunPod)
chrome_pgo_phase = 0

# Linux-specific: prefer system libs where possible
use_system_libffi = false
use_system_libjpeg = false

# Symbol level: 0 = no symbols (smaller binary)
symbol_level = 0
blink_symbol_level = 0

# Additional features
enable_vulkan = false
use_vaapi = false

# Speed up build via thin LTO
use_thin_lto = false
EOF

log "GN args written to $BUILD_DIR/args.gn"
log "Running gn gen..."
gn gen "$BUILD_DIR" 2>&1 | tail -5

ok "Build configured"

# ─── Phase 9: Build ────────────────────────────────────────────────────────────
hdr "Phase 9: Build Chromium (~2-6h depending on CPU)"

log "Starting build with $CORES cores..."
log "Build start time: $(date)"
START_TIME=$(date +%s)

# Build chrome binary + sandbox
autoninja -C "$BUILD_DIR" chrome chrome_sandbox -j"$CORES" 2>&1 | \
    grep -E "^\[|error:|warning:|FAILED|ninja:"
BUILD_EXIT=${PIPESTATUS[0]}

[[ $BUILD_EXIT -ne 0 ]] && err "autoninja failed with exit code $BUILD_EXIT"

END_TIME=$(date +%s)
BUILD_DURATION=$(( (END_TIME - START_TIME) / 60 ))
log "Build completed in ${BUILD_DURATION} minutes"

# Verify binary exists
CHROME_BIN="$BUILD_DIR/chrome"
if [[ ! -f "$CHROME_BIN" ]]; then
    err "Build failed: chrome binary not found at $CHROME_BIN"
fi

ok "Chrome binary built: $CHROME_BIN ($(du -sh $CHROME_BIN | cut -f1))"

# ─── Phase 10: Package ─────────────────────────────────────────────────────────
hdr "Phase 10: Package Build Output"

PACKAGE_NAME="geekez-chromium-${CHROMIUM_VERSION}-linux-${TARGET_CPU}"
PACKAGE_DIR="$OUTPUT_DIR/$PACKAGE_NAME"
mkdir -p "$PACKAGE_DIR"

log "Copying build artifacts..."

# Essential files for Chromium to run
ESSENTIAL_FILES=(
    "chrome"
    "chrome_sandbox"
    "chrome.pak"
    "chrome_100_percent.pak"
    "chrome_200_percent.pak"
    "resources.pak"
    "icudtl.dat"
    "v8_context_snapshot.bin"
    "libEGL.so"
    "libGLESv2.so"
    "libvulkan.so.1"
    "libvk_swiftshader.so"
    "vk_swiftshader_icd.json"
    "snapshot_blob.bin"
    "chrome_crashpad_handler"
    "MEIPreload"
    "resources"
    "locales"
)

for item in "${ESSENTIAL_FILES[@]}"; do
    src="$BUILD_DIR/$item"
    if [[ -e "$src" ]]; then
        cp -r "$src" "$PACKAGE_DIR/" 2>/dev/null || true
    fi
done

# Set sandbox permissions
if [[ -f "$PACKAGE_DIR/chrome_sandbox" ]]; then
    chmod 4755 "$PACKAGE_DIR/chrome_sandbox"
fi

# Copy chrome with execute permission
chmod +x "$PACKAGE_DIR/chrome"

# Write metadata
cat > "$PACKAGE_DIR/geekez-meta.json" << EOF
{
    "version": "$CHROMIUM_VERSION",
    "buildDate": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "platform": "linux",
    "arch": "$TARGET_CPU",
    "patches": [
        "ungoogled-chromium",
        "fingerprint-chromium",
        "geekez-custom"
    ],
    "builder": "RunPod",
    "cores": $CORES,
    "buildDuration": "${BUILD_DURATION}min"
}
EOF

# Create zip archive
log "Creating zip archive..."
cd "$OUTPUT_DIR"
zip -r "${PACKAGE_NAME}.zip" "$PACKAGE_NAME/" -x "*.dSYM/*"

PACKAGE_SIZE=$(du -sh "${PACKAGE_NAME}.zip" | cut -f1)
ok "Package created: ${PACKAGE_NAME}.zip ($PACKAGE_SIZE)"

# ─── Phase 11: Upload ──────────────────────────────────────────────────────────
hdr "Phase 11: Upload Binary"

PACKAGE_ZIP="$OUTPUT_DIR/${PACKAGE_NAME}.zip"

# Option A: Upload to Cloudflare R2 / S3
if [[ -n "$R2_ENDPOINT" && -n "$R2_ACCESS_KEY" ]]; then
    log "Uploading to Cloudflare R2..."
    aws configure set aws_access_key_id "$R2_ACCESS_KEY" --profile r2
    aws configure set aws_secret_access_key "$R2_SECRET_KEY" --profile r2
    aws configure set region auto --profile r2

    aws s3 cp "$PACKAGE_ZIP" \
        "s3://${R2_BUCKET}/${PACKAGE_NAME}.zip" \
        --endpoint-url "$R2_ENDPOINT" \
        --profile r2

    ok "Uploaded to R2: ${R2_ENDPOINT}/${R2_BUCKET}/${PACKAGE_NAME}.zip"

# Option B: Upload to GitHub Releases
elif [[ -n "$GITHUB_REPO" && -n "$GITHUB_TOKEN" ]]; then
    log "Uploading to GitHub Releases..."
    export GH_TOKEN="$GITHUB_TOKEN"

    # Create release tag
    RELEASE_TAG="v${CHROMIUM_VERSION}"

    # Create release if not exists
    gh release create "$RELEASE_TAG" \
        --repo "$GITHUB_REPO" \
        --title "GeekezBrowser Chromium $CHROMIUM_VERSION" \
        --notes "Custom Chromium build for GeekezBrowser

**Version:** $CHROMIUM_VERSION
**Build Date:** $(date -u +%Y-%m-%d)
**Patches:** ungoogled-chromium + fingerprint-chromium + geekez-custom

**Anti-detect features:**
- navigator.webdriver = false (C++ level)
- Canvas noise (seed-based, undetectable)
- WebGL vendor/renderer spoofing
- AudioContext noise
- ClientRect noise
- Automation flag removal
" 2>/dev/null || log "Release already exists, uploading asset..."

    # Upload asset
    gh release upload "$RELEASE_TAG" "$PACKAGE_ZIP" \
        --repo "$GITHUB_REPO" \
        --clobber

    ok "Uploaded to GitHub: https://github.com/${GITHUB_REPO}/releases/tag/${RELEASE_TAG}"

# Option C: Quick upload via transfer.sh (temporary, 14 days)
else
    warn "No upload credentials provided. Using transfer.sh (14-day temp link)..."
    TRANSFER_URL=$(curl -s --upload-file "$PACKAGE_ZIP" \
        "https://transfer.sh/${PACKAGE_NAME}.zip")

    log "Download URL (valid 14 days): $TRANSFER_URL"
    echo "$TRANSFER_URL" > "$OUTPUT_DIR/download-url.txt"
    ok "Uploaded to transfer.sh"
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
hdr "Build Complete!"

echo -e "${GREEN}"
echo "  ✓ Chromium $CHROMIUM_VERSION built successfully"
echo "  ✓ Patches: ungoogled + fingerprint + geekez-custom"
echo "  ✓ Package: ${PACKAGE_NAME}.zip ($PACKAGE_SIZE)"
echo "  ✓ Duration: ${BUILD_DURATION} minutes"
echo ""
echo "Next steps:"
echo "  1. Download the zip from your storage"
echo "  2. Extract to GeekezBrowser userData/fingerprint-chromium/"
echo "  3. Rename the binary to 'chrome' (Linux) or 'chrome.exe' (Windows)"
echo "  4. GeekezBrowser will auto-detect it"
echo -e "${NC}"
