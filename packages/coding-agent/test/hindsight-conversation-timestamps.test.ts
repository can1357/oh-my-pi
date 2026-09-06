import { afterEach, describe, expect, it, vi } from "bun:test";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import { extractMessages } from "@oh-my-pi/pi-coding-agent/hindsight/transcript";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

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

function expectSameInstant(actual: unknown, isoUtc: string): void {
	expect(typeof actual).toBe("string");
	expect(String(actual)).not.toBe(isoUtc);
	expect(Date.parse(String(actual))).toBe(Date.parse(isoUtc));
}

const SESSION_START = "2026-08-17T09:00:00.000Z";
const USER_TS = "2026-08-17T10:00:00.000Z";
const ASSISTANT_TS = "2026-08-17T10:00:05.000Z";

function conversationEntries(): SessionEntry[] {
	return [
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: USER_TS,
			message: {
				role: "user",
				content: "i stopped doing that yesterday",
				timestamp: Date.parse(USER_TS),
			},
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: ASSISTANT_TS,
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "internal monologue must not be retained" },
					{ type: "text", text: "got it, that was sunday then" },
					{
						type: "toolCall",
						id: "call-1",
						name: "bash",
						arguments: { command: "echo secret" },
					},
				],
				timestamp: Date.parse(ASSISTANT_TS),
			},
		},
		{
			type: "thinking_level_change",
			id: "tl1",
			parentId: "a1",
			timestamp: "2026-08-17T10:00:06.000Z",
			thinkingLevel: "high",
		},
		{
			type: "message",
			id: "tool-noise",
			parentId: "tl1",
			timestamp: "2026-08-17T10:00:07.000Z",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: "secret tool output" }],
				isError: false,
				timestamp: Date.parse("2026-08-17T10:00:07.000Z"),
			},
		},
	] as SessionEntry[];
}

describe("Hindsight conversation source timestamps", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps user/assistant SessionEntry timestamps and drops thinking/tool entries", () => {
		const extracted = extractMessages({ getEntries: () => conversationEntries() });
		expect(extracted).toEqual([
			{
				role: "user",
				content: "i stopped doing that yesterday",
				timestamp: USER_TS,
			},
			{
				role: "assistant",
				content: "got it, that was sunday then",
				timestamp: ASSISTANT_TS,
			},
		]);
		expect(extracted.some(m => m.content.includes("internal monologue"))).toBe(false);
		expect(extracted.some(m => m.content.includes("secret tool output"))).toBe(false);
	});

	it("uses the session start timestamp on every retain of the same conversation", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const entries = conversationEntries();
		const state = new HindsightSessionState({
			sessionId: "sess-ts",
			client,
			bankId: "personal",
			config: makeConfig(),
			session: {
				sessionId: "sess-ts",
				sessionManager: {
					getEntries: () => entries,
					getHeader: () => ({
						type: "session",
						id: "sess-ts",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		const first = extractMessages({ getEntries: () => entries });
		await state.retainSession(first);
		const laterEntries = [
			...entries,
			{
				type: "message",
				id: "u2",
				parentId: "a1",
				timestamp: "2026-08-21T15:00:00.000Z",
				message: {
					role: "user",
					content: "same conversation, later thursday turn",
					timestamp: Date.parse("2026-08-21T15:00:00.000Z"),
				},
			} as SessionEntry,
		];
		await state.retainSession(extractMessages({ getEntries: () => laterEntries }));

		expect(bodies).toHaveLength(2);
		expectSameInstant(firstItem(bodies[0]).timestamp, SESSION_START);
		expectSameInstant(firstItem(bodies[1]).timestamp, SESSION_START);
		expect(String(firstItem(bodies[0]).content)).toContain("[timestamp: 2026-08-17T10:00:00.000Z]");
		expect(String(firstItem(bodies[0]).content)).toContain("[timestamp: 2026-08-17T10:00:05.000Z]");
		expect(String(firstItem(bodies[1]).content)).toContain("same conversation, later thursday turn");
		expect(String(firstItem(bodies[1]).content)).not.toContain("internal monologue");
		expect(String(firstItem(bodies[1]).content)).not.toContain("secret tool output");
		expect(String(firstItem(bodies[1]).content)).not.toContain("<memories>");
	});

	it("falls back to retain-time when the session header timestamp is invalid", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const entries = conversationEntries();
		const state = new HindsightSessionState({
			sessionId: "sess-bad-ts",
			client,
			bankId: "personal",
			config: makeConfig(),
			session: {
				sessionId: "sess-bad-ts",
				sessionManager: {
					getEntries: () => entries,
					getHeader: () => ({
						type: "session",
						id: "sess-bad-ts",
						timestamp: "not-a-date",
						cwd: "/tmp",
					}),
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.retainSession(extractMessages({ getEntries: () => entries }));
		expect(bodies).toHaveLength(1);
		expect(firstItem(bodies[0]).timestamp).not.toBe("not-a-date");
		expect(Number.isNaN(Date.parse(String(firstItem(bodies[0]).timestamp)))).toBe(false);
	});
});
