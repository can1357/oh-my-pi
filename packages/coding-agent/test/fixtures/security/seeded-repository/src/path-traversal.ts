import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function readExport(root: string, requestedName: string): Promise<string> {
	// Deliberately vulnerable fixture: no containment check after path resolution.
	return fs.readFile(path.join(root, requestedName), "utf-8");
}
