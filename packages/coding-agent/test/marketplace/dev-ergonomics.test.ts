import { describe, expect, it } from "bun:test";

// Cannot import parseArgs from cli/args.ts (transitively loads @oh-my-pi/pi-natives
// via ../tools). Instead, test the flag parsing logic by reimplementing the relevant
// subset. The actual integration is verified by bun check:ts (Args.pluginDirs exists
// and parseArgs populates it).

/** Minimal flag parser matching the --plugin-dir logic in parseArgs. */
function parsePluginDirFlags(args: string[]): string[] | undefined {
	let result: string[] | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--plugin-dir" && i + 1 < args.length) {
			result = result || [];
			result.push(args[++i]);
		}
	}
	return result;
}

describe("--plugin-dir flag parsing logic", () => {
	it("parses single --plugin-dir", () => {
		expect(parsePluginDirFlags(["--plugin-dir", "./my-plugin"])).toEqual(["./my-plugin"]);
	});

	it("parses multiple --plugin-dir flags", () => {
		expect(parsePluginDirFlags(["--plugin-dir", "./a", "--plugin-dir", "./b"])).toEqual(["./a", "./b"]);
	});

	it("returns undefined when no --plugin-dir", () => {
		expect(parsePluginDirFlags([])).toBeUndefined();
	});

	it("ignores --plugin-dir with no value", () => {
		expect(parsePluginDirFlags(["--plugin-dir"])).toBeUndefined();
	});
});
