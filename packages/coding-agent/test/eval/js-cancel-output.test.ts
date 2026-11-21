import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import {
	disposeAllVmContexts,
	executeInVmContext,
	setJsEvalWorkerFactoriesForTests,
} from "../../src/eval/js/context-manager";
import { executeJs, type JsResult } from "../../src/eval/js/executor";
import type { ToolSession } from "../../src/tools";

const cleanups: Array<() => void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	await disposeAllVmContexts();
});

function toolSession(cwd: string, tool?: AgentTool): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		getToolByName: (name: string) => (tool?.name === name ? tool : undefined),
	};
}

/**
 * Run a cell that prints, then spins forever, and abort it while main has not handled that print.
 * The cell waits for a file main writes, prints, then writes a second file; main writes the first
 * and blocks synchronously until the second exists, then aborts. Main never yields in between, so
 * the print is queued but undispatched when the abort kills the worker.
 * Returns what the run observed, in order: each output chunk, then how the run settled.
 */
async function abortAfterUnhandledPrint(): Promise<string[]> {
	using dir = TempDir.createSync("@omp-js-cancel-output-");
	const go = path.join(dir.path(), "go");
	const printed = path.join(dir.path(), "printed");
	const sessionKey = `js-cancel-output:${crypto.randomUUID()}`;
	const events: string[] = [];
	const started = Promise.withResolvers<void>();
	const controller = new AbortController();
	const code = [
		// The cell's own module loader, not a static import of the test: fs is the cell's handshake channel.
		'const fs = await import("node:fs");',
		'console.log("started");',
		`while (!fs.existsSync(${JSON.stringify(go)})) {}`,
		'console.log("printed before the abort");',
		`fs.writeFileSync(${JSON.stringify(printed)}, "");`,
		"for (;;) {}",
	].join("\n");
	const run = executeInVmContext({
		sessionKey,
		sessionId: sessionKey,
		cwd: dir.path(),
		session: toolSession(dir.path()),
		code,
		filename: "cancel-output.js",
		timeoutMs: 60_000,
		runState: {
			signal: controller.signal,
			onText: chunk => {
				events.push(`text: ${chunk.trim()}`);
				if (chunk.includes("started")) started.resolve();
			},
		},
	}).then(
		() => events.push("settled: resolved"),
		(error: unknown) => events.push(`settled: ${error instanceof Error ? error.message : String(error)}`),
	);
	await started.promise;
	fs.writeFileSync(go, "");
	const deadline = Date.now() + 30_000;
	while (!fs.existsSync(printed)) {
		if (Date.now() > deadline) throw new Error("the cell never printed its second line");
		Bun.sleepSync(1);
	}
	controller.abort(new Error("cancelled by the test"));
	await run;
	return events;
}

describe("a JavaScript cell aborted while its output is still queued", () => {
	// executeJs dumps the cell's output when the run settles, so a chunk handed over after the
	// rejection is missing from the cancelled cell's output.
	const expected = ["text: started", "text: printed before the abort", "settled: cancelled by the test"];

	it("keeps that output, before the run settles, in subprocess mode", async () => {
		expect(await abortAfterUnhandledPrint()).toEqual(expected);
	});

	it("keeps that output, before the run settles, in worker-thread mode", async () => {
		let processSpawns = 0;
		cleanups.push(
			setJsEvalWorkerFactoriesForTests({
				spawnProcess: () => {
					processSpawns++;
					throw new Error("test: use the Bun Worker fallback");
				},
			}),
		);
		expect(await abortAfterUnhandledPrint()).toEqual(expected);
		expect(processSpawns).toBe(1);
	});
});

interface StoppedRun {
	/** Whether the host operation saw its cancellation. */
	aborted: boolean;
	/** What the caller was told. */
	result: JsResult;
}

/**
 * Run a cell that leaves a bridge call in flight and then kills its own runtime.
 *
 * The worker reports the cell finished while that call is still running, so the context manager
 * withholds the result until the call drains — a cell owns every bridge call it starts. The
 * runtime then dies. Stopping the session aborts the call, and the abort unwinds through the same
 * drain the stop is waiting on.
 */
async function runtimeDiesWithBridgeCallOutstanding(): Promise<StoppedRun> {
	using dir = TempDir.createSync("@omp-js-stop-held-result-");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let aborted = false;
	const slow: AgentTool = {
		name: "slow",
		label: "Slow",
		description: "A host operation that runs until it is cancelled",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute: async (_id, _args, signal) => {
			entered.resolve();
			signal?.addEventListener("abort", () => {
				aborted = true;
				release.reject(signal.reason);
			});
			await release.promise;
			return { content: [{ type: "text", text: "the host operation finished" }], details: {} };
		},
	};
	const code = [
		// The cell's own module loader: this exit happens in the runtime, not in the test process.
		'const runtime = await import("node:process");',
		// Floated, so the worker finishes the cell while the call is still running.
		"void tool.slow({}).catch(() => {});",
		'console.log("printed before the runtime stops");',
		// A real timer inside the runtime: the result has to reach the host and be withheld before
		// the runtime dies, and host fake time cannot advance a separate process or thread.
		"setTimeout(() => runtime.exit(17), 200);",
	].join("\n");
	const run = executeJs(code, {
		session: toolSession(dir.path(), slow),
		sessionId: `js-stop-held-result:${crypto.randomUUID()}`,
	});
	await entered.promise;
	const result = await run;
	return { aborted, result };
}

describe("a JavaScript cell whose runtime dies with a bridge call still running", () => {
	const expectStopReported = ({ aborted, result }: StoppedRun): void => {
		expect(aborted).toBe(true);
		// The output the runtime sent before it died is still the cell's output.
		expect(result.output).toContain("printed before the runtime stops");
		// Nobody cancelled this cell, and its host work never finished: a failure, with the reason.
		expect(result.cancelled).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("worker exited");
	};

	it("reports the death rather than the withheld success, in subprocess mode", async () => {
		expectStopReported(await runtimeDiesWithBridgeCallOutstanding());
	});

	it("reports the death rather than the withheld success, in worker-thread mode", async () => {
		let processSpawns = 0;
		cleanups.push(
			setJsEvalWorkerFactoriesForTests({
				spawnProcess: () => {
					processSpawns++;
					throw new Error("test: use the Bun Worker fallback");
				},
			}),
		);
		expectStopReported(await runtimeDiesWithBridgeCallOutstanding());
		expect(processSpawns).toBe(1);
	});
});
