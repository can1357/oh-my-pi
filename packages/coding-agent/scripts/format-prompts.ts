#!/usr/bin/env bun
import { prompt } from "@oh-my-pi/pi-utils";
import { Glob } from "bun";

const SOURCE_DIR = `${import.meta.dir}/../src`;

const PROMPT_FORMAT_OPTIONS = {
	renderPhase: "pre-render",
	replaceAsciiSymbols: true,
	normalizeRfc2119: true,
} as const;

async function main() {
	const glob = new Glob("**/prompts/**/*.md");
	let changed = 0;
	const check = process.argv.includes("--check");

	for await (const fullPath of glob.scan({ cwd: SOURCE_DIR, absolute: true })) {
		const original = await Bun.file(fullPath).text();
		const formatted = prompt.format(original, PROMPT_FORMAT_OPTIONS);

		if (original !== `${formatted}\n`) {
			if (check) {
				console.log(`Would format: ${fullPath}`);
			} else {
				await Bun.write(fullPath, `${formatted}\n`);
				console.log(`Formatted: ${fullPath}`);
			}
			changed++;
		}
	}

	if (check && changed > 0) {
		console.log(`\n${changed} file(s) need formatting. Run 'bun run format-prompts' to fix.`);
		process.exit(1);
	} else if (changed === 0) {
		console.log("All prompt files are formatted.");
	} else {
		console.log(`\nFormatted ${changed} file(s).`);
	}
}

main();
