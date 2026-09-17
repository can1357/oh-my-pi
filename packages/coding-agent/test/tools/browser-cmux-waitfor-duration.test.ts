import { describe, expect, it } from "bun:test";
import { CmuxTab } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/cmux-tab";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";

// Regression coverage for the cmux-backed `tab.waitFor(ms)` duration form (#12137
// review): the numeric overload previously fell through to `#waitForSelector`, where
// `assertSelectorString` rejected the number — so the duration form worked on Chromium
// workers but threw under cmux. These cases run with no daemon connection: the duration
// path must validate and sleep locally, never reaching the transport.

function unconnectedTab(): CmuxTab {
	return new CmuxTab({
		client: new CmuxSocketClient({ socketPath: "/tmp/unused-cmux-waitfor-duration.sock" }),
		surfaceId: "waitfor-duration-probe",
	});
}

describe("CmuxTab.waitFor duration form", () => {
	it("completes a zero-duration wait immediately instead of throwing a selector assertion error", async () => {
		const tab = unconnectedTab();
		const start = Date.now();
		await expect(tab.waitFor(0)).resolves.toBeUndefined();
		expect(Date.now() - start).toBeLessThan(250);
	});

	it("resolves short positive durations locally without contacting the daemon", async () => {
		const tab = unconnectedTab();
		const start = Date.now();
		await expect(tab.waitFor(5)).resolves.toBeUndefined();
		expect(Date.now() - start).toBeLessThan(250);
	});

	it("rejects negative and non-finite durations with a named error before any transport use", async () => {
		const tab = unconnectedTab();
		for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
			await expect(tab.waitFor(bad)).rejects.toThrow(/non-negative duration/);
		}
	});
});
