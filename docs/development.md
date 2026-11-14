# Development

The app bundles the compiled server, client, Ruffle, game data and sound. Everything runs on this computer; the only network request is **Settings → Updates → Check for updates**, which the player clicks. The browser requires WebGL 2.

## Saves

The portable launcher passes `--user-data-dir=<folder>/player data`; the app refuses to start without it. Saves are in `player data/state/`, backups in `player data/backups/`. Electron caches, settings and diagnostics live in `server data/profile/`.

Every Play makes and verifies a full backup before the server opens the save. Import, account edits and restore also make a verified full backup first, through the bundled server's `--local-save` commands. Passwords stay salted Argon2 hashes and travel only through private stdin.

Close and **Save & stop** ask the server to drain through a private pipe. A failed shutdown blocks save actions until the launcher is reopened; the server's state lock prevents two servers using one save. Never delete `state/state.lock`.

## Build

Build on the target OS with Node 22.23.2 and the server's pinned Rust toolchain. Set `OPENROTMG_BUILD_INPUTS` to an absolute JSON file describing the pinned sources in `source-pins.json`:

```json
{
  "platform": "linux",
  "arch": "x64",
  "serverSource": "/absolute/server",
  "clientSource": "/absolute/client",
  "preparedClient": "/absolute/prepared-client",
  "serverBinary": "/absolute/openrotmg",
  "serverBinarySha256": "the actual 64-character lowercase SHA256",
  "serverBuildReceipt": "/absolute/server-artifact.json"
}
```

On GitHub Actions, `node scripts/ci-inputs.mjs` clones and builds these. Then:

```sh
npm ci
npm test
npm run make   # out/make/openrotmg-singleplayer-VERSION-TARGET.zip
```

Release steps and the end-to-end check are in [portable-zip.md](portable-zip.md).

AGPL-3.0-only launcher. See LICENSE and NOTICES.md for server, client, Ruffle, Electron and asset notices.
