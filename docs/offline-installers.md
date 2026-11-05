# Offline installer delivery

The manual `offline-installers.yml` workflow consumes an **existing parent-promoted signed runtime**. It does not compile the server/client, sign anything, create a release or upload release assets. Parent review/promotion/publication remains separate. No production signed assets existed when this seam was authored; native installer acceptance is not claimed by unit tests.

Select a dispatch ref matching `installer_sha` (full reviewed Git SHA), and supply the exact `runtime_head`, `runtime_native_run`, `runtime_promotion_run`, and existing fixed `tag`. Both runtime runs must be successful trusted-main runs at that runtime SHA. The promotion receipt must identify that native run. The embedded production Ed25519 key verifies the downloaded target manifest; the exact tested archive digest/size must match the signed metadata and promotion receipt. Existing `build.mjs` `runtimeRelease` verification/extraction is reused unchanged. No configurable signing key/origin or source-build fallback is provided.

Required native targets:

- Ubuntu 22.04 x64: Forge ZIP containing Electron and full runtime. Extract to a chosen directory and run `openrotmg-single-player`. Desktop libraries required by Electron must be present; this is not a claim of support for every Linux distribution. Build/check runs on the oldest supported Ubuntu baseline.
- Windows x64: Forge WiX MSI, per-user by default, stable upgrade code. WiX 3.14.1.8722 is checked on the standard Windows 2022 hosted image. No auto-update, auto-launch or installer-triggered game start is enabled; MSI does not require Squirrel application-event handling. Close the game/launcher before repair or upgrade.
- Apple Silicon macOS: Forge DMG. Copy the application out of the mounted image into a chosen application directory. Close it before replacing it.

**OS installers are unsigned.** No Authenticode signing, notarization, Gatekeeper/SmartScreen bypass or quarantine removal is performed. Runtime manifest authentication is not an OS signature. Follow normal OS security prompts/policies; a protected downloaded installation may require later signing before it is usable on a particular machine.

The app's existing stable `Open RotMG Single Player` userData location is independent of installation. Reinstall/upgrade must not delete it. No compiler, Node, Python, Rust or Ruffle download is required by the installed app. Test tooling is installed only on the hosted verification runner.

Each Actions artifact contains the MSI/DMG/ZIP, `SHA256SUMS`, launcher corresponding source, exact pinned server/client source archives (including the client's pinned Ruffle build/patch provenance), licenses/notices, signed runtime metadata/signature, and `installer-receipt.json`. The receipt distinguishes actual installer source HEAD from the promoted runtime source HEAD/native run/promotion run/archive identity. Electron's bundled licenses and runtime notices remain inside the installation. The existing game-art/audio/SWF rights caveat in `NOTICES.md` remains; these archives do not grant new redistribution rights or replace parent source-obligation review.

## Bounded installed native check

From the same clean installer source HEAD with `npm ci` and compiled test tools (`npm test`), run:

```
npm run verify:release -- /absolute/path/to/openrotmg-VERSION-TARGET.msi
```

Use the native `.dmg` or `.zip` on the other targets. Keep adjacent `installer-receipt.json`. Linux requires Xvfb, xauth, dbus-run-session, unzip and an explicit short owned on-disk `OPENROTMG_TEST_TMP_ROOT`; the command creates its own private display/bus. Non-Linux installation checks require an owned standard hosted runner. Select the existing explicit CI browser mode; the workflow installs its owned Chromium. Only the approved `--ignore-gpu-blocklist` QA flag is permitted.

The check installs/extracts the actual artifact, verifies its SHA, embedded signed positive baseline and runtime pins, protects the installed directory against writes, removes developer tools from the consumer PATH, and uses existing native game/renderer save controls for synthetic export/import, real inventory progress, Stop, full backup/restore, active-game Close, cold reopen and same-version reinstall/repair with the identical persistent profile. Process image/hash and actual child health are recorded. It writes **`installer-result.json`**, never an extra native-promoter `result.json`.

Scope limits are recorded in that receipt: controlled update-service HTTP 503 and browser request interception, not OS-global offline; explicit chooser/confirmation fixtures, not manual chooser usability; Chromium, not default-browser/Safari/Edge inventory; hosted runner user, not a clean standard-user machine; same-version reinstall, not a separately built newer-version upgrade. Downloaded quarantine/SmartScreen behavior and hardware graphics remain unqualified. No OS network/security settings are changed. Passing one target is not all-platform acceptance or publication approval.

The pinned Forge DMG build dependency currently pulls `image-size@0.7.5`, affected by GHSA-w3rx-r6r6-pgpr (ICNS parser DoS). This is build-only tooling reading the packaged Electron icon, not an installed app dependency or untrusted user icon input. No vulnerable-parser fix is claimed; retain this limitation in review of the native maker run.
