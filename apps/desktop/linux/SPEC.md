---
id: submodule-desktop-linux-packaging
type: module-design
status: active
title: Local Linux RPM and AppImage packaging
parent: module-desktop
tags: [desktop, linux, packaging]
---

## Responsibility and boundary

Owns the host-native RPM and AppImage wrappers for building and installing a fork locally, plus the
launcher and desktop-entry templates.
The public entrypoints are `package:linux`, `package:rpm`, and `package:appimage` in the desktop package,
also exposed with the `desktop:` prefix at the repository root. Build-only dependencies are Bash,
Bun, coreutils, tar, zstd for release archives, `desktop-file-validate`, RPM's `rpmdeps`/`rpmbuild`
for RPM, and `appimagetool` for AppImage.
It consumes Electrobun's expanded bundle, shared's PNG and the repository license. It does not own
runtime code, application branding, system dependency bundling, signing, publication or the setup
installer. Application payloads stay byte-for-byte identical to the native
build, including version, channel, analytics configuration and updater metadata.

## Packaging contract

- Build only on Linux x64 or ARM64, selecting the matching Electrobun and RPM/AppImage architecture
  names. Default to stable; `--channel=stable|nightly|dev` selects the shared release channel, mapped to
  Electrobun's stable/canary/dev environment. Retain `--env=stable|canary|dev` as an equivalent selector;
  conflicting selectors fail. `--skip-build` consumes that exact bundle, failing on missing inputs
  instead of selecting a different channel.
- Default the version to `packages/shared/src/version.ts`; `--version=X.Y.Z` optionally overrides it,
  accepting SemVer prerelease/build suffixes. Empty or invalid versions fail before building. Before
  the native build, temporarily replace only that module's `version` and `channel` values so runtime
  identity, Electrobun metadata and both outer package formats agree. Preserve `commit`,
  `posthogProjectKey` and all other source content. Restore the original file after success, failure
  or a handled interrupt; keep its backup outside Electrobun's build directories. `--check` and
  `--skip-build` never stamp source. Do not read Git tags or rewrite already built application files.
- Stable and canary consume the exact Electrobun application archive
  `artifacts/<environment>-linux-<arch>-ThinkRail[-canary].tar.zst`. Release wrapping can remove or
  replace the expanded `build/` directory, so it is not an input for those environments. Dev consumes
  `build/dev-linux-<arch>/ThinkRail-dev`. Extract release archives into disposable staging, select the
  expected top-level application directory, and validate its launcher, Bun and version metadata.
  Never fall back to another architecture, environment or stale expanded release tree.
- Build Electrobun once when both formats are requested. Use disposable staging beneath desktop's
  ignored `build/`; outputs default to `artifacts/linux/`, with `--output-dir` resolved against the
  caller's cwd. Write a SHA-256 sidecar for each completed artifact. All builds in one worktree remain
  sequential. `--check` validates the pinned Bun, packaging tools and required build inputs without
  preparing the native SDK, downloading tools, building, installing or publishing anything.
- Preserve the expanded bundle and executable modes. Both formats use `AppRun`, which resolves its
  own symlink and enters the bundle's `bin/` before invoking the native launcher: Electrobun's early
  metadata reads require that cwd. Desktop startup then leaves it under the existing runtime rule.
- The wrapper root contains `.thinkrail-update-method`: `rpm` for RPM payloads and `appimage` for
  AppImage payloads. This marker stays outside the native application bundle. Native update authority
  reads it relative to the Resources folder and exposes manual upgrade guidance, without invoking
  Electrobun's updater against a system-managed or portable installation.
- Stable uses `thinkrail-desktop`; canary uses `thinkrail-desktop-nightly`; dev uses
  `thinkrail-desktop-dev`. Separate install paths, commands, desktop entries and icons let channels
  coexist without replacing the browser CLI's `thinkrail` command.
- RPM installs the bundle beneath `/opt/<package-name>`, links `/usr/bin/<package-name>` to `AppRun`,
  and installs the desktop entry, icon and license in standard system paths. The spec declares the
  native WebKitGTK/GTK/AppIndicator/librsvg SONAME dependencies, glibc 2.38+, git and xdg-utils.
  Keep automatic requirements for the shipped ELF files, but do not advertise private library provides.
  Scan bundled `.so`/`.so.*` files with RPM's own `rpmdeps --provides`; filter exactly those provided
  library capabilities from automatic requirements with `__requires_exclude`. This resolves private
  dependencies such as `libasar.so()(64bit)` within the bundle while retaining system-library and ABI
  requirements. Escape and anchor capability strings, doubling backslashes for RPM macro expansion,
  rather than suppressing entire files or all automatic requirements. Locate `rpmdeps` through RPM's
  `_rpmconfigdir` instead of a distro path.
  Disable RPM's binary postprocessing/debug extraction so it cannot strip or rewrite the prebuilt Bun
  and Electrobun payloads. Convert SemVer's prerelease separator to RPM `~` so prereleases sort before
  stable, and other hyphens to periods for RPM's version syntax. Build metadata alone does not create
  a prerelease. `RPM_RELEASE` defaults to `1` and accepts positive integer rebuild revisions.
- AppImage contains an AppDir with `AppRun`, a desktop entry, PNG, `.DirIcon` and the intact bundle.
  It retains the existing glibc and system GTK/WebKitGTK dependencies; this is not an older-distro
  compatibility layer. `APPIMAGETOOL` may name an explicit tool executable;
  `APPIMAGETOOL_RUNTIME_FILE` is the tool's standard offline runtime override. Tool installation and
  version selection remain explicit prerequisites; this script downloads no tools.
- Read and validate the native bundle's metadata without modifying it. `RPM_RELEASE` distinguishes
  packaging rebuilds without changing the application's version. The packaging command has no
  dependency on upstream release jobs, signing services, publication credentials or Git tags. With
  `--skip-build`, require the native version and environment to match the resolved identity; reject a
  mismatch and require a native rebuild rather than relabeling an existing application.

## Verification

`package.test.mjs` runs under the desktop Bun test suite, or directly with
`node --test apps/desktop/linux/package.test.mjs`. Linux fixtures use real tar/zstd archives while
mocking the native build and packaging tools. They cover archive-only stable/canary outputs, exact
channel/architecture selection, dev directories, malformed/missing inputs, source identity injection
and restoration on success/failure/signals, metadata agreement and payload preservation.
Archive cases skip when tar/zstd are unavailable. Static shell, desktop-entry and RPM-spec checks
add validation without building or launching the app.
Real native build, install, launch and upgrade acceptance must be performed on each target machine;
these formats are not included in the existing setup-installer smoke or public release matrix.
