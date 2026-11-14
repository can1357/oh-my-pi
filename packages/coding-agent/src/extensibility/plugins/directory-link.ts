import * as fs from "node:fs/promises";

/** Link a plugin directory without requiring Windows symlink privileges. */
export async function linkPluginDirectory(target: string, linkPath: string): Promise<void> {
	await fs.symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}
