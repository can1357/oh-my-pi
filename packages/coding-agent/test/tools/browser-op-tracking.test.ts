import { describe, expect, it } from "bun:test";
import {
	describeInflight,
	describeScreenshot,
	type InflightOp,
	preparePageForScreenshot,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";

type ScreenshotPage = Parameters<typeof preparePageForScreenshot>[0];

describe("browser op tracking — timeout diagnostics", () => {
	it("labels a screenshot op by its distinguishing argument", () => {
		expect(describeScreenshot({ selector: ".wb-paper-popover" })).toBe(
			'tab.screenshot({ selector: ".wb-paper-popover" })',
		);
		expect(describeScreenshot({ fullPage: true })).toBe("tab.screenshot({ fullPage: true })");
		expect(describeScreenshot()).toBe("tab.screenshot()");
		expect(describeScreenshot({})).toBe("tab.screenshot()");
	});

	it("names every still-running helper so a cell timeout is attributable", () => {
		const now = Date.now();
		// Inserted newest-first to prove the summary sorts by start time, not insertion order.
		const inflight = new Map<number, InflightOp>([
			[1, { label: "tab.observe()", startedAt: now - 1_000 }],
			[0, { label: 'tab.screenshot({ selector: ".x" })', startedAt: now - 3_000 }],
		]);

		const summary = describeInflight(inflight);

		// Oldest op (most likely the culprit) is listed first.
		expect(summary.indexOf("tab.screenshot")).toBeLessThan(summary.indexOf("tab.observe"));
		// Each op carries an elapsed-seconds annotation.
		expect(summary).toMatch(/tab\.screenshot\(\{ selector: "\.x" \}\) \(\d+\.\d+s\)/);
		expect(summary).toMatch(/tab\.observe\(\) \(\d+\.\d+s\)/);
	});

	it("returns an empty summary when nothing is in flight", () => {
		expect(describeInflight(new Map())).toBe("");
	});
});

describe("browser screenshot activation", () => {
	it("activates owned targets before capture", async () => {
		let activations = 0;
		const page = {
			bringToFront: async () => {
				activations += 1;
			},
			evaluate: async () => {
				throw new Error("visibility should not be queried");
			},
		};

		await preparePageForScreenshot(page as ScreenshotPage, undefined, true);

		expect(activations).toBe(1);
	});

	it("leaves a visible user-driven target in place", async () => {
		let activations = 0;
		const page = {
			bringToFront: async () => {
				activations += 1;
			},
			evaluate: async () => true,
		};

		await preparePageForScreenshot(page as ScreenshotPage, undefined, false);

		expect(activations).toBe(0);
	});

	it("rejects a background user-driven target instead of capturing sibling pixels", async () => {
		const page = {
			bringToFront: async () => undefined,
			evaluate: async () => false,
		};

		await expect(preparePageForScreenshot(page as ScreenshotPage, undefined, false)).rejects.toThrow(
			"The attached browser tab is not visible",
		);
	});
});
