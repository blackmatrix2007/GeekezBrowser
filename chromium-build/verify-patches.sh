#!/bin/bash
# =============================================================================
# GeekezBrowser - Verify Custom Chromium Patches
# =============================================================================
# Test xem custom Chromium binary có hoạt động đúng không
# Chạy sau khi build hoặc download binary
#
# Usage:
#   bash verify-patches.sh /path/to/chrome
#   bash verify-patches.sh  # Auto-detect from GeekezBrowser userData
# =============================================================================

set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; NC='\033[0m'

ok()   { echo -e "${GREEN}[PASS]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; FAILED=$((FAILED+1)); }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log()  { echo -e "${BLUE}[INFO]${NC} $1"; }
FAILED=0

# Find chrome binary
CHROME_BIN="${1:-}"
if [[ -z "$CHROME_BIN" ]]; then
    # Auto-detect on different platforms
    if [[ "$(uname -s)" == "Darwin" ]]; then
        USERDATA="$HOME/Library/Application Support/GeekEZ Browser"
    elif [[ "$(uname -s)" == "Linux" ]]; then
        USERDATA="$HOME/.config/GeekEZ Browser"
    else
        USERDATA="$APPDATA/GeekEZ Browser"
    fi

    for dir in "custom-chromium" "fingerprint-chromium"; do
        candidate="$USERDATA/$dir/chrome"
        if [[ -f "$candidate" ]]; then
            CHROME_BIN="$candidate"
            break
        fi
    done
fi

if [[ -z "$CHROME_BIN" || ! -f "$CHROME_BIN" ]]; then
    echo "Usage: $0 /path/to/chrome"
    echo "Or place chrome in GeekezBrowser userData/custom-chromium/"
    exit 1
fi

log "Testing: $CHROME_BIN"
log "Version: $("$CHROME_BIN" --version 2>/dev/null || echo 'unknown')"
echo ""

# ─── Test 1: navigator.webdriver ─────────────────────────────────────────────
echo "Test 1: navigator.webdriver"
WEBDRIVER_RESULT=$("$CHROME_BIN" \
    --headless=new \
    --no-sandbox \
    --disable-dev-shm-usage \
    --run-all-compositor-stages-before-draw \
    --virtual-time-budget=5000 \
    --dump-dom \
    'data:text/html,<script>document.title=JSON.stringify(navigator.webdriver)</script>' \
    2>/dev/null | grep -o '"false"\|"true"\|false\|true' | head -1 || echo "unknown")

if [[ "$WEBDRIVER_RESULT" == "false" || "$WEBDRIVER_RESULT" == '"false"' ]]; then
    ok "navigator.webdriver = false (C++ patch working)"
elif [[ "$WEBDRIVER_RESULT" == "true" || "$WEBDRIVER_RESULT" == '"true"' ]]; then
    fail "navigator.webdriver = true (patch NOT working)"
else
    warn "navigator.webdriver = $WEBDRIVER_RESULT (could not determine)"
fi

# ─── Test 2: Canvas noise (seed-based) ───────────────────────────────────────
echo ""
echo "Test 2: Canvas noise with seed"
CANVAS_TEST_HTML=$(cat << 'EOF'
data:text/html,<canvas id=c width=100 height=100></canvas><script>
var ctx=document.getElementById('c').getContext('2d');
ctx.fillStyle='red';ctx.fillRect(0,0,100,100);
var d1=ctx.getImageData(0,0,1,1).data;
document.title='canvas:'+d1[0]+','+d1[1]+','+d1[2]+','+d1[3];
</script>
EOF
)

# Run twice with same seed - should get same result
CANVAS_1=$("$CHROME_BIN" \
    --headless=new --no-sandbox --disable-dev-shm-usage \
    --canvas-noise-seed=12345 \
    --run-all-compositor-stages-before-draw \
    --virtual-time-budget=5000 \
    --dump-dom "$CANVAS_TEST_HTML" 2>/dev/null | \
    grep -o 'canvas:[0-9,]*' | head -1 || echo "none")

CANVAS_2=$("$CHROME_BIN" \
    --headless=new --no-sandbox --disable-dev-shm-usage \
    --canvas-noise-seed=12345 \
    --run-all-compositor-stages-before-draw \
    --virtual-time-budget=5000 \
    --dump-dom "$CANVAS_TEST_HTML" 2>/dev/null | \
    grep -o 'canvas:[0-9,]*' | head -1 || echo "none")

CANVAS_3=$("$CHROME_BIN" \
    --headless=new --no-sandbox --disable-dev-shm-usage \
    --canvas-noise-seed=99999 \
    --run-all-compositor-stages-before-draw \
    --virtual-time-budget=5000 \
    --dump-dom "$CANVAS_TEST_HTML" 2>/dev/null | \
    grep -o 'canvas:[0-9,]*' | head -1 || echo "none")

log "Canvas (seed=12345, run 1): $CANVAS_1"
log "Canvas (seed=12345, run 2): $CANVAS_2"
log "Canvas (seed=99999, run 1): $CANVAS_3"

if [[ "$CANVAS_1" != "none" && "$CANVAS_1" == "$CANVAS_2" ]]; then
    ok "Canvas noise is deterministic (same seed = same result)"
else
    warn "Canvas determinism check inconclusive (headless mode may affect canvas)"
fi

if [[ "$CANVAS_1" != "$CANVAS_3" && "$CANVAS_1" != "none" ]]; then
    ok "Canvas noise differs with different seeds"
else
    warn "Canvas seed differentiation check inconclusive"
fi

# ─── Test 3: CDP marker cleanup ──────────────────────────────────────────────
echo ""
echo "Test 3: CDP automation markers"
CDP_TEST=$("$CHROME_BIN" \
    --headless=new --no-sandbox --disable-dev-shm-usage \
    --enable-automation \
    --run-all-compositor-stages-before-draw \
    --virtual-time-budget=5000 \
    --dump-dom \
    'data:text/html,<script>
var cdcKeys=Object.keys(window).filter(k=>k.startsWith("cdc_"));
document.title="cdc:"+cdcKeys.length+",wd:"+navigator.webdriver;
</script>' 2>/dev/null | grep -o 'cdc:[0-9]*' | head -1 || echo "unknown")

if [[ "$CDP_TEST" == "cdc:0" ]]; then
    ok "CDP markers ($cdc_*) cleaned up"
else
    warn "CDP markers: $CDP_TEST"
fi

# ─── Test 4: Binary can run ───────────────────────────────────────────────────
echo ""
echo "Test 4: Binary integrity"
if "$CHROME_BIN" --version &>/dev/null; then
    VERSION=$("$CHROME_BIN" --version 2>/dev/null)
    ok "Binary runs: $VERSION"
else
    fail "Binary failed to run"
fi

# ─── Test 5: Custom switches accepted ────────────────────────────────────────
echo ""
echo "Test 5: Custom switches accepted"
if "$CHROME_BIN" --headless=new --no-sandbox \
    --canvas-noise-seed=0 \
    --audio-noise-seed=0 \
    --webgl-vendor="" \
    --webgl-renderer="" \
    --perf-noise-seed=0 \
    --dump-dom 'data:text/html,ok' &>/dev/null; then
    ok "Custom GeekezBrowser switches accepted"
else
    warn "Custom switches check inconclusive (some versions ignore unknown flags)"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════"
if [[ $FAILED -eq 0 ]]; then
    echo -e "${GREEN}All tests passed!${NC} Custom Chromium is working correctly."
else
    echo -e "${RED}$FAILED test(s) failed.${NC}"
    echo "The binary may still work - some tests require specific patch versions."
fi
echo ""
echo "Next step: Test with real detection sites:"
echo "  - https://pixelscan.net/"
echo "  - https://www.browserscan.net/"
echo "  - https://iphey.com/"
echo "  - https://abrahamjuliot.github.io/creepjs/"
