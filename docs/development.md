# Development

The ZIP bundles the server, client and Ruffle; only Settings → Updates uses the network. Saves live in `player data/`, the app in `server data/`. Play, import, account edits and restore back up the save first. Never delete `state/state.lock`.

## Build

Build on the target OS. `OPENROTMG_BUILD_INPUTS` names a JSON file with the pinned sources (`node scripts/ci-inputs.mjs` makes it in CI), then `npm ci && npm test && npm run make`.

## Release

1. Bump the version in `package.json`, `package-lock.json` and `launcher/Cargo.*`; merge.
2. Run `offline-installers.yml` on main. It builds and plays each ZIP (Linux with no network) and updates to it from 1.0.0.
3. Upload each ZIP, `launcher-TARGET.tar.gz`, `server-TARGET.tar.gz` and sources to a draft release whose body has `LAUNCHER_VERSION=X.Y.Z`, run `promote-launcher.yml` (signs launcher and server metadata), then publish with `make_latest:false` so pre-1.0.3 launchers still find the v1.0.2 server.

Each release carries both updates; players can take Server + client without updating the launcher. A server that needs a newer launcher raises `serverMinLauncher` in `source-pins.json`.
