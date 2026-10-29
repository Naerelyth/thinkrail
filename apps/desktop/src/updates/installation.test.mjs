import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, test } from "node:test";
import { readManualUpdateMethod } from "./installation.ts";

const roots = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function installation() {
	const root = mkdtempSync(join(tmpdir(), "thinkrail-update-method-"));
	roots.push(root);
	const resources = join(root, "lib/thinkrail/Resources");
	mkdirSync(resources, { recursive: true });
	return { resources, marker: join(root, ".thinkrail-update-method") };
}

test("unmarked native installations keep the normal update policy", () => {
	const { resources } = installation();
	assert.equal(readManualUpdateMethod(resources), undefined);
});

test("relative Resources paths resolve before the launcher leaves its working directory", () => {
	const { resources, marker } = installation();
	writeFileSync(marker, "rpm\n");
	assert.equal(readManualUpdateMethod(relative(process.cwd(), resources)), "rpm");
});

for (const method of ["rpm", "appimage"]) {
	test(`${method} wrappers select their manual update method`, () => {
		const { resources, marker } = installation();
		writeFileSync(marker, `${method}\n`);
		assert.equal(readManualUpdateMethod(resources), method);
	});
}

test("unknown or empty marker contents require generic manual updating", () => {
	const { resources, marker } = installation();
	for (const contents of ["", "unknown", "rpm\nappimage"]) {
		writeFileSync(marker, contents);
		assert.equal(readManualUpdateMethod(resources), "external");
	}
});

test("unreadable markers cannot enable the native updater", () => {
	const { resources, marker } = installation();
	mkdirSync(marker);
	assert.equal(readManualUpdateMethod(resources), "external");
});
