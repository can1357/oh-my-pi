import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { CliUsageError } from "@oh-my-pi/pi-coding-agent/cli/usage-error";

describe("--tui-mode", () => {
	it.each(["regular", "fullscreen"] as const)("parses %s", mode => {
		expect(parseArgs(["--tui-mode", mode]).tuiMode).toBe(mode);
		expect(parseArgs([`--tui-mode=${mode}`]).tuiMode).toBe(mode);
	});

	it("rejects a missing or invalid mode", () => {
		expect(() => parseArgs(["--tui-mode"])).toThrow("--tui-mode requires regular or fullscreen");
		expect(() => parseArgs(["--tui-mode", "windowed"])).toThrow(CliUsageError);
	});
});
