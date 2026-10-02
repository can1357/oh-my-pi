/**
 * `/new` (AgentSession.newSession) must not carry a persona across the
 * logical session boundary: the runtime exits before the transcript and
 * context are cleared, so the fresh session starts from the unrestricted
 * baseline — no stale grant, append prompt, or spawn override.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { PersonaRuntime } from "@oh-my-pi/pi-coding-agent/session/persona-runtime";
import type { PersonaModelApplyHooks } from "@oh-my-pi/pi-coding-agent/session/persona-model-hooks";
import { SessionToolPolicy, type DiscoveredAgent } from "@oh-my-pi/pi-coding-agent/session/tool-policy";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function makePersona(overrides: Partial<DiscoveredAgent> = {}): DiscoveredAgent {
	return {
		name: "persona-a",
		description: "test persona",
		systemPrompt: "persona-a identity prompt",
		tools: ["read", "grep"],
		source: "bundled",
		...overrides,
	};
}

function makeStubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `Stub ${name}`,
		parameters: {} as never,
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
}

describe("persona state teardown for /new sessions", () => {
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	afterEach(async () => {
		if (session) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
	});

	async function makePersonaSession(
		persona?: DiscoveredAgent,
		options?: { cancelBeforeSwitch?: boolean },
	): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const toolRegistry = new Map<string, AgentTool>();
		for (const name of ["read", "grep", "bash", "edit", "write", "task"]) {
			toolRegistry.set(name, makeStubTool(name));
		}
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("anthropic", "test-key");
		const policy = new SessionToolPolicy({
			registry: () => new Set(["read", "grep", "bash", "edit", "write", "task"]),
			isDefaultActive: () => true,
		});
		const extensionRunner =
			options?.cancelBeforeSwitch === true
				? ({
						hasHandlers: (eventType: string) => eventType === "session_before_switch",
						emit: async () => ({ cancel: true }),
					} as never)
				: undefined;
		const s = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			toolPolicy: policy,
			toolRegistry,
			extensionRunner,
		});
		s.setPersonaRuntime(new PersonaRuntime(policy, s));
		if (persona) await s.getPersonaRuntime()!.enter(persona, {}, { apply: async () => {} });
		return s;
	}

	it("newSession exits an active persona before clearing state", async () => {
		session = await makePersonaSession(makePersona());
		const policy = session.getToolPolicy()!;
		expect(policy.isPersonaActive()).toBe(true);
		expect(policy.effective("bash")).toBe(false); // persona tools: [read, grep]
		expect(session.getPersonaAppendPrompt()).toBe("persona-a identity prompt");

		await session.newSession();

		expect(policy.isPersonaActive()).toBe(false);
		expect(policy.effective("bash")).toBe(true); // unrestricted again
		expect(session.getPersonaAppendPrompt()).toBeUndefined();
		expect(session.getSessionSpawns()).toBe("*"); // no persona override → unrestricted host default
	});

	// Review P2 (presentation half of the ceiling discard): a persona exit
	// restores its snapshot THROUGH the journal ceiling (`granted()` gates the
	// replay), so only ceilinged names stay active. Clearing the ceiling at the
	// /new boundary must also repopulate the presentation — otherwise the fresh
	// session reports `effective("write")` true while write/bash stay absent
	// from the active tool set.
	it("newSession repopulates the presentation after clearing a journal ceiling", async () => {
		session = await makePersonaSession(makePersona());
		const policy = session.getToolPolicy()!;
		// A resumed persona whose journal carried a CLI `--tools read` ceiling.
		// Give the agent a real presentation first (the harness ships empty), so
		// the assertions below exercise the live tool set, not an empty default.
		session.agent.setTools(["read", "grep", "write", "bash"].map(name => makeStubTool(name)));
		await session.setActiveToolsByName(["read", "grep"]);
		policy.installJournalCeiling(["read"]);
		// The persona enter above filtered through granted() with no ceiling, so
		// read+grep are active; the ceiling install only bounds future funnels.
		expect(session.getActiveToolNames()).toContain("read");

		await session.newSession();

		// Both layers reset: the policy derivation AND the live presentation.
		expect(policy.journalCeiling).toBeNull();
		expect(policy.effective("write")).toBe(true);
		expect(session.getActiveToolNames()).toContain("write");
		expect(session.getActiveToolNames()).toContain("bash");
	});

	it("newSession is a no-op for persona state when none is active", async () => {
		session = await makePersonaSession();
		const policy = session.getToolPolicy()!;

		await session.newSession();

		expect(policy.isPersonaActive()).toBe(false);
		expect(session.getPersonaAppendPrompt()).toBeUndefined();
	});

	it("session_before_switch veto preserves the active persona", async () => {
		session = await makePersonaSession(makePersona(), { cancelBeforeSwitch: true });
		const policy = session.getToolPolicy()!;
		expect(policy.isPersonaActive()).toBe(true);

		const cancelled = await session.newSession();

		expect(cancelled).toBe(false);
		// The vetoed /new must leave the persona metadata intact: grant, identity
		// prompt, and persona spawn override all still in place.
		expect(policy.isPersonaActive()).toBe(true);
		expect(policy.effective("bash")).toBe(false);
		expect(session.getPersonaAppendPrompt()).toBe("persona-a identity prompt");
		expect(session.getSessionSpawns()).toBe("*"); // persona tools lack a spawns field → persona-owned null → host fallback `*`
	});

	// Review P2 (runtime half of the deferred-restore discard): a give-up'd
	// mid-turn persona exit parks its baseline in the runtime's
	// #deferredExitBaseline even after the surface queue gives up. /new's
	// boundary cleanup must drop that parked value too — a mid-turn /agent in
	// the fresh session would otherwise adopt the stale pre-persona model as
	// the new persona's exit baseline.
	it("newSession drops the runtime's parked deferred exit baseline", async () => {
		session = await makePersonaSession(makePersona());
		const runtime = session.getPersonaRuntime()!;

		// Park the deferred exit baseline exactly as a mid-turn exit does: the
		// runtime restores nothing (the surface owns the queue) and the value
		// survives until onPendingModelRestoreFlushed.
		const exitHooks = {
			apply: async () => {},
			shouldDeferModelSwitch: () => true,
			deferModelRestoreWhileStreaming: () => {},
		} as unknown as PersonaModelApplyHooks;
		// The park requires a mid-turn exit: isStreaming must read true while
		// the runtime parks the baseline.
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		try {
			await runtime.exit(exitHooks);
		} finally {
			delete (session as unknown as { isStreaming?: boolean }).isStreaming;
		}

		const parked = await runtime.snapshot();
		expect(parked.deferredExitBaseline?.model).toBeDefined();

		await session.newSession();

		const after = await runtime.snapshot();
		expect(after.deferredExitBaseline).toBeUndefined();
	});
});
