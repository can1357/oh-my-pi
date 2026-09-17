/**
 * Regression guard for #11961: Hindsight mental models must not rewrite the
 * active session's cached system-prompt prefix. Two independent churn sources
 * are covered — volatile render metadata and the removed on-timer reload.
 */

import { describe, expect, it, vi } from "bun:test";
import type {
	HindsightApi,
	MentalModelListResponse,
	MentalModelSummary,
} from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { renderMentalModelsBlock } from "@oh-my-pi/pi-coding-agent/hindsight/mental-models";
import type { AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import { SessionMemory, type SessionMemoryHost } from "@oh-my-pi/pi-coding-agent/session/session-memory";

function makeConfig(overrides: Partial<HindsightConfig> = {}): HindsightConfig {
	return {
		hindsightApiUrl: "http://localhost:8888",
		hindsightApiToken: null,
		bankId: null,
		bankIdPrefix: "",
		scoping: "global",
		bankMission: "",
		retainMission: null,
		autoRecall: false,
		autoRetain: false,
		retainMode: "full-session",
		retainEveryNTurns: 3,
		retainOverlapTurns: 2,
		retainContext: "omp",
		recallBudget: "mid",
		recallMaxTokens: 1024,
		recallTypes: [],
		recallContextTurns: 1,
		recallMaxQueryChars: 800,
		recallPromptPreamble: "preamble",
		debug: false,
		requestTimeoutMs: 30_000,
		reflectTimeoutMs: 120_000,
		recallTimeoutMs: 30_000,
		retainTimeoutMs: 60_000,
		mentalModelsEnabled: true,
		mentalModelAutoSeed: false,
		mentalModelMaxRenderChars: 16_000,
		...overrides,
	};
}

describe("renderMentalModelsBlock cache stability", () => {
	it("is byte-identical when only last_refreshed_at changes", () => {
		const model: MentalModelSummary = { id: "u", bank_id: "b", name: "User Preferences", content: "prefers tabs" };
		const early = renderMentalModelsBlock([{ ...model, last_refreshed_at: "2026-09-12T20:00:00Z" }], 16_000);
		const late = renderMentalModelsBlock([{ ...model, last_refreshed_at: "2026-09-12T20:10:00Z" }], 16_000);
		expect(early).toBe(late);
		// And the volatile timestamp never leaks into the model-facing block.
		expect(early).not.toContain("refreshed");
	});
});

describe("HindsightSessionState mental-model freeze", () => {
	function makeState() {
		const listeners = new Set<AgentSessionEventListener>();
		const listMentalModels = vi.fn(async () => ({ items: [] }));
		const client = { listMentalModels } as unknown as HindsightApi;
		const state = new HindsightSessionState({
			sessionId: "s",
			client,
			bankId: "b",
			config: makeConfig(),
			session: {
				subscribe: (fn: AgentSessionEventListener) => {
					listeners.add(fn);
					return () => listeners.delete(fn);
				},
				refreshBaseSystemPrompt: async () => {},
				sessionManager: { getEntries: () => [] },
			} as never,
			banksSet: new Set(),
			lastRetainedTurn: 0,
			hasRecalledForFirstTurn: false,
		});
		return { state, listeners, listMentalModels };
	}

	it("does not reload the snippet on agent_end even long past the old TTL window", () => {
		const { state, listeners, listMentalModels } = makeState();
		const flush = vi.spyOn(state, "flushRetainQueue").mockResolvedValue();
		state.mentalModelsSnippet = "<mental_models>frozen</mental_models>";
		// Loaded well beyond any previous refresh interval — the timer path is gone.
		state.mentalModelsLoadedAt = Date.now() - 60 * 60 * 1000;

		state.attachSessionListeners();
		for (const fn of listeners) fn({ type: "agent_end", messages: [] } as never);

		// Listener is live (retain queue drained) but the frozen block is untouched.
		expect(flush).toHaveBeenCalled();
		expect(listMentalModels).not.toHaveBeenCalled();
		expect(state.mentalModelsSnippet).toBe("<mental_models>frozen</mental_models>");
	});
});

describe("SessionMemory mental-model boundary reload", () => {
	function makeBoundaryHarness(response: Promise<MentalModelListResponse>, publicationGate?: Promise<void>) {
		const published: Array<string | undefined> = [];
		const client = { listMentalModels: () => response } as unknown as HindsightApi;
		const stateSession: {
			refreshBaseSystemPrompt: (commitIf?: () => boolean) => Promise<void>;
			sessionManager: { getEntries: () => never[] };
		} = {
			refreshBaseSystemPrompt: async () => {},
			sessionManager: { getEntries: () => [] },
		};
		const state = new HindsightSessionState({
			sessionId: "next-session",
			client,
			bankId: "b",
			config: makeConfig(),
			session: stateSession as never,
			banksSet: new Set(),
			lastRetainedTurn: 0,
			hasRecalledForFirstTurn: false,
		});
		const publishBoundary = async (commitIf?: () => boolean) => {
			await publicationGate;
			if (!commitIf || commitIf()) published.push(state.mentalModelsSnippet);
		};
		const publishReset = async () => {
			published.push(state.mentalModelsSnippet);
		};
		stateSession.refreshBaseSystemPrompt = publishBoundary;
		state.mentalModelsSnippet = "<mental_models>old</mental_models>";
		state.mentalModelsLoadedAt = Date.now();
		const host = {
			agent: { sessionId: "next-session" },
			settings: Settings.isolated({ "memory.backend": "hindsight" }),
			modelRegistry: {},
			isDisposed: () => false,
			memoryBackendSession: () => ({}),
			getHindsightSessionState: () => state,
			setHindsightSessionState: () => {},
			getMnemopiSessionState: () => undefined,
			takeMnemopiSessionState: () => undefined,
			setBaseSystemPrompt: () => {},
			refreshBaseSystemPrompt: publishReset,
			replaceMemoryTools: async () => {},
		} as unknown as SessionMemoryHost;
		return { memory: new SessionMemory(host, {}), published, state };
	}

	it("does not block the transition and publishes a refresh that meets the first-turn deadline", async () => {
		const response = Promise.withResolvers<MentalModelListResponse>();
		const { memory, published, state } = makeBoundaryHarness(response.promise);

		await memory.resetContextForNewTranscript();
		expect(published).toEqual(["<mental_models>old</mental_models>"]);

		response.resolve({
			items: [{ id: "u", bank_id: "b", name: "User Preferences", content: "updated preference" }],
		});
		await state.mentalModelsLoadPromise;

		expect(published).toHaveLength(2);
		expect(published[1]).toContain("updated preference");
	});

	it("preserves the previous snapshot when the boundary fetch rejects", async () => {
		const response = Promise.withResolvers<MentalModelListResponse>();
		const { memory, published, state } = makeBoundaryHarness(response.promise);

		await memory.resetContextForNewTranscript();
		response.reject(new Error("Hindsight unavailable"));
		await state.mentalModelsLoadPromise;

		expect(state.mentalModelsSnippet).toBe("<mental_models>old</mental_models>");
		expect(published).toEqual(["<mental_models>old</mental_models>"]);
	});

	it("clears the previous snapshot after a successful empty response", async () => {
		const response = Promise.withResolvers<MentalModelListResponse>();
		const { memory, published, state } = makeBoundaryHarness(response.promise);

		await memory.resetContextForNewTranscript();
		response.resolve({ items: [] });
		await state.mentalModelsLoadPromise;

		expect(state.mentalModelsSnippet).toBeUndefined();
		expect(published).toEqual(["<mental_models>old</mental_models>", undefined]);
	});

	it("preserves the previous snapshot when the reload misses the deadline", async () => {
		vi.useFakeTimers();
		try {
			const response = Promise.withResolvers<MentalModelListResponse>();
			const { memory, published, state } = makeBoundaryHarness(response.promise);

			await memory.resetContextForNewTranscript();
			vi.advanceTimersByTime(1_500);
			await state.mentalModelsLoadPromise;

			response.resolve({
				items: [{ id: "u", bank_id: "b", name: "User Preferences", content: "late preference" }],
			});
			await Promise.resolve();

			expect(state.mentalModelsSnippet).toBe("<mental_models>old</mental_models>");
			expect(published).toEqual(["<mental_models>old</mental_models>"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("discards a snapshot whose prompt publication misses the deadline", async () => {
		vi.useFakeTimers();
		try {
			const publication = Promise.withResolvers<void>();
			const response = Promise.resolve<MentalModelListResponse>({
				items: [{ id: "u", bank_id: "b", name: "User Preferences", content: "unpublished preference" }],
			});
			const { memory, published, state } = makeBoundaryHarness(response, publication.promise);

			await memory.resetContextForNewTranscript();
			await Promise.resolve();
			vi.advanceTimersByTime(1_500);
			await state.mentalModelsLoadPromise;

			expect(state.mentalModelsSnippet).toBe("<mental_models>old</mental_models>");
			publication.resolve();
			await Promise.resolve();
			expect(published).toEqual(["<mental_models>old</mental_models>"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("discards a pending bootstrap write after a transcript boundary reload", async () => {
		const bootstrapResponse = Promise.withResolvers<MentalModelListResponse>();
		const boundaryResponse = Promise.withResolvers<MentalModelListResponse>();
		let request = 0;
		const client = {
			listMentalModels: () => (request++ === 0 ? bootstrapResponse.promise : boundaryResponse.promise),
		} as unknown as HindsightApi;
		const published: Array<string | undefined> = [];
		const stateSession: {
			refreshBaseSystemPrompt: (commitIf?: () => boolean) => Promise<void>;
			sessionManager: { getEntries: () => never[] };
		} = {
			refreshBaseSystemPrompt: async commitIf => {
				if (!commitIf || commitIf()) published.push(state.mentalModelsSnippet);
			},
			sessionManager: { getEntries: () => [] },
		};
		const state = new HindsightSessionState({
			sessionId: "s",
			client,
			bankId: "b",
			config: makeConfig(),
			session: stateSession as never,
			banksSet: new Set(["b"]),
			lastRetainedTurn: 0,
			hasRecalledForFirstTurn: false,
		});

		const bootstrap = state.runMentalModelLoad({ bankId: "b" });
		await Promise.resolve();
		state.beginMentalModelsTranscriptReload();
		boundaryResponse.resolve({
			items: [{ id: "new", bank_id: "b", name: "User Preferences", content: "boundary preference" }],
		});
		await state.mentalModelsLoadPromise;
		bootstrapResponse.resolve({
			items: [{ id: "old", bank_id: "b", name: "User Preferences", content: "stale bootstrap preference" }],
		});
		await bootstrap;

		expect(state.mentalModelsSnippet).toContain("boundary preference");
		expect(state.mentalModelsSnippet).not.toContain("stale bootstrap preference");
		expect(published).toHaveLength(1);
	});
});
