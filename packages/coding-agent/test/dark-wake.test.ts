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
		await waitForFullWake(new AbortController().signal, { probe: async () => states[probes++] ?? false, pollMs: 1 });
		expect(probes).toBe(3);
	});

	it("rejects on abort while a probe is still pending", async () => {
		const controller = new AbortController();
		const probe = Promise.withResolvers<boolean>();
		const held = waitForFullWake(controller.signal, { probe: () => probe.promise, pollMs: 1 });
		controller.abort();
		await expect(held).rejects.toThrow();
	});

	it("rejects when aborted while held between probes", async () => {
		const controller = new AbortController();
		const probed = Promise.withResolvers<void>();
		const held = waitForFullWake(controller.signal, {
			probe: async () => {
				probed.resolve();
				return true;
			},
			pollMs: 60_000,
		});
		await probed.promise;
		controller.abort();
		await expect(held).rejects.toThrow();
	});
});
