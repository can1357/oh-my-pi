import { describe, expect, it } from "bun:test";
import { startCpuProfile } from "@oh-my-pi/pi-coding-agent/debug/profiler";

describe("startCpuProfile", () => {
	// Regression: `node:v8` `setFlagsFromString` throws on Bun
	// (oven-sh/bun#1702). The profiler used to call it unconditionally and
	// crash before connecting the inspector session. Running this test under
	// Bun guarantees the guard is in place — without it the call below would
	// reject with "node:v8 setFlagsFromString is not yet implemented in Bun".
	it("starts and stops successfully even when v8.setFlagsFromString is unavailable", async () => {
		const session = await startCpuProfile();
		// Run a tiny bit of work so the profile has at least one sample.
		let acc = 0;
		for (let i = 0; i < 10_000; i++) acc += i;
		expect(acc).toBeGreaterThan(0);

		const profile = await session.stop();
		const parsed = JSON.parse(profile.data) as { nodes: unknown[] };
		expect(Array.isArray(parsed.nodes)).toBe(true);
		expect(parsed.nodes.length).toBeGreaterThan(0);
		expect(typeof profile.markdown).toBe("string");
		expect(profile.markdown.length).toBeGreaterThan(0);
	});
});
