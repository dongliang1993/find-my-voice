# Spike: can this app ship as a desktop bundle?

One question, already narrowed three times:

1. ~~Tauri or Electron?~~ Either way the bundle carries the 262 MB Anthropic
   claude binary, so the framework is not the deciding factor.
2. ~~Can the SDK spawn from a compiled single executable?~~ Moot: the sidecar
   is not a compiled binary. The server ships as `dist/` + `node_modules`,
   started by the user's own node or bun. Nothing of ours is a Mach-O.
3. **Will notarization accept a bundle whose executables are signed by two
   different teams — ours (the Tauri shell) and Anthropic's (the claude
   binary, Developer ID, hardened runtime, security timestamp)?**

Everything below serves question 3.

## Settled (do not re-litigate)

- The SDK ships a native claude binary per platform and spawns it directly;
  it never goes through the host interpreter. Explicit-path spawn works
  (`pathToClaudeCodeExecutable` is the official escape hatch) — proven by
  `spike-0-spawn-check.mjs`, which now PASSes with the corrected judgement
  (a `system:init` message arriving is itself the proof of spawn + exec).
- The public SDK wrapper does no checksum verification of that binary
  (`grep -c checksum` is 0 across the wrapper; every `createHash` site is
  session-key derivation; `manifestSignatureEnforcement: "flag"` means
  flagged, not enforced).
- The claude binary is Developer-ID-signed by Anthropic (team `Q6L2SF6YDW`)
  with hardened runtime and a security timestamp. We never re-sign it,
  never modify it, and copy it byte-identical.
- The runtime is the **user's own node or bun** — the app ships none. This
  kills the entire SEA/Bun-compile line: no JIT entitlements of ours, no
  `node:sqlite` compatibility question, no `executable: 'bun'` escape hatch
  to research. The `entitlements-sidecar.plist` from the old single-file
  plan is obsolete.
- Node 22, Rust 1.90 and Xcode's `notarytool`/`stapler` are on this
  machine; only `tauri-cli` is missing (`cargo install tauri-cli`).

## Scripts

### `spike-0-spawn-check.mjs` — explicit-path spawn (settled: PASS)

    npx tsx scripts/spike/spike-0-spawn-check.mjs [path-to-claude]

PASS: `system:init` arrives (that message cannot exist without a live
child). FAIL: no init; the printed wrapper error names the refusing layer.
Never re-run with `extraArgs: { version: null }` as a "no-billing" probe —
the wrapper never spawns on that path, so it silently tests nothing
(learned the hard way, kept in the script header).

### `spike-1-notarize-dryrun.sh` — the open question

Builds the real bundle layout — `dist/` + `node_modules` + a text
`run.sh` (user's runtime) + the byte-identical Anthropic binary + one
placeholder Mach-O shell of ours — signs it, submits it.

    SPIKE_IDENTITY="Developer ID Application: <name> (<TEAMID>)" \
      zsh scripts/spike/spike-1-notarize-dryrun.sh

Blocked on three inputs, all outside this repo:

- the keychain profile `fv-notary` (App-specific password, team id),
- the identity string from `security find-identity -v -p codesigning`,
- a placeholder signed Mach-O for the shell slot (a real `tauri build`
  output once `tauri-cli` is installed; any small signed binary does for
  the dry-run).

PASS: notarytool Accepted + stapler + spctl all green. FAIL: read
`xcrun notarytool log <submission-id>` — the log names the file and the
reason:

- claude binary rejected → bundling is dead for this SDK version; the
  first-launch-download route (the app downloads the binary itself;
  self-downloaded files carry no quarantine attribute) becomes the main
  line;
- layout rejected → adjust, resubmit.

## After (and only after) spike-1 passes

A clean-machine check: download the notarized artifact **with a browser**
(that is what attaches the quarantine attribute), double-click, confirm the
server starts under the user's node and `spike-0` PASSes from inside the
bundle. The dev machine cannot test this — its binaries carry no
quarantine.

## Open questions with owners

- **Legal**: redistributing Anthropic's 262 MB binary inside our bundle.
  The local LICENSE.md is one line ("All rights reserved", terms at an
  external URL). The answer must exist before any release date; it also
  decides bundling vs first-launch-download, so it outranks this spike's
  remaining engineering work. Not a blocker for the dry-run.
- **tauri-cli**: not installed; `cargo install tauri-cli` takes a while
  and blocks only the *real* shell build, not the dry-run (any signed
  placeholder Mach-O stands in).
