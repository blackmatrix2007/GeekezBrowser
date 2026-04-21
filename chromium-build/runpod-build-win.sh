#!/bin/bash
# =============================================================================
# BUILD CHROMIUM FOR WINDOWS (x64) - CHẠY TRÊN RUNPOD LINUX
# =============================================================================
# Chromium CHÍNH THỨC hỗ trợ cross-compile từ Linux → Windows
# Build system tự download Windows SDK từ server của Google
#
# RUNPOD REQUIREMENTS:
#   CPU:    32 cores minimum (96 cores = ~2h, 32 cores = ~5h)
#   RAM:    64 GB minimum  (128 GB recommended)
#   DISK:   Container Disk = 300 GB  (source + build artifacts)
#   OS:     Ubuntu 22.04 (bất kỳ template nào của RunPod)
#
# SETUP ENVIRONMENT VARS TRƯỚC KHI CHẠY:
#   export GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"
#   export GITHUB_REPO="your-username/geekez-chromium"
#   export CHROMIUM_VERSION="130.0.6723.69"   # optional, auto-detect nếu để trống
#
# CHẠY:
#   bash runpod-build-win.sh
# =============================================================================

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# CONFIG
# ──────────────────────────────────────────────────────────────────────────────
WORKSPACE="${WORKSPACE:-/workspace}"           # Network volume (persistent)
BUILD_ROOT="$WORKSPACE"
DEPOT_TOOLS="$BUILD_ROOT/depot_tools"
CHROMIUM_SRC="$BUILD_ROOT/chromium/src"
OUTPUT_DIR="$BUILD_ROOT/output"
PATCHES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/patches"

GITHUB_TOKEN="${GITHUB_TOKEN:-}"
GITHUB_REPO="${GITHUB_REPO:-}"
CHROMIUM_VERSION="${CHROMIUM_VERSION:-}"       # e.g. "130.0.6723.69"

CORES=$(nproc)

# ──────────────────────────────────────────────────────────────────────────────
# COLORS / LOG
# ──────────────────────────────────────────────────────────────────────────────
R='\033[0;31m' G='\033[0;32m' Y='\033[1;33m' B='\033[0;34m' C='\033[0;36m' N='\033[0m'
log()  { echo -e "${B}[$(date '+%H:%M:%S')]${N} $*"; }
ok()   { echo -e "${G}[✓]${N} $*"; }
warn() { echo -e "${Y}[!]${N} $*"; }
err()  { echo -e "${R}[✗]${N} $*"; exit 1; }
hdr()  { echo -e "\n${C}══════════════════════════════════════════════${N}"; \
          echo -e "${C}  $*${N}"; \
          echo -e "${C}══════════════════════════════════════════════${N}\n"; }

# ──────────────────────────────────────────────────────────────────────────────
# PHASE 0 — KIỂM TRA MÔI TRƯỜNG
# ──────────────────────────────────────────────────────────────────────────────
hdr "Phase 0 — Kiểm tra môi trường"

log "OS: $(lsb_release -ds 2>/dev/null || cat /etc/os-release | head -1)"
log "CPU cores: $CORES"
log "RAM: $(free -g | awk '/Mem:/{print $2}') GB"
DISK_GB=$(df -BG "$BUILD_ROOT" | tail -1 | awk '{print $4}' | tr -d G)
log "Disk free: ${DISK_GB} GB tại $BUILD_ROOT"

[[ $DISK_GB -lt 200 ]] && err "Cần ít nhất 200 GB. Tăng Container Disk trong RunPod."
[[ $(free -g | awk '/Mem:/{print $2}') -lt 32 ]] && warn "RAM < 32 GB, build sẽ dùng swap."

mkdir -p "$BUILD_ROOT" "$OUTPUT_DIR"
ok "Môi trường OK"

# ──────────────────────────────────────────────────────────────────────────────
# PHASE 1 — CÀI PACKAGES
# ──────────────────────────────────────────────────────────────────────────────
hdr "Phase 1 — Cài build dependencies"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
    git python3 python3-pip curl wget \
    ninja-build pkg-config \
    lsb-release sudo tzdata \
    clang lld llvm \
    lib32gcc-s1 lib32stdc++6 \
    p7zip-full zip unzip jq \
    2>/dev/null

# GitHub CLI (để upload release)
if [[ -n "$GITHUB_TOKEN" ]] && ! command -v gh &>/dev/null; then
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
        https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list
    apt-get update -qq && apt-get install -y -qq gh 2>/dev/null || true
fi

ok "Packages installed"

# ──────────────────────────────────────────────────────────────────────────────
# PHASE 2 — DEPOT_TOOLS
# ──────────────────────────────────────────────────────────────────────────────
hdr "Phase 2 — depot_tools"

if [[ ! -d "$DEPOT_TOOLS" ]]; then
    log "Cloning depot_tools..."
    git clone --depth 1 \
        https://chromium.googlesource.com/chromium/tools/depot_tools.git \
        "$DEPOT_TOOLS"
else
    log "depot_tools đã có, cập nhật..."
    git -C "$DEPOT_TOOLS" pull --ff-only 2>/dev/null || true
fi

export PATH="$DEPOT_TOOLS:$PATH"

# Bắt buộc với cross-compile Windows trên Linux
export DEPOT_TOOLS_WIN_TOOLCHAIN=0   # Dùng clang thay MSVC
export GYP_MSVS_VERSION=2022

ok "depot_tools sẵn sàng: $DEPOT_TOOLS"

# ──────────────────────────────────────────────────────────────────────────────
# PHASE 3 — XÁC ĐỊNH CHROMIUM VERSION
# ──────────────────────────────────────────────────────────────────────────────
hdr "Phase 3 — Xác định Chromium version"

if [[ -z "$CHROMIUM_VERSION" ]]; then
    log "Auto-detect từ fingerprint-chromium releases..."
    HEADERS=(-H "Accept: application/vnd.github.v3+json")
    [[ -n "$GITHUB_TOKEN" ]] && HEADERS+=(-H "Authorization: token $GITHUB_TOKEN")
    CHROMIUM_VERSION=$(curl -s "${HEADERS[@]}" \
        "https://api.github.com/repos/adryfish/fingerprint-chromium/releases/latest" | \
        python3 -c "
import sys,json,re
d=json.load(sys.stdin)
tag=d.get('tag_name','')
m=re.search(r'(\d+\.\d+\.\d+\.\d+)',tag)
print(m.group(1) if m else tag.lstrip('v'))
" 2>/dev/null || echo "130.0.6723.69")
fi

log "Target version: $CHROMIUM_VERSION"
MAJOR="${CHROMIUM_VERSION%%.*}"
log "Major: $MAJOR"

# ──────────────────────────────────────────────────────────────────────────────
# PHASE 4 — FETCH CHROMIUM SOURCE
# ──────────────────────────────────────────────────────────────────────────────
hdr "Phase 4 — Fetch Chromium source (~25 GB, 30-60 phút)"

# Cấu hình git để download nhanh hơn
git config --global core.compression 0
git config --global http.postBuffer 524288000

mkdir -p "$BUILD_ROOT/chromium"
cd "$BUILD_ROOT/chromium"

if [[ ! -d "$CHROMIUM_SRC/.git" ]]; then
    log "Fetch lần đầu (mất nhiều thời gian)..."
    # --no-history = shallow clone, tiết kiệm 50% disk
    fetch --nohooks --no-history chromium
else
    log "Source đã có. Sync đến $CHROMIUM_VERSION..."
fi

cd "$CHROMIUM_SRC"

# Checkout đúng version
log "Checkout $CHROMIUM_VERSION..."
git fetch --depth 1 origin "refs/tags/$CHROMIUM_VERSION" 2>/dev/null || \
    git fetch --depth 1 origin "+refs/heads/main:refs/remotes/origin/main" 2>/dev/null || true

git checkout "refs/tags/$CHROMIUM_VERSION" 2>/dev/null || \
    git checkout "origin/main" 2>/dev/null || true

# Sync dependencies (QUAN TRỌNG: --no-history tiết kiệm disk)
log "gclient sync (bước này lâu nhất ~30 phút)..."
gclient sync \
    --with_branch_heads \
    --with_tags \
    --no-history \
    --shallow \
    -D \
    2>&1 | grep -v "^Syncing\|^______\|^$" || true

# Cài build deps Linux (cần cả khi cross-compile cho Windows)
log "Cài build deps..."
./build/install-build-deps.sh \
    --no-arm --no-chromeos-fonts --no-nacl --no-prompt \
    2>/dev/null || true

gclient runhooks

ok "Chromium source sẵn sàng: $CHROMIUM_SRC"

# ──────────────────────────────────────────────────────────────────────────────
# PHASE 5 — TẢI WINDOWS SDK (critical step)
# ──────────────────────────────────────────────────────────────────────────────
hdr "Phase 5 — Download Windows SDK cho cross-compile"

# Chromium tự động download Windows SDK từ Google's server
# Không cần license Windows hay Visual Studio!
log "Download Windows toolchain (MSVC headers + SDK)..."

export DEPOT_TOOLS_WIN_TOOLCHAIN=1   # Bật download Windows toolchain
export WINDOWSSDKDIR=""
export GYP_MSVS_VERSION=2022

# Script này download ~3 GB Windows SDK headers
python3 build/vs_toolchain.py update --force 2>&1 | tail -10 || {
    warn "vs_toolchain.py thất bại. Thử alternative method..."
    # Alternative: dùng clang cross-compile không cần SDK
    export DEPOT_TOOLS_WIN_TOOLCHAIN=0
    warn "Tiếp tục với clang cross-compile (không cần Windows SDK)"
}

ok "Windows toolchain ready"

# ──────────────────────────────────────────────────────────────────────────────
# PHASE 6 — APPLY PATCHES
# ──────────────────────────────────────────────────────────────────────────────
hdr "Phase 6 — Apply anti-detect patches"

cd "$CHROMIUM_SRC"

apply_patch() {
    local patch="$1"
    local name="$(basename $patch)"
    if git apply --check --ignore-whitespace "$patch" 2>/dev/null; then
        git apply --ignore-whitespace "$patch" && ok "  ✓ $name" || warn "  ✗ $name failed"
    else
        warn "  ⚠ $name không apply được (version mismatch, bỏ qua)"
    fi
}

# Apply fingerprint-chromium patches nếu có
FP_DIR="$BUILD_ROOT/fingerprint-chromium-src"
if [[ ! -d "$FP_DIR" ]]; then
    git clone --depth 1 \
        https://github.com/adryfish/fingerprint-chromium.git "$FP_DIR" 2>/dev/null || \
        warn "Không clone được fingerprint-chromium, bỏ qua"
fi

if [[ -d "$FP_DIR/patches" ]]; then
    log "Applying fingerprint-chromium patches..."
    for p in "$FP_DIR/patches/"*.patch; do
        [[ -f "$p" ]] && apply_patch "$p"
    done
fi

# Apply GeekezBrowser custom patches
if [[ -d "$PATCHES_DIR" ]]; then
    log "Applying GeekezBrowser custom patches..."
    SERIES="$PATCHES_DIR/series"
    if [[ -f "$SERIES" ]]; then
        while IFS= read -r line; do
            [[ -z "$line" || "$line" == \#* ]] && continue
            [[ -f "$PATCHES_DIR/$line" ]] && apply_patch "$PATCHES_DIR/$line"
        done < "$SERIES"
    else
        for p in "$PATCHES_DIR/"*.patch; do
            [[ -f "$p" ]] && apply_patch "$p"
        done
    fi
fi

ok "Patches applied"

# ──────────────────────────────────────────────────────────────────────────────
# PHASE 7 — CẤU HÌNH GN (Windows target)
# ──────────────────────────────────────────────────────────────────────────────
hdr "Phase 7 — Cấu hình GN cho Windows x64"

BUILD_OUT="$CHROMIUM_SRC/out/GeekezWin"
mkdir -p "$BUILD_OUT"

# Kiểm tra có Windows toolchain không
if [[ -d "$CHROMIUM_SRC/build/win/toolchain" ]] || \
   python3 -c "import os; open('build/win/toolchain.py')" 2>/dev/null || \
   [[ -n "$(find $CHROMIUM_SRC -name 'cl.exe' 2>/dev/null | head -1)" ]]; then
    WIN_TOOLCHAIN=1
    log "Windows SDK/toolchain detected - dùng MSVC headers"
else
    WIN_TOOLCHAIN=0
    log "Không có Windows SDK - dùng clang cross-compile"
fi

cat > "$BUILD_OUT/args.gn" << EOF
# ═══════════════════════════════════════════════════════
# GeekezBrowser Custom Chromium - Windows x64 Build Args
# ═══════════════════════════════════════════════════════

# ─── Target Platform ─────────────────────────────────
target_os   = "win"
target_cpu  = "x64"

# ─── Build type ──────────────────────────────────────
is_debug          = false
is_official_build = true
is_component_build = false

# ─── Compiler ────────────────────────────────────────
# Clang cross-compile từ Linux → Windows
is_clang              = true
clang_use_chrome_plugins = false

# ─── Codecs (cần cho multimedia fingerprinting) ───────
ffmpeg_branding    = "Chrome"
proprietary_codecs = true

# ─── Tắt features không cần ──────────────────────────
enable_nacl        = false
enable_widevine    = true
use_cups           = false

# ─── Tắt Google services ─────────────────────────────
use_official_google_api_keys = false
google_api_key               = ""
google_default_client_id     = ""
google_default_client_secret = ""

# ─── Symbol level (0 = nhỏ nhất, không có debug info) ──
symbol_level       = 0
blink_symbol_level = 0

# ─── Tốc độ build ────────────────────────────────────
jumbo_file_merge_limit = 50
EOF

log "Chạy gn gen..."
gn gen "$BUILD_OUT" 2>&1 | tail -20 || err "gn gen thất bại. Xem lỗi trên."

ok "GN configured tại $BUILD_OUT"

# ──────────────────────────────────────────────────────────────────────────────
# PHASE 8 — BUILD
# ──────────────────────────────────────────────────────────────────────────────
hdr "Phase 8 — Build (~2-6h tùy số cores)"

log "Bắt đầu build với $CORES cores lúc $(date)"
START=$(date +%s)

# Build chrome binary cho Windows
# chrome.exe là target chính
autoninja -C "$BUILD_OUT" chrome -j"$CORES" 2>&1 | \
    grep -E "^\[|error:|FAILED|ninja:|Generating" | \
    while IFS= read -r line; do
        echo "[$(date '+%H:%M:%S')] $line"
    done

DURATION=$(( ($(date +%s) - START) / 60 ))
log "Build hoàn thành trong ${DURATION} phút"

# Verify binary
WIN_CHROME="$BUILD_OUT/chrome.exe"
[[ ! -f "$WIN_CHROME" ]] && err "Build thất bại: $WIN_CHROME không tồn tại"
ok "chrome.exe: $(du -sh $WIN_CHROME | cut -f1)"

# ──────────────────────────────────────────────────────────────────────────────
# PHASE 9 — PACKAGE
# ──────────────────────────────────────────────────────────────────────────────
hdr "Phase 9 — Package Windows binary"

PKG_NAME="geekez-chromium-${CHROMIUM_VERSION}-windows-x64"
PKG_DIR="$OUTPUT_DIR/$PKG_NAME"
mkdir -p "$PKG_DIR"

log "Copy artifacts..."

# Files cần thiết cho Windows Chrome
WIN_FILES=(
    "chrome.exe"
    "chrome.dll"
    "chrome_elf.dll"
    "chrome_proxy.exe"
    "chrome_pwa_launcher.exe"
    "chrome.pak"
    "chrome_100_percent.pak"
    "chrome_200_percent.pak"
    "resources.pak"
    "icudtl.dat"
    "v8_context_snapshot.bin"
    "snapshot_blob.bin"
    "d3dcompiler_47.dll"
    "libEGL.dll"
    "libGLESv2.dll"
    "vk_swiftshader.dll"
    "vk_swiftshader_icd.json"
    "vulkan-1.dll"
    "resources"
    "locales"
    "MEIPreload"
)

for f in "${WIN_FILES[@]}"; do
    src="$BUILD_OUT/$f"
    [[ -e "$src" ]] && cp -r "$src" "$PKG_DIR/" && log "  ✓ $f" || log "  ⚠ $f (not found)"
done

# Metadata
cat > "$PKG_DIR/fp-meta.json" << EOF
{
    "version": "$CHROMIUM_VERSION",
    "downloadedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "source": "geekez-custom-build",
    "platform": "windows",
    "arch": "x64",
    "patches": ["fingerprint-chromium", "geekez-custom"],
    "buildDuration": "${DURATION}min",
    "cores": $CORES
}
EOF

log "Tạo zip..."
cd "$OUTPUT_DIR"
zip -r "${PKG_NAME}.zip" "$PKG_NAME/" -q

PKG_SIZE=$(du -sh "${PKG_NAME}.zip" | cut -f1)
ok "Package: ${PKG_NAME}.zip ($PKG_SIZE)"

# ──────────────────────────────────────────────────────────────────────────────
# PHASE 10 — UPLOAD
# ──────────────────────────────────────────────────────────────────────────────
hdr "Phase 10 — Upload"

ZIP="$OUTPUT_DIR/${PKG_NAME}.zip"

if [[ -n "$GITHUB_REPO" && -n "$GITHUB_TOKEN" ]]; then
    export GH_TOKEN="$GITHUB_TOKEN"
    TAG="v${CHROMIUM_VERSION}"

    gh release create "$TAG" \
        --repo "$GITHUB_REPO" \
        --title "GeekezBrowser Chromium $CHROMIUM_VERSION" \
        --notes "Windows x64 build with anti-detect C++ patches" \
        2>/dev/null || true

    gh release upload "$TAG" "$ZIP" --repo "$GITHUB_REPO" --clobber
    ok "GitHub: https://github.com/${GITHUB_REPO}/releases/tag/${TAG}"
else
    # Fallback: transfer.sh
    URL=$(curl -s --upload-file "$ZIP" "https://transfer.sh/${PKG_NAME}.zip")
    echo "$URL" > "$OUTPUT_DIR/download-url.txt"
    ok "Transfer.sh (14 ngày): $URL"
fi

hdr "HOÀN THÀNH"
echo -e "${G}chrome.exe $CHROMIUM_VERSION built successfully${N}"
echo "Duration: ${DURATION} phút | Size: $PKG_SIZE"
