#!/bin/bash
# Deploy BNC Browser update lên GitHub Releases
# Cần: gh CLI đã login (gh auth login)
# Usage: ./deploy-update.sh [path-to-dist-folder]

set -e

DIST="${1:-./dist}"
REPO="vietnamairlineit-byte/bnc-release"
VERSION=$(node -e "console.log(require('./package.json').version)")
TAG="v${VERSION}"

echo "📦 Deploy BNC Browser ${TAG} → GitHub Releases"

# Kiểm tra gh CLI
if ! command -v gh &>/dev/null; then
    echo "❌ Cần cài gh CLI: https://cli.github.com"
    exit 1
fi

# Kiểm tra file Windows bắt buộc
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

# Gom file cần upload
FILES=("$WIN_EXE" "$WIN_YML")
[ -f "$DIST/BNC-${VERSION}-win-x64.exe.blockmap" ] && FILES+=("$DIST/BNC-${VERSION}-win-x64.exe.blockmap")
[ -f "$DIST/BNC-${VERSION}-win-arm64.exe" ]        && FILES+=("$DIST/BNC-${VERSION}-win-arm64.exe")
[ -f "$DIST/BNC-${VERSION}-win-arm64.exe.blockmap" ] && FILES+=("$DIST/BNC-${VERSION}-win-arm64.exe.blockmap")
[ -f "$DIST/latest-mac.yml" ]                       && FILES+=("$DIST/latest-mac.yml")
[ -f "$DIST/BNC-${VERSION}-mac-arm64.dmg" ]         && FILES+=("$DIST/BNC-${VERSION}-mac-arm64.dmg")
[ -f "$DIST/BNC-${VERSION}-mac-arm64.dmg.blockmap" ] && FILES+=("$DIST/BNC-${VERSION}-mac-arm64.dmg.blockmap")
[ -f "$DIST/BNC-${VERSION}-mac-x64.dmg" ]           && FILES+=("$DIST/BNC-${VERSION}-mac-x64.dmg")

echo "📤 Files sẽ upload:"
for f in "${FILES[@]}"; do
    echo "   $(basename $f) ($(du -sh $f | cut -f1))"
done
echo ""

# Tạo hoặc update release
if gh release view "$TAG" --repo "$REPO" &>/dev/null; then
    echo "♻️  Release ${TAG} đã tồn tại → upload/overwrite files..."
    gh release upload "$TAG" "${FILES[@]}" --repo "$REPO" --clobber
else
    echo "🚀 Tạo release mới ${TAG}..."
    gh release create "$TAG" "${FILES[@]}" \
        --title "BNC Browser ${TAG}" \
        --notes "Release ${TAG}" \
        --repo "$REPO"
fi

echo ""
echo "✅ Done!"
echo "🔗 Release:    https://github.com/${REPO}/releases/tag/${TAG}"
echo "🔗 latest.yml: https://github.com/${REPO}/releases/download/${TAG}/latest.yml"
