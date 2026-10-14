# ZenPlay desktop packaging

ZenPlay uses `com.zenplay.app` as its public Electron application identifier
and `ZenPlay` as the product and installer name on Windows and macOS.

The internal package, desktop and executable names remain `iptvnator`. This is
intentional: those names are implementation details used by existing profile
paths and packaging contracts, and changing them together with the visible
brand risks losing user data or breaking native runtime validation.

## Windows package

Windows is released as one NSIS installer for `x64`:
`ZenPlay-<version>-windows-x64-setup.exe`. A portable build and 32-bit `ia32`
build are intentionally not part of the release contract. Keeping one native
architecture also matches the bundled Embedded MPV runtime and prevents an
installer from being labelled for an architecture its native modules do not
support.

The installer uses the dedicated multi-resolution
`apps/web/src/assets/branding/zenplay.ico`. Regenerate it from the checked-in
ZenPlay artwork with:

```powershell
node tools/packaging/generate-zenplay-windows-icon.mjs
```

Embedded MPV/curl on Windows receives a pinned Mozilla CA bundle under
`resources/certs/cacert.pem`. Its dated curl source, SHA-256 digest,
certificate count, MPL-2.0 license and notice live in `vendor/certs`. Package
verification fails if any packaged certificate resource is missing or differs
from the pinned source. Do not work around certificate errors by disabling TLS
verification.

The GitHub **Build and Make Electron App** workflow is the canonical Windows
build because it stages and verifies the checksum-pinned native MPV runtime.
For a prepared local checkout with that runtime already staged, the final
commands are:

```powershell
$env:IPTVNATOR_EMBEDDED_MPV_PLATFORM = 'win32'
$env:IPTVNATOR_EMBEDDED_MPV_ARCH = 'x64'
$env:IPTVNATOR_REQUIRE_EMBEDDED_MPV = '1'
pnpm run build:backend
pnpm run make:app -- --publishPolicy=never
pnpm run verify:package-layout -- windows x64
```

The output includes `latest.yml` and a blockmap for `electron-updater`, but
`--publishPolicy=never` prevents a build from uploading anything. A public
release still requires the dedicated GitHub repository and Windows code
signing; unsigned installers can trigger Microsoft Defender SmartScreen.

## Release configuration still required

Do not distribute a packaged ZenPlay desktop build until all of these are
complete:

1. Create and confirm `alpoxggn-lang/zenplay-desktop` and, if the nightly
   channel is retained, `alpoxggn-lang/zenplay-desktop-nightly`. These names
   are currently safe pending destinations that may return 404. Customer
   update repositories must be public: shipping a GitHub token inside the app
   to access private releases would expose that credential.
2. Confirm that the configured GitHub `publish` destination,
   `alpoxggn-lang/zenplay-desktop`, exists and is controlled by ZenPlay. Normal
   builds use `--publishPolicy=never`; the entry generates updater metadata but
   never authorizes direct uploads to the upstream IPTVnator repository.
3. Run the updater and package identity tests, then verify an installed build
   never contacts or offers an IPTVnator release.
4. Review the 1254×1254 ZenPlay PNG in a packaged macOS build. Electron Builder
   accepts this high-resolution square source and converts it to ICNS, so a
   separately checked-in `.icns` is optional; no upstream IPTVnator icon is
   used.

Windows code signing and Apple signing/notarization are distribution steps,
not part of this metadata change. Unsigned development artifacts must not be
presented as production installers.

## macOS build matrix

The macOS workflow builds two native variants:

| Mac | Architecture | Artifacts |
| --- | --- | --- |
| Intel | `x64` | `ZenPlay-<version>-mac-x64.dmg` and `.zip` |
| Apple Silicon | `arm64` | `ZenPlay-<version>-mac-arm64.dmg` and `.zip` |

CI uses the architecture-explicit `macos-15-intel` runner and the Apple
Silicon `macos-15` runner. ZenPlay currently uses Electron 43, so the packaged
application supports macOS 12 Monterey or newer; the Embedded MPV runtime's
lower deployment target does not lower Electron's own operating-system floor.
[GitHub has announced](https://github.com/actions/runner-images/issues/13045)
that its hosted Intel image is available only through August 2027, so continued
Intel releases after that date require a replacement x64 runner or an updated
build strategy.

The ZIP files are required by `electron-updater`; the DMG files are the normal
manual installers. CI merges both architecture entries into one
`latest-mac.yml`, so the updater selects the matching ZIP. Keep both matrix
jobs and both ZIP artifacts in every public release.

Do not add an Electron `universal` target yet. The app bundles an architecture-
specific native addon and Embedded MPV runtime. A universal Electron shell
without universal versions of every native binary can install successfully and
then fail during playback. Separate Intel and Apple Silicon packages are the
supported release shape until the complete native dependency graph is merged
and validated with `lipo`.

## Unsigned test builds

A manual **Build and Make Electron App** run defaults `sign_macos` to `false`.
That path disables code signing, notarization, and the hardened runtime only
for the manual test run, builds the matching Embedded MPV runtime, and uploads
DMG/ZIP artifacts for both architectures. Pull-request builds use the same
unsigned policy. Hardened runtime is kept off because electron-builder warns
that it can prevent an unsigned app from launching. These artifacts are
suitable for engineering tests, but Gatekeeper can warn or block them and they
must not be sent to customers as production installers.

Tag and `master` builds stay fail-closed: they require signing and notarization.
A manual run can exercise the same production path by setting `sign_macos` to
`true`.

## Apple distribution credentials

Public macOS installers require Apple Developer Program credentials configured
in the GitHub repository:

- repository variable `CSC_NAME` with the exact Developer ID Application
  identity;
- secrets `CSC_LINK` and `CSC_KEY_PASSWORD` for its exported certificate;
- either App Store Connect API-key secrets `APPLE_API_KEY`,
  `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`;
- or Apple-ID notarization secrets `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.

CI rejects partial credential sets, ad-hoc signatures, missing Team IDs,
Gatekeeper rejection, and missing notarization staples. The Apple Developer
Program and certificate/notarization setup are external prerequisites; the
repository can create unsigned test artifacts without them, but it cannot
create customer-ready macOS installers.
