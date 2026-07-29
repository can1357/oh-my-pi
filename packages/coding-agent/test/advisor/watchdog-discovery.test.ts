import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { discoverWatchdogFiles } from "../../src/advisor/watchdog";

describe("discoverWatchdogFiles", () => {
	it("loads project .ompk/WATCHDOG.md for the repo cwd", async () => {
		const cwd = path.resolve(import.meta.dir, "../../../..");
		const blocks = await discoverWatchdogFiles(cwd);
		const combined = blocks.join("\n");
		expect(combined).toContain("AssignmentContract verification");
		expect(combined).toContain("blind exploration");
	});
});
