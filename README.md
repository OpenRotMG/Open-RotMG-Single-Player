![Single-player launcher with Start Client and durable Stop Server controls](https://github.com/user-attachments/assets/ecde49cc-9132-46a3-8252-d543e5cd1928)

# Open RotMG Single Player

An unreleased source preview of the offline launcher. It currently provides Start/Stop Server, Start Client in the default browser, status and logs. Live-account transfer, import, backup controls and runtime updates are not implemented yet.

The package bundles the compiled server, client, Ruffle, game data and sound. Players do not need to install Rust, Python or Node. The browser needs WebGL 2; unavailable graphics produce an explicit error. No sandbox or GPU-blocklist bypass flags are shipped.

## Saves and shutdown

Saves are outside the installation, in Electron's userData `state/` directory. Detailed logs are in `diagnostics/`; the launcher shows the actual path. The server uses loopback port 47831 and reports a conflict without stopping its owner.

Stop and Close/Quit request durable shutdown through a private pipe. A launcher crash also closes that pipe so the server can drain. Failed shutdowns are not save success: the launcher blocks mutation and records `shutdown-failed.json`. If that record cannot be written, it keeps ownership and shows the error. Preserve the save and diagnostics for investigation. Never delete `state/state.lock` to override a running server.

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

## Acceptance limits

Local Debian 13 x64 package journeys passed with real gameplay and persisted inventory changes. Ubuntu 22.04, Windows x64 and macOS 15 Intel/ARM64 native jobs still need acceptance. Chromium testing does not establish Edge/Safari or default-browser behavior. OS-wide offline isolation, clean-machine installers, signing/notarization and asset/source distribution checks remain open. No consumer release or all-platform support is claimed.

AGPL-3.0-only launcher. See LICENSE and NOTICES.md for server, client, Ruffle, Electron and asset notices.
