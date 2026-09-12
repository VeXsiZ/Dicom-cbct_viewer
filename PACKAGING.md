# CBCT Viewer — packaging guide

This fork wraps the OHIF viewer into three installable apps that all run the
same code:

| Platform | Output | Wrapper |
|---|---|---|
| Android | `CBCT-Viewer.apk` | Capacitor |
| Windows | `CBCT-Viewer-Setup.exe` | Tauri (uses the built-in WebView2) |
| iPhone | `CBCT-Viewer.ipa` | Capacitor |

> **Not a certified medical device.** This build has not been cleared by the FDA,
> under EU MDR, or by any other regulator, and the quality presets below
> deliberately reduce image fidelity to fit constrained hardware. Do not use it
> as the sole basis for diagnosis or treatment planning.

---

## Building

Each platform has its own workflow, so they run independently — if the Android
build breaks, Windows and iOS are unaffected.

1. Open the repository on GitHub → **Actions** tab
2. Pick the workflow you want in the left sidebar:
   - **Build Android APK**
   - **Build Windows Installer**
   - **Build iOS App**
3. Press **Run workflow** → **Run workflow**

Everything runs on GitHub's servers, so no PC is needed. Android and Windows
need no setup at all. When a run finishes the file appears in two places:

- **Releases** — tagged `android-<n>`, `windows-<n>` or `ios-<n>`
- **Actions → the run → Artifacts**

Both are downloadable directly from a phone browser.

Each workflow builds the viewer bundle itself (via the shared `_build-web`
reusable workflow) and then wraps it. That means the bundle is built once per
platform rather than once in total — the cost of keeping the three fully
isolated from each other. A run takes roughly 15–30 minutes, most of it the
bundle.

`_build-web.yml` is a building block, not something to run on its own; it has
no "Run workflow" button.

### A note on the inherited OHIF workflows

The fork arrived with upstream OHIF's own CI. `build-docs.yml` ran on every
push and always failed here — it tries to deploy to OHIF's documentation site
and looks for a merged pull request that a fork does not have. It has been
removed. CodeQL's weekly cron was switched to manual-only, and Playwright only
runs on pull requests. Nothing now triggers automatically on push.

## Installing

**Android.** Download the `.apk`, allow "install unknown apps" for your browser
when prompted, then tap the file. Without a signing keystore configured the APK
is debug-signed — that installs fine by sideloading, it just cannot be published
to the Play Store.

**Windows.** Run `CBCT-Viewer-Setup.exe`. It installs for the current user, so no
administrator rights are needed. SmartScreen will warn about an unknown
publisher because the installer is not code-signed; choose "More info" → "Run
anyway".

**iPhone.** See the two options below.

## iOS signing — the two paths

Both are supported, chosen by the **signing** dropdown when you start the
**Build iOS App** workflow.

### `unsigned` — free Apple ID

CI produces `CBCT-Viewer-unsigned.ipa`. It is *not* installable as-is; you sign
it yourself with [SideStore](https://sidestore.io),
[AltStore](https://altstore.io) or Sideloadly using your ordinary Apple ID. No
secrets, no yearly fee. The catch is Apple's: a free-account signature lasts
**7 days**, after which the app stops launching until it is re-signed. SideStore
can refresh it over Wi-Fi automatically, which makes this bearable but not
maintenance-free.

### `signed` — paid Apple Developer account ($99/year)

CI produces a properly signed `CBCT-Viewer.ipa` ready to install or push to
TestFlight, and the install lasts a year rather than a week. It needs these
repository secrets (Settings → Secrets and variables → Actions):

| Secret | What it is |
|---|---|
| `IOS_CERTIFICATE_BASE64` | your distribution `.p12`, base64-encoded |
| `IOS_CERTIFICATE_PASSWORD` | password for that `.p12` |
| `IOS_PROVISIONING_PROFILE_BASE64` | `.mobileprovision`, base64-encoded |
| `IOS_TEAM_ID` | 10-character Apple Team ID |
| `IOS_EXPORT_METHOD` | optional: `development`, `ad-hoc`, or `app-store` |

You can set these up later and switch between the two paths freely — the app
itself is identical, only the signing step differs.

## Optional: signed Android release

Add these secrets and the Android workflow switches from a debug APK to a
release-signed one automatically:

`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD`.

---

## Rendering quality

CBCT volumes are large — a few hundred slices is normal — and a phone GPU
cannot always hold one at full precision. Rather than guessing, the app lets the
user pick. Tap the **gear button** (bottom-right) in the viewer.

| Preset | Cache | Volume texture | 3D raycast step | Intended for |
|---|---|---|---|---|
| Low | 256 MB | 8-bit | 4× (coarse) | older / low-RAM phones |
| Medium | 768 MB | 8-bit | 2× | most phones and tablets |
| High | 1.5 GB | 16-bit | 1.5× | flagship phones, most PCs |
| Ultra | 3 GB | 16-bit | 1× (full) | desktop with a discrete GPU |
| Automatic | — | — | — | picks one from the device (default) |

What the knobs actually do:

- **Volume texture** — `preferSizeOverAccuracy`. 8-bit roughly halves GPU memory
  at the cost of coarser intensity steps. This is the single biggest lever for
  getting a full scan onto a mid-range mobile GPU.
- **3D raycast step** — `sampleDistanceMultiplier`. `1` samples every voxel
  (sharpest, slowest); higher values take bigger steps, so the 3D view renders
  faster but grainier. This is the real "3D resolution" dial.
- **Cache** — how much cornerstone may keep in memory before evicting.

Automatic mode reads `navigator.deviceMemory` and `hardwareConcurrency`.
`deviceMemory` is Chromium-only, so on iOS it is unavailable and the detection
falls back to core count and biases conservative — a viewer that renders
coarsely is more useful than one that runs out of memory and shows a blank
viewport. If Automatic guesses too low for your device, just set the preset
manually.

The choice is stored in `localStorage` and survives restarts. Changing it
reloads the viewer.

## Known limitations

**Folder picking does not work on phones.** The viewer offers both "load
folder" and "load files". Directory selection relies on `webkitdirectory`,
which neither Android's WebView nor iOS WKWebView supports. **On Android and
iPhone, use the multi-file picker** and select all the DICOM files in the
series. On Windows both buttons work.

**Large studies can still exhaust memory on mobile.** This is a real constraint
of WebGL on phones, not a bug in the packaging. If a volume fails to render,
drop one quality preset and reload.

**No network features.** This build ships with only the local-file data source —
no PACS, no DICOMweb, no telemetry. It works fully offline.

---

## Layout

```
packaging/
  mobile/            Capacitor wrapper (Android + iOS)
    capacitor.config.json
    assets/          icon + splash source art
  desktop/           Tauri wrapper (Windows)
    src-tauri/
  scripts/
    generate-icons.py
platform/app/public/config/cbct.js    app config, quality presets, settings UI
.github/workflows/
  _build-web.yml     shared: builds the viewer bundle
  build-android.yml  Android APK
  build-windows.yml  Windows installer
  build-ios.yml      iOS IPA
```

The `android/`, `ios/`, `www/` and `dist/` folders are generated during the
build and intentionally not committed.

## Building locally

Only needed if you want to iterate without waiting on CI.

```bash
pnpm install --frozen-lockfile
APP_CONFIG=config/cbct.js NODE_ENV=production pnpm --filter @ohif/app run build

# Android
cp -r platform/app/dist packaging/mobile/www
cd packaging/mobile && npm install && npx cap add android && npx cap sync android
cd android && ./gradlew assembleDebug

# Windows
cp -r platform/app/dist packaging/desktop/dist
cd packaging/desktop && npm install && npx tauri build
```
