import { afterEach, describe, expect, it, vi } from "bun:test";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import type { HindsightMessage } from "@oh-my-pi/pi-coding-agent/hindsight/content";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function captureBodies(): unknown[] {
	const bodies: unknown[] = [];
	const fetchMock: typeof globalThis.fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
			bodies.push(JSON.parse(String(init?.body ?? "{}")));
			return new Response("{}", { status: 200 });
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
	return bodies;
}

const makeConfig = (overrides: Partial<HindsightConfig> = {}): HindsightConfig => ({
	hindsightApiUrl: "http://localhost:8888",
	hindsightApiToken: null,
	bankId: "personal",
	bankIdPrefix: "",
	scoping: "per-project-tagged",
	bankMission: "",
	retainMission: null,
	autoRecall: true,
	autoRetain: true,
	retainMode: "full-session",
	retainEveryNTurns: 3,
	retainOverlapTurns: 2,
	retainContext: "omp",
	retainStrategy: null,
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
	mentalModelRefreshIntervalMs: 5 * 60 * 1000,
	mentalModelMaxRenderChars: 16_000,
	...overrides,
});

function firstItem(body: unknown): Record<string, unknown> {
	if (typeof body !== "object" || body === null) throw new Error("missing retain body");
	const items = (body as { items?: unknown }).items;
	if (!Array.isArray(items) || items[0] === undefined) throw new Error("missing retain item");
	const item = items[0];
	if (typeof item !== "object" || item === null) throw new Error("retain item is not an object");
	return item as Record<string, unknown>;
}

describe("Hindsight retain strategy request bodies", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("omits item.strategy when retainStrategy is unset", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const state = new HindsightSessionState({
			sessionId: "sess-unset",
			client,
			bankId: "personal",
			retainTags: ["project:speech-core"],
			config: makeConfig(),
			session: {
				sessionId: "sess-unset",
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.retainSession([{ role: "user", content: "remember this decision" }]);
		const item = firstItem(bodies[0]);
		expect(item).not.toHaveProperty("strategy");
		expect(item.metadata).toEqual({ session_id: "sess-unset" });
		expect(item.tags).toEqual(["project:speech-core"]);
		expect(JSON.stringify(item)).not.toContain("strategy:");
	});

	it("serializes retainStrategy as item.strategy and not a strategy tag or metadata field", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const messages: HindsightMessage[] = [{ role: "user", content: "pin the speech-core decoder" }];
		const state = new HindsightSessionState({
			sessionId: "sess-1",
			client,
			bankId: "personal",
			retainTags: ["project:speech-core"],
			config: makeConfig({ retainStrategy: "personal_chat" }),
			session: {
				sessionId: "sess-1",
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.retainSession(messages);
		const item = firstItem(bodies[0]);
		expect(item.strategy).toBe("personal_chat");
		expect(item.tags).toEqual(["project:speech-core"]);
		expect(item.tags).not.toContain("strategy:personal_chat");
		expect(item.metadata).toEqual({ session_id: "sess-1" });
		expect(item).not.toHaveProperty("observation_scopes");
	});

	it("forwards retainStrategy on tool-initiated retain queue flushes", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const state = new HindsightSessionState({
			sessionId: "sess-queue",
			client,
			bankId: "personal",
			retainTags: ["project:speech-core"],
			config: makeConfig({ retainStrategy: "personal_chat" }),
			session: {
				sessionId: "sess-queue",
				emitNotice: () => {},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		state.enqueueRetain("operator prefers tabs over spaces");
		await state.flushRetainQueue();
		const item = firstItem(bodies[0]);
		expect(item.strategy).toBe("personal_chat");
		expect(item.content).toBe("operator prefers tabs over spaces");
		expect(item.tags).not.toContain("strategy:personal_chat");
		expect(item.metadata).toEqual({ session_id: "sess-queue" });
		expect(item).not.toHaveProperty("observation_scopes");
	});
});
