import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";

describe("parseArgs — Windows extension paths", () => {
	it("rejoins a module path split at spaces before parsing following flags", () => {
		const parsed = parseArgs([
			"--extension",
			"C:\\Users\\Shi",
			"Xin\\AppData\\Local\\ompcot\\extensions\\embedded-server.mjs",
			"--mode",
			"rpc",
		]);

		expect(parsed.extensions).toEqual([
			"C:\\Users\\Shi Xin\\AppData\\Local\\ompcot\\extensions\\embedded-server.mjs",
		]);
		expect(parsed.messages).toEqual([]);
		expect(parsed.mode).toBe("rpc");
	});
});

describe("parseArgs — trusted extension allowlist", () => {
	it("accepts repeatable native absolute paths", () => {
		const parsed = parseArgs(["--trusted-extension", "/opt/omp/policy.ts", "--trusted-extension=/opt/omp/audit.ts"]);

		expect(parsed.trustedExtensions).toEqual(["/opt/omp/policy.ts", "/opt/omp/audit.ts"]);
	});

	it("ignores trusted-looking tokens outside trusted flag dispatch", () => {
		expect(parseArgs(["--", "--trusted-extension"]).messages).toEqual(["--trusted-extension"]);
		expect(parseArgs(["--system-prompt", "--trusted-extension"]).systemPrompt).toBe("--trusted-extension");
	});

	it("fails closed on missing, relative, swallowed, or mixed values", () => {
		expect(() => parseArgs(["--trusted-extension"])).toThrow(/requires a non-empty/);
		expect(() => parseArgs(["--trusted-extension="])).toThrow(/requires a non-empty/);
		expect(() => parseArgs(["--trusted-extension", "relative.ts"])).toThrow(/absolute path/);
		expect(() => parseArgs(["--extension", "--trusted-extension", "/opt/omp/policy.ts"])).toThrow(
			/requires a non-empty/,
		);
		expect(() => parseArgs(["--trusted-extension", "/opt/omp/policy.ts", "--hook", "/tmp/hook.ts"])).toThrow(
			/cannot be combined/,
		);
	});
});
