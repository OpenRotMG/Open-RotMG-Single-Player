# Portable ZIP

One ZIP per platform contains everything needed to play offline:

```text
OpenRotMG Singleplayer/
  OpenRotMG Singleplayer       # .exe on Windows: starts the app and handles updates
  README.txt                   # launcher/README.txt
  player data/                 # saves and backups (empty in the ZIP)
  server data/                 # the app with its bundled server, client and Ruffle
```

Binaries are unsigned. No Authenticode signing or notarization is performed.

## Release

1. Bump the version in `package.json`, `package-lock.json`, `launcher/Cargo.toml` and `launcher/Cargo.lock`, merge to main.
2. Run **Portable offline ZIPs** (`offline-installers.yml`) on main. Each target builds the pinned server and client, makes the ZIP and runs `scripts/verify-installer.mjs`. On Linux the whole check runs in a network namespace with no route out.
3. Create a draft `vX.Y.Z` release at that commit whose body has a `LAUNCHER_VERSION=X.Y.Z` line, upload each target's ZIP, `launcher-TARGET.tar.gz`, sources and checksums, then run **promote-launcher.yml** with the workflow run and draft IDs. It signs `launcher-TARGET.json`.
4. Publish. Never replace assets of a published version.

Releases older than 1.0.3 also downloaded a separate "Server + client" runtime from the latest release. Keep publishing with `make_latest:false` so those launchers' manual runtime check still resolves the last signed runtime; their launcher update finds new versions in the full release list.

## End-to-end check

```sh
OPENROTMG_LEGACY_ZIP=/abs/openrotmg-singleplayer-1.0.0-TARGET.zip \
  npm run verify:release -- /abs/openrotmg-singleplayer-VERSION-TARGET.zip
```

Keep the adjacent `installer-receipt.json`. Linux needs Xvfb, xauth, dbus-run-session, unzip and `OPENROTMG_TEST_TMP_ROOT`; `node scripts/offline-linux.mjs ZIP` runs it with no network.

The check extracts the ZIP into a Unicode path and starts it through the top-level launcher with all non-loopback requests refused. It plays the real game in Chromium, imports an exported account (with its pre-import backup), backs up, toggles bots, closes and reopens with the same progress. It then updates to a privately signed next version, and updates the published 1.0.0 launcher to this build, confirming the updated launcher manages accounts with its bundled server. It writes `installer-result.json` and screenshots.
