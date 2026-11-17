import { describe, expect, it } from "bun:test";
import { isDarkWakeSystemState, waitForFullWake } from "../src/session/dark-wake";

describe("isDarkWakeSystemState", () => {
	it("reads a wake without graphics as a dark wake and a wake with graphics as full", () => {
		expect(
			isDarkWakeSystemState("Current System Capabilities are: CPU Network Disk \nCurrent Power State: 4\n"),
		).toBe(true);
		expect(
			isDarkWakeSystemState(
				"Current System Capabilities are: CPU Graphics Audio Network \nCurrent Power State: 4\n",
			),
		).toBe(false);
	});

	it("reads output without a capabilities line as awake", () => {
		expect(isDarkWakeSystemState("pmset: unknown option\n")).toBe(false);
	});
});

describe("waitForFullWake", () => {
	it("holds until the probe reports a full wake", async () => {
		const states = [true, true, false];
		let probes = 0;
		await waitForFullWake(new AbortController().signal, async () => states[probes++] ?? false, 1);
		expect(probes).toBe(3);
	});

	it("rejects when aborted while held", async () => {
		const controller = new AbortController();
		const held = waitForFullWake(controller.signal, async () => true, 60_000);
		controller.abort();
		await expect(held).rejects.toThrow();
	});
});
