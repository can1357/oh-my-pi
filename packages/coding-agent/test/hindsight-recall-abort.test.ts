import { describe, expect, it } from "bun:test";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

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
	debug: false,
	requestTimeoutMs: 30_000,
	reflectTimeoutMs: 30_000,
	recallTimeoutMs: 30_000,
	retainTimeoutMs: 30_000,
	mentalModelsEnabled: false,
	mentalModelAutoSeed: false,
	mentalModelMaxRenderChars: 16_000,
	...overrides,
});

class Deferred<T> {
	promise: Promise<T>;
	resolve!: (value: T) => void;
	reject!: (error: unknown) => void;
	constructor() {
		this.promise = new Promise<T>((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}
}

/**
 * Esc during Hindsight auto-recall (#12668): the in-flight recall must abort
 * so turn setup unwinds promptly and the stale result is never committed,
 * allowing the released submission to resubmit cleanly.
 */
describe("Hindsight pending recall abort", () => {
	it("aborts the in-flight recall fetch and refuses to commit the stale result", async () => {
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const deferred = new Deferred<{ results: { id: string; text: string }[] }>();
		const seenSignals: (AbortSignal | undefined)[] = [];
		const slowRecall = (bankId: string, query: string, options?: { signal?: AbortSignal }) => {
			seenSignals.push(options?.signal);
			const { signal } = options ?? {};
			if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
			return new Promise<{ results: { id: string; text: string }[] }>((resolve, reject) => {
				signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
				void deferred.promise.then(resolve, reject);
			});
		};
		client.recall = slowRecall as typeof client.recall;

		const session = {
			sessionId: "sess-recall-abort",
			sessionManager: { getEntries: () => [] },
		} as object as AgentSession;
		const state = new HindsightSessionState({
			sessionId: "sess-recall-abort",
			client,
			bankId: "personal",
			config: makeConfig(),
			session,
			banksSet: new Set(["personal"]),
		});

		const pending = state.beforeAgentStartPrompt("what did we decide?");
		// The recall mock attaches synchronously (no awaits precede it), so a
		// microtask flush is enough — no wall-clock wait for the in-flight fetch.
		await Promise.resolve();
		expect(seenSignals.length).toBe(1);

		state.abortPendingRecall("esc");
		const preparation = await pending;
		expect(preparation).toBeUndefined();
		expect(state.hasRecalledForFirstTurn).toBe(false);
	});

	it("passes the recall signal through to the HTTP client", async () => {
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const seenSignals: (AbortSignal | undefined)[] = [];
		client.recall = (async (_bankId: string, _query: string, options?: { signal?: AbortSignal }) => {
			seenSignals.push(options?.signal);
			return { results: [{ id: "1", text: "remembered fact" }] };
		}) as typeof client.recall;

		const session = {
			sessionId: "sess-recall-signal",
			sessionManager: { getEntries: () => [] },
		} as object as AgentSession;
		const state = new HindsightSessionState({
			sessionId: "sess-recall-signal",
			client,
			bankId: "personal",
			config: makeConfig(),
			session,
			banksSet: new Set(["personal"]),
		});

		const preparation = await state.beforeAgentStartPrompt("what did we decide?");
		expect(seenSignals.length).toBe(1);
		expect(preparation?.context).toContain("remembered fact");
		expect(preparation?.commit()).toBe(true);
		expect(state.hasRecalledForFirstTurn).toBe(true);
	});
});
