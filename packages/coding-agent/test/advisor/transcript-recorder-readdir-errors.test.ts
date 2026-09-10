// Issue #11476: directory scans must not swallow real readdir errors.
// loadAdvisorTranscriptCosts maps EVERY readdir failure to an empty scan, so an
// unreadable (e.g. ENOTDIR) transcript directory is reported as "no spend".
// Real errors must warn; ENOENT (absent directory) stays silent.
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger, removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { loadAdvisorTranscriptCosts } from "../../src/advisor/transcript-recorder";

describe("loadAdvisorTranscriptCosts readdir errors", () => {
	let tempDir!: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-transcript-readdir-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		removeSyncWithRetries(tempDir);
	});

	test("warns when the transcript directory is not a directory (ENOTDIR), still returns empty", async () => {
		const blocker = path.join(tempDir, "blocker");
		fs.writeFileSync(blocker, "not a directory");
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const costs = await loadAdvisorTranscriptCosts(`${blocker}.jsonl`);

		expect(costs.size).toBe(0);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(String(warnSpy.mock.calls[0]?.[0] ?? "")).toMatch(/transcript/i);
	});

	test("stays silent when the transcript directory does not exist (ENOENT)", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const costs = await loadAdvisorTranscriptCosts(path.join(tempDir, "missing", "session.jsonl"));

		expect(costs.size).toBe(0);
		expect(warnSpy).not.toHaveBeenCalled();
	});
});
