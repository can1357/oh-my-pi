import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { executeJulia } from "../../src/eval/jl/executor";

// Regression for review round 4 P11/P14 and round 5 P19: createCancelledJuliaResult
// must gate its timeout annotation on `timedOut` — in both directions. A plain
// user abort with a timeout configured used to render "[cell timed out after Ns]"
// while the structured termination correctly said interrupted; conversely, a
// broken TimeoutError detection would silently downgrade a real timeout to a
// plain cancel. No Julia install is needed: executeJulia short-circuits an
// already-aborted signal before ensureKernelAvailable, so these run the real
// factory on any machine.
describe("eval Julia cancelled results", () => {
	it("renders [execution cancelled] for a plain user abort even when a timeout is configured", async () => {
		using tempDir = TempDir.createSync("@omp-eval-julia-cancel-");
		const controller = new AbortController();
		controller.abort(); // plain abort — not a timeout

		const result = await executeJulia("1 + 1", {
			cwd: tempDir.path(),
			timeoutMs: 5000,
			signal: controller.signal,
		});

		expect(result.output).toContain("[execution cancelled]");
		expect(result.output).not.toContain("timed out");
	});

	it("renders the timeout annotation and structured termination for a TimeoutError abort", async () => {
		using tempDir = TempDir.createSync("@omp-eval-julia-cancel-");
		const controller = new AbortController();
		controller.abort(Object.assign(new Error("deadline exceeded"), { name: "TimeoutError" }));

		const result = await executeJulia("1 + 1", {
			cwd: tempDir.path(),
			timeoutMs: 5000,
			signal: controller.signal,
		});

		expect(result.output).toContain("[cell timed out after 5s]");
		expect(result.termination).toEqual({ kind: "timed_out", timeoutMs: 5000 });
	});
});
