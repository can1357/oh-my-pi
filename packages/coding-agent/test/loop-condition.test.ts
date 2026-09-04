import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	describeLoopCondition,
	evaluateLoopCondition,
	type LoopConditionVerdict,
} from "@oh-my-pi/pi-coding-agent/modes/loop-condition";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("evaluateLoopCondition", () => {
	let tempDir: TempDir;

	beforeAll(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-loop-condition-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
	});

	afterAll(() => {
		tempDir.removeSync();
		resetSettingsForTest();
	});

	function run(
		command: string,
		until: boolean,
		options?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<LoopConditionVerdict> {
		return evaluateLoopCondition(
			{ command, until },
			{ cwd: tempDir.path(), timeoutMs: options?.timeoutMs ?? 30_000, signal: options?.signal },
		);
	}

	it("reads exit 0 as true and exit 1 as false for --while", async () => {
		expect(await run("true", false)).toEqual({ kind: "continue" });
		expect((await run("false", false)).kind).toBe("halt");
	});

	it("inverts both outcomes for --until", async () => {
		expect(await run("false", true)).toEqual({ kind: "continue" });
		expect((await run("true", true)).kind).toBe("halt");
	});

	// The whole point of the exit>1 branch: a condition that cannot run must not
	// look like a condition that answered "stop". Both polarities agree here,
	// because a broken command has no truth value to invert.
	it("treats an unrunnable command as broken rather than false", async () => {
		for (const until of [false, true]) {
			const verdict = await run("definitely-not-a-real-binary-xyz", until);
			expect(verdict.kind).toBe("error");
			// The exit status is the actionable payload — without it the user
			// cannot tell a typo from a genuine stop.
			if (verdict.kind !== "error") throw new Error("expected an error verdict");
			expect(verdict.message).toContain("127");
		}
	});

	it("treats a shell syntax error as broken rather than false", async () => {
		const verdict = await run("if [ ; then", false);
		expect(verdict.kind).toBe("error");
	});

	// Deliberate real delay: the deadline is enforced by the native shell around
	// a real child process, so fake timers cannot drive it. Kept short.
	it("stops the loop when the condition outruns its deadline", async () => {
		const verdict = await run("sleep 30", false, { timeoutMs: 200 });
		expect(verdict.kind).toBe("error");
		if (verdict.kind !== "error") throw new Error("expected an error verdict");
		expect(verdict.message).toContain("timed out");
	});

	// Esc during a condition is not a broken condition: the caller has already
	// paused the loop and must not also print a failure. Deliberate real delay
	// (see the timeout test above): aborting a real spawned shell process can't
	// be driven by fake timers, so this must wait for the process to actually
	// start before aborting it mid-flight — a pre-aborted signal would only
	// exercise the short-circuit before any process spawns.
	it("reports a user abort distinctly from a failure", async () => {
		const controller = new AbortController();
		const pending = run("sleep 30", false, { signal: controller.signal });
		await Bun.sleep(50);
		controller.abort();
		expect(await pending).toEqual({ kind: "aborted" });
	});

	it("ignores stdout when it contradicts the exit status", async () => {
		// `echo false` exits 0. Reading stdout would halt a --while loop here.
		expect(await run("echo false", false)).toEqual({ kind: "continue" });
	});
});

describe("describeLoopCondition", () => {
	it("names the polarity so the enable message is unambiguous", () => {
		expect(describeLoopCondition({ command: "bun test", until: true })).toBe("until `bun test` succeeds");
		expect(describeLoopCondition({ command: "bun test", until: false })).toBe("while `bun test` succeeds");
	});
});
