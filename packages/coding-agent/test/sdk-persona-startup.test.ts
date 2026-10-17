/**
 * Contract tests for the SDK startup persona loading path (createAgentSession).
 *
 * Oracle: when `taskDepth === 0` (top-level session), createAgentSession must:
 *   1. Auto-load the first primary agent (by order) when the session has no stamps
 *   2. Restore the last-stamped agent on resume (case-insensitive match)
 *   3. Fall back to the first primary when the stamped agent no longer exists on disk
 *   4. Prefer --agent flag over any stamp or default
 *   5. Skip subagent-mode agents entirely (only primary agents are eligible)
 *   6. Never auto-apply a project-sourced persona's model on a fresh session —
 *      only "bundled"/"user" sources (or an explicit --agent) may swap the model
 *
 * Tested by spying on discoverAgents so no agent files need to live on disk.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

function makeAgent(
	name: string,
	mode: "primary" | "subagent" = "primary",
	order?: number,
	models?: string[],
	source: AgentDefinition["source"] = "user",
): AgentDefinition {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: `You are ${name}.`,
		mode,
		order,
		source,
		tools: [],
		...(models ? { model: models } : {}),
	};
}

function userMsg() {
	return { role: "user" as const, content: "hello", timestamp: Date.now() };
}

describe("createAgentSession — startup persona loading", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: Array<{ dispose(): Promise<void> }> = [];

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const s of sessions.splice(0)) {
			await s.dispose();
		}
	});

	async function create(
		sessionManager: SessionManager,
		agents: AgentDefinition[],
		initialAgentName?: string,
		startupOptions: Pick<CreateAgentSessionOptions, "model" | "thinkingLevel"> = {},
	) {
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents,
			projectAgentsDir: null,
		});
		const { session } = await createAgentSession({
			cwd: "/tmp/persona-startup-test",
			sessionManager,
			modelRegistry,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			...startupOptions,
			...(initialAgentName ? { initialAgentName } : {}),
		});
		sessions.push(session);
		return session;
	}

	it("loads the first primary agent (by order) when session has no stamps", async () => {
		const sm = SessionManager.inMemory();
		// Agents deliberately out-of-order — sorted by order asc
		const session = await create(sm, [
			makeAgent("gamma", "primary", 3),
			makeAgent("alpha", "primary", 1),
			makeAgent("beta", "primary", 2),
		]);
		expect(session.activePersonaName).toBe("alpha");
	});

	it("does not load any persona when no primary agents exist", async () => {
		const sm = SessionManager.inMemory();
		const session = await create(sm, [makeAgent("worker", "subagent")]);
		expect(session.activePersonaName).toBeNull();
	});

	it("ignores subagent-mode agents when choosing the default", async () => {
		const sm = SessionManager.inMemory();
		const session = await create(sm, [
			makeAgent("worker", "subagent", 0), // order 0 but subagent — must be skipped
			makeAgent("boss", "primary", 1),
		]);
		expect(session.activePersonaName).toBe("boss");
	});

	it("restores the last-stamped agent on resume", async () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(userMsg(), "beta");

		const session = await create(sm, [makeAgent("alpha", "primary", 1), makeAgent("beta", "primary", 2)]);
		expect(session.activePersonaName).toBe("beta");
	});

	it("stamp lookup is case-insensitive", async () => {
		const sm = SessionManager.inMemory();
		// Stamped with mixed case...
		sm.appendMessage(userMsg(), "Beta");

		// ...but agent definition uses lowercase
		const session = await create(sm, [makeAgent("beta", "primary", 1)]);
		expect(session.activePersonaName).toBe("beta");
	});

	it("falls back to first primary when the stamped agent no longer exists on disk", async () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(userMsg(), "deleted-agent");

		// "deleted-agent" is not in the discovered list anymore
		const session = await create(sm, [makeAgent("alpha", "primary", 1), makeAgent("beta", "primary", 2)]);
		expect(session.activePersonaName).toBe("alpha");
	});

	it("--agent flag takes precedence over session stamp and defaults", async () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(userMsg(), "beta"); // stamp says beta

		const session = await create(
			sm,
			[makeAgent("alpha", "primary", 1), makeAgent("beta", "primary", 2)],
			"alpha", // --agent says alpha
		);
		expect(session.activePersonaName).toBe("alpha");
	});

	it("does not write model_change or thinking_level_change on startup restore", async () => {
		// Enable anthropic auth so the persona's model string can resolve
		authStorage.keys.setRuntime("anthropic", "test-key");

		const sm = SessionManager.inMemory();
		// Stamp a persona in history so startup uses the restore path (not default-first)
		sm.appendMessage(userMsg(), "alpha");
		const stampCount = sm.getBranch().length;

		await create(sm, [
			// Model with explicit thinking (:high) exercises both the model_change and
			// thinking_level_change guards added by I3.
			makeAgent("alpha", "primary", 1, ["anthropic/claude-sonnet-4-5:high"]),
		]);

		const newEntries = sm.getBranch().slice(stampCount);
		expect(newEntries.filter(e => e.type === "model_change")).toHaveLength(0);
		expect(newEntries.filter(e => e.type === "thinking_level_change")).toHaveLength(0);
	});

	it("stamp-restore startup passes mode: 'restore', preserving the session's restored model", async () => {
		const sm = SessionManager.inMemory();
		// Stamp session as if a previous run applied "alpha"
		sm.appendMessage(userMsg(), "alpha");

		const spy = vi.spyOn(AgentSession.prototype, "applyAgentPersona");

		await create(sm, [makeAgent("alpha", "primary", 1, ["anthropic/claude-sonnet-4-5"])]);

		// The agent was inferred from a session stamp, so mode must be "restore" —
		// the session's restored model (from branch history) should not be clobbered
		// by the persona's frontmatter model.
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][1]).toMatchObject({ mode: "restore" });
	});

	it("explicit --agent startup passes mode: 'cycle', applying the persona model", async () => {
		const sm = SessionManager.inMemory();

		const spy = vi.spyOn(AgentSession.prototype, "applyAgentPersona");

		await create(sm, [makeAgent("alpha", "primary", 1, ["anthropic/claude-sonnet-4-5"])], "alpha");

		// Explicit --agent: persona model should be applied (user chose this persona
		// intentionally, including its configured model).
		expect(spy).toHaveBeenCalledTimes(1);
		const opts = spy.mock.calls[0][1] as { mode?: string } | undefined;
		expect(opts?.mode).toBe("cycle");
	});

	it("invalid --agent does not fall through to session stamp", async () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(userMsg(), "beta"); // stamp says beta

		// Provide --agent with a name that doesn't match any primary agent (typo).
		const session = await create(
			sm,
			[makeAgent("alpha", "primary", 1), makeAgent("beta", "primary", 2)],
			"nonexistent-typo",
		);

		// Must fall back to first primary ("alpha"), NOT restore the stamp ("beta").
		// An explicitly rejected flag should never silently load an unrelated persona.
		expect(session.activePersonaName).toBe("alpha");
	});

	it("startup with no session stamp passes mode: 'cycle' so persona model survives next resume", async () => {
		const sm = SessionManager.inMemory(); // no stamp — genuinely fresh
		const spy = vi.spyOn(AgentSession.prototype, "applyAgentPersona");

		await create(sm, [makeAgent("alpha", "primary", 1, ["anthropic/claude-sonnet-4-5"])]);

		// mode must be "cycle": the model_change must be written to history so that
		// the next resume (mode: "restore") still runs the correct model.
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][1]).toMatchObject({ mode: "cycle" });
	});

	it("unstamped legacy session (existing messages, no persona stamp) passes mode: 'restore'", async () => {
		const sm = SessionManager.inMemory();
		// Existing session with messages but no persona stamp — simulates a
		// session created before this feature shipped. getLastAgentName()
		// returns undefined (no stamp), but hasExistingSession is true.
		sm.appendMessage(userMsg());
		const spy = vi.spyOn(AgentSession.prototype, "applyAgentPersona");

		await create(sm, [makeAgent("alpha", "primary", 1, ["anthropic/claude-sonnet-4-5"])]);

		// Falling back to primaryAgents[0] here must not be treated as a fresh
		// "cycle" — the session's model was already restored from model_change
		// history earlier in startup, and mode: "cycle" would silently
		// overwrite it with the persona's frontmatter model.
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][1]).toMatchObject({ mode: "restore" });
	});

	it("explicit --agent startup passes mode: 'cycle'", async () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(userMsg(), "alpha");
		const spy = vi.spyOn(AgentSession.prototype, "applyAgentPersona");

		// --agent beta overrides the stamp; beta has a model — must be recorded.
		await create(
			sm,
			[makeAgent("alpha", "primary", 1), makeAgent("beta", "primary", 2, ["anthropic/claude-sonnet-4-5"])],
			"beta",
		);

		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][1]).toMatchObject({ mode: "cycle" });
	});
	it("honors explicit-clear null sentinel on startup — does not load first primary", async () => {
		const sm = SessionManager.inMemory();
		// Write a null persona_change to simulate a session that explicitly cleared its persona.
		sm.appendPersonaChange(null);

		const session = await create(sm, [makeAgent("alpha", "primary", 1)]);

		// null sentinel must be preserved — first primary should NOT auto-load.
		expect(session.activePersonaName).toBeNull();
	});

	it("--agent flag overrides explicit-clear null sentinel", async () => {
		const sm = SessionManager.inMemory();
		sm.appendPersonaChange(null);

		const session = await create(sm, [makeAgent("alpha", "primary", 1)], "alpha");

		// Explicit --agent overrides the sentinel.
		expect(session.activePersonaName).toBe("alpha");
	});

	it("fresh session with a project-sourced default persona passes mode: 'restore' — does not auto-apply its model", async () => {
		const sm = SessionManager.inMemory(); // no stamp — genuinely fresh
		const spy = vi.spyOn(AgentSession.prototype, "applyAgentPersona");

		await create(sm, [makeAgent("alpha", "primary", 1, ["anthropic/claude-sonnet-4-5"], "project")]);

		// A project-sourced primary is discovered from the repo's own files, not
		// chosen by the user — opening a checkout must not silently swap the
		// user's model/provider. The persona prompt still applies via "restore".
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][1]).toMatchObject({ mode: "restore" });
	});

	it("explicit model option on startup passes mode: 'restore' — does not auto-apply the persona's model", async () => {
		const model = getBundledModel("cursor", "composer-1.5");
		if (!model) throw new Error("Expected bundled Cursor model");

		const sm = SessionManager.inMemory(); // no stamp — genuinely fresh
		const spy = vi.spyOn(AgentSession.prototype, "applyAgentPersona");

		await create(sm, [makeAgent("alpha", "primary", 1, ["anthropic/claude-sonnet-4-5"], "bundled")], undefined, {
			model,
		});

		// The caller explicitly selected this model before startup. The persona
		// prompt still applies via "restore", but its frontmatter model must not
		// overwrite the caller's model/provider selection.
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][1]).toMatchObject({ mode: "restore" });
	});

	it("explicit thinking-level option on startup passes mode: 'restore' — does not auto-apply the persona's model", async () => {
		const sm = SessionManager.inMemory(); // no stamp — genuinely fresh
		const spy = vi.spyOn(AgentSession.prototype, "applyAgentPersona");

		await create(sm, [makeAgent("alpha", "primary", 1, ["anthropic/claude-sonnet-4-5:high"], "bundled")], undefined, {
			thinkingLevel: Effort.Low,
		});

		// The caller explicitly selected this thinking level before startup. The
		// persona prompt still applies via "restore", but its model suffix must
		// not overwrite the caller's thinking-level selection.
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][1]).toMatchObject({ mode: "restore" });
	});

	it("bundled- and user-sourced default personas still auto-apply their model on a fresh session", async () => {
		for (const source of ["bundled", "user"] as const) {
			const sm = SessionManager.inMemory();
			const spy = vi.spyOn(AgentSession.prototype, "applyAgentPersona");

			await create(sm, [makeAgent("alpha", "primary", 1, ["anthropic/claude-sonnet-4-5"], source)]);

			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0][1]).toMatchObject({ mode: "cycle" });
			vi.restoreAllMocks();
		}
	});

	it("explicit --agent still applies the model for a project-sourced persona", async () => {
		const sm = SessionManager.inMemory();
		const spy = vi.spyOn(AgentSession.prototype, "applyAgentPersona");

		await create(sm, [makeAgent("alpha", "primary", 1, ["anthropic/claude-sonnet-4-5"], "project")], "alpha");

		// Explicit --agent is informed user action — it overrides the source gate
		// regardless of where the persona definition came from.
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][1]).toMatchObject({ mode: "cycle" });
	});
});
