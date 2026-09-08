/**
 * Backend behavioural contract tests.
 *
 * These exercise hindsightBackend.start / preCompactionContext / clear without
 * a real AgentSession by passing a fake session that exposes a `subscribe`
 * method we can drive manually. The HindsightApi is spied via
 * `vi.spyOn(HindsightApi.prototype, ...)` per AGENTS.md.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { hindsightBackend, reloadMentalModelsForSession } from "@oh-my-pi/pi-coding-agent/hindsight/backend";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session";

interface FakeSessionDeps {
	sessionId: string | null;
	cwd?: string;
	entries?: Array<{ role: "user" | "assistant"; text: string }>;
	settings?: Settings;
}

function makeFakeSession(deps: FakeSessionDeps) {
	const listeners = new Set<AgentSessionEventListener>();
	const entries = deps.entries ?? [];
	let hindsightState: HindsightSessionState | undefined;
	const session = {
		sessionId: deps.sessionId,
		settings: deps.settings ?? Settings.isolated(),
		sessionManager: {
			getEntries: () =>
				entries.map((e, i) => ({
					id: `e${i}`,
					parentId: i === 0 ? null : `e${i - 1}`,
					timestamp: new Date(0).toISOString(),
					type: "message" as const,
					message:
						e.role === "user"
							? {
									role: "user" as const,
									content: e.text,
									timestamp: 0,
								}
							: {
									role: "assistant" as const,
									content: [{ type: "text" as const, text: e.text }],
									model: "x",
									provider: "x",
									api: "x",
									stopReason: "end_turn" as const,
									timestamp: 0,
								},
				})),
			getCwd: () => deps.cwd ?? "/tmp",
			getSessionFile: () => null,
			getSessionId: () => deps.sessionId ?? "",
		},
		subscribe(listener: AgentSessionEventListener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		refreshBaseSystemPrompt: vi.fn().mockResolvedValue(undefined),
		getHindsightSessionState: () => hindsightState,
		setHindsightSessionState(state: HindsightSessionState | undefined) {
			const previous = hindsightState;
			hindsightState = state;
			return previous;
		},
		emit(event: Parameters<AgentSessionEventListener>[0]) {
			// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
			for (const l of [...listeners]) l(event);
		},
		listenerCount: () => listeners.size,
	};
	return session;
}

describe("hindsightBackend.start", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does nothing when memory.backend is hindsight but apiUrl is empty", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight", "hindsight.apiUrl": "" });
		const session = makeFakeSession({ sessionId: "s1" });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		expect(session.getHindsightSessionState()).toBeUndefined();
	});

	it("registers per-session state and subscribes to agent events when configured", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s2" });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		expect(session.getHindsightSessionState()).toBeDefined();
		expect(session.getHindsightSessionState()?.bankId).toBeTruthy();
	});

	it("rekeys state when the same AgentSession gets a new session id (resume/switch)", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s-before" });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		(session as { sessionId: string | null }).sessionId = "s-after";
		session.getHindsightSessionState()?.setSessionId("s-after");
		expect(session.getHindsightSessionState()?.sessionId).toBe("s-after");
		expect(session.getHindsightSessionState()?.bankId).toBeTruthy();
	});

	it("retains every Nth user turn on agent_end and skips intermediate turns", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.retainEveryNTurns": 2,
		});
		const retainSpy = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);

		const entries: Array<{ role: "user" | "assistant"; text: string }> = [];
		const session = makeFakeSession({ sessionId: "s3", entries });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		// Turn 1: not enough turns yet
		entries.push({ role: "user", text: "first user message that is long enough" });
		entries.push({ role: "assistant", text: "first assistant reply that is long enough" });
		session.emit({ type: "agent_end", messages: [] });
		await Bun.sleep(0);
		expect(retainSpy).toHaveBeenCalledTimes(0);

		// Turn 2: hits the threshold
		entries.push({ role: "user", text: "second user message that is long enough" });
		entries.push({ role: "assistant", text: "second reply that is long enough" });
		session.emit({ type: "agent_end", messages: [] });
		await Bun.sleep(0);
		expect(retainSpy).toHaveBeenCalledTimes(1);
		expect(retainSpy.mock.calls[0]?.[2]?.timestamp).toBeInstanceOf(Date);
	});

	it("aliases parent state on subagent runs (taskDepth > 0) so tools share the parent bank", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});

		// Register a primary (top-level) state first.
		const parentSession = makeFakeSession({ sessionId: "parent" });
		await hindsightBackend.start({
			session: parentSession as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const parentState = parentSession.getHindsightSessionState();

		// Subagent runs with taskDepth > 0 should alias the parent.
		const subSession = makeFakeSession({ sessionId: "sub" });
		await hindsightBackend.start({
			session: subSession as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
			parentHindsightSessionState: parentState,
		});
		const subState = subSession.getHindsightSessionState();
		expect(subState?.aliasOf).toBe(parentState);
		expect(subState?.bankId).toBe(parentState?.bankId);
		expect(subState?.client).toBe(parentState?.client);
		expect(subState?.banksSet).toBe(parentState?.banksSet);
		// Aliases must not subscribe to session events — the parent owns auto-recall/auto-retain.
		expect(subState?.unsubscribe).toBeUndefined();
		// hasRecalledForFirstTurn=true suppresses beforeAgentStartPrompt auto-recall on the sub.
		expect(subState?.hasRecalledForFirstTurn).toBe(true);
	});

	it("returns silently for subagent runs when no primary state has been registered", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "orphan-sub" });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
		});

		expect(session.getHindsightSessionState()).toBeUndefined();
	});
});

describe("hindsightBackend.preCompactionContext", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns undefined when no apiUrl is configured", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight", "hindsight.apiUrl": "" });
		const messages: AgentMessage[] = [{ role: "user", content: "hi", timestamp: 0 } as never];
		const ctx = await hindsightBackend.preCompactionContext?.(messages, settings);
		expect(ctx).toBeUndefined();
	});

	it("returns a <memories> block when recall yields results", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s5" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [{ id: "1", text: "remembered fact" }],
		} as never);

		const messages: AgentMessage[] = [{ role: "user", content: "What did we decide?", timestamp: 0 } as never];
		const ctx = await hindsightBackend.preCompactionContext?.(messages, settings, session as never);
		expect(ctx).toContain("<memories>");
		expect(ctx).toContain("remembered fact");
	});

	it("returns undefined when recall finds nothing", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s6" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		const messages: AgentMessage[] = [{ role: "user", content: "anything", timestamp: 0 } as never];
		const ctx = await hindsightBackend.preCompactionContext?.(messages, settings, session as never);
		expect(ctx).toBeUndefined();
	});
});

describe("hindsightBackend first-turn injection", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns a tagged block for the current first turn before agent_start", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({
			sessionId: "s8",
			entries: [{ role: "assistant", text: "previous assistant context" }],
		});
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [{ id: "1", text: "Can prefers concise communication" }],
		} as never);

		const block = await hindsightBackend.beforeAgentStartPrompt?.(
			session as never,
			"What do I know about this user?",
		);
		expect(block).toContain("<memories>");
		expect(block).toContain("Can prefers concise communication");
		expect(session.getHindsightSessionState()?.hasRecalledForFirstTurn).toBe(true);
		expect(session.getHindsightSessionState()?.lastRecallSnippet).toBe(block);
	});

	it("does not let agent_start preempt first-turn recall injection", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({
			sessionId: "s-race",
			entries: [{ role: "user", text: "What is the canary phrase?" }],
		});
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [{ id: "1", text: "The canary phrase is PURPLE-OTTER-9931." }],
		} as never);

		// The agent loop fires agent_start once the turn begins. This must NOT run
		// its own recall: doing so consumed the shared first-turn flag and left
		// injection to a racing background prompt rebuild that a fast turn outran,
		// dropping recalled memory from the model's prompt (#7568).
		session.emit({ type: "agent_start" });
		for (let i = 0; i < 50; i++) await Promise.resolve();

		expect(session.getHindsightSessionState()?.hasRecalledForFirstTurn).toBe(false);

		// beforeAgentStartPrompt is the sole, awaited injection path.
		const block = await hindsightBackend.beforeAgentStartPrompt?.(session as never, "What is the canary phrase?");
		expect(block).toContain("PURPLE-OTTER-9931");
		expect(session.getHindsightSessionState()?.hasRecalledForFirstTurn).toBe(true);
	});

	it("keeps the <memories> wrapper in buildDeveloperInstructions", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s9" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		const state = session.getHindsightSessionState();
		state!.lastRecallSnippet = "<memories>\nremembered fact\n</memories>";

		const prompt = await hindsightBackend.buildDeveloperInstructions("/tmp", settings, session as never);
		expect(prompt).toContain("<memories>");
		expect(prompt).toContain("</memories>");
		expect(prompt).toContain("remembered fact");
	});

	it("places the <mental_models> block above the <memories> recall block in developer instructions", async () => {
		// Stable, curated semantic memory must come first so the LLM's prior is
		// anchored on it; the volatile per-turn recall block follows. Ordering
		// is part of the integration's behavioural contract.
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.mentalModelsEnabled": true,
		});
		const session = makeFakeSession({ sessionId: "s-order" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = session.getHindsightSessionState();
		state!.mentalModelsSnippet = "<mental_models>\n# User Preferences\nprefers tabs\n</mental_models>";
		state!.lastRecallSnippet = "<memories>\nrecalled fact\n</memories>";

		const prompt = await hindsightBackend.buildDeveloperInstructions("/tmp", settings, session as never);
		// `<memories>` and `<mental_models>` are mentioned in STATIC_INSTRUCTIONS
		// bullets too. Match the actual injected block opener (tag + newline)
		// to disambiguate documentation prose from the injected payloads.
		const mmIdx = prompt!.indexOf("<mental_models>\n");
		const memIdx = prompt!.indexOf("<memories>\n");
		expect(mmIdx).toBeGreaterThanOrEqual(0);
		expect(memIdx).toBeGreaterThanOrEqual(0);
		expect(mmIdx).toBeLessThan(memIdx);
	});

	it("reloadMentalModelsForSession refreshes the cached snippet and base prompt", async () => {
		// Defends the TTL/manual reload contract: a fresh `listMentalModels`
		// must update both `mentalModelsSnippet` and `mentalModelsLoadedAt`,
		// and call `refreshBaseSystemPrompt` so the next turn picks up the
		// new content.
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.mentalModelsEnabled": true,
		});
		const session = makeFakeSession({ sessionId: "s-ttl" });
		// Initial start may issue its own listMentalModels (read-only by default);
		// stub it to return nothing so the initial snippet is undefined.
		const listSpy = vi.spyOn(HindsightApi.prototype, "listMentalModels").mockResolvedValue({ items: [] } as never);
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		// Wait for the kicked-off load to settle.
		await session.getHindsightSessionState()?.mentalModelsLoadPromise;
		const state = session.getHindsightSessionState();
		expect(state!.mentalModelsSnippet).toBeUndefined();
		expect(state!.mentalModelsLoadedAt).toBeDefined();
		const initialLoadedAt = state!.mentalModelsLoadedAt!;
		const refreshSpy = session.refreshBaseSystemPrompt;
		const callsBefore = refreshSpy.mock.calls.length;

		// Now publish content and trigger a reload.
		listSpy.mockResolvedValue({
			items: [
				{
					id: "user-preferences",
					bank_id: state!.bankId,
					name: "User Preferences",
					content: "prefers concise prose",
				},
			],
		} as never);
		// Force the loadedAt timestamp to differ so the next assertion is meaningful.
		state!.mentalModelsLoadedAt = initialLoadedAt - 1000;

		const ok = await reloadMentalModelsForSession(session as never);
		expect(ok).toBe(true);
		expect(state!.mentalModelsSnippet).toContain("# User Preferences");
		expect(state!.mentalModelsSnippet).toContain("prefers concise prose");
		expect(state!.mentalModelsLoadedAt).toBeGreaterThan(initialLoadedAt - 1000);
		expect(refreshSpy.mock.calls.length).toBeGreaterThan(callsBefore);
	});

	it("reloadMentalModelsForSession returns false on subagent aliases", async () => {
		// Aliases delegate to the parent; reloads on an alias must no-op so
		// the parent's cache is the single source of truth.
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.mentalModelsEnabled": true,
		});
		vi.spyOn(HindsightApi.prototype, "listMentalModels").mockResolvedValue({ items: [] } as never);
		const parent = makeFakeSession({ sessionId: "alias-parent" });
		await hindsightBackend.start({
			session: parent as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const child = makeFakeSession({ sessionId: "alias-child" });
		await hindsightBackend.start({
			session: child as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
			parentHindsightSessionState: parent.getHindsightSessionState(),
		});
		const ok = await reloadMentalModelsForSession(child as never);
		expect(ok).toBe(false);
	});
});

describe("hindsightBackend.clear", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("drops every registered session state", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s7" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		expect(session.getHindsightSessionState()).toBeDefined();

		await hindsightBackend.clear("/tmp", "/tmp", session as never);
		expect(session.getHindsightSessionState()).toBeUndefined();
	});

	it("does not delete server-side mental models on /memory clear (server-side state is sacred)", async () => {
		// `/memory clear` is documented to wipe only the local recall cache.
		// Mental models persist on the Hindsight server across sessions and
		// must not be silently deleted by a local clear command — operators
		// who actually want to drop server-side state use the Hindsight UI or
		// `/memory mm delete <id>` explicitly.
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.mentalModelsEnabled": true,
		});
		vi.spyOn(HindsightApi.prototype, "listMentalModels").mockResolvedValue({ items: [] } as never);
		const deleteSpy = vi.spyOn(HindsightApi.prototype, "deleteMentalModel").mockResolvedValue(true);
		const session = makeFakeSession({ sessionId: "s-clear-mm" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		await hindsightBackend.clear("/tmp", "/tmp", session as never);
		expect(deleteSpy).not.toHaveBeenCalled();
	});
});

describe("hindsightBackend live bank routing", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Regression for issue #1902: changing `hindsight.bankId` during a live
	// session used to leave the active `HindsightSessionState` pinned to the
	// bank that was selected when the session started, so subsequent retains
	// kept landing in the stale bank ("omp") instead of the new one
	// ("Minigames"). The bank-routing settings must re-resolve on `set`.
	it("rebuilds the primary state when hindsight.bankId changes mid-session", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.scoping": "global",
		});
		// Seed bankId via `set` (not `isolated` overrides), otherwise the
		// follow-up `set` writes to `#global` while `get` keeps returning the
		// `#overrides` value — exactly the precedence the live settings UI
		// does NOT have, since real config writes land in `#global`.
		settings.set("hindsight.bankId", "omp");
		const session = makeFakeSession({ sessionId: "s-rebuild", settings });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		const initial = session.getHindsightSessionState();
		expect(initial?.bankId).toBe("omp");

		settings.set("hindsight.bankId", "Minigames");
		// Hook is sync but the rebuild is async; yield once so the handler runs.
		await Bun.sleep(0);

		const next = session.getHindsightSessionState();
		expect(next?.bankId).toBe("Minigames");
		// Must be a brand-new state — the old one was disposed.
		expect(next).not.toBe(initial);
	});

	// Same regression, exercising the `hindsight.scoping` axis: switching
	// scope mode also reshapes the bank id / tag filters and must rebuild.
	it("rebuilds the primary state when hindsight.scoping changes mid-session", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		settings.set("hindsight.scoping", "global");
		const session = makeFakeSession({ sessionId: "s-scoping", cwd: "/work/proj", settings });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		const initial = session.getHindsightSessionState();
		expect(initial?.bankId).toBe("omp");
		expect(initial?.retainTags).toBeUndefined();

		settings.set("hindsight.scoping", "per-project");
		await Bun.sleep(0);

		const next = session.getHindsightSessionState();
		expect(next?.bankId).toBe("omp-proj");
		expect(next).not.toBe(initial);
	});

	// Same setting written with the same value MUST NOT rebuild — a rebuild
	// would reset `lastRetainedTurn` / `hasRecalledForFirstTurn` and force a
	// fresh mental-model bootstrap for no observable reason.
	it("does not rebuild when the bank-routing setting is rewritten with the same value", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		settings.set("hindsight.bankId", "omp");
		const session = makeFakeSession({ sessionId: "s-noop", settings });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		const initial = session.getHindsightSessionState();
		settings.set("hindsight.bankId", "omp"); // unchanged
		await Bun.sleep(0);

		expect(session.getHindsightSessionState()).toBe(initial);
	});

	// Same regression flipped: resetting `hindsight.bankId` back to blank /
	// default after a non-empty value MUST also rebuild and route subsequent
	// retains to the default bank. The Codex-flagged follow-up was that the
	// fix had to be bidirectional — set→value AND value→reset. We defend the
	// reset direction end-to-end by enqueuing a retain after the reset and
	// asserting the batch call hits the recomputed bank, not the previous one.
	it("rebuilds when hindsight.bankId is reset to blank after a non-empty value", async () => {
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		settings.set("hindsight.scoping", "per-project");
		settings.set("hindsight.bankId", "Minigames");
		const session = makeFakeSession({ sessionId: "s-reset", cwd: "/work/_NEW_XenGameKit", settings });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const initial = session.getHindsightSessionState();
		expect(initial?.bankId).toBe("Minigames-_new_xengamekit");

		// Operator clears the bankId via the TUI — `settings.set(path, "")` is
		// the same call shape `#setSettingValue` uses for an empty text input.
		settings.set("hindsight.bankId", "");
		await Bun.sleep(0);

		const next = session.getHindsightSessionState();
		expect(next).not.toBe(initial);
		// With scoping=per-project the base falls back to the default ("omp"),
		// so the reset bank id picks up the project suffix from cwd.
		expect(next?.bankId).toBe("omp-_new_xengamekit");

		next!.enqueueRetain("post-reset fact", "reset routing");
		await next!.flushRetainQueue();

		expect(retainBatchSpy).toHaveBeenCalledTimes(1);
		expect(retainBatchSpy.mock.calls[0][0]).toBe("omp-_new_xengamekit");
	});

	// Companion case: when `hindsight.scoping` is `global`, clearing the
	// non-empty bankId should restore the bare `omp` default — the operator's
	// stated expectation in the live repro from #1902.
	it("routes future retains to the bare omp bank when bankId is cleared in global scoping", async () => {
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		settings.set("hindsight.scoping", "global");
		settings.set("hindsight.bankId", "Minigames-_NEW_XenGameKit");
		const session = makeFakeSession({ sessionId: "s-reset-global", settings });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		expect(session.getHindsightSessionState()?.bankId).toBe("Minigames-_NEW_XenGameKit");

		settings.set("hindsight.bankId", "");
		await Bun.sleep(0);

		const next = session.getHindsightSessionState();
		expect(next?.bankId).toBe("omp");

		next!.enqueueRetain("post-reset global fact");
		await next!.flushRetainQueue();

		expect(retainBatchSpy).toHaveBeenCalledTimes(1);
		expect(retainBatchSpy.mock.calls[0][0]).toBe("omp");
	});

	it("coalesces synchronous routing hooks so rebuilt states do not leak agent listeners", async () => {
		const retainSpy = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.retainEveryNTurns": 1,
		});
		settings.set("hindsight.bankId", "omp");
		settings.set("hindsight.scoping", "global");
		const entries = [
			{ role: "user" as const, text: "remember this routing coalesce fact" },
			{ role: "assistant" as const, text: "acknowledged routing coalesce fact" },
		];
		const session = makeFakeSession({ sessionId: "s-coalesce", cwd: "/work/proj", entries, settings });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		expect(session.listenerCount()).toBe(1);

		// Mirrors `Settings.#fireAllHooks()` during cwd reload: all three
		// Hindsight routing hooks can fire synchronously before the first async
		// queue flush continuation resumes. They must collapse into one rebuild.
		settings.set("hindsight.bankIdPrefix", "live");
		settings.set("hindsight.bankId", "Minigames");
		settings.set("hindsight.scoping", "per-project");
		await Bun.sleep(0);

		const next = session.getHindsightSessionState();
		expect(next?.bankId).toBe("live-Minigames-proj");
		expect(session.listenerCount()).toBe(1);

		session.emit({ type: "agent_end", messages: [] });
		await Bun.sleep(0);

		expect(retainSpy).toHaveBeenCalledTimes(1);
		expect(retainSpy.mock.calls[0][0]).toBe("live-Minigames-proj");
	});

	// Regression for issue #1902 fix #2: mental-model auto-seed used to POST
	// `createMentalModel` against a bank the server never saw, because the
	// old `ensureBankMission` skipped creation entirely when `bankMission`
	// was blank. The bank MUST be PUT (created) before any mental-model POST.
	it("creates the bank before mental-model bootstrap even when bankMission is blank", async () => {
		const callOrder: string[] = [];
		const createBankSpy = vi.spyOn(HindsightApi.prototype, "createBank").mockImplementation(async () => {
			callOrder.push("createBank");
			return {} as never;
		});
		const listMentalSpy = vi.spyOn(HindsightApi.prototype, "listMentalModels").mockImplementation(async () => {
			callOrder.push("listMentalModels");
			return { items: [] } as never;
		});
		const createMentalModelSpy = vi
			.spyOn(HindsightApi.prototype, "createMentalModel")
			.mockImplementation(async () => {
				callOrder.push("createMentalModel");
				return {} as never;
			});

		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.mentalModelsEnabled": true,
			"hindsight.mentalModelAutoSeed": true,
			"hindsight.bankMission": "",
		});
		const session = makeFakeSession({ sessionId: "s-bank-first", settings });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		await session.getHindsightSessionState()?.mentalModelsLoadPromise;

		expect(createBankSpy).toHaveBeenCalled();
		// First call must be `createBank`. Otherwise the mental-model POST
		// lands against a never-created bank and the server FK-fails it.
		expect(callOrder[0]).toBe("createBank");
		// Mental-model POSTs are allowed but they MUST come after the bank
		// is on the server.
		if (createMentalModelSpy.mock.calls.length > 0) {
			const bankIdx = callOrder.indexOf("createBank");
			const mmIdx = callOrder.indexOf("createMentalModel");
			expect(bankIdx).toBeLessThan(mmIdx);
		}
		void listMentalSpy;
	});
});

describe("hindsightBackend retain queue flush on session teardown", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Regression for issue #1902 fix #3: `AgentSession.dispose` used to clear
	// `#hindsightSessionState` BEFORE flushing the retain queue, so
	// `HindsightRetainQueue.#doFlush` saw `session.getHindsightSessionState()
	// !== state` and dropped the spliced batch. The fix flips the order:
	// flush MUST complete while the session pointer still references the same
	// state. We defend the contract end-to-end by enqueuing a tool-initiated
	// retain, then calling `flushRetainQueue` in the order
	// `AgentSession.dispose` uses (flush → clear → state.dispose).
	it("flushes the retain queue to the server before the session pointer clears", async () => {
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);

		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.bankId": "omp",
		});
		const session = makeFakeSession({ sessionId: "s-dispose-flush", settings });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = session.getHindsightSessionState();

		state!.enqueueRetain("durable fact", "test context");

		// AgentSession.dispose order: flush first, THEN clear, THEN dispose.
		// Reversed (clear → flush), `#doFlush`'s identity check would fail and
		// the batch would be dropped with a `session vanished` warning.
		await state!.flushRetainQueue();
		session.setHindsightSessionState(undefined);
		state!.dispose();

		expect(retainBatchSpy).toHaveBeenCalledTimes(1);
		const [bankId, items] = retainBatchSpy.mock.calls[0];
		expect(bankId).toBe("omp");
		expect(items).toHaveLength(1);
		expect(items[0].content).toBe("durable fact");
		expect(items[0].timestamp).toBeInstanceOf(Date);
	});

	// Companion contract test: documents the failure mode the dispose-order
	// fix prevents. If the session pointer is cleared first, the queue's
	// identity guard drops the spliced batch (and `retainBatch` is NOT
	// called). This is exactly what was happening before the fix.
	it("drops the spliced batch when the session pointer is cleared before flush (anti-regression)", async () => {
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);

		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s-buggy-order", settings });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = session.getHindsightSessionState();
		state!.enqueueRetain("dropped fact");

		// Buggy order — clear THEN flush. The queue's identity check fails.
		session.setHindsightSessionState(undefined);
		await state!.flushRetainQueue();

		expect(retainBatchSpy).not.toHaveBeenCalled();
	});
});
