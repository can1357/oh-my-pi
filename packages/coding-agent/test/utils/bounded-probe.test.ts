import { describe, expect, it } from "bun:test";
import { runBoundedProbe } from "@oh-my-pi/pi-coding-agent/utils/bounded-probe";

describe("runBoundedProbe", () => {
	it("kills a probe that never exits instead of blocking startup (#8402)", async () => {
		// Integration test against real OS timer behavior: the contract is that
		// the probe's wall-clock bound actually kills a genuinely blocked
		// child. Fake timers cannot stand in for it — the deadline lives in the
		// OS process lifecycle, not in the test's clock — so this drives the
		// real one and injects a short budget instead of paying the production
		// probe cost.
		const start = performance.now();
		const result = await runBoundedProbe([process.execPath, "-e", "await Bun.sleep(60_000)"], 25);
		const elapsed = performance.now() - start;
		expect(result).toBeUndefined();
		// Loose bound proves the probe returned via its timeout, not the child.
		expect(elapsed).toBeLessThan(1_000);
	});

	it("returns trimmed stdout for a probe that succeeds (#8402)", async () => {
		const result = await runBoundedProbe([process.execPath, "-e", "process.stdout.write('  host-home  ')"]);
		expect(result).toBe("host-home");
	});

	it.skipIf(process.platform === "win32")(
		"keeps the probe bound when a descendant inherits stdout (#8402)",
		async () => {
			// The pipe is held open by the forked child, not by the leader the
			// deadline kills: only a group kill plus cancelled pipe readers ends
			// the wait at the deadline instead of when the descendant exits. The
			// elapsed wall clock is the contract, so it has to be the real one.
			const start = performance.now();
			const result = await runBoundedProbe(["sh", "-c", "sleep 3 & exec sleep 60"], 25);
			const elapsed = performance.now() - start;
			expect(result).toBeUndefined();
			expect(elapsed).toBeLessThan(1_000);
		},
	);

	it("treats a non-zero exit as an unavailable host (#8402)", async () => {
		const result = await runBoundedProbe([process.execPath, "-e", "process.exit(3)"]);
		expect(result).toBeUndefined();
	});

	it("treats empty stdout as an unavailable host (#8402)", async () => {
		const result = await runBoundedProbe([process.execPath, "-e", "process.stdout.write('')"]);
		expect(result).toBeUndefined();
	});
});
