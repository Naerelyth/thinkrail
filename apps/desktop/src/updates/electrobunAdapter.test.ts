import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Linux wrapper markers select manual updates on every channel, including dev", () => {
	const root = mkdtempSync(join(tmpdir(), "thinkrail-update-adapter-"));
	try {
		mkdirSync(join(root, "lib/thinkrail/Resources"), { recursive: true });
		const script = `
import { mock } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
const [adapter, root] = process.argv.slice(1);
let channel = "dev";
const unexpected = () => { throw new Error("manual updater must remain inert"); };
mock.module("electrobun/main", () => ({
  PATHS: { RESOURCES_FOLDER: join(root, "lib/thinkrail/Resources") },
  Updater: {
    getLocalInfo: async () => ({ channel, version: "1.2.3", baseUrl: "https://example.invalid/u" }),
    updateInfo: unexpected,
    onStatusChange: unexpected,
    checkForUpdate: unexpected,
    downloadUpdate: unexpected,
  },
  Utils: {},
}));
const { createElectrobunUpdateController } = await import(adapter);
const states = [];
for (channel of ["stable", "canary", "dev"]) {
  for (const method of ["rpm", "appimage"]) {
    writeFileSync(join(root, ".thinkrail-update-method"), method);
    const controller = await createElectrobunUpdateController({
      isPackaged: channel !== "dev", platform: "linux", arch: "x64",
      version: "1.2.3", channel, userData: root, restartToUpdate: unexpected,
    });
    controller.start();
    await controller.checkForUpdates();
    await controller.downloadUpdate();
    await controller.restartToUpdate();
    const state = await controller.getState();
    states.push([state.channel, state.status, state.manualUpdate]);
    controller.dispose();
  }
}
unlinkSync(join(root, ".thinkrail-update-method"));
const source = await createElectrobunUpdateController({
  isPackaged: false, platform: "linux", arch: "x64", version: "1.2.3", channel: "dev",
  userData: root, restartToUpdate: unexpected,
});
states.push([(await source.getState()).status]);
source.dispose();
console.log(JSON.stringify(states));
`;
		const result = Bun.spawnSync(
			[process.execPath, "--eval", script, join(import.meta.dir, "electrobunAdapter.ts"), root],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.stderr.toString()).toBe("");
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toEqual([
			["stable", "manual", "rpm"],
			["stable", "manual", "appimage"],
			["canary", "manual", "rpm"],
			["canary", "manual", "appimage"],
			["dev", "manual", "rpm"],
			["dev", "manual", "appimage"],
			["disabled"],
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
