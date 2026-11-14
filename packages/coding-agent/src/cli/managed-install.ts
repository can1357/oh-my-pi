/**
 * Installs another app keeps: an app that manages omp's executables or its
 * WebKit engine (Tern) puts `manager.json` (`{"manager": "tern", "name":
 * "Tern"}`) in the root it installs them in, two folders above each one
 * (`<root>/versions/<version>`, `<root>/bin/omp.exe`), and updates them
 * itself. `omp update` and omp's engine install leave such installs alone.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";

/**
 * Name of the app that manages the executable or engine directory at
 * `installPath`, judged from its real path: the manifest's `name`, else its
 * `manager`. Undefined when none does: no such path, or a missing,
 * unreadable or nameless manifest.
 */
export async function managedInstallName(installPath: string): Promise<string | undefined> {
	let resolved: string;
	try {
		resolved = fs.realpathSync.native(installPath);
	} catch {
		return undefined;
	}
	let manifest: unknown;
	try {
		manifest = await Bun.file(path.join(path.dirname(path.dirname(resolved)), "manager.json")).json();
	} catch {
		return undefined;
	}
	if (!isRecord(manifest)) return undefined;
	const name = typeof manifest.name === "string" && manifest.name ? manifest.name : manifest.manager;
	return typeof name === "string" && name ? name : undefined;
}
