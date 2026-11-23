/**
 * `execContained`: an abort that fired before the call spawns nothing and still reports the
 * documented killed result.
 */
import { describe, expect, it, vi } from "bun:test";
import { execContained } from "@oh-my-pi/pi-coding-agent/exec/exec";
import type { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import { failure } from "../helpers/sandbox-test-state";

function fakeRuntime() {
	const spawn = vi.fn(async () => {
		throw new Error("spawn refused");
	});
	return { runtime: { spawn } as unknown as SandboxRuntime, spawn };
}

describe("execContained", () => {
	it("returns the killed result without spawning when the signal already aborted", async () => {
		const { runtime, spawn } = fakeRuntime();
		const result = await execContained(runtime, ["true"], { cwd: "/", signal: AbortSignal.abort() });
		expect(result).toEqual({ stdout: "", stderr: "", code: -1, killed: true });
		expect(spawn).not.toHaveBeenCalled();
	});

	it("spawns when the signal has not aborted", async () => {
		const { runtime, spawn } = fakeRuntime();
		const error = await failure(execContained(runtime, ["true"], { cwd: "/", signal: new AbortController().signal }));
		expect((error as Error).message).toBe("spawn refused");
		expect(spawn).toHaveBeenCalledTimes(1);
	});
});
