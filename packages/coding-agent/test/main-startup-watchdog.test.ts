import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";

describe("startup watchdog under test runner", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not write startup watchdog messages to stderr during runRootCommand under bun test", async () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true as unknown as boolean);
		const stop = new Error("stop after auth discovery");
		const parsed = parseArgs([]);
		parsed.noExtensions = true;

		let thrownError: unknown;
		try {
			await runRootCommand(parsed, [], {
				discoverAuthStorage: async () => {
					throw stop;
				},
			});
		} catch (err) {
			thrownError = err;
		}
		expect(thrownError).toBe(stop);

		const watchdogMessages = stderrSpy.mock.calls.filter(call => {
			const text = typeof call[0] === "string" ? call[0] : "";
			return text.includes("Still starting after");
		});

		expect(watchdogMessages).toEqual([]);
	});
});
