#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: bash linux/package.sh [all|rpm|appimage] [options]

Build Linux packages locally from this checkout, without publishing them.
  --version=VERSION       Override packages/shared/src/version.ts (SemVer; e.g. 1.2.3).
  --channel=stable|nightly|dev  Select the release channel (default: stable).
  --env=stable|canary|dev  Equivalent native environment selector (canary means nightly).
  --skip-build            Reuse this environment/host's native output (release archive or dev directory).
  --output-dir=PATH       Write packages and SHA-256 sidecars here (relative to cwd).
  --check                 Check prerequisites without building or packaging.

Prerequisites: the repository's pinned Bun, desktop-file-validate, tar/zstd (release archives),
rpmbuild (RPM), appimagetool (AppImage). Run bun install --frozen-lockfile before building.
APPIMAGETOOL selects an explicit tool executable; APPIMAGETOOL_RUNTIME_FILE selects its runtime.
RPM_RELEASE sets the positive integer RPM rebuild revision (default: 1).
Version/channel are temporarily injected into shared's version.ts before building, then restored.
Existing application payloads and runtime settings are preserved; Git tags are not used.
EOF
}

fail() {
	printf 'Linux packaging: %s\n' "$*" >&2
	exit 1
}

format=all
build_env=
skip_build=false
check_only=false
output_dir=
version=
if [[ $# -gt 0 && $1 != -* ]]; then
	format=$1
	shift
fi
case "$format" in all|rpm|appimage) ;; *) fail "unknown format: $format" ;; esac
for option in "$@"; do
	case "$option" in
		--version=*) version=${option#--version=}; [[ -n $version ]] || fail "--version cannot be empty" ;;
		--env=stable|--env=canary|--env=dev|--channel=stable|--channel=nightly|--channel=dev)
			selected_env=${option#*=}
			if [[ $selected_env == nightly ]]; then selected_env=canary; fi
			[[ -z $build_env || $build_env == "$selected_env" ]] || fail "conflicting channel/environment selectors"
			build_env=$selected_env ;;
		--skip-build) skip_build=true ;;
		--output-dir=*) output_dir=${option#--output-dir=}; [[ -n $output_dir ]] || fail "output directory cannot be empty" ;;
		--check) check_only=true ;;
		--help|-h) usage; exit 0 ;;
		*) fail "unknown option: $option" ;;
	esac
done
build_env=${build_env:-stable}
release_channel=$build_env
if [[ $release_channel == canary ]]; then release_channel=nightly; fi

[[ $(uname -s) == Linux ]] || fail "build on a Linux machine"
case "$(uname -m)" in
	x86_64) electrobun_arch=x64; package_arch=x86_64 ;;
	aarch64|arm64) electrobun_arch=arm64; package_arch=aarch64 ;;
	*) fail "unsupported host architecture: $(uname -m)" ;;
esac

desktop_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
repo_root=$(cd -- "$desktop_dir/../.." && pwd)
config_dir="$desktop_dir/linux"
version_file="$repo_root/packages/shared/src/version.ts"
output_dir=$(realpath -m -- "${output_dir:-$desktop_dir/artifacts/linux}")
appimagetool=${APPIMAGETOOL:-appimagetool}
required_tools=(bun desktop-file-validate sha256sum)
if [[ $format != appimage ]]; then required_tools+=(rpm rpmbuild); fi
if [[ $format != appimage || $build_env != dev ]]; then required_tools+=(tar); fi
if [[ $build_env != dev ]]; then required_tools+=(zstd); fi
if [[ $format != rpm ]]; then required_tools+=("$appimagetool"); fi
for tool in "${required_tools[@]}"; do
	command -v "$tool" >/dev/null 2>&1 || fail "required tool not found: $tool"
done
if [[ $format != rpm ]]; then appimagetool=$(command -v "$appimagetool"); fi
required_bun=$(bun -e 'console.log(require(process.argv[1]).packageManager.replace(/^bun@/, ""))' "$repo_root/package.json")
installed_bun=$(bun --version)
[[ $installed_bun == "$required_bun" ]] || fail "Bun $required_bun is required; found $installed_bun"
version=$(bun -e '
const current = require(process.argv[1]);
const version = process.argv[2] || current.version;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
if (typeof version !== "string" || semver.exec(version)?.[0] !== version) {
  throw new Error("version must be a SemVer version in version.ts or --version, e.g. 1.2.3");
}
console.log(version);
' -- "$version_file" "$version")
rpm_release=${RPM_RELEASE:-1}
if [[ $format != appimage ]]; then
	[[ $rpm_release =~ ^[1-9][0-9]*$ ]] || fail "RPM_RELEASE must be a positive integer"
	rpmdeps="$(rpm --eval '%{_rpmconfigdir}')/rpmdeps"
	[[ -x $rpmdeps ]] || fail "RPM dependency scanner not found at $rpmdeps; install the RPM build tools"
fi

bundle_name=ThinkRail
package_name=thinkrail-desktop
app_name=ThinkRail
case "$build_env" in
	canary) bundle_name+=-canary; package_name+=-nightly; app_name+=' Nightly' ;;
	dev) bundle_name+=-dev; package_name+=-dev; app_name+=' Dev' ;;
esac
bundle_dir="$desktop_dir/build/$build_env-linux-$electrobun_arch/$bundle_name"
bundle_archive="$desktop_dir/artifacts/$build_env-linux-$electrobun_arch-$bundle_name.tar.zst"

require_native_output() {
	if [[ $build_env == dev ]]; then
		[[ -x $bundle_dir/bin/launcher && -x $bundle_dir/bin/bun && -f $bundle_dir/Resources/version.json ]] ||
			fail "native dev bundle not found at $bundle_dir; build the selected environment first"
	else
		[[ -f $bundle_archive ]] || fail "native application archive not found at $bundle_archive; build the selected environment first"
	fi
}

if [[ $skip_build == true ]]; then
	require_native_output
else
	[[ -x $desktop_dir/node_modules/.bin/electrobun || -x $repo_root/node_modules/.bin/electrobun ]] ||
		fail "run bun install --frozen-lockfile from the repository root first"
fi
printf 'Linux %s; environment=%s; formats=%s\nOutput: %s\n' "$package_arch" "$build_env" "$format" "$output_dir"
printf 'Application/package version: %s; channel=%s\n' "$version" "$release_channel"
if [[ $check_only == true ]]; then
	printf 'Prerequisites ready. No build or packaging performed.\n'
	exit 0
fi

if [[ $skip_build == false ]]; then
	(
		version_backup=$(mktemp -d)
		trap 'rm -rf -- "$version_backup"' EXIT
		cp -p -- "$version_file" "$version_backup/version.ts"
		trap 'cp -p -- "$version_backup/version.ts" "$version_file" && rm -rf -- "$version_backup"' EXIT
		trap 'exit 130' INT
		trap 'exit 143' TERM
		bun -e '
const fs = require("node:fs");
const file = process.argv[1];
const values = { version: process.argv[2], channel: process.argv[3] };
const counts = { version: 0, channel: 0 };
const source = fs.readFileSync(file, "utf8").replace(
  /^(export const (version|channel)\s*=\s*)[^;\r\n]+;/gm,
  (_, prefix, name) => { counts[name]++; return prefix + JSON.stringify(values[name]) + ";"; },
);
if (counts.version !== 1 || counts.channel !== 1) throw new Error("version.ts must declare version and channel once");
fs.writeFileSync(file, source);
' -- "$version_file" "$version" "$release_channel"
		cd -- "$desktop_dir"
		bun run "package:$build_env"
	)
fi
require_native_output

mkdir -p -- "$desktop_dir/build" "$output_dir"
stage_dir=$(mktemp -d "$desktop_dir/build/linux-packaging.XXXXXX")
trap 'rm -rf -- "$stage_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
payload="$stage_dir/payload"
mkdir -p -- "$payload/lib"
if [[ $build_env == dev ]]; then
	cp -a -- "$bundle_dir" "$payload/lib/thinkrail"
else
	mkdir -- "$stage_dir/unpacked"
	tar --zstd --no-same-owner --same-permissions -xf "$bundle_archive" -C "$stage_dir/unpacked" -- "$bundle_name"
	mv -- "$stage_dir/unpacked/$bundle_name" "$payload/lib/thinkrail"
fi
[[ -x $payload/lib/thinkrail/bin/launcher && -x $payload/lib/thinkrail/bin/bun && -f $payload/lib/thinkrail/Resources/version.json ]] ||
	fail "application payload is incomplete: bin/launcher, bin/bun and Resources/version.json are required"
bun -e '
const fs = require("node:fs");
const file = process.argv[1];
const info = JSON.parse(fs.readFileSync(file, "utf8"));
if (info.channel !== process.argv[2]) throw new Error("bundle channel does not match --env");
if (info.version !== process.argv[3]) {
  throw new Error("bundle version does not match the requested version; rebuild without --skip-build");
}
' "$payload/lib/thinkrail/Resources/version.json" "$build_env" "$version"
printf 'Application metadata matches version=%s; environment=%s\n' "$version" "$build_env"

install -m755 -- "$config_dir/AppRun" "$payload/AppRun"
install -m644 -- "$repo_root/packages/shared/assets/icon.png" "$payload/$package_name.png"
install -m644 -- "$repo_root/LICENSE" "$payload/LICENSE"
sed -e "s/@APP_NAME@/$app_name/g" -e "s/@PACKAGE_NAME@/$package_name/g" \
	"$config_dir/thinkrail.desktop" > "$payload/$package_name.desktop"
ln -s -- "$package_name.png" "$payload/.DirIcon"
desktop-file-validate "$payload/$package_name.desktop"
artifacts=()

if [[ $format != appimage ]]; then
	printf 'rpm\n' > "$payload/.thinkrail-update-method"
	chmod 644 -- "$payload/.thinkrail-update-method"
	shopt -s globstar nullglob
	libraries=("$payload/lib/thinkrail"/**/*.so "$payload/lib/thinkrail"/**/*.so.*)
	private_provides=
	if [[ ${#libraries[@]} -gt 0 ]]; then
		private_provides=$("$rpmdeps" --provides "${libraries[@]}")
	fi
	private_requires_pattern=$(bun -e '
const capabilities = [...new Set(process.argv[1].split("\n").filter(line => line.includes(".so") && !/\s/.test(line)))].sort();
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
console.log(capabilities.length ? "^(" + capabilities.map(escape).join("|") + ")$" : "^$");
' "$private_provides")
	rpm_dir="$stage_dir/rpm"
	mkdir -p -- "$rpm_dir"/{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS}
	tar -czf "$rpm_dir/SOURCES/payload.tar.gz" -C "$stage_dir" payload
	rpm_version=${version%%+*}
	rpm_version=${rpm_version/-/\~}
	if [[ $version == *+* ]]; then rpm_version+="+${version#*+}"; fi
	rpm_version=${rpm_version//-/.}
	rpmbuild -bb "$config_dir/thinkrail.spec" --target "$package_arch" \
		--define "_topdir $rpm_dir" \
		--define "_rpmdir $output_dir" \
		--define '_rpmfilename %{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}.rpm' \
		--define "package_name $package_name" \
		--define "app_version $rpm_version" \
		--define "package_release $rpm_release" \
		--define "__requires_exclude ${private_requires_pattern//\\/\\\\}"
	artifacts+=("$package_name-$rpm_version-$rpm_release.$package_arch.rpm")
fi

if [[ $format != rpm ]]; then
	printf 'appimage\n' > "$payload/.thinkrail-update-method"
	chmod 644 -- "$payload/.thinkrail-update-method"
	app_dir="$stage_dir/$app_name.AppDir"
	mv -- "$payload" "$app_dir"
	ARCH="$package_arch" VERSION="$version" "$appimagetool" --no-appstream \
		"$app_dir" "$output_dir/$package_name-$version-$package_arch.AppImage"
	artifacts+=("$package_name-$version-$package_arch.AppImage")
fi

for artifact in "${artifacts[@]}"; do
	(cd -- "$output_dir" && sha256sum -- "$artifact" > "$artifact.sha256")
done
printf 'Linux packages written to %s\n' "$output_dir"
