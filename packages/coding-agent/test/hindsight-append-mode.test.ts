import { afterEach, describe, expect, it, vi } from "bun:test";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import type { HindsightMessage } from "@oh-my-pi/pi-coding-agent/hindsight/content";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import { countRetainableUserTurns } from "@oh-my-pi/pi-coding-agent/hindsight/transcript";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

function captureBodies(opts?: { delay?: Promise<void>; onStart?: () => void }): unknown[] {
	const bodies: unknown[] = [];
	const fetchMock: typeof globalThis.fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
			opts?.onStart?.();
			if (opts?.delay) await opts.delay;
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
	retainEveryNTurns: 5,
	retainOverlapTurns: 2,
	retainContext: "omp",
	retainUpdateMode: "replace",
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

function retainBodyAsync(body: unknown): unknown {
	if (typeof body !== "object" || body === null) throw new Error("missing retain body");
	if (!("async" in body)) throw new Error("missing retain async flag");
	return body.async;
}

const SESSION_START = "2026-08-17T09:00:00.000Z";

function turn(role: "user" | "assistant", content: string): HindsightMessage {
	return { role, content };
}

function userEntry(id: string, parentId: string | null, content: string, timestamp: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "user", content, timestamp: Date.parse(timestamp) },
	} as SessionEntry;
}

function assistantEntry(id: string, parentId: string, content: string, timestamp: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: content }],
			timestamp: Date.parse(timestamp),
		},
	} as SessionEntry;
}

function resetBoundaryEntry(id: string, parentId: string, timestamp: string): SessionEntry {
	return {
		type: "reset_boundary",
		id,
		parentId,
		timestamp,
	};
}

describe("Hindsight append-mode session retention", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps default replace behavior: no update_mode and a full transcript on later retains", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const first = [turn("user", "hello first turn here")];
		const second = [
			...first,
			turn("assistant", "first reply is long enough"),
			turn("user", "hello second turn here"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-replace",
			client,
			bankId: "personal",
			config: makeConfig(),
			session: { sessionId: "sess-replace", getHindsightSessionState: () => state } as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.retainSession(first);
		await state.retainSession(second);
		expect(firstItem(bodies[0])).not.toHaveProperty("update_mode");
		expect(firstItem(bodies[1])).not.toHaveProperty("update_mode");
		expect(firstItem(bodies[0]).document_id).toBe("sess-replace");
		expect(firstItem(bodies[1]).document_id).toBe("sess-replace");
		expect(String(firstItem(bodies[1]).content)).toContain("hello first turn here");
		expect(String(firstItem(bodies[1]).content)).toContain("hello second turn here");
		expect(retainBodyAsync(bodies[0])).toBe(false);
		expect(retainBodyAsync(bodies[1])).toBe(false);
	});

	it("appends only the new delta to the same document_id without resending history", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const first = [turn("user", "hello first turn here"), turn("assistant", "first reply is long enough")];
		const second = [...first, turn("user", "hello second turn here")];
		const state = new HindsightSessionState({
			sessionId: "sess-append",
			client,
			bankId: "personal",
			config: makeConfig({ retainUpdateMode: "append", retainOverlapTurns: 2 }),
			session: {
				sessionId: "sess-append",
				sessionManager: {
					getHeader: () => ({ type: "session", id: "sess-append", timestamp: SESSION_START, cwd: "/tmp" }),
					getEntries: () => [],
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.retainSession(first);
		await state.retainSession(second);

		expect(firstItem(bodies[0])).not.toHaveProperty("update_mode");
		expect(firstItem(bodies[0]).document_id).toBe("sess-append");
		expect(firstItem(bodies[1]).document_id).toBe("sess-append");
		expect(firstItem(bodies[1]).update_mode).toBe("append");
		expect(String(firstItem(bodies[1]).content)).toContain("hello second turn here");
		expect(String(firstItem(bodies[1]).content)).not.toContain("hello first turn here");
		expect(String(firstItem(bodies[1]).content)).not.toContain("first reply is long enough");
		expect(retainBodyAsync(bodies[0])).toBe(false);
		expect(retainBodyAsync(bodies[1])).toBe(false);
	});

	it("retries the uncommitted delta after a failed append retain", async () => {
		const bodies: unknown[] = [];
		let remainingFailures = 1;
		const fetchMock: typeof globalThis.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
				bodies.push(JSON.parse(String(init?.body ?? "{}")));
				if (remainingFailures > 0) {
					remainingFailures -= 1;
					return new Response("retain failed", { status: 500 });
				}
				return new Response("{}", { status: 200 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const first = [turn("user", "hello first turn here"), turn("assistant", "first reply is long enough")];
		const second = [...first, turn("user", "hello second turn here")];
		const state = new HindsightSessionState({
			sessionId: "sess-append-retry",
			client,
			bankId: "personal",
			config: makeConfig({ retainUpdateMode: "append" }),
			session: {
				sessionId: "sess-append-retry",
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await expect(state.retainSession(first)).rejects.toThrow(/retain failed/);
		await state.retainSession(second);

		expect(bodies).toHaveLength(2);
		expect(retainBodyAsync(bodies[0])).toBe(false);
		expect(retainBodyAsync(bodies[1])).toBe(false);
		expect(firstItem(bodies[1])).not.toHaveProperty("update_mode");
		expect(String(firstItem(bodies[1]).content)).toContain("hello first turn here");
		expect(String(firstItem(bodies[1]).content)).toContain("first reply is long enough");
		expect(String(firstItem(bodies[1]).content)).toContain("hello second turn here");
	});

	it("rebuilds with replace after an ambiguous append retain failure", async () => {
		const bodies: unknown[] = [];
		let remainingFailures = 1;
		const fetchMock: typeof globalThis.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
				bodies.push(JSON.parse(String(init?.body ?? "{}")));
				if (bodies.length > 1 && remainingFailures > 0) {
					remainingFailures -= 1;
					return new Response("retain failed", { status: 500 });
				}
				return new Response("{}", { status: 200 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const first = [turn("user", "hello first turn here"), turn("assistant", "first reply is long enough")];
		const second = [...first, turn("user", "hello second turn here")];
		const state = new HindsightSessionState({
			sessionId: "sess-append-ambiguous",
			client,
			bankId: "personal",
			config: makeConfig({ retainUpdateMode: "append" }),
			session: {
				sessionId: "sess-append-ambiguous",
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.retainSession(first);
		await expect(state.retainSession(second)).rejects.toThrow(/retain failed/);
		await state.retainSession(second);

		expect(bodies).toHaveLength(3);
		expect(firstItem(bodies[1]).update_mode).toBe("append");
		expect(String(firstItem(bodies[1]).content)).toContain("hello second turn here");
		expect(String(firstItem(bodies[1]).content)).not.toContain("hello first turn here");
		expect(firstItem(bodies[2]).update_mode).toBe("replace");
		expect(String(firstItem(bodies[2]).content)).toContain("hello first turn here");
		expect(String(firstItem(bodies[2]).content)).toContain("first reply is long enough");
		expect(String(firstItem(bodies[2]).content)).toContain("hello second turn here");
	});

	it("omits pre-clear history from a below-cadence close retain after /clear", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const beforeClear = [
			userEntry("u1", null, "cleared turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "cleared reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "cleared turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "cleared reply two has enough text", "2026-08-17T10:01:01.000Z"),
		];
		let entries: SessionEntry[] = beforeClear;
		const state = new HindsightSessionState({
			sessionId: "sess-clear-close",
			client,
			bankId: "personal",
			config: makeConfig({ retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-clear-close",
				sessionManager: {
					getHeader: () => ({ type: "session", id: "sess-clear-close", timestamp: SESSION_START, cwd: "/tmp" }),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.maybeRetainOnAgentEnd();
		expect(bodies).toHaveLength(0);

		entries = [...beforeClear, resetBoundaryEntry("rb1", "a2", "2026-08-17T10:02:00.000Z")];
		state.resetConversationTracking();
		entries = [
			...entries,
			userEntry("u3", "rb1", "fresh turn after clear has enough text", "2026-08-17T10:03:00.000Z"),
			assistantEntry("a3", "u3", "fresh reply after clear has enough text", "2026-08-17T10:03:01.000Z"),
			userEntry("u4", "a3", "second fresh turn after clear has enough text", "2026-08-17T10:04:00.000Z"),
		];

		await state.drainOnClose();
		expect(bodies).toHaveLength(1);
		expect(String(firstItem(bodies[0]).content)).toContain("fresh turn after clear has enough text");
		expect(String(firstItem(bodies[0]).content)).toContain("second fresh turn after clear has enough text");
		expect(String(firstItem(bodies[0]).content)).not.toContain("cleared turn one has enough text");
		expect(String(firstItem(bodies[0]).content)).not.toContain("cleared turn two has enough text");
	});

	it("writes post-clear retain to a new document instead of replacing drained history", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const beforeClear = [
			userEntry("u1", null, "cleared turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "cleared reply one has enough text", "2026-08-17T10:00:01.000Z"),
		];
		let entries: SessionEntry[] = beforeClear;
		const state = new HindsightSessionState({
			sessionId: "sess-clear-doc",
			client,
			bankId: "personal",
			config: makeConfig({ retainEveryNTurns: 1, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-clear-doc",
				sessionManager: {
					getHeader: () => ({ type: "session", id: "sess-clear-doc", timestamp: SESSION_START, cwd: "/tmp" }),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.maybeRetainOnAgentEnd();
		expect(bodies).toHaveLength(1);
		expect(firstItem(bodies[0]).document_id).toBe("sess-clear-doc");

		entries = [...beforeClear, resetBoundaryEntry("rb1", "a1", "2026-08-17T10:02:00.000Z")];
		state.setSessionId("sess-clear-doc-epoch");
		state.resetConversationTracking();
		entries = [
			...entries,
			userEntry("u2", "rb1", "fresh turn after clear has enough text", "2026-08-17T10:03:00.000Z"),
			assistantEntry("a2", "u2", "fresh reply after clear has enough text", "2026-08-17T10:03:01.000Z"),
		];

		await state.drainOnClose();
		expect(bodies).toHaveLength(2);
		expect(firstItem(bodies[1]).document_id).toBe("sess-clear-doc-epoch");
		expect(String(firstItem(bodies[1]).content)).toContain("fresh turn after clear has enough text");
		expect(String(firstItem(bodies[1]).content)).not.toContain("cleared turn one has enough text");
	});

	it("rebuilds with replace when the retained prefix diverges", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const original = [turn("user", "hello original branch"), turn("assistant", "original tail is long enough")];
		const rewritten = [
			turn("user", "hello original branch"),
			turn("assistant", "rewritten tail is long enough"),
			turn("user", "next message after rewrite"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-diverge",
			client,
			bankId: "personal",
			config: makeConfig({ retainUpdateMode: "append" }),
			session: { sessionId: "sess-diverge", getHindsightSessionState: () => state } as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.retainSession(original);
		await state.retainSession(rewritten);
		expect(firstItem(bodies[1]).update_mode).toBe("replace");
		expect(String(firstItem(bodies[1]).content)).toContain("hello original branch");
		expect(String(firstItem(bodies[1]).content)).toContain("rewritten tail is long enough");
		expect(String(firstItem(bodies[1]).content)).toContain("next message after rewrite");
		expect(String(firstItem(bodies[1]).content)).not.toContain("original tail is long enough");
	});

	it("rebuilds with replace after /tree navigation onto a new branch in append mode", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const shared = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
		];
		const abandoned = [
			userEntry("u2", "a1", "abandoned turn has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "abandoned reply has enough text", "2026-08-17T10:01:01.000Z"),
		];
		const replacement = [
			userEntry("u3", "a1", "replacement turn has enough text", "2026-08-17T10:02:00.000Z"),
			assistantEntry("a3", "u3", "replacement reply has enough text", "2026-08-17T10:02:01.000Z"),
		];
		let branch = [...shared, ...abandoned];
		const allEntries = [...shared, ...abandoned, ...replacement];
		const state = new HindsightSessionState({
			sessionId: "sess-tree-nav",
			client,
			bankId: "personal",
			config: makeConfig({ retainUpdateMode: "append", retainEveryNTurns: 2, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-tree-nav",
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-tree-nav",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => allEntries,
					getBranch: () => branch,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.maybeRetainOnAgentEnd();
		expect(bodies).toHaveLength(1);
		expect(String(firstItem(bodies[0]).content)).toContain("abandoned turn has enough text");

		branch = [...shared, ...replacement];
		await state.maybeRetainOnAgentEnd();
		expect(bodies).toHaveLength(2);
		expect(firstItem(bodies[1]).update_mode).toBe("replace");
		expect(String(firstItem(bodies[1]).content)).toContain("replacement turn has enough text");
		expect(String(firstItem(bodies[1]).content)).not.toContain("abandoned turn has enough text");
	});

	it("retains last-turn replacement-branch work after /tree rewind below cadence", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const shared = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "reply two has enough text", "2026-08-17T10:01:01.000Z"),
		];
		const abandoned = [
			userEntry("u3", "a2", "abandoned three has enough text", "2026-08-17T10:02:00.000Z"),
			assistantEntry("a3", "u3", "abandoned reply three has enough text", "2026-08-17T10:02:01.000Z"),
			userEntry("u4", "a3", "abandoned four has enough text", "2026-08-17T10:03:00.000Z"),
			assistantEntry("a4", "u4", "abandoned reply four has enough text", "2026-08-17T10:03:01.000Z"),
			userEntry("u5", "a4", "abandoned five has enough text", "2026-08-17T10:04:00.000Z"),
			assistantEntry("a5", "u5", "abandoned reply five has enough text", "2026-08-17T10:04:01.000Z"),
		];
		const replacement = [
			userEntry("u6", "a2", "replacement three has enough text", "2026-08-17T10:05:00.000Z"),
			assistantEntry("a6", "u6", "replacement reply three has enough text", "2026-08-17T10:05:01.000Z"),
		];
		let branch = [...shared, ...abandoned];
		const state = new HindsightSessionState({
			sessionId: "sess-tree-lastturn",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "last-turn", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-tree-lastturn",
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-tree-lastturn",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => [...shared, ...abandoned, ...replacement],
					getBranch: () => branch,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.maybeRetainOnAgentEnd();
		expect(bodies).toHaveLength(1);
		expect(String(firstItem(bodies[0]).content)).toContain("abandoned five has enough text");

		branch = [...shared, ...replacement];
		await state.maybeRetainOnAgentEnd();
		expect(bodies).toHaveLength(2);
		expect(String(firstItem(bodies[1]).content)).toContain("replacement three has enough text");
		expect(String(firstItem(bodies[1]).content)).not.toContain("abandoned five has enough text");
	});

	it("retains last-turn replacement-branch work on close after /tree rewind below cadence", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const shared = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "reply two has enough text", "2026-08-17T10:01:01.000Z"),
		];
		const abandoned = [
			userEntry("u3", "a2", "abandoned three has enough text", "2026-08-17T10:02:00.000Z"),
			assistantEntry("a3", "u3", "abandoned reply three has enough text", "2026-08-17T10:02:01.000Z"),
			userEntry("u4", "a3", "abandoned four has enough text", "2026-08-17T10:03:00.000Z"),
			assistantEntry("a4", "u4", "abandoned reply four has enough text", "2026-08-17T10:03:01.000Z"),
			userEntry("u5", "a4", "abandoned five has enough text", "2026-08-17T10:04:00.000Z"),
			assistantEntry("a5", "u5", "abandoned reply five has enough text", "2026-08-17T10:04:01.000Z"),
		];
		const replacement = [
			userEntry("u6", "a2", "replacement three has enough text", "2026-08-17T10:05:00.000Z"),
			assistantEntry("a6", "u6", "replacement reply three has enough text", "2026-08-17T10:05:01.000Z"),
		];
		let branch = [...shared, ...abandoned];
		const state = new HindsightSessionState({
			sessionId: "sess-tree-lastturn-close",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "last-turn", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-tree-lastturn-close",
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-tree-lastturn-close",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => [...shared, ...abandoned, ...replacement],
					getBranch: () => branch,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.maybeRetainOnAgentEnd();
		expect(bodies).toHaveLength(1);
		expect(String(firstItem(bodies[0]).content)).toContain("abandoned five has enough text");

		branch = [...shared, ...replacement];
		await state.drainOnClose();
		expect(bodies).toHaveLength(2);
		expect(String(firstItem(bodies[1]).content)).toContain("replacement three has enough text");
		expect(String(firstItem(bodies[1]).content)).not.toContain("abandoned five has enough text");
	});

	it("retains a resumed last-turn replacement branch on close before any retain in this process", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const shared = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "reply two has enough text", "2026-08-17T10:01:01.000Z"),
		];
		const abandoned = [
			userEntry("u3", "a2", "abandoned three has enough text", "2026-08-17T10:02:00.000Z"),
			assistantEntry("a3", "u3", "abandoned reply three has enough text", "2026-08-17T10:02:01.000Z"),
			userEntry("u4", "a3", "abandoned four has enough text", "2026-08-17T10:03:00.000Z"),
			assistantEntry("a4", "u4", "abandoned reply four has enough text", "2026-08-17T10:03:01.000Z"),
			userEntry("u5", "a4", "abandoned five has enough text", "2026-08-17T10:04:00.000Z"),
			assistantEntry("a5", "u5", "abandoned reply five has enough text", "2026-08-17T10:04:01.000Z"),
		];
		const replacement = [
			userEntry("u6", "a2", "replacement three has enough text", "2026-08-17T10:05:00.000Z"),
			assistantEntry("a6", "u6", "replacement reply three has enough text", "2026-08-17T10:05:01.000Z"),
		];
		let branch = [...shared, ...abandoned];
		const state = new HindsightSessionState({
			sessionId: "sess-tree-resume-close",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "last-turn", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-tree-resume-close",
				loadedUserTurnCount: 5,
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-tree-resume-close",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => [...shared, ...abandoned, ...replacement],
					getBranch: () => branch,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
			closeRetainBaselineTurns: 5,
		});

		branch = [...shared, ...replacement];
		await state.drainOnClose();
		expect(bodies).toHaveLength(1);
		expect(String(firstItem(bodies[0]).content)).toContain("replacement three has enough text");
		expect(String(firstItem(bodies[0]).content)).not.toContain("abandoned five has enough text");
	});

	it("does not duplicate last-turn documents when close races an in-flight forced retain", async () => {
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const bodies = captureBodies({ delay: gate.promise, onStart: () => started.resolve() });
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const entries = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "reply two has enough text", "2026-08-17T10:01:01.000Z"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-lastturn-force-close",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "last-turn", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-lastturn-force-close",
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-lastturn-force-close",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
					getBranch: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		const forced = state.forceRetainCurrentSession();
		await started.promise;
		const close = state.drainOnClose();
		gate.resolve();
		await Promise.all([forced, close]);
		expect(bodies).toHaveLength(1);
		expect(String(firstItem(bodies[0]).content)).toContain("turn two has enough text");
	});

	it("drops a queued forced retain when the session is rekeyed before it starts", async () => {
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const bodies = captureBodies({ delay: gate.promise, onStart: () => started.resolve() });
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const original = [
			userEntry("u1", null, "original turn has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "original reply has enough text", "2026-08-17T10:00:01.000Z"),
		];
		const replacement = [
			userEntry("tu1", null, "replacement turn has enough text", "2026-08-17T11:00:00.000Z"),
			assistantEntry("ta1", "tu1", "replacement reply has enough text", "2026-08-17T11:00:01.000Z"),
		];
		let entries = original;
		const state = new HindsightSessionState({
			sessionId: "sess-force-queued-old",
			client,
			bankId: "personal",
			config: makeConfig({ retainEveryNTurns: 1, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-force-queued-old",
				sessionManager: {
					getHeader: () => ({ type: "session", id: state.sessionId, timestamp: SESSION_START, cwd: "/tmp" }),
					getEntries: () => entries,
					getBranch: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		const cadence = state.maybeRetainOnAgentEnd();
		await started.promise;
		const forced = state.forceRetainCurrentSession();
		entries = replacement;
		state.setSessionId("sess-force-queued-new");
		state.resetConversationTracking();
		gate.resolve();
		await Promise.all([cadence, forced]);

		expect(bodies).toHaveLength(1);
		expect(firstItem(bodies[0]).document_id).toBe("sess-force-queued-old");
		expect(String(firstItem(bodies[0]).content)).not.toContain("replacement turn has enough text");
	});

	it("serializes close with a forced retain scheduled during the shared queue flush", async () => {
		const retainGate = Promise.withResolvers<void>();
		const retainStarted = Promise.withResolvers<void>();
		const flushGate = Promise.withResolvers<void>();
		const flushStarted = Promise.withResolvers<void>();
		const bodies = captureBodies({ delay: retainGate.promise, onStart: () => retainStarted.resolve() });
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const entries = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-lastturn-flush-race",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "last-turn", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-lastturn-flush-race",
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-lastturn-flush-race",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
					getBranch: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});
		vi.spyOn(state, "flushRetainQueue").mockImplementation(async () => {
			flushStarted.resolve();
			await flushGate.promise;
		});

		const close = state.drainOnClose();
		await flushStarted.promise;
		const forced = state.forceRetainCurrentSession();
		flushGate.resolve();
		await retainStarted.promise;
		retainGate.resolve();
		await Promise.all([close, forced]);

		expect(bodies).toHaveLength(1);
		expect(String(firstItem(bodies[0]).content)).toContain("turn one has enough text");
	});

	it("does not duplicate a completed last-turn retain after session-switch rollback", async () => {
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const bodies = captureBodies({ delay: gate.promise, onStart: () => started.resolve() });
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const original = [
			userEntry("u1", null, "home turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "home reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "home turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "home reply two has enough text", "2026-08-17T10:01:01.000Z"),
		];
		const target = [
			userEntry("tu1", null, "target turn has enough text", "2026-08-17T11:00:00.000Z"),
			assistantEntry("ta1", "tu1", "target reply has enough text", "2026-08-17T11:00:01.000Z"),
		];
		let entries = original;
		const state = new HindsightSessionState({
			sessionId: "sess-lastturn-rollback",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "last-turn", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-lastturn-rollback",
				sessionManager: {
					getHeader: () => ({ type: "session", id: state.sessionId, timestamp: SESSION_START, cwd: "/tmp" }),
					getEntries: () => entries,
					getBranch: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		const snapshot = state.captureConversationTracking();
		const forced = state.forceRetainCurrentSession();
		await started.promise;
		entries = target;
		state.setSessionId("sess-lastturn-target");
		state.resetConversationTracking();
		entries = original;
		state.setSessionId("sess-lastturn-rollback");
		state.restoreConversationTracking(snapshot);
		gate.resolve();
		await forced;
		await state.drainOnClose();

		expect(bodies).toHaveLength(1);
		expect(String(firstItem(bodies[0]).content)).toContain("home turn two has enough text");
		expect(String(firstItem(bodies[0]).content)).not.toContain("target turn has enough text");
	});

	it("does not duplicate a completed last-turn retain after a no-in-flight switch rollback", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const original = [
			userEntry("u1", null, "home turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "home reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "home turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "home reply two has enough text", "2026-08-17T10:01:01.000Z"),
			userEntry("u3", "a2", "home turn three has enough text", "2026-08-17T10:02:00.000Z"),
			assistantEntry("a3", "u3", "home reply three has enough text", "2026-08-17T10:02:01.000Z"),
			userEntry("u4", "a3", "home turn four has enough text", "2026-08-17T10:03:00.000Z"),
			assistantEntry("a4", "u4", "home reply four has enough text", "2026-08-17T10:03:01.000Z"),
			userEntry("u5", "a4", "home turn five has enough text", "2026-08-17T10:04:00.000Z"),
			assistantEntry("a5", "u5", "home reply five has enough text", "2026-08-17T10:04:01.000Z"),
		];
		const target = [
			userEntry("tu1", null, "target turn has enough text", "2026-08-17T11:00:00.000Z"),
			assistantEntry("ta1", "tu1", "target reply has enough text", "2026-08-17T11:00:01.000Z"),
		];
		let entries: SessionEntry[] = [];
		const state = new HindsightSessionState({
			sessionId: "sess-lastturn-idle-rollback",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "last-turn", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-lastturn-idle-rollback",
				loadedUserTurnCount: 0,
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: state.sessionId,
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
					getBranch: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		entries = original;
		await state.maybeRetainOnAgentEnd();
		expect(bodies).toHaveLength(1);

		const snapshot = state.captureConversationTracking();
		entries = target;
		state.setSessionId("sess-lastturn-idle-target");
		state.resetConversationTracking();
		entries = original;
		state.setSessionId("sess-lastturn-idle-rollback");
		state.restoreConversationTracking(snapshot);
		await state.drainOnClose();

		expect(bodies).toHaveLength(1);
		expect(String(firstItem(bodies[0]).content)).toContain("home turn five has enough text");
		expect(String(firstItem(bodies[0]).content)).not.toContain("target turn has enough text");
	});

	it("restores the close baseline when a session switch rolls back", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const restored = [
			userEntry("u1", null, "home turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "home reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "home turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "home reply two has enough text", "2026-08-17T10:01:01.000Z"),
		];
		const target = Array.from({ length: 10 }, (_, i) => [
			userEntry(
				`tu${i + 1}`,
				i === 0 ? null : `ta${i}`,
				`target turn ${i + 1} has enough text`,
				`2026-08-17T11:0${i}:00.000Z`,
			),
			assistantEntry(
				`ta${i + 1}`,
				`tu${i + 1}`,
				`target reply ${i + 1} has enough text`,
				`2026-08-17T11:0${i}:01.000Z`,
			),
		]).flat();
		let entries = restored;
		const state = new HindsightSessionState({
			sessionId: "sess-switch-rollback",
			client,
			bankId: "personal",
			config: makeConfig({ retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-switch-rollback",
				loadedUserTurnCount: 2,
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-switch-rollback",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
					getBranch: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
			lastRetainedTurn: 2,
			closeRetainBaselineTurns: 2,
		});

		const snapshot = state.captureConversationTracking();
		entries = target;
		state.setSessionId("sess-switch-target");
		state.resetConversationTracking();
		expect(state.lastRetainedTurn).toBe(0);

		entries = [
			...restored,
			userEntry("u3", "a2", "home turn three has enough text", "2026-08-17T10:02:00.000Z"),
			assistantEntry("a3", "u3", "home reply three has enough text", "2026-08-17T10:02:01.000Z"),
		];
		state.setSessionId("sess-switch-rollback");
		state.restoreConversationTracking(snapshot);
		await state.drainOnClose();
		expect(bodies).toHaveLength(1);
		expect(String(firstItem(bodies[0]).content)).toContain("home turn three has enough text");
		expect(String(firstItem(bodies[0]).content)).not.toContain("target turn 10 has enough text");
	});

	it("replaces after rollback when an in-flight append retain superseded the saved cache", async () => {
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const bodies: unknown[] = [];
		let requestCount = 0;
		const fetchMock: typeof globalThis.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
				requestCount++;
				if (requestCount === 2) {
					started.resolve();
					await gate.promise;
				}
				bodies.push(JSON.parse(String(init?.body ?? "{}")));
				return new Response("{}", { status: 200 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const first = [
			userEntry("u1", null, "home turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "home reply one has enough text", "2026-08-17T10:00:01.000Z"),
		];
		const second = [
			...first,
			userEntry("u2", "a1", "home turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "home reply two has enough text", "2026-08-17T10:01:01.000Z"),
		];
		let entries = first;
		const state = new HindsightSessionState({
			sessionId: "sess-rollback-append",
			client,
			bankId: "personal",
			config: makeConfig({ retainUpdateMode: "append", retainEveryNTurns: 1, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-rollback-append",
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: state.sessionId,
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
					getBranch: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.retainSession([
			turn("user", "home turn one has enough text"),
			turn("assistant", "home reply one has enough text"),
		]);
		const snapshot = state.captureConversationTracking();
		entries = second;
		const append = state.retainSession([
			turn("user", "home turn one has enough text"),
			turn("assistant", "home reply one has enough text"),
			turn("user", "home turn two has enough text"),
			turn("assistant", "home reply two has enough text"),
		]);
		await started.promise;
		state.setSessionId("sess-rollback-target");
		state.resetConversationTracking();
		state.setSessionId("sess-rollback-append");
		state.restoreConversationTracking(snapshot);
		gate.resolve();
		await append;
		await state.drainOnClose();

		expect(bodies).toHaveLength(3);
		expect(firstItem(bodies[1]).update_mode).toBe("append");
		expect(firstItem(bodies[2]).update_mode).toBe("replace");
		expect(String(firstItem(bodies[2]).content)).toContain("home turn one has enough text");
		expect(String(firstItem(bodies[2]).content)).toContain("home turn two has enough text");
	});

	it("force-rebuilds the full canonical transcript with replace", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const entries = [
			userEntry("u1", null, "hello first turn here", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "first reply is long enough", "2026-08-17T10:00:05.000Z"),
			userEntry("u2", "a1", "hello second turn here", "2026-08-17T10:01:00.000Z"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-force",
			client,
			bankId: "personal",
			config: makeConfig({ retainUpdateMode: "append" }),
			session: {
				sessionId: "sess-force",
				sessionManager: {
					getHeader: () => ({ type: "session", id: "sess-force", timestamp: SESSION_START, cwd: "/tmp" }),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.retainSession([
			turn("user", "hello first turn here"),
			turn("assistant", "first reply is long enough"),
		]);
		await state.forceRetainCurrentSession();
		expect(firstItem(bodies[1]).update_mode).toBe("replace");
		expect(firstItem(bodies[1]).document_id).toBe("sess-force");
		expect(String(firstItem(bodies[1]).content)).toContain("hello first turn here");
		expect(String(firstItem(bodies[1]).content)).toContain("hello second turn here");
	});

	it("flushes a short unretained tail on clean session close without duplicating the prefix", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const firstFive = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "reply two has enough text", "2026-08-17T10:01:01.000Z"),
			userEntry("u3", "a2", "turn three has enough text", "2026-08-17T10:02:00.000Z"),
			assistantEntry("a3", "u3", "reply three has enough text", "2026-08-17T10:02:01.000Z"),
			userEntry("u4", "a3", "turn four has enough text", "2026-08-17T10:03:00.000Z"),
			assistantEntry("a4", "u4", "reply four has enough text", "2026-08-17T10:03:01.000Z"),
			userEntry("u5", "a4", "turn five has enough text", "2026-08-17T10:04:00.000Z"),
			assistantEntry("a5", "u5", "reply five has enough text", "2026-08-17T10:04:01.000Z"),
		];
		let entries = firstFive;
		const state = new HindsightSessionState({
			sessionId: "sess-tail",
			client,
			bankId: "personal",
			config: makeConfig({ retainUpdateMode: "append", retainEveryNTurns: 5, retainOverlapTurns: 2 }),
			session: {
				sessionId: "sess-tail",
				sessionManager: {
					getHeader: () => ({ type: "session", id: "sess-tail", timestamp: SESSION_START, cwd: "/tmp" }),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.maybeRetainOnAgentEnd();
		expect(bodies).toHaveLength(1);
		expect(firstItem(bodies[0])).not.toHaveProperty("update_mode");
		expect(String(firstItem(bodies[0]).content)).toContain("turn five has enough text");

		entries = [
			...firstFive,
			userEntry("u6", "a5", "turn six has enough text", "2026-08-17T10:05:00.000Z"),
			assistantEntry("a6", "u6", "reply six has enough text", "2026-08-17T10:05:01.000Z"),
			userEntry("u7", "a6", "turn seven has enough text", "2026-08-17T10:06:00.000Z"),
		];
		await state.maybeRetainOnAgentEnd();
		expect(bodies).toHaveLength(1);

		await state.drainOnClose();
		expect(bodies).toHaveLength(2);
		expect(firstItem(bodies[1]).update_mode).toBe("append");
		expect(firstItem(bodies[1]).document_id).toBe("sess-tail");
		expect(String(firstItem(bodies[1]).content)).toContain("turn six has enough text");
		expect(String(firstItem(bodies[1]).content)).toContain("turn seven has enough text");
		expect(String(firstItem(bodies[1]).content)).not.toContain("turn one has enough text");
		expect(String(firstItem(bodies[1]).content)).not.toContain("turn five has enough text");
	});

	it("does not re-retain last-turn content that was already flushed at cadence", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const entries = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "reply two has enough text", "2026-08-17T10:01:01.000Z"),
			userEntry("u3", "a2", "turn three has enough text", "2026-08-17T10:02:00.000Z"),
			assistantEntry("a3", "u3", "reply three has enough text", "2026-08-17T10:02:01.000Z"),
			userEntry("u4", "a3", "turn four has enough text", "2026-08-17T10:03:00.000Z"),
			assistantEntry("a4", "u4", "reply four has enough text", "2026-08-17T10:03:01.000Z"),
			userEntry("u5", "a4", "turn five has enough text", "2026-08-17T10:04:00.000Z"),
			assistantEntry("a5", "u5", "reply five has enough text", "2026-08-17T10:04:01.000Z"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-lastturn-done",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "last-turn", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-lastturn-done",
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-lastturn-done",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.maybeRetainOnAgentEnd();
		expect(bodies).toHaveLength(1);
		expect(String(firstItem(bodies[0]).document_id)).toMatch(/^sess-lastturn-done-\d+$/);

		await state.drainOnClose();
		expect(bodies).toHaveLength(1);
	});

	it("flushes a below-cadence last-turn tail exactly once on clean close", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const firstFive = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "reply two has enough text", "2026-08-17T10:01:01.000Z"),
			userEntry("u3", "a2", "turn three has enough text", "2026-08-17T10:02:00.000Z"),
			assistantEntry("a3", "u3", "reply three has enough text", "2026-08-17T10:02:01.000Z"),
			userEntry("u4", "a3", "turn four has enough text", "2026-08-17T10:03:00.000Z"),
			assistantEntry("a4", "u4", "reply four has enough text", "2026-08-17T10:03:01.000Z"),
			userEntry("u5", "a4", "turn five has enough text", "2026-08-17T10:04:00.000Z"),
			assistantEntry("a5", "u5", "reply five has enough text", "2026-08-17T10:04:01.000Z"),
		];
		let entries = firstFive;
		const state = new HindsightSessionState({
			sessionId: "sess-lastturn-tail",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "last-turn", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-lastturn-tail",
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-lastturn-tail",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.maybeRetainOnAgentEnd();
		expect(bodies).toHaveLength(1);

		entries = [
			...firstFive,
			userEntry("u6", "a5", "turn six has enough text", "2026-08-17T10:05:00.000Z"),
			assistantEntry("a6", "u6", "reply six has enough text", "2026-08-17T10:05:01.000Z"),
			userEntry("u7", "a6", "turn seven has enough text", "2026-08-17T10:06:00.000Z"),
		];
		await state.maybeRetainOnAgentEnd();
		expect(bodies).toHaveLength(1);

		await state.drainOnClose();
		expect(bodies).toHaveLength(2);
		expect(String(firstItem(bodies[1]).document_id)).toMatch(/^sess-lastturn-tail-\d+$/);
		expect(String(firstItem(bodies[1]).content)).toContain("turn six has enough text");
		expect(String(firstItem(bodies[1]).content)).toContain("turn seven has enough text");
		expect(String(firstItem(bodies[1]).content)).not.toContain("turn one has enough text");
		expect(String(firstItem(bodies[1]).content)).not.toContain("turn five has enough text");
		expect(firstItem(bodies[1])).not.toHaveProperty("update_mode");
	});

	it("force-rebuilds even when a cadence retain is still in flight", async () => {
		const gate = Promise.withResolvers<void>();
		const bodies = captureBodies({ delay: gate.promise });
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const first = [turn("user", "hello first turn here"), turn("assistant", "first reply is long enough")];
		const entries = [
			userEntry("u1", null, "hello first turn here", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "first reply is long enough", "2026-08-17T10:00:05.000Z"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-force-race",
			client,
			bankId: "personal",
			config: makeConfig({ retainUpdateMode: "append" }),
			session: {
				sessionId: "sess-force-race",
				sessionManager: {
					getHeader: () => ({ type: "session", id: "sess-force-race", timestamp: SESSION_START, cwd: "/tmp" }),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		const cadence = state.retainSession(first);
		const forced = state.forceRetainCurrentSession();
		gate.resolve();
		await Promise.all([cadence, forced]);

		expect(bodies).toHaveLength(2);
		expect(firstItem(bodies[1]).update_mode).toBe("replace");
		expect(firstItem(bodies[1]).document_id).toBe("sess-force-race");
		expect(String(firstItem(bodies[1]).content)).toContain("hello first turn here");
		expect(String(firstItem(bodies[1]).content)).toContain("first reply is long enough");
	});

	it("does not carry a forced-retain cursor across a session rekey", async () => {
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const bodies = captureBodies({ delay: gate.promise, onStart: () => started.resolve() });
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		let entries = [
			userEntry("old-u1", null, "old turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("old-a1", "old-u1", "old reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("old-u2", "old-a1", "old turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("old-a2", "old-u2", "old reply two has enough text", "2026-08-17T10:01:01.000Z"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-force-old",
			client,
			bankId: "personal",
			config: makeConfig({ retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-force-old",
				sessionManager: {
					getHeader: () => ({ type: "session", id: state.sessionId, timestamp: SESSION_START, cwd: "/tmp" }),
					getEntries: () => entries,
					getBranch: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		const forced = state.forceRetainCurrentSession();
		await started.promise;
		entries = [];
		state.setSessionId("sess-force-new");
		state.resetConversationTracking();
		entries = [
			userEntry("new-u1", null, "new turn one has enough text", "2026-08-17T11:00:00.000Z"),
			assistantEntry("new-a1", "new-u1", "new reply one has enough text", "2026-08-17T11:00:01.000Z"),
		];
		gate.resolve();
		await forced;
		await state.drainOnClose();

		expect(bodies).toHaveLength(2);
		expect(firstItem(bodies[0]).document_id).toBe("sess-force-old");
		expect(firstItem(bodies[1]).document_id).toBe("sess-force-new");
		expect(String(firstItem(bodies[1]).content)).toContain("new turn one has enough text");
	});

	it("does not duplicate last-turn documents when close races an in-flight cadence retain", async () => {
		const gate = Promise.withResolvers<void>();
		const bodies = captureBodies({ delay: gate.promise });
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const entries = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "reply two has enough text", "2026-08-17T10:01:01.000Z"),
			userEntry("u3", "a2", "turn three has enough text", "2026-08-17T10:02:00.000Z"),
			assistantEntry("a3", "u3", "reply three has enough text", "2026-08-17T10:02:01.000Z"),
			userEntry("u4", "a3", "turn four has enough text", "2026-08-17T10:03:00.000Z"),
			assistantEntry("a4", "u4", "reply four has enough text", "2026-08-17T10:03:01.000Z"),
			userEntry("u5", "a4", "turn five has enough text", "2026-08-17T10:04:00.000Z"),
			assistantEntry("a5", "u5", "reply five has enough text", "2026-08-17T10:04:01.000Z"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-lastturn-race",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "last-turn", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-lastturn-race",
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-lastturn-race",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		const cadence = state.maybeRetainOnAgentEnd();
		const close = state.drainOnClose();
		gate.resolve();
		await Promise.all([cadence, close]);
		expect(bodies).toHaveLength(1);
		expect(String(firstItem(bodies[0]).document_id)).toMatch(/^sess-lastturn-race-\d+$/);
	});

	it("does not append onto a rekeyed session from an in-flight retain cache", async () => {
		const gate = Promise.withResolvers<void>();
		const bodies = captureBodies({ delay: gate.promise });
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const first = [turn("user", "hello first turn here"), turn("assistant", "first reply is long enough")];
		const later = [
			...first,
			turn("user", "hello second turn here"),
			turn("assistant", "second reply is long enough"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-old",
			client,
			bankId: "personal",
			config: makeConfig({ retainUpdateMode: "append" }),
			session: { sessionId: "sess-old", getHindsightSessionState: () => state } as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		const inFlight = state.retainSession(first);
		state.setSessionId("sess-forked");
		gate.resolve();
		await inFlight;
		expect(bodies).toHaveLength(1);
		expect(firstItem(bodies[0]).document_id).toBe("sess-old");

		await state.retainSession(later);
		expect(bodies).toHaveLength(2);
		expect(firstItem(bodies[1]).document_id).toBe("sess-forked");
		expect(firstItem(bodies[1])).not.toHaveProperty("update_mode");
		expect(String(firstItem(bodies[1]).content)).toContain("hello first turn here");
		expect(String(firstItem(bodies[1]).content)).toContain("hello second turn here");
	});

	it("does not duplicate a last-turn retain after a same-id rekey", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const entries = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "reply two has enough text", "2026-08-17T10:01:01.000Z"),
			userEntry("u3", "a2", "turn three has enough text", "2026-08-17T10:02:00.000Z"),
			assistantEntry("a3", "u3", "reply three has enough text", "2026-08-17T10:02:01.000Z"),
			userEntry("u4", "a3", "turn four has enough text", "2026-08-17T10:03:00.000Z"),
			assistantEntry("a4", "u4", "reply four has enough text", "2026-08-17T10:03:01.000Z"),
			userEntry("u5", "a4", "turn five has enough text", "2026-08-17T10:04:00.000Z"),
			assistantEntry("a5", "u5", "reply five has enough text", "2026-08-17T10:04:01.000Z"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-lastturn-sameid",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "last-turn", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-lastturn-sameid",
				loadedUserTurnCount: 0,
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-lastturn-sameid",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
					getBranch: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.maybeRetainOnAgentEnd();
		expect(bodies).toHaveLength(1);
		state.setSessionId("sess-lastturn-sameid");
		await state.drainOnClose();
		expect(bodies).toHaveLength(1);
		expect(String(firstItem(bodies[0]).document_id)).toMatch(/^sess-lastturn-sameid-\d+$/);
	});

	it("does not re-retain a completed full-session tail after a same-id rekey", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const entries = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-full-sameid",
			client,
			bankId: "personal",
			config: makeConfig({ retainEveryNTurns: 1, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-full-sameid",
				loadedUserTurnCount: 0,
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-full-sameid",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
					getBranch: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.maybeRetainOnAgentEnd();
		expect(bodies).toHaveLength(1);
		state.setSessionId("sess-full-sameid");
		await state.drainOnClose();
		expect(bodies).toHaveLength(1);
		expect(firstItem(bodies[0]).document_id).toBe("sess-full-sameid");
	});

	it("does not re-retain a resumed last-turn session on close without new turns", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const entries = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "reply two has enough text", "2026-08-17T10:01:01.000Z"),
			userEntry("u3", "a2", "turn three has enough text", "2026-08-17T10:02:00.000Z"),
			assistantEntry("a3", "u3", "reply three has enough text", "2026-08-17T10:02:01.000Z"),
			userEntry("u4", "a3", "turn four has enough text", "2026-08-17T10:03:00.000Z"),
			assistantEntry("a4", "u4", "reply four has enough text", "2026-08-17T10:03:01.000Z"),
			userEntry("u5", "a4", "turn five has enough text", "2026-08-17T10:04:00.000Z"),
			assistantEntry("a5", "u5", "reply five has enough text", "2026-08-17T10:04:01.000Z"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-lastturn-resume",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "last-turn", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-lastturn-resume",
				loadedUserTurnCount: 5,
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-lastturn-resume",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
			closeRetainBaselineTurns: 5,
		});

		await state.drainOnClose();
		expect(bodies).toHaveLength(0);
	});

	it("does not keep a rekeyed session's cadence cursor after an in-flight retain", async () => {
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const bodies = captureBodies({ delay: gate.promise, onStart: () => started.resolve() });
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const entries = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "reply two has enough text", "2026-08-17T10:01:01.000Z"),
			userEntry("u3", "a2", "turn three has enough text", "2026-08-17T10:02:00.000Z"),
			assistantEntry("a3", "u3", "reply three has enough text", "2026-08-17T10:02:01.000Z"),
			userEntry("u4", "a3", "turn four has enough text", "2026-08-17T10:03:00.000Z"),
			assistantEntry("a4", "u4", "reply four has enough text", "2026-08-17T10:03:01.000Z"),
			userEntry("u5", "a4", "turn five has enough text", "2026-08-17T10:04:00.000Z"),
			assistantEntry("a5", "u5", "reply five has enough text", "2026-08-17T10:04:01.000Z"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-cadence-rekey",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "last-turn", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-cadence-rekey",
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-cadence-rekey",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		const cadence = state.maybeRetainOnAgentEnd();
		await started.promise;
		state.resetConversationTracking();
		gate.resolve();
		await cadence;
		expect(bodies).toHaveLength(1);
		expect(state.lastRetainedTurn).toBe(0);
	});

	it("does not retain a rekeyed session from a queued stale cadence retain", async () => {
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const bodies = captureBodies({ delay: gate.promise, onStart: () => started.resolve() });
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const entries = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "reply two has enough text", "2026-08-17T10:01:01.000Z"),
			userEntry("u3", "a2", "turn three has enough text", "2026-08-17T10:02:00.000Z"),
			assistantEntry("a3", "u3", "reply three has enough text", "2026-08-17T10:02:01.000Z"),
			userEntry("u4", "a3", "turn four has enough text", "2026-08-17T10:03:00.000Z"),
			assistantEntry("a4", "u4", "reply four has enough text", "2026-08-17T10:03:01.000Z"),
			userEntry("u5", "a4", "turn five has enough text", "2026-08-17T10:04:00.000Z"),
			assistantEntry("a5", "u5", "reply five has enough text", "2026-08-17T10:04:01.000Z"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-queued-stale-cadence",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "last-turn", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-queued-stale-cadence",
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-queued-stale-cadence",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		const first = state.maybeRetainOnAgentEnd();
		await started.promise;
		const queued = state.maybeRetainOnAgentEnd();
		state.resetConversationTracking();
		state.setSessionId("sess-queued-stale-cadence-resumed");
		gate.resolve();
		await Promise.all([first, queued]);
		expect(bodies).toHaveLength(1);
		expect(firstItem(bodies[0]).document_id).not.toContain("resumed");
		expect(state.lastRetainedTurn).toBe(0);
	});

	it("flushes a terminal assistant message persisted after cadence retention", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const userOnly = [userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z")];
		let entries = userOnly;
		const state = new HindsightSessionState({
			sessionId: "sess-assistant-close-tail",
			client,
			bankId: "personal",
			config: makeConfig({ retainEveryNTurns: 1, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-assistant-close-tail",
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-assistant-close-tail",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		await state.maybeRetainOnAgentEnd();
		expect(bodies).toHaveLength(1);
		expect(String(firstItem(bodies[0]).content)).toContain("turn one has enough text");

		entries = [
			...userOnly,
			assistantEntry("a1", "u1", "terminal assistant reply has enough text", "2026-08-17T10:00:01.000Z"),
		];
		await state.drainOnClose();

		expect(bodies).toHaveLength(2);
		expect(String(firstItem(bodies[1]).content)).toContain("terminal assistant reply has enough text");
	});

	it("does not re-retain a resumed full-session conversation that added no new turns", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const entries = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "reply two has enough text", "2026-08-17T10:01:01.000Z"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-resume-idle-full",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "full-session", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-resume-idle-full",
				loadedUserTurnCount: 2,
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-resume-idle-full",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
			closeRetainBaselineTurns: 2,
		});

		await state.drainOnClose();
		expect(bodies).toHaveLength(0);
	});

	it("retains a below-cadence tail after resuming a full-session conversation", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const entries = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "reply two has enough text", "2026-08-17T10:01:01.000Z"),
			userEntry("u3", "a2", "turn three has enough text", "2026-08-17T10:02:00.000Z"),
			assistantEntry("a3", "u3", "reply three has enough text", "2026-08-17T10:02:01.000Z"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-resume-tail-full",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "full-session", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-resume-tail-full",
				loadedUserTurnCount: 2,
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-resume-tail-full",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
			closeRetainBaselineTurns: 2,
		});

		await state.drainOnClose();
		expect(bodies).toHaveLength(1);
		expect(String(firstItem(bodies[0]).content)).toContain("turn three has enough text");
	});

	it("still retains a first turn that arrived before delayed last-turn backend start", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const entries = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-first-turn-race",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "last-turn", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-first-turn-race",
				loadedUserTurnCount: 0,
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-first-turn-race",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
			closeRetainBaselineTurns: 0,
		});

		await state.drainOnClose();
		expect(bodies).toHaveLength(1);
		expect(String(firstItem(bodies[0]).content)).toContain("turn one has enough text");
	});

	it("flushes queued tool retains on drainOnClose before the queue is closed", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const state = new HindsightSessionState({
			sessionId: "sess-queue-drain",
			client,
			bankId: "personal",
			config: makeConfig(),
			session: {
				sessionId: "sess-queue-drain",
				loadedUserTurnCount: 0,
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-queue-drain",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => [],
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		state.enqueueRetain("user asked me to remember the deploy token rotation");
		await state.drainOnClose();
		expect(bodies).toHaveLength(1);
		expect(String(firstItem(bodies[0]).content)).toContain("deploy token rotation");
		state.dispose();
	});

	it("flushes queued alias retain/learn items on drainOnClose without auto-retaining the subagent transcript", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const parent = new HindsightSessionState({
			sessionId: "sess-parent",
			client,
			bankId: "personal",
			config: makeConfig(),
			session: {
				sessionId: "sess-parent",
				loadedUserTurnCount: 0,
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-parent",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => [],
				},
				getHindsightSessionState: () => parent,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});
		const entries = [
			userEntry("u1", null, "subagent exploration has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "internal reply has enough text", "2026-08-17T10:00:01.000Z"),
		];
		const alias = new HindsightSessionState({
			sessionId: "sess-alias",
			client,
			bankId: "personal",
			config: makeConfig(),
			session: {
				sessionId: "sess-alias",
				loadedUserTurnCount: 0,
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-alias",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => alias,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
			aliasOf: parent,
		});

		alias.enqueueRetain("subagent asked me to remember the deploy token rotation");
		await alias.drainOnClose();
		expect(bodies).toHaveLength(1);
		expect(String(firstItem(bodies[0]).content)).toContain("deploy token rotation");
		expect(String(firstItem(bodies[0]).content)).not.toContain("subagent exploration");
		alias.dispose();
		parent.dispose();
	});

	it("flushes queued tool retains before a slow session retain on close", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const entries = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-queue-first",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "last-turn", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-queue-first",
				loadedUserTurnCount: 0,
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-queue-first",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
			closeRetainBaselineTurns: 0,
		});

		state.enqueueRetain("user asked me to remember the deploy token rotation");
		await state.drainOnClose();
		expect(bodies).toHaveLength(2);
		expect(String(firstItem(bodies[0]).content)).toContain("deploy token rotation");
		expect(String(firstItem(bodies[1]).content)).toContain("turn one has enough text");
	});

	it("rebases last-turn close history when conversation tracking is reset onto a loaded transcript", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const entries = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "turn two has enough text", "2026-08-17T10:01:00.000Z"),
			assistantEntry("a2", "u2", "reply two has enough text", "2026-08-17T10:01:01.000Z"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-switch",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "last-turn", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-switch",
				loadedUserTurnCount: 0,
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-switch",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		state.resetConversationTracking();
		await state.drainOnClose();
		expect(bodies).toHaveLength(0);
	});

	it("does not treat a promoted /btw turn as already-retained close history", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const entries = [
			userEntry("u1", null, "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
			userEntry("u2", "a1", "promoted btw question has enough text", "2026-08-17T10:02:00.000Z"),
			assistantEntry("a2", "u2", "promoted btw answer has enough text", "2026-08-17T10:02:01.000Z"),
		];
		const state = new HindsightSessionState({
			sessionId: "sess-btw-promote",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "last-turn", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-btw-promote",
				loadedUserTurnCount: 1,
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-btw-promote",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
		});

		state.resetConversationTracking(1);
		await state.drainOnClose();
		expect(bodies).toHaveLength(1);
		expect(String(firstItem(bodies[0]).content)).toContain("promoted btw question has enough text");
	});

	it("does not treat an image-only user entry as a retainable close baseline turn", async () => {
		const bodies = captureBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		const imageOnly = {
			type: "message",
			id: "u-image",
			parentId: null,
			timestamp: "2026-08-17T09:59:00.000Z",
			message: {
				role: "user",
				content: [{ type: "image", data: "abc", mimeType: "image/png" }],
				timestamp: Date.parse("2026-08-17T09:59:00.000Z"),
			},
		} as SessionEntry;
		const entries = [
			imageOnly,
			userEntry("u1", "u-image", "turn one has enough text", "2026-08-17T10:00:00.000Z"),
			assistantEntry("a1", "u1", "reply one has enough text", "2026-08-17T10:00:01.000Z"),
		];
		expect(countRetainableUserTurns({ getEntries: () => [imageOnly] })).toBe(0);
		expect(countRetainableUserTurns({ getEntries: () => entries })).toBe(1);
		const state = new HindsightSessionState({
			sessionId: "sess-image-baseline",
			client,
			bankId: "personal",
			config: makeConfig({ retainMode: "last-turn", retainEveryNTurns: 5, retainOverlapTurns: 0 }),
			session: {
				sessionId: "sess-image-baseline",
				loadedUserTurnCount: countRetainableUserTurns({ getEntries: () => [imageOnly] }),
				sessionManager: {
					getHeader: () => ({
						type: "session",
						id: "sess-image-baseline",
						timestamp: SESSION_START,
						cwd: "/tmp",
					}),
					getEntries: () => entries,
				},
				getHindsightSessionState: () => state,
			} as object as AgentSession,
			banksSet: new Set(["personal"]),
			closeRetainBaselineTurns: countRetainableUserTurns({ getEntries: () => [imageOnly] }),
		});

		await state.drainOnClose();
		expect(bodies).toHaveLength(1);
		expect(String(firstItem(bodies[0]).content)).toContain("turn one has enough text");
	});
});
