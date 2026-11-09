# Development

This is an unreleased source preview. The package bundles the compiled server, client, Ruffle, game data and sound. The browser requires WebGL 2; unavailable graphics produce an explicit error. No sandbox or GPU-blocklist bypass flags are shipped.

## Saves and shutdown

Packaged builds run from the portable ZIP: the `OpenRotMG Singleplayer` launcher passes `--user-data-dir=<ZIP folder>/player data`, and the packaged app refuses to start without it. Saves are in that userData `state/` directory. Detailed logs are in `diagnostics/`; the launcher shows the actual path. The server uses loopback port 47831 and reports a conflict without stopping its owner.

Stop and Close/Quit request durable shutdown through a private pipe. A launcher crash also closes that pipe so the server can drain. Failed shutdowns are not save success: the launcher blocks mutation and records `shutdown-failed.json`. If that record cannot be written, it keeps ownership and shows the error. Preserve the save and diagnostics for investigation. Never delete `state/state.lock` to override a running server.

Options imports a credential-free player export with a new local password. Import/restore stop the server and validate privately staged input through the bundled server's `--local-save` authority. Replacements and restores require a verified full pre-operation backup. Full local snapshots in `userData/backups/` include all accounts and original local credentials, not downloaded assets, logs or control files. Manual snapshots accumulate without automatic deletion. Keep backups private.

## Native builds and tests

Build tools: Node 22.23.2/npm and the repository-pinned Rust toolchain for the server. Electron 45.2.1, Forge 8.0.1, TypeScript 5.9.3 and Playwright 1.64.1 are locked dependencies. Build on the target OS and architecture.

The manual `Native Phase 1 package tests` workflow builds the exact `source-pins.json` inputs. Preview pins explicitly name reviewed contributor forks; official upstream pins and fresh validation are required before a consumer release. There is no implicit origin substitution.

For a local build, prepare the pinned clean sources, verified client assets and native server. Set `OPENROTMG_BUILD_INPUTS` to an absolute JSON file with these fields:

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

The receipt identifies the exact server `head`, `dirty:false` and binary `sha256`. The build verifies these identities and the pinned asset trees rather than substituting missing inputs.

```sh
npm ci
npm run package
```

Retain the entire `out/Open RotMG Single Player-PLATFORM-ARCH/` directory, including Electron licenses and runtime notices. `npm run package:test` drives the packaged launcher and actual game, including inventory mutation, restart, connected-parent crash and failure cases. Its explicit managed-browser and dedicated-CI modes are test infrastructure, not consumer capabilities. Receipts and screenshots stay in ignored `.qa/` output.

The focused Linux save-controls gate is `npm run test:e2e -- --project=desktop`, after packaging the clean pinned generation. It requires explicit `OPENROTMG_BUILD_INPUTS`, an actual Phase 3 download in `OPENROTMG_SAVE_FIXTURE` with `OPENROTMG_SAVE_FIXTURE_SHA256`, a short owned on-disk `OPENROTMG_TEST_TMP_ROOT`, and the managed-browser environment described by `scripts/native-game.mjs`. Native dialog selections are declared only by the attached test process; there is no shipped renderer path override. This gate does not qualify other OSes, default-browser routing or installers.

## Validation limits

Native packaged gameplay and save persistence have passed on Ubuntu x64, Windows x64 and Apple Silicon macOS. Windows also has a passing application-scoped offline journey. These results cover different source revisions and test scopes, not an all-platform pass of the current head.

Actual OS-default-browser routing, Intel Mac gameplay, Mac offline enforcement and clean-machine installers remain unqualified. Signing/notarization and distribution checks are also unfinished. There is no consumer release.

AGPL-3.0-only launcher. See LICENSE and NOTICES.md for server, client, Ruffle, Electron and asset notices.
