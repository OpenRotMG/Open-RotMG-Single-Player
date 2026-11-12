# Portable ZIP delivery

The manual `offline-installers.yml` workflow consumes an **existing parent-promoted signed runtime**. It does not compile the server/client, sign anything, create a release or upload release assets. Native acceptance is not claimed by unit tests.

Select a dispatch ref matching `installer_sha` (full reviewed Git SHA), and supply the exact `runtime_head`, `runtime_native_run`, `runtime_promotion_run`, and existing fixed `tag`. Both runtime runs must be successful trusted-main runs: the native run at `runtime_head`, and the promotion run at its separately recorded `validated.promotionHead`. The protected `runtime-draft-receipts` Actions artifact supplies the original signed manifest/raw signature, validated native receipt and historical draft snapshot; no live draft/release endpoint is queried. The embedded production Ed25519 key verifies those exact metadata bytes. The identical runtime archive comes only from the uniquely bound original native `runtime-update-OS` Actions artifact at `runtime-inputs/C/runtime-TARGET.tar.gz`; artifact ID/name/run/head/non-expiry are checked before and after download. Missing/expired/replaced inputs fail; no other transport or rebuild is attempted.

`npm run make` packages the app with Forge (no makers), builds the `launcher/` Rust program and writes `out/make/openrotmg-singleplayer-VERSION-PLATFORM-ARCH.zip`. The ZIP contains one `OpenRotMG Singleplayer` folder. Inside it:

- `OpenRotMG Singleplayer` (`.exe` on Windows): starts `server data`'s Electron app with `--user-data-dir=<game folder>/player data`, forwarding any other arguments. It execs on Linux/macOS and waits as the parent on Windows. Missing folders are reported, not guessed.
- `README.txt` (`launcher/README.txt`).
- `player data`: empty. Becomes the Electron userData: saves, backups, diagnostics and downloaded runtime generations. Moving it to a fresh extraction keeps everything.
- `server data`: initial Forge package under `baseline`, explicit launcher selection and native ownership lock; authenticated subsequent generations and handoff receipts remain here, never in the save database. The front door holds ownership through save/exit/activation/reopen. Its helper is copied outside the old application before the front door is replaced.

The packaged app refuses to start without `--user-data-dir`, so opening the inner executable cannot silently use an OS profile. Targets: Ubuntu 22.04 x64, Windows x64 and Apple Silicon macOS. The selected macOS launcher is a plain binary run in Terminal; downloaded quarantine behavior is not qualified.

**Binaries are unsigned.** No Authenticode signing, notarization or quarantine removal is performed. Runtime manifest authentication is not an OS signature.

Each Actions artifact contains the ZIP, `SHA256SUMS`, launcher corresponding source, exact pinned server/client source archives, licenses/notices, signed runtime metadata/signature, and `installer-receipt.json`. The existing game-art/audio/SWF rights caveat in `NOTICES.md` remains.

Settings has independent **Server + client** and **Launcher** checks. Runtime checks still use `releases/latest` and their existing signed paired manifests. Launcher **Update and reopen** verifies a purpose-bound Ed25519 descriptor and complete archive, stages a separate generation, then uses the existing durable game close before a native helper replaces the front door and selection. Renderer health confirms the exact operation/version/player-data path. Interrupted handoffs block Play until explicit Check launcher files; no automatic replay or rollback. Initial0.1.3-and-older users need one manual ZIP upgrade to acquire this feature. Windows refuses a generation image path longer than240 UTF-16 units before stopping the game; move the whole portable folder to a shorter local path rather than bypassing Chromium's process-launch limit.

Bump `package.json`/lock for each launcher release; create a new matching `vX.Y.Z` release, never replace a published version's ZIPs. Put `LAUNCHER_VERSION=X.Y.Z` on its own release-body line. A launcher-only release must use GitHub `make_latest:false` so old runtime-only checkers still resolve the latest signed runtime. A combined runtime/launcher release has both markers and all native-qualified signed runtime assets; only that release may become latest. Source changes alone are not published game updates.

Commit labels are verified reachable counts at pinned SHAs, retained offline; add a count when updating source pins. They are display labels, not identities. Signatures and checks always use full hashes. Schema23 runtimes declare exact reads `[21,22,23]`, write23 and minimum launcher0.1.1. Native acknowledgements must match the selected runtime's authenticated capability notice; older signed schema22 runtimes remain supported.

The browser game page is served on loopback port 47832 by the launcher. It supplies only presentation, forwarding the selected runtime's namespaced assets, ordinary account API and WebSocket to the existing server. Host and Origin must match the local game page; the upstream Origin stays the server's configured loopback origin. Runtime files, signatures, cache headers, save authority and server port 47831 are unchanged. Closing the launcher first drains the server, then closes the local game page listener. Port conflicts fail rather than selecting a hidden alternative.

## Bounded native check

From the same clean source HEAD with `npm ci` and `npm test`:

```
npm run verify:release -- /absolute/path/to/openrotmg-singleplayer-VERSION-TARGET.zip
```

Keep adjacent `installer-receipt.json`. Linux requires Xvfb, xauth, dbus-run-session, unzip and an explicit short owned on-disk `OPENROTMG_TEST_TMP_ROOT`. Non-Linux checks require an owned standard hosted runner.

The check extracts the actual ZIP with the platform tool (`unzip`, `ditto`, Windows `tar.exe`), requires one game folder containing exactly the four entries and an empty `player data`, verifies the embedded signed baseline and pins, protects `server data` against writes, and launches **through the top-level launcher**. It confirms userData is the extracted `player data`, then runs synthetic export/import, real inventory progress, Stop, full backup/restore, active-game Close and cold reopen. Finally it extracts a fresh copy, moves `player data` into it and replays the saved progress. It writes `installer-result.json`.

Recorded limits: normal-cache browser requests are uncontrolled; only update-service availability is controlled (HTTP 503), not OS-global offline; chooser/confirmation fixtures, not manual usability; Chromium, not default browsers; hosted runner user; the same build re-extracted, not a newer-version upgrade; no downloaded quarantine/Mark-of-the-Web, so Gatekeeper/SmartScreen prompts are unqualified.
