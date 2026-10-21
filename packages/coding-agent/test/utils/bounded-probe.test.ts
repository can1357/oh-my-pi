import { describe, expect, it, vi } from "bun:test";
import { ptree } from "@oh-my-pi/pi-utils";
import { probeStdout, runBoundedProcess } from "@oh-my-pi/pi-coding-agent/utils/bounded-probe";

describe("runBoundedProcess", () => {
	it("kills a probe that never exits instead of blocking startup (#8402)", async () => {
		// Integration test against real OS timer behavior: the contract is that
		// the probe's wall-clock bound actually kills a genuinely blocked
		// child. Fake timers cannot stand in for it — the deadline lives in the
		// OS process lifecycle, not in the test's clock — so this drives the
		// real one and injects a short budget instead of paying the production
		// probe cost. The real-timer exception applies deliberately here.
		const start = performance.now();
		const result = await runBoundedProcess([process.execPath, "-e", "await Bun.sleep(60_000)"], { timeoutMs: 25 });
		const elapsed = performance.now() - start;
		expect(result.timedOut).toBe(true);
		expect(result.exitCode).toBeNull();
		// Loose bound proves the probe returned via its timeout, not the child.
		expect(elapsed).toBeLessThan(1_000);
	});

	it("delivers its result at the deadline even when the child never exits (#8402)", async () => {
		// The wedged-interop failure the bound exists for: the kill is delivered
		// but the child never settles its exit promise, so a helper that awaits
		// that promise holds its caller open indefinitely. The result must
		// therefore be delivered by the wall-clock deadline while the cleanup
		// continues in the background.
		//
		// The real-timer exception applies: the deadline lives in the OS
		// process lifecycle and in the helper's own wall clock, so fake timers
		// cannot advance it. The wait is short (25 ms) and asserts an upper
		// bound, so it does not mask a race.
		vi.spyOn(ptree, "exec").mockImplementation(
			() =>
				new Promise(() => {
					// Never settles: the child cannot be reaped.
				}),
		);
		try {
			const start = performance.now();
			const result = await runBoundedProcess(["whatever"], { timeoutMs: 25 });
			const elapsed = performance.now() - start;
			expect(result.timedOut).toBe(true);
			expect(result.exitCode).toBeNull();
			expect(elapsed).toBeLessThan(1_000);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("returns trimmed stdout for a probe that succeeds (#8402)", async () => {
		const result = await runBoundedProcess([process.execPath, "-e", "process.stdout.write('  host-home  ')"]);
		expect(result.stdout).toBe("host-home");
		expect(result.exitCode).toBe(0);
		expect(result.timedOut).toBe(false);
		expect(result.aborted).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"keeps the probe bound when a descendant inherits stdout (#8402)",
		async () => {
			// The pipe is held open by the forked child, not by the leader the
			// deadline kills: only a group kill plus cancelled pipe readers ends
			// the wait at the deadline instead of when the descendant exits. The
			// elapsed wall clock is the contract, so it has to be the real one.
			const start = performance.now();
			const result = await runBoundedProcess(["sh", "-c", "sleep 3 & exec sleep 60"], { timeoutMs: 25 });
			const elapsed = performance.now() - start;
			expect(result.timedOut).toBe(true);
			expect(elapsed).toBeLessThan(1_000);
		},
	);

	it("reports a non-zero exit with its real code (#8402)", async () => {
		const result = await runBoundedProcess([process.execPath, "-e", "process.exit(3)"]);
		expect(result.exitCode).toBe(3);
		expect(result.timedOut).toBe(false);
		expect(result.aborted).toBe(false);
	});

	it("reports an aborted probe without a result (#8402)", async () => {
		const result = await runBoundedProcess([process.execPath, "-e", "await Bun.sleep(60_000)"], {
			timeoutMs: 5_000,
			signal: AbortSignal.timeout(50),
		});
		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBeNull();
	});
});

describe("probeStdout", () => {
	it("returns the trimmed stdout of a successful probe (#8402)", async () => {
		const result = await probeStdout([process.execPath, "-e", "process.stdout.write('  host-home  ')"]);
		expect(result).toBe("host-home");
	});

	it("treats a non-zero exit as an unavailable host (#8402)", async () => {
		const result = await probeStdout([process.execPath, "-e", "process.exit(3)"]);
		expect(result).toBeUndefined();
	});

	it("treats empty stdout as an unavailable host (#8402)", async () => {
		const result = await probeStdout([process.execPath, "-e", "process.stdout.write('')"]);
		expect(result).toBeUndefined();
	});

	it("treats a killed probe as an unavailable host (#8402)", async () => {
		const result = await probeStdout([process.execPath, "-e", "await Bun.sleep(60_000)"], { timeoutMs: 25 });
		expect(result).toBeUndefined();
	});

	it("treats a missing command as an unavailable host (#8402)", async () => {
		const result = await probeStdout(["omp-no-such-command-probe"]);
		expect(result).toBeUndefined();
	});
});
