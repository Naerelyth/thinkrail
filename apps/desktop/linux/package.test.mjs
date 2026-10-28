import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(sourceDir, "../../..");
const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const archiveTestsUnavailable =
	process.platform !== "linux" ||
	["tar", "zstd"].some((tool) => spawnSync(tool, ["--version"]).status !== 0);
const rpmMacrosUnavailable = archiveTestsUnavailable || spawnSync("rpm", ["--version"]).status !== 0;
const roots = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function executable(path, source) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, source);
	chmodSync(path, 0o755);
}

function fixture(environment = "stable", arch = "x64") {
	const root = mkdtempSync(join(tmpdir(), "thinkrail archive test "));
	roots.push(root);
	const desktop = join(root, "apps/desktop");
	const config = join(desktop, "linux");
	mkdirSync(config, { recursive: true });
	for (const name of ["package.sh", "AppRun", "thinkrail.desktop", "thinkrail.spec"]) {
		cpSync(join(sourceDir, name), join(config, name));
	}
	cpSync(join(repoRoot, "package.json"), join(root, "package.json"));
	cpSync(join(repoRoot, "LICENSE"), join(root, "LICENSE"));
	mkdirSync(join(root, "packages/shared/assets"), { recursive: true });
	cpSync(
		join(repoRoot, "packages/shared/assets/icon.png"),
		join(root, "packages/shared/assets/icon.png"),
	);
	const versionFile = join(root, "packages/shared/src/version.ts");
	mkdirSync(dirname(versionFile), { recursive: true });
	writeFileSync(
		versionFile,
		[
			'export const version = "1.2.3";',
			'export const channel = "dev";',
			'export const commit = "fixture-commit";',
			'export const posthogProjectKey = "fixture-key";',
			'export const fixtureNote = "preserve me";',
			"",
		].join("\n"),
	);
	executable(join(root, "node_modules/.bin/electrobun"), "#!/bin/sh\nexit 0\n");
	const bundleName = environment === "stable" ? "ThinkRail" : `ThinkRail-${environment}`;
	const bundle = join(
		environment === "dev" ? join(desktop, "build", `dev-linux-${arch}`) : join(root, "archive input"),
		bundleName,
	);
	executable(join(bundle, "bin/launcher"), "#!/bin/sh\nexit 0\n");
	executable(join(bundle, "bin/bun"), "#!/bin/sh\nexit 0\n");
	for (const name of ["libasar.so", "libNativeWrapper.so", "libspecial++.so.1"]) {
		writeFileSync(join(bundle, "bin", name), "private library fixture");
	}
	symlinkSync("bun", join(bundle, "bin/bun-link"));
	mkdirSync(join(bundle, "Resources/app/runtime"), { recursive: true });
	const metadata = JSON.stringify({
		version: "1.2.3",
		channel: environment,
		baseUrl: "https://example.test/original-feed",
	});
	writeFileSync(join(bundle, "Resources/version.json"), metadata);
	const bakedIdentity = {
		version: "1.2.3",
		channel: environment === "canary" ? "nightly" : environment,
		commit: "fixture-commit",
		posthogProjectKey: "fixture-key",
	};
	writeFileSync(join(bundle, "Resources/app/runtime/identity.json"), JSON.stringify(bakedIdentity));
	writeFileSync(join(bundle, "Resources/app/runtime/opaque.bin"), Buffer.from([0, 1, 255, 128]));
	const archive = join(desktop, "artifacts", `${environment}-linux-${arch}-${bundleName}.tar.zst`);
	if (environment !== "dev") {
		mkdirSync(dirname(archive), { recursive: true });
		const result = spawnSync("tar", ["--zstd", "-cf", archive, "-C", dirname(bundle), bundleName]);
		assert.equal(result.status, 0, result.stderr?.toString());
	}
	const tools = join(root, "tools");
	const libraryCapabilities = join(root, "private-capabilities.txt");
	writeFileSync(
		libraryCapabilities,
		[
			"libasar.so()(64bit)",
			"libasar.so(ASAR_1.0)(64bit)",
			"libNativeWrapper.so()(64bit)",
			"libNativeWrapper.so()(64bit)",
			"libspecial++.so.1()(64bit)",
		].join("\n") + "\n",
	);
	executable(join(tools, "rpm"), '#!/bin/sh\nprintf "%s\\n" "$TEST_RPM_CONFIG"\n');
	executable(
		join(tools, "rpmdeps"),
		'#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_RPMDEPS_LOG"\ncat "$TEST_LIBRARY_CAPABILITIES"\n',
	);
	executable(
		join(tools, "bun"),
		`#!/bin/sh
if [ "$1" = --version ]; then printf '%s\\n' "$TEST_BUN_VERSION"; exit 0; fi
if [ "$1" = run ]; then
  printf '%s\\n' "$@" >> "$TEST_BUILD_LOG"
  exec "$TEST_RUNTIME" "$TEST_BUILD_HELPER"
fi
exec "$TEST_RUNTIME" "$@"
`,
	);
	const buildHelper = join(root, "build-helper.mjs");
	writeFileSync(
		buildHelper,
		`import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
const env = process.env;
writeFileSync(env.TEST_BUILD_SOURCE, readFileSync(env.TEST_VERSION_FILE));
if (env.TEST_BUILD_SIGNAL === "TERM") {
  process.kill(process.ppid, "SIGTERM");
  process.exit(143);
}
if (env.TEST_BUILD_FAILURE !== "0") process.exit(Number(env.TEST_BUILD_FAILURE));
const identity = await import(pathToFileURL(env.TEST_VERSION_FILE).href);
const metadataFile = join(env.TEST_BUNDLE, "Resources/version.json");
const metadata = { ...JSON.parse(readFileSync(metadataFile, "utf8")), version: identity.version };
const baked = { version: identity.version, channel: identity.channel, commit: identity.commit, posthogProjectKey: identity.posthogProjectKey };
let changed = false;
for (const [file, value] of [
  [metadataFile, metadata],
  [join(env.TEST_BUNDLE, "Resources/app/runtime/identity.json"), baked],
]) {
  const next = JSON.stringify(value);
  if (readFileSync(file, "utf8") !== next) {
    writeFileSync(file, next);
    changed = true;
  }
}
if (changed && env.TEST_BUILD_ENV !== "dev") {
  const result = spawnSync("tar", ["--zstd", "-cf", env.TEST_ARCHIVE, "-C", dirname(env.TEST_BUNDLE), env.TEST_BUNDLE_NAME]);
  if (result.status !== 0) process.exit(1);
}
`,
	);
	executable(
		join(tools, "uname"),
		`#!/bin/sh
case "$1" in -s) echo Linux ;; -m) echo "$TEST_MACHINE" ;; esac
`,
	);
	executable(join(tools, "desktop-file-validate"), "#!/bin/sh\nexit 0\n");
	executable(
		join(tools, "appimagetool"),
		'#!/bin/sh\ncp -a -- "$2" "$TEST_APPDIR"\nprintf "AppImage fixture\\n" > "$3"\n',
	);
	const rpmHelper = join(root, "rpm-helper.mjs");
	writeFileSync(
		rpmHelper,
		`import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const macros = Object.fromEntries(args.flatMap((value, index) => {
  if (args[index - 1] !== "--define") return [];
  const space = value.indexOf(" ");
  return [[value.slice(0, space), value.slice(space + 1)]];
}));
writeFileSync(process.env.TEST_RPM_MACROS, JSON.stringify(macros));
mkdirSync(process.env.TEST_RPMDIR, { recursive: true });
const result = spawnSync("tar", ["-xf", join(macros._topdir, "SOURCES/payload.tar.gz"), "-C", process.env.TEST_RPMDIR]);
if (result.status !== 0) process.exit(1);
const arch = args[args.indexOf("--target") + 1];
writeFileSync(join(macros._rpmdir, macros.package_name + "-" + macros.app_version + "-" + macros.package_release + "." + arch + ".rpm"), "RPM fixture");
`,
	);
	executable(join(tools, "rpmbuild"), '#!/bin/sh\nexec "$TEST_RUNTIME" "$TEST_RPM_HELPER" "$@"\n');
	const env = {
		...process.env,
		PATH: `${tools}:${process.env.PATH}`,
		TEST_RUNTIME: process.execPath,
		TEST_BUN_VERSION: manifest.packageManager.replace(/^bun@/, ""),
		TEST_MACHINE: arch === "x64" ? "x86_64" : "aarch64",
		TEST_BUILD_LOG: join(root, "build.log"),
		TEST_BUILD_HELPER: buildHelper,
		TEST_BUILD_SOURCE: join(root, "build-version.ts"),
		TEST_VERSION_FILE: versionFile,
		TEST_BUNDLE: bundle,
		TEST_BUNDLE_NAME: bundleName,
		TEST_ARCHIVE: archive,
		TEST_BUILD_ENV: environment,
		TEST_BUILD_FAILURE: "0",
		TEST_BUILD_SIGNAL: "",
		TEST_APPDIR: join(root, "captured.AppDir"),
		TEST_RPMDIR: join(root, "captured-rpm"),
		TEST_RPM_HELPER: rpmHelper,
		TEST_RPM_CONFIG: tools,
		TEST_RPMDEPS_LOG: join(root, "rpmdeps.log"),
		TEST_RPM_MACROS: join(root, "rpm-macros.json"),
		TEST_LIBRARY_CAPABILITIES: libraryCapabilities,
		APPIMAGETOOL: join(tools, "appimagetool"),
		RPM_RELEASE: "1",
	};
	delete env.NODE_TEST_CONTEXT;
	return { root, desktop, bundle, bundleName, archive, metadata, versionFile, env };
}

function run(f, ...args) {
	return spawnSync("bash", [join(f.desktop, "linux/package.sh"), ...args], {
		cwd: f.root,
		env: f.env,
		encoding: "utf8",
	});
}

function assertPayload(f, path) {
	assert.equal(
		readFileSync(join(path, "Resources/version.json"), "utf8"),
		readFileSync(join(f.bundle, "Resources/version.json"), "utf8"),
	);
	assert.equal(
		readFileSync(join(path, "Resources/app/runtime/identity.json"), "utf8"),
		readFileSync(join(f.bundle, "Resources/app/runtime/identity.json"), "utf8"),
	);
	assert.deepEqual(
		readFileSync(join(path, "Resources/app/runtime/opaque.bin")),
		readFileSync(join(f.bundle, "Resources/app/runtime/opaque.bin")),
	);
	assert.equal(statSync(join(path, "bin/launcher")).mode & 0o777, 0o755);
	assert.equal(readlinkSync(join(path, "bin/bun-link")), "bun");
	assert.equal(readFileSync(join(path, "bin/libasar.so"), "utf8"), "private library fixture");
}

for (const environment of ["stable", "canary"]) {
	for (const arch of ["x64", "arm64"]) {
		test(
			`wraps archive-only ${environment} ${arch} output after a simulated native build`,
			{ skip: archiveTestsUnavailable },
			() => {
				const f = fixture(environment, arch);
				const expanded = join(f.desktop, "build", `${environment}-linux-${arch}`, f.bundleName);
				assert.equal(existsSync(expanded), false);
				const archiveBefore = readFileSync(f.archive);
				const result = run(f, "all", "--version=1.2.3", `--env=${environment}`);
				assert.equal(result.status, 0, result.stderr);
				assert.equal(readFileSync(f.env.TEST_BUILD_LOG, "utf8"), `run\npackage:${environment}\n`);
				assertPayload(f, join(f.env.TEST_APPDIR, "lib/thinkrail"));
				assertPayload(f, join(f.env.TEST_RPMDIR, "payload/lib/thinkrail"));
				assert.deepEqual(readFileSync(f.archive), archiveBefore);
				const name = environment === "stable" ? "thinkrail-desktop" : "thinkrail-desktop-nightly";
				const rpm = `${name}-1.2.3-1.${arch === "x64" ? "x86_64" : "aarch64"}.rpm`;
				const output = join(f.desktop, "artifacts/linux");
				const digest = createHash("sha256").update(readFileSync(join(output, rpm))).digest("hex");
				assert.equal(readFileSync(join(output, `${rpm}.sha256`), "utf8"), `${digest}  ${rpm}\n`);
			},
		);
	}
}

test(
	"reuses the exact stable archive despite a stale expanded release tree",
	{ skip: archiveTestsUnavailable },
	() => {
		const f = fixture();
		const stale = join(f.desktop, "build/stable-linux-x64/ThinkRail");
		cpSync(f.bundle, stale, { recursive: true });
		writeFileSync(join(stale, "Resources/version.json"), '{"version":"9.9.9","channel":"stable"}');
		const result = run(f, "appimage", "--version=1.2.3", "--skip-build");
		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(f.env.TEST_BUILD_LOG), false);
		assertPayload(f, join(f.env.TEST_APPDIR, "lib/thinkrail"));
	},
);

test(
	"checks archive-only inputs without extracting or packaging",
	{ skip: archiveTestsUnavailable },
	() => {
		const f = fixture();
		const result = run(f, "rpm", "--version=1.2.3", "--skip-build", "--check");
		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(join(f.desktop, "build")), false);
		assert.equal(existsSync(join(f.desktop, "artifacts/linux")), false);
	},
);

test(
	"rejects a missing exact archive instead of choosing a sibling target or expanded tree",
	{ skip: archiveTestsUnavailable },
	() => {
		const f = fixture();
		cpSync(f.archive, join(dirname(f.archive), "stable-linux-arm64-ThinkRail.tar.zst"));
		cpSync(f.bundle, join(f.desktop, "build/stable-linux-x64/ThinkRail"), { recursive: true });
		rmSync(f.archive);
		const result = run(f, "rpm", "--version=1.2.3", "--skip-build");
		assert.notEqual(result.status, 0);
		assert.ok(result.stderr.includes(f.archive), result.stderr);
		assert.equal(existsSync(f.env.TEST_RPMDIR), false);
	},
);

test(
	"rejects corrupt release archives and removes temporary extraction",
	{ skip: archiveTestsUnavailable },
	() => {
		const f = fixture();
		writeFileSync(f.archive, "not a zstd archive");
		const result = run(f, "rpm", "--version=1.2.3", "--skip-build");
		assert.notEqual(result.status, 0);
		assert.equal(existsSync(f.env.TEST_RPMDIR), false);
		assert.equal(existsSync(f.env.TEST_BUILD_LOG), false);
		assert.deepEqual(readdirSync(join(f.desktop, "build")), []);
	},
);

test(
	"rejects an archive with a different application root",
	{ skip: archiveTestsUnavailable },
	() => {
		const f = fixture();
		const parent = dirname(f.bundle);
		cpSync(f.bundle, join(parent, "OtherApp"), { recursive: true });
		const packed = spawnSync("tar", ["--zstd", "-cf", f.archive, "-C", parent, "OtherApp"]);
		assert.equal(packed.status, 0, packed.stderr?.toString());
		const result = run(f, "appimage", "--version=1.2.3", "--skip-build");
		assert.notEqual(result.status, 0);
		assert.equal(existsSync(f.env.TEST_APPDIR), false);
		assert.deepEqual(readdirSync(join(f.desktop, "build")), []);
	},
);

test(
	"rejects an archive with an incomplete application payload",
	{ skip: archiveTestsUnavailable },
	() => {
		const f = fixture();
		rmSync(join(f.bundle, "bin/bun"));
		const packed = spawnSync("tar", ["--zstd", "-cf", f.archive, "-C", dirname(f.bundle), f.bundleName]);
		assert.equal(packed.status, 0, packed.stderr?.toString());
		const result = run(f, "appimage", "--version=1.2.3", "--skip-build");
		assert.notEqual(result.status, 0);
		assert.ok(result.stderr.includes("application payload is incomplete"), result.stderr);
		assert.equal(existsSync(f.env.TEST_APPDIR), false);
		assert.deepEqual(readdirSync(join(f.desktop, "build")), []);
	},
);

test("continues to wrap the expanded dev bundle", { skip: process.platform !== "linux" }, () => {
	const f = fixture("dev");
	const result = run(f, "appimage", "--version=1.2.3", "--env=dev", "--skip-build");
	assert.equal(result.status, 0, result.stderr);
	assertPayload(f, join(f.env.TEST_APPDIR, "lib/thinkrail"));
});

test(
	"injects the AppImage version before building without consulting Git",
	{ skip: process.platform !== "linux" },
	() => {
		const f = fixture("dev");
		const sourceBefore = readFileSync(f.versionFile, "utf8");
		f.env.TEST_GIT_LOG = join(f.root, "git.log");
		executable(
			join(f.root, "tools/git"),
			'#!/bin/sh\nprintf "Git was invoked\\n" > "$TEST_GIT_LOG"\nexit 97\n',
		);
		const result = run(f, "appimage", "--version=2.4.6", "--channel=dev");
		assert.equal(result.status, 0, result.stderr);
		assert.ok(existsSync(join(f.desktop, "artifacts/linux/thinkrail-desktop-dev-2.4.6-x86_64.AppImage")));
		assertPayload(f, join(f.env.TEST_APPDIR, "lib/thinkrail"));
		assert.equal(JSON.parse(readFileSync(join(f.bundle, "Resources/version.json"))).version, "2.4.6");
		assert.equal(
			readFileSync(f.env.TEST_BUILD_SOURCE, "utf8"),
			sourceBefore.replace('version = "1.2.3"', 'version = "2.4.6"'),
		);
		assert.equal(readFileSync(f.versionFile, "utf8"), sourceBefore);
		assert.equal(existsSync(f.env.TEST_RPMDEPS_LOG), false);
		assert.equal(existsSync(f.env.TEST_GIT_LOG), false);
		assert.equal(existsSync(join(f.root, ".git")), false);
	},
);

test(
	"defaults to the shared source version for runtime metadata and both package formats",
	{ skip: archiveTestsUnavailable },
	() => {
		const f = fixture();
		const source = readFileSync(f.versionFile, "utf8").replace('"1.2.3"', '"0.0.0-dev"');
		writeFileSync(f.versionFile, source);
		const result = run(f, "all");
		assert.equal(result.status, 0, result.stderr);
		const macros = JSON.parse(readFileSync(f.env.TEST_RPM_MACROS, "utf8"));
		assert.equal(macros.app_version, "0.0.0~dev");
		assert.ok(existsSync(join(f.desktop, "artifacts/linux/thinkrail-desktop-0.0.0-dev-x86_64.AppImage")));
		assert.deepEqual(JSON.parse(readFileSync(join(f.bundle, "Resources/app/runtime/identity.json"))), {
			version: "0.0.0-dev",
			channel: "stable",
			commit: "fixture-commit",
			posthogProjectKey: "fixture-key",
		});
		assert.equal(readFileSync(f.versionFile, "utf8"), source);
		assertPayload(f, join(f.env.TEST_APPDIR, "lib/thinkrail"));
		assertPayload(f, join(f.env.TEST_RPMDIR, "payload/lib/thinkrail"));
	},
);

test("rejects an empty explicit version", { skip: process.platform !== "linux" }, () => {
	const f = fixture("dev");
	const result = run(f, "appimage", "--version=", "--env=dev", "--skip-build");
	assert.notEqual(result.status, 0);
	assert.ok(result.stderr.includes("--version cannot be empty"), result.stderr);
	assert.equal(existsSync(f.env.TEST_BUILD_LOG), false);
	assert.equal(existsSync(f.env.TEST_APPDIR), false);
});

test(
	"uses the explicit prerelease version for both package formats",
	{ skip: archiveTestsUnavailable },
	() => {
		const f = fixture("canary");
		const sourceBefore = readFileSync(f.versionFile, "utf8");
		const result = run(f, "all", "--version=2.3.4-nightly.8+fork.2", "--channel=nightly", "--env=canary");
		assert.equal(result.status, 0, result.stderr);
		const macros = JSON.parse(readFileSync(f.env.TEST_RPM_MACROS, "utf8"));
		assert.equal(macros.app_version, "2.3.4~nightly.8+fork.2");
		assert.ok(
			existsSync(
				join(f.desktop, "artifacts/linux/thinkrail-desktop-nightly-2.3.4-nightly.8+fork.2-x86_64.AppImage"),
			),
		);
		assertPayload(f, join(f.env.TEST_RPMDIR, "payload/lib/thinkrail"));
		assertPayload(f, join(f.env.TEST_APPDIR, "lib/thinkrail"));
		assert.deepEqual(JSON.parse(readFileSync(join(f.bundle, "Resources/app/runtime/identity.json"))), {
			version: "2.3.4-nightly.8+fork.2",
			channel: "nightly",
			commit: "fixture-commit",
			posthogProjectKey: "fixture-key",
		});
		assert.equal(readFileSync(f.versionFile, "utf8"), sourceBefore);
	},
);

test(
	"keeps build metadata separate from RPM prerelease ordering",
	{ skip: archiveTestsUnavailable },
	() => {
		const f = fixture("dev");
		for (const [version, rpmVersion] of [
			["1.2.3+fork-build.2", "1.2.3+fork.build.2"],
			["1.2.3-nightly-test.8+fork-build.2", "1.2.3~nightly.test.8+fork.build.2"],
		]) {
			const result = run(f, "rpm", `--version=${version}`, "--env=dev");
			assert.equal(result.status, 0, result.stderr);
			const macros = JSON.parse(readFileSync(f.env.TEST_RPM_MACROS, "utf8"));
			assert.equal(macros.app_version, rpmVersion);
		}
	},
);

test(
	"rejects malformed explicit versions before starting a native build",
	{ skip: process.platform !== "linux" },
	() => {
		const f = fixture("dev");
		for (const version of [
			"--version",
			"--help",
			"-v",
			"--",
			"v1.2.3",
			"01.2.3",
			"1.2.3-01",
			"1.2",
			"1.2.3 invalid",
			"1.2.3\n",
			"1.2.3%{?dist}",
		]) {
			const result = run(f, "appimage", `--version=${version}`, "--env=dev");
			assert.notEqual(result.status, 0);
			assert.ok(result.stderr.includes("version must be a SemVer version"), result.stderr);
		}
		assert.equal(existsSync(f.env.TEST_BUILD_LOG), false);
		assert.equal(existsSync(f.env.TEST_APPDIR), false);
	},
);

test(
	"leaves source untouched during preflight with overrides",
	{ skip: archiveTestsUnavailable },
	() => {
		const f = fixture("canary");
		const sourceBefore = readFileSync(f.versionFile, "utf8");
		const result = run(f, "rpm", "--version=9.8.7", "--channel=nightly", "--check");
		assert.equal(result.status, 0, result.stderr);
		assert.equal(readFileSync(f.versionFile, "utf8"), sourceBefore);
		assert.equal(existsSync(f.env.TEST_BUILD_SOURCE), false);
		assert.equal(existsSync(join(f.desktop, "build")), false);
	},
);

test(
	"restores source after native build failure or a handled signal",
	{ skip: process.platform !== "linux" },
	() => {
		for (const signal of ["", "TERM"]) {
			const f = fixture("dev");
			const sourceBefore = readFileSync(f.versionFile, "utf8");
			chmodSync(f.versionFile, 0o640);
			f.env.TEST_BUILD_FAILURE = "17";
			f.env.TEST_BUILD_SIGNAL = signal;
			const result = run(f, "appimage", "--version=9.8.7", "--channel=dev");
			assert.equal(result.status, signal ? 143 : 17, result.stderr);
			assert.ok(readFileSync(f.env.TEST_BUILD_SOURCE, "utf8").includes('version = "9.8.7"'));
			assert.equal(readFileSync(f.versionFile, "utf8"), sourceBefore);
			assert.equal(statSync(f.versionFile).mode & 0o777, 0o640);
			assert.equal(existsSync(f.env.TEST_APPDIR), false);
		}
	},
);

test(
	"rejects conflicting or invalid channel selectors",
	{ skip: process.platform !== "linux" },
	() => {
		const f = fixture("dev");
		const sourceBefore = readFileSync(f.versionFile, "utf8");
		for (const args of [
			["--channel=nightly", "--env=stable"],
			["--env=dev", "--channel=stable"],
			["--channel=stable", "--channel=dev"],
			["--channel=canary"],
			["--channel="],
		]) {
			const result = run(f, "appimage", ...args);
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /conflicting channel\/environment selectors|unknown option/);
		}
		assert.equal(readFileSync(f.versionFile, "utf8"), sourceBefore);
		assert.equal(existsSync(f.env.TEST_BUILD_LOG), false);
	},
);

test(
	"rejects an invalid source version before native build",
	{ skip: process.platform !== "linux" },
	() => {
		const f = fixture("dev");
		const invalid = readFileSync(f.versionFile, "utf8").replace('"1.2.3"', '"invalid"');
		writeFileSync(f.versionFile, invalid);
		const result = run(f, "appimage", "--channel=dev");
		assert.notEqual(result.status, 0);
		assert.ok(result.stderr.includes("version must be a SemVer version"), result.stderr);
		assert.equal(readFileSync(f.versionFile, "utf8"), invalid);
		assert.equal(existsSync(f.env.TEST_BUILD_LOG), false);
	},
);

test(
	"rejects relabeling an existing bundle with a different version",
	{ skip: archiveTestsUnavailable },
	() => {
		const f = fixture();
		const sourceBefore = readFileSync(f.versionFile, "utf8");
		const archiveBefore = readFileSync(f.archive);
		const result = run(f, "all", "--version=9.8.7", "--skip-build");
		assert.notEqual(result.status, 0);
		assert.ok(result.stderr.includes("bundle version does not match the requested version"), result.stderr);
		assert.equal(readFileSync(f.versionFile, "utf8"), sourceBefore);
		assert.deepEqual(readFileSync(f.archive), archiveBefore);
		assert.equal(existsSync(f.env.TEST_BUILD_LOG), false);
		assert.equal(existsSync(f.env.TEST_APPDIR), false);
		assert.equal(existsSync(f.env.TEST_RPMDIR), false);
	},
);

test(
	"rejects an existing bundle with the wrong channel",
	{ skip: process.platform !== "linux" },
	() => {
		const f = fixture("dev");
		writeFileSync(join(f.bundle, "Resources/version.json"), '{"version":"1.2.3","channel":"stable"}');
		const result = run(f, "appimage", "--channel=dev", "--skip-build");
		assert.notEqual(result.status, 0);
		assert.ok(result.stderr.includes("bundle channel does not match --env"), result.stderr);
		assert.equal(existsSync(f.env.TEST_APPDIR), false);
	},
);

test("shows help without requiring a version", { skip: process.platform !== "linux" }, () => {
	const f = fixture("dev");
	const result = run(f, "--help");
	assert.equal(result.status, 0, result.stderr);
	assert.ok(result.stdout.includes("--version=VERSION"), result.stdout);
	assert.equal(existsSync(f.env.TEST_BUILD_LOG), false);
});

test(
	"filters precisely the capabilities provided by bundled libraries and retains system dependencies",
	{ skip: archiveTestsUnavailable },
	() => {
		const f = fixture();
		const result = run(f, "rpm", "--version=1.2.3", "--skip-build");
		assert.equal(result.status, 0, result.stderr);
		const macros = JSON.parse(readFileSync(f.env.TEST_RPM_MACROS, "utf8"));
		assert.equal(typeof macros.__requires_exclude, "string");
		const excluded = new RegExp(macros.__requires_exclude.replaceAll("\\\\", "\\"));
		for (const capability of readFileSync(f.env.TEST_LIBRARY_CAPABILITIES, "utf8").trim().split("\n")) {
			assert.equal(excluded.test(capability), true, capability);
		}
		for (const capability of [
			"libc.so.6()(64bit)",
			"libc.so.6(GLIBC_2.38)(64bit)",
			"libgtk-3.so.0()(64bit)",
			"libwebkit2gtk-4.1.so.0()(64bit)",
			"libasar.so()(32bit)",
			"libasar.so(NOT_BUNDLED)(64bit)",
			"libasarXso()(64bit)",
			"libspecialllll.so.1()(64bit)",
		]) {
			assert.equal(excluded.test(capability), false, capability);
		}
		const scanned = readFileSync(f.env.TEST_RPMDEPS_LOG, "utf8");
		assert.ok(scanned.startsWith("--provides\n"));
		assert.ok(scanned.includes("/lib/thinkrail/bin/libasar.so\n"));
		assert.ok(scanned.includes("/lib/thinkrail/bin/libspecial++.so.1\n"));
		assertPayload(f, join(f.env.TEST_RPMDIR, "payload/lib/thinkrail"));
	},
);

test(
	"uses a nonmatching filter when no private libraries are bundled",
	{ skip: process.platform !== "linux" },
	() => {
		const f = fixture("dev");
		for (const name of ["libasar.so", "libNativeWrapper.so", "libspecial++.so.1"]) {
			rmSync(join(f.bundle, "bin", name));
		}
		const result = run(f, "rpm", "--version=1.2.3", "--env=dev", "--skip-build");
		assert.equal(result.status, 0, result.stderr);
		const macros = JSON.parse(readFileSync(f.env.TEST_RPM_MACROS, "utf8"));
		assert.equal(macros.__requires_exclude, "^$");
		assert.equal(existsSync(f.env.TEST_RPMDEPS_LOG), false);
	},
);

test(
	"stops before packaging when private dependency inspection fails",
	{ skip: archiveTestsUnavailable },
	() => {
		const f = fixture();
		executable(join(f.env.TEST_RPM_CONFIG, "rpmdeps"), "#!/bin/sh\nexit 17\n");
		const result = run(f, "rpm", "--version=1.2.3", "--skip-build");
		assert.equal(result.status, 17);
		assert.equal(existsSync(f.env.TEST_RPM_MACROS), false);
		assert.deepEqual(readdirSync(join(f.desktop, "build")), []);
	},
);

test(
	"preserves exact capability matching through the real RPM macro parser",
	{ skip: rpmMacrosUnavailable },
	() => {
		const f = fixture();
		const result = run(f, "rpm", "--version=1.2.3", "--skip-build");
		assert.equal(result.status, 0, result.stderr);
		const macros = JSON.parse(readFileSync(f.env.TEST_RPM_MACROS, "utf8"));
		const evaluated = spawnSync(
			"rpm",
			["--define", `__requires_exclude ${macros.__requires_exclude}`, "--eval", "%{__requires_exclude}"],
			{ encoding: "utf8" },
		);
		assert.equal(evaluated.status, 0, evaluated.stderr);
		const excluded = new RegExp(evaluated.stdout.trim());
		assert.equal(excluded.test("libasar.so()(64bit)"), true);
		assert.equal(excluded.test("libasar.so(ASAR_1.0)(64bit)"), true);
		assert.equal(excluded.test("libspecial++.so.1()(64bit)"), true);
		assert.equal(excluded.test("libasarXso()(64bit)"), false);
		assert.equal(excluded.test("libc.so.6(GLIBC_2.38)(64bit)"), false);
	},
);
