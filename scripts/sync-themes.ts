#!/usr/bin/env bun
/**
 * Syncs the theme index file with the JSON files in the defaults directory.
 * Usage: bun scripts/sync-themes.ts
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

const THEMES_DIR = join(process.cwd(), "packages/coding-agent/src/modes/interactive/theme/defaults");
const INDEX_FILE = join(THEMES_DIR, "index.ts");

async function main() {
	const files = await readdir(THEMES_DIR);
	const jsonFiles = files.filter(f => f.endsWith(".json")).sort();

	const imports: string[] = [];
	const exportEntries: string[] = [];

	for (const file of jsonFiles) {
		const name = file.replace(".json", "");
		const varName = name.replace(/-/g, "_");

		imports.push(`import ${varName} from "./${file}" with { type: "json" };`);
		exportEntries.push(`	"${name}": ${varName},`);
	}

	let content = imports.join("\n");
	content += "\n\nexport const defaultThemes = {\n";
	content += exportEntries.join("\n");
	content += "\n};\n";

	await Bun.write(INDEX_FILE, content);
	console.log(`Updated ${INDEX_FILE} with ${jsonFiles.length} themes.`);
}

main().catch(console.error);
