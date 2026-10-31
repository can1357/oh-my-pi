import { describe, expect, it } from "bun:test";
import { HindsightApi, HindsightError, type RecallOptions } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HINDSIGHT_NOTICE_SOURCE, HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const config = {
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
	recallTypes: [],
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
} satisfies HindsightConfig;

interface Notice {
	level: string;
	message: string;
	source?: string;
}

/** Recall that fails with `error` once `fail()` is called, or rejects as soon as its signal aborts. */
class FailingRecallApi extends HindsightApi {
	#failures: (() => void)[] = [];

	constructor(readonly error: Error) {
		super({ baseUrl: "http://localhost" });
	}

	override recall(_bankId: string, _query: string, options?: RecallOptions): Promise<never> {
		const { promise, reject } = Promise.withResolvers<never>();
		options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
		this.#failures.push(() => reject(this.error));
		return promise;
	}

	fail(): void {
		for (const fail of this.#failures.splice(0)) fail();
	}
}

function setup(error: Error = new HindsightError("recall request timed out after 30s")) {
	const notices: Notice[] = [];
	const session = {
		sessionId: "s",
		emitNotice: (level: string, message: string, source?: string) => notices.push({ level, message, source }),
	} as object as AgentSession;
	const client = new FailingRecallApi(error);
	const state = new HindsightSessionState({
		sessionId: "s",
		client,
		bankId: "b",
		config,
		session,
		banksSet: new Set(),
	});
	return { notices, client, state };
}

describe("Hindsight recall failure notice", () => {
	it("warns once with server text stripped of terminal controls and bounded to one line", async () => {
		const { notices, client, state } = setup(
			new HindsightError(`recall failed: \x1b[2Jboom\nline two\t${"x".repeat(5000)}`, 500),
		);
		const outcome = state.recallForContext("query");
		client.fail();

		expect(await outcome).toEqual({ context: null, ok: false });
		expect(notices).toHaveLength(1);
		const [notice] = notices;
		expect(notice.level).toBe("warning");
		expect(notice.source).toBe(HINDSIGHT_NOTICE_SOURCE);
		expect(notice.message.startsWith("Memory recall failed: recall failed: boom line two x")).toBe(true);
		expect(notice.message).not.toMatch(/[\x00-\x1f\x7f]/);
		expect(notice.message.length).toBeLessThan(250);
	});

	it("stays silent when a superseded compaction aborts its recall", async () => {
		const { notices, state } = setup();
		const controller = new AbortController();
		const outcome = state.recallForCompaction([{ role: "user", content: "what did we decide?" }], controller.signal);
		controller.abort();

		expect(await outcome).toBeUndefined();
		expect(notices).toEqual([]);
	});

	it("stays silent when the failure lands after a conversation reset", async () => {
		const { notices, client, state } = setup();
		const outcome = state.recallForContext("query");
		state.resetConversationTracking();
		client.fail();

		expect((await outcome).ok).toBe(false);
		expect(notices).toEqual([]);
	});
});
