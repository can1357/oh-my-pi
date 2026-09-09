import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { executeJs, type JsResult } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

// JS eval cold-starts a Bun worker; under --isolate + high CI concurrency that startup
// can exceed Bun's 5s default per-test timeout, flaking the suite. Give the worker-backed
// tests headroom above the worker-init floor (context-manager WORKER_INIT_TIMEOUT_MS).
setDefaultTimeout(20_000);

function statusEvents(result: JsResult) {
	return result.displayOutputs.filter(
		(output): output is Extract<JsResult["displayOutputs"][number], { type: "status" }> => output.type === "status",
	);
}

function baseSession(cwd: string, sessionFile: string, extra?: Partial<ToolSession>): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		...extra,
	} as ToolSession;
}

describe("executeJs workflow helpers", () => {
	let tempDir: TempDir;
	let sessionFile: string;

	beforeAll(() => {
		tempDir = TempDir.createSync("@js-workflow-helpers-");
		sessionFile = path.join(tempDir.path(), "session.jsonl");
	});

	afterAll(async () => {
		await disposeAllVmContexts();
		tempDir.removeSync();
	});

	it("emits log and phase status events", async () => {
		const session = baseSession(tempDir.path(), sessionFile);
		const result = await executeJs('log("hello"); phase("Scan");', {
			sessionId: `js-logphase:${tempDir.path()}`,
			session,
			sessionFile,
		});
		expect(result.exitCode).toBe(0);
		const events = statusEvents(result);
		const log = events.find(e => e.event.op === "log");
		const phase = events.find(e => e.event.op === "phase");
		expect(log?.event.message).toBe("hello");
		expect(phase?.event.title).toBe("Scan");
	});

	it("reads the turn budget from Goal Mode via the __budget__ bridge", async () => {
		const session = baseSession(tempDir.path(), sessionFile, {
			getGoalModeState: () => ({
				enabled: true,
				mode: "active",
				goal: {
					id: "g1",
					objective: "x",
					status: "active",
					tokenBudget: 100_000,
					tokensUsed: 4_200,
					timeUsedSeconds: 0,
					createdAt: 0,
					updatedAt: 0,
				},
			}),
		});
		const result = await executeJs(
			"return JSON.stringify([await budget.total(), await budget.spent(), await budget.remaining()]);",
			{ sessionId: `js-budget-goal:${tempDir.path()}`, session, sessionFile },
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("[100000,4200,95800]");
	});

	it("falls back to session output tokens with no ceiling when Goal Mode is inactive", async () => {
		const session = baseSession(tempDir.path(), sessionFile, {
			getUsageStatistics: () => ({
				input: 10,
				output: 777,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 787,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		});
		const result = await executeJs(
			"return JSON.stringify([await budget.total(), await budget.spent(), (await budget.remaining()) === Infinity]);",
			{ sessionId: `js-budget-usage:${tempDir.path()}`, session, sessionFile },
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("[null,777,true]");
	});
});
