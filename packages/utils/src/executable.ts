import * as fs from "node:fs";

/**
 * Check if a file path exists, is a regular file, and has effective execute permission.
 */
export function isExecutable(filePath: string): boolean {
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) return false;
		if (process.platform !== "win32") {
			fs.accessSync(filePath, fs.constants.X_OK);
		}
		return true;
	} catch {
		return false;
	}
}
