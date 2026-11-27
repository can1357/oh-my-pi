import * as fs from "node:fs";
import * as path from "node:path";

/** Tags per note name, stored in `<root>/index.json`. */
export type Index = Record<string, string[]>;

export function readIndex(root: string): Index {
	const file = path.join(root, "index.json");
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

export function writeIndex(root: string, index: Index): void {
	fs.writeFileSync(path.join(root, "index.json"), `${JSON.stringify(index, null, "\t")}\n`);
}
