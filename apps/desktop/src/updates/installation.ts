import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NativeUpdateState } from "@thinkrail/contracts";

export function readManualUpdateMethod(
	resourcesFolder: string,
): NativeUpdateState["manualUpdate"] {
	let method: string;
	try {
		method = readFileSync(
			resolve(resourcesFolder, "../../..", ".thinkrail-update-method"),
			"utf8",
		).trim();
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		return "external";
	}
	return method === "rpm" || method === "appimage" ? method : "external";
}
