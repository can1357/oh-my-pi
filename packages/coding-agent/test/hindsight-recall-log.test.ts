/**
 * Issue #10960: `recallForContext` only logged on failure, so a successful
 * recall left no trace — the recalled item count and latency were
 * unobservable in the debug log (the retain path is instrumented on both
 * outcomes). These tests pin the success-side log contract.
 */

import { describe, expect, it, vi } from "bun:test";
import type { RecallOptions, RecallResponse } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { logger } from "@oh-my-pi/pi-utils";

const makeConfig = (overrides: Partial<HindsightConfig> = {}): HindsightConfig => ({
	hindsightApiUrl: "http://localhost:8888",
	hindsightApiToken: null,
	bankId: null,
	bankIdPrefix: "",
	scoping: "global",
	bankMission: "",
	retainMission: null,
	autoRecall: true,
	autoRetain: true,
	retainMode: "full-session",
	retainEveryNTurns: 3,
	retainOverlapTurns: 2,
	retainContext: "omp",
	recallBudget: "mid",
	recallMaxTokens: 1024,
	recallTypes: ["world", "experience"],
	recallContextTurns: 1,
	recallMaxQueryChars: 800,
	recallPromptPreamble: "preamble",
	debug: true,
	requestTimeoutMs: 30_000,
	reflectTimeoutMs: 30_000,
	recallTimeoutMs: 30_000,
	retainTimeoutMs: 30_000,
	mentalModelsEnabled: false,
	mentalModelAutoSeed: false,
	mentalModelMaxRenderChars: 16_000,
	...overrides,
});

class FakeHindsightApi extends HindsightApi {
	constructor(private readonly results: RecallResponse["results"]) {
		super({ baseUrl: "http://localhost" });
	}

	override async recall(_bankId: string, _query: string, _options?: RecallOptions): Promise<RecallResponse> {
		return { results: this.results };
	}
}

function makeState(results: RecallResponse["results"], config = makeConfig()): HindsightSessionState {
	const session = { sessionId: "test-session" } as object as AgentSession;
	return new HindsightSessionState({
		sessionId: "test-session",
		client: new FakeHindsightApi(results),
		bankId: "test-bank",
		config,
		session,
		banksSet: new Set<string>(),
	});
}

function recallSuccessLogs(calls: unknown[][]): Array<Record<string, unknown>> {
	return calls
		.filter(call => call[0] === "Hindsight: recall succeeded")
		.map(call => (call[1] ?? {}) as Record<string, unknown>);
}

describe("Hindsight recall success logging (#10960)", () => {
	it("logs the recalled item count and latency on a successful recall", async () => {
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		try {
			const state = makeState([
				{ id: "1", text: "remembered fact" },
				{ id: "2", text: "another remembered fact" },
			]);

			const outcome = await state.recallForContext("what do we know?");

			expect(outcome.ok).toBe(true);
			expect(outcome.context).toContain("remembered fact");

			const logs = recallSuccessLogs(debugSpy.mock.calls);
			expect(logs.length).toBe(1);
			expect(logs[0].bankId).toBe("test-bank");
			expect(logs[0].items).toBe(2);
			expect(typeof logs[0].durationMs).toBe("number");
			expect(logs[0].durationMs as number).toBeGreaterThanOrEqual(0);
		} finally {
			debugSpy.mockRestore();
		}
	});

	it("logs a zero-item success line when recall returns no results", async () => {
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		try {
			const state = makeState([]);

			const outcome = await state.recallForContext("anything");

			expect(outcome.ok).toBe(true);
			expect(outcome.context).toBeNull();

			const logs = recallSuccessLogs(debugSpy.mock.calls);
			expect(logs.length).toBe(1);
			expect(logs[0].items).toBe(0);
			expect(typeof logs[0].durationMs).toBe("number");
		} finally {
			debugSpy.mockRestore();
		}
	});

	it("stays silent on the success path when debug logging is off", async () => {
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		try {
			const state = makeState([{ id: "1", text: "remembered fact" }], makeConfig({ debug: false }));

			await state.recallForContext("what do we know?");

			expect(recallSuccessLogs(debugSpy.mock.calls).length).toBe(0);
		} finally {
			debugSpy.mockRestore();
		}
	});
});
