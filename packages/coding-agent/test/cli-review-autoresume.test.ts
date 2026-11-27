import { describe, expect, it, vi } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("freshSession session selection", () => {
	it("does not implicitly resume a previous transcript", async () => {
		using dir = TempDir.createSync("@omp-review-resume-");
		const previous = SessionManager.inMemory();
		previous.appendMessage({ role: "user", content: "Earlier conversation", timestamp: Date.now() });
		const resume = vi.spyOn(SessionManager, "continueRecent").mockResolvedValue(previous);
		const settings = Settings.isolated({ autoResume: true });
		try {
			const ordinaryArgs = parseArgs([]);
			const ordinary = await createSessionManager(ordinaryArgs, dir.path(), settings);
			expect(ordinary?.getEntries()).toHaveLength(1);
			expect(ordinaryArgs.continue).toBe(true);

			const fresh = await createSessionManager(parseArgs([]), dir.path(), settings, async () => "keep", {
				freshSession: true,
			});
			expect(fresh).toBeUndefined();
			expect(resume).toHaveBeenCalledTimes(1);
		} finally {
			resume.mockRestore();
			await previous.close();
		}
	});
});
