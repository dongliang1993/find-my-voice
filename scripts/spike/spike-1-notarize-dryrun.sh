#!/bin/zsh
# Step 1: notarization dry-run of the desktop bundle, node_modules layout.
#
# The sidecar is NOT a compiled single executable: it is the existing server
# (dist/server) plus its node_modules, started by the user's own node/bun.
# Nothing of ours in the bundle is a Mach-O binary — every executable in
# Contents/MacOS is either the Tauri shell or Anthropic's signed claude.
#
# Judgement (fixed, do not reinterpret at run time):
#   PASS  notarytool Accepted, then stapler + spctl --assess both green
#   FAIL  anything else — read `notarytool log <submission-id>`; the log
#         names the file and the reason, which decides the next move:
#           - the claude binary rejected → bundling is dead for this SDK
#             version; first-launch download becomes the main line
#           - layout rejected → adjust, resubmit
#
# Required environment (this script refuses to run without them):
#   SPIKE_IDENTITY  "Developer ID Application: <name> (<TEAMID>)" from
#                   `security find-identity -v -p codesigning`
#   The keychain profile "fv-notary" created once by hand:
#     xcrun notarytool store-credentials "fv-notary" \
#       --apple-id <email> --team-id <TEAMID> --password <app-specific-password>

set -e
cd "$(dirname "$0")/../.."

: "${SPIKE_IDENTITY:?Set SPIKE_IDENTITY from security find-identity -v -p codesigning}"
APP_DIR="${SPIKE_APP_DIR:-$PWD/releases/spike}/FindVoiceSpike.app"
KEYCHAIN_PROFILE="fv-notary"

echo "[spike-1] identity: $SPIKE_IDENTITY"
echo "[spike-1] bundle:   $APP_DIR"

# --- inputs -------------------------------------------------------------
CLAUDE="node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"
[[ -x "$CLAUDE" ]] || { echo "[spike-1] FAIL: claude binary missing"; exit 1; }

# --- bundle layout: node_modules sidecar, user-supplied runtime ----------
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS/server" "$APP_DIR/Contents/Resources"

# 1) the server: dist/ + node_modules, byte for byte, nothing compiled
cp -R dist/server        "$APP_DIR/Contents/MacOS/server/dist"
cp -R node_modules       "$APP_DIR/Contents/MacOS/server/node_modules"

# 2) the launcher: a text script, exec'd by the user's node — NOT a binary
cat > "$APP_DIR/Contents/MacOS/server/run.sh" <<'EOF'
#!/bin/sh
# The runtime is the user's own node or bun; the app ships none.
exec "$(command -v node || command -v bun)" "$(dirname "$0")/dist/index.js" "$@"
EOF
chmod +x "$APP_DIR/Contents/MacOS/server/run.sh"

# 3) the claude binary: byte-identical, Anthropic's signature left alone
mkdir -p "$APP_DIR/Contents/MacOS/server/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64"
cp "$CLAUDE" "$APP_DIR/Contents/MacOS/server/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"

# --- Info.plist ---------------------------------------------------------
cat > "$APP_DIR/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key><string>FindVoiceSpike</string>
	<key>CFBundleIdentifier</key><string>com.findmyvoice.spike</string>
	<key>CFBundleName</key><string>FindVoiceSpike</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>0.0.1</string>
</dict>
</plist>
EOF

# --- the one Mach-O that is ours: the placeholder shell -----------------
# A real build signs the compiled Tauri shell; for the dry-run a tiny
# signed placeholder stands in so the mixed-signature case is real.
 Placeholder="${SPIKE_APP_DIR:-$PWD/releases/spike}/placeholder-shell"
 [[ -x "$Placeholder" ]] || { echo "[spike-1] FAIL: build a placeholder shell first (any signed Mach-O)"; exit 1; }
codesign --force --sign "$SPIKE_IDENTITY" --options runtime "$Placeholder"
cp "$Placeholder" "$APP_DIR/Contents/MacOS/FindVoiceSpike"

# --- sign the bundle ----------------------------------------------------
codesign --force --sign "$SPIKE_IDENTITY" --options runtime "$APP_DIR"

echo "[spike-1] signatures inside the bundle:"
for f in "$APP_DIR/Contents/MacOS/FindVoiceSpike" \
         "$APP_DIR/Contents/MacOS/server/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude" \
         "$APP_DIR"; do
  codesign -dvv "$f" 2>&1 | grep -E "^Authority=|^TeamIdentifier=" | sed "s|^|$f : |"
done

# --- notarize -----------------------------------------------------------
ditto -c -k --keepParent "$APP_DIR" FindVoiceSpike.zip
xcrun notarytool submit FindVoiceSpike.zip --keychain-profile "$KEYCHAIN_PROFILE" --wait
xcrun stapler staple "$APP_DIR"
spctl --assess --type execute -vv "$APP_DIR"
echo "[spike-1] PASS — notarized, stapled, Gatekeeper-assessed"
