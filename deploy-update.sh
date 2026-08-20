#!/bin/bash
# Deploy BNC Browser update lên yttool.vn/updates/
# Chạy SAU KHI build:win xong trên máy Windows
# Usage: ./deploy-update.sh [path-to-dist-folder]

set -e

DIST="${1:-./dist}"
VPS="root@103.163.215.48"
VPS_DIR="/var/www/yttool-updates"
VERSION=$(node -e "console.log(require('./package.json').version)")

echo "📦 Deploy BNC Browser v${VERSION} → yttool.vn/updates"

# Kiểm tra file cần thiết
WIN_EXE=$(ls "$DIST"/BNC-${VERSION}-win-x64.exe 2>/dev/null || true)
WIN_YML=$(ls "$DIST"/latest.yml 2>/dev/null || true)

if [ -z "$WIN_EXE" ]; then
    echo "❌ Không tìm thấy $DIST/BNC-${VERSION}-win-x64.exe"
    echo "   Build Windows trước: npm run build:win"
    exit 1
fi
if [ -z "$WIN_YML" ]; then
    echo "❌ Không tìm thấy $DIST/latest.yml"
    exit 1
fi

echo "📤 Upload files..."
scp "$DIST/BNC-${VERSION}-win-x64.exe"     "$VPS:$VPS_DIR/"
scp "$DIST/BNC-${VERSION}-win-x64.exe.blockmap" "$VPS:$VPS_DIR/" 2>/dev/null || true
scp "$DIST/latest.yml"                       "$VPS:$VPS_DIR/"

# Mac nếu có
MAC_ARM=$(ls "$DIST"/BNC-${VERSION}-mac-arm64.dmg 2>/dev/null || true)
MAC_X64=$(ls "$DIST"/BNC-${VERSION}-mac-x64.dmg   2>/dev/null || true)
MAC_YML=$(ls "$DIST"/latest-mac.yml               2>/dev/null || true)
if [ -n "$MAC_ARM" ]; then
    scp "$DIST/BNC-${VERSION}-mac-arm64.dmg" "$VPS:$VPS_DIR/"
    scp "$DIST/BNC-${VERSION}-mac-arm64.dmg.blockmap" "$VPS:$VPS_DIR/" 2>/dev/null || true
fi
if [ -n "$MAC_X64" ]; then
    scp "$DIST/BNC-${VERSION}-mac-x64.dmg"   "$VPS:$VPS_DIR/"
fi
if [ -n "$MAC_YML" ]; then
    scp "$DIST/latest-mac.yml"                "$VPS:$VPS_DIR/"
fi

echo ""
echo "✅ Upload xong! Verify:"
ssh "$VPS" "ls -lh $VPS_DIR/"
echo ""
echo "🔗 latest.yml: https://yttool.vn/updates/latest.yml"
