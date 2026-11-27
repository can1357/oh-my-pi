import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as path from "node:path";

const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");

async function launch(args: string[]): Promise<{ exitCode: number; stderr: string }> {
	using dir = TempDir.createSync("@omp-preset-flag-");
	const proc = Bun.spawn([process.execPath, cliEntry, "--no-session", ...args], {
		cwd: dir.path(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	return { exitCode, stderr };
}

describe("--preset launch option", () => {
	it("parses a preset name as one value, not a positional prompt", () => {
		const args = parseArgs(["--preset", "deep", "hello"]);
		expect(args.preset).toBe("deep");
		expect(args.messages).toEqual(["hello"]);
		expect(args.unrecognizedFlags).toEqual([]);
	});

	it("rejects a bare --preset as a usage error", () => {
		const args = parseArgs(["-p", "hello", "--preset"]);
		expect(args.invalidFlagValues).toEqual(["--preset requires a preset name."]);
		expect(args.preset).toBeUndefined();
	});

	it("rejects a flag-looking preset value without letting that flag act", () => {
		const args = parseArgs(["--preset", "--profile", "work"]);
		expect(args.invalidFlagValues).toContain("--preset requires a preset name.");
	});

	it("keeps --preset reserved against a same-named extension flag", () => {
		const extensionFlags = new Map([["preset", { type: "string" as const }]]);
		const parsed = parseArgs(["--preset", "deep"], extensionFlags);
		expect(parsed.preset).toBe("deep");
		expect(parsed.unknownFlags.has("preset")).toBe(false);
	});

	it("rejects a bare --preset launch with a usage exit", async () => {
		const result = await launch(["-p", "hello", "--preset"]);
		expect(result.exitCode, result.stderr).toBe(2);
		expect(result.stderr).toContain("--preset requires a preset name.");
	}, 30_000);
});
