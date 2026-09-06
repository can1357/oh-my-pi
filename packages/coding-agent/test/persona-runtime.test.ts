import { describe, expect, it } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { PersonaRuntime, PersonaSwitchError } from "@oh-my-pi/pi-coding-agent/session/persona-runtime";
import type { PersonaModelApplyHooks } from "@oh-my-pi/pi-coding-agent/session/persona-model-hooks";
import { type DiscoveredAgent, SessionToolPolicy } from "@oh-my-pi/pi-coding-agent/session/tool-policy";

function makeAgent(overrides: Partial<DiscoveredAgent> = {}): DiscoveredAgent {
	return {
		name: "persona-a",
		description: "test persona",
		systemPrompt: "persona prompt",
		source: "bundled",
		...overrides,
	};
}

const ALL_TOOLS = new Set(["read", "grep", "glob", "write", "edit", "bash", "task", "hub"]);
interface SessionStub {
	isStreaming: boolean;
	enabledToolNames: string[];
	mountedToolNames: string[];
	activeToolNames: string[];
	model: undefined;
	thinkingLevel: undefined;
	spawnsOverride: string[] | "*" | null;
	appendPrompt: string | undefined;
	modeChangeCalls: Array<{ mode: string; data?: Record<string, unknown> }>;
	clearCacheKeyCalls: number;
	spawnsCalls: Array<string[] | "*" | null>;
	appendPromptCalls: Array<string | undefined>;
	refreshBaseSystemPromptCalls: number;
	presentationCalls: Array<{ toolNames: string[]; mountedToolNames: string[] }>;
}

function makeSessionStub(overrides: Partial<SessionStub> = {}): { stub: SessionStub; session: AgentSession } {
	const stub: SessionStub = {
		isStreaming: false,
		enabledToolNames: ["read", "grep", "glob", "write"],
		mountedToolNames: ["xd://alpha"],
		activeToolNames: ["read", "grep", "glob", "write"],
		model: undefined,
		refreshBaseSystemPromptCalls: 0,
		thinkingLevel: undefined,
		spawnsOverride: null,
		appendPrompt: undefined,
		clearCacheKeyCalls: 0,
		spawnsCalls: [],
		appendPromptCalls: [],
		modeChangeCalls: [],
		presentationCalls: [],
		...overrides,
	};
	const session = {
		get isStreaming() {
			return stub.isStreaming;
		},
		getEnabledToolNames: () => [...stub.enabledToolNames],
		getMountedXdevToolNames: () => [...stub.mountedToolNames],
		getActiveToolNames: () => [...stub.activeToolNames],
		get model() {
			return stub.model;
		},
		configuredThinkingLevel: () => stub.thinkingLevel,
		refreshBaseSystemPrompt: async () => {
			stub.refreshBaseSystemPromptCalls += 1;
		},
		setActiveToolPresentation: async (toolNames: string[], mountedToolNames: string[]) => {
			stub.presentationCalls.push({ toolNames: [...toolNames], mountedToolNames: [...mountedToolNames] });
		},
		clearInheritedProviderPromptCacheKey: () => {
			stub.clearCacheKeyCalls += 1;
		},
		getSessionSpawns: () => stub.spawnsOverride ?? "*",
		setSessionSpawns: (spawns: string[] | "*" | null) => {
			stub.spawnsOverride = spawns;
			stub.spawnsCalls.push(spawns);
		},
		applyPersonaAppendPrompt: (text: string | undefined) => {
			stub.appendPrompt = text;
			stub.appendPromptCalls.push(text);
		},
		getPersonaAppendPrompt: () => stub.appendPrompt,
		sessionManager: {
			appendModeChange: (mode: string, data?: Record<string, unknown>) => {
				stub.modeChangeCalls.push({ mode, data });
				return `entry-${stub.modeChangeCalls.length}`;
			},
		},
	} as unknown as AgentSession;
	return { stub, session };
}

function makeHooks(overrides: Partial<PersonaModelApplyHooks> = {}): PersonaModelApplyHooks {
	return {
		apply: async () => {},
		restore: async () => {},
		...overrides,
	};
}

function makeRuntime(session: AgentSession): PersonaRuntime {
	const policy = new SessionToolPolicy({
		registry: () => ALL_TOOLS,
		isDefaultActive: () => true,
	});
	return new PersonaRuntime(policy, session);
}

describe("PersonaRuntime", () => {
	it("snapshot captures all seven PersonaSwitchSnapshot fields", async () => {
		const { stub, session } = makeSessionStub();
		const runtime = makeRuntime(session);
		runtime.policy.enterPersona(makeAgent({ tools: ["read"] }), {});

		const snap = await runtime.snapshot();
		expect(snap.policy.persona?.agent.name).toBe("persona-a");
		expect(snap.policy.sessionToggles).toBeInstanceOf(Map);
		expect([...snap.tools]).toEqual(stub.enabledToolNames);
		expect([...snap.mountedToolNames]).toEqual(stub.mountedToolNames);
		expect(snap.baseModelOverride).toEqual({ model: undefined, thinkingLevel: undefined });
		expect(snap.appendPrompt).toBeUndefined();
		expect(snap.spawns).toBe("*"); // no persona: effective host spawns value
		expect(snap.lastAssistantUsageCleared).toBe(false);
		expect(Object.keys(snap).sort()).toEqual([
			"appendPrompt",
			"baseModelOverride",
			"lastAssistantUsageCleared",
			"mountedToolNames",
			"policy",
			"spawns",
			"tools",
		]);
	});

	it("restore round-trips a snapshot (policy persona + presentation)", async () => {
		const { stub, session } = makeSessionStub();
		const runtime = makeRuntime(session);
		runtime.policy.enterPersona(makeAgent({ tools: ["read", "write"] }), {});
		const snap = await runtime.snapshot();

		// Mutate after capture
		runtime.policy.exitPersona();
		runtime.policy.setSessionToolEnabled("read", false);
		stub.enabledToolNames = ["bash"];
		stub.mountedToolNames = ["xd://helper"];

		await runtime.restore(snap);

		expect(runtime.policy.isPersonaActive()).toBe(true);
		expect(runtime.policy.effective("read")).toBe(true);
		expect(runtime.policy.effective("bash")).toBe(false); // persona grant narrows
		expect(stub.presentationCalls).toEqual([
			{ toolNames: [...snap.tools], mountedToolNames: [...snap.mountedToolNames] },
		]);
	});

	it("enter throws PersonaSwitchError when session.isStreaming", async () => {
		const { session } = makeSessionStub({ isStreaming: true });
		const runtime = makeRuntime(session);
		expect(runtime.enter(makeAgent(), {}, makeHooks())).rejects.toThrow(PersonaSwitchError);
		expect(runtime.policy.isPersonaActive()).toBe(false);
	});

	it("enter invokes policy.enterPersona and refreshBaseSystemPrompt", async () => {
		const { stub, session } = makeSessionStub();
		const runtime = makeRuntime(session);
		let applied = 0;
		await runtime.enter(
			makeAgent({ tools: ["read", "grep"] }),
			{},
			makeHooks({ apply: async () => void (applied += 1) }),
		);

		expect(runtime.policy.isPersonaActive()).toBe(true);
		expect(runtime.policy.effective("read")).toBe(true);
		expect(runtime.policy.effective("write")).toBe(false);
		expect(applied).toBe(1);
		expect(stub.refreshBaseSystemPromptCalls).toBe(1);
	});

	it("enter applies persona state immediately and defers only the model when hooks report defer", async () => {
		const { stub, session } = makeSessionStub({ isStreaming: true });
		const runtime = makeRuntime(session);
		let deferred = 0;
		await runtime.enter(
			makeAgent(),
			{},
			makeHooks({
				shouldDeferModelSwitch: () => true,
				deferModelSwitchWhileStreaming: () => void (deferred += 1),
			}),
		);

		expect(deferred).toBe(1);
		expect(runtime.policy.isPersonaActive()).toBe(true);
		expect(stub.appendPrompt).toBe("persona prompt");
		expect(stub.refreshBaseSystemPromptCalls).toBe(1);
	});

	it("enter mid-turn with deferral hooks applies the persona immediately and defers the model", async () => {
		const { stub, session } = makeSessionStub({ isStreaming: true });
		const runtime = makeRuntime(session);
		const deferredAgents: string[] = [];
		let applied = 0;
		await runtime.enter(
			makeAgent({ tools: ["read"], model: ["deferred-model-pattern"] }),
			{},
			makeHooks({
				apply: async () => void (applied += 1),
				shouldDeferModelSwitch: () => true,
				deferModelSwitchWhileStreaming: agent => deferredAgents.push(agent.name),
			}),
		);

		expect(deferredAgents).toEqual(["persona-a"]);
		expect(applied).toBe(0); // model switch deferred, not applied
		expect(runtime.policy.isPersonaActive()).toBe(true);
		expect(runtime.policy.effective("read")).toBe(true);
		expect(runtime.policy.effective("write")).toBe(false);
		expect(stub.appendPrompt).toBe("persona prompt");
		expect(stub.refreshBaseSystemPromptCalls).toBe(1);
	});

	it("exit mid-turn with deferral hooks tears down immediately and defers the model restore", async () => {
		const { stub, session } = makeSessionStub({ isStreaming: false });
		const runtime = makeRuntime(session);
		let restored = 0;
		let restoreDeferred = 0;
		const hooks = makeHooks({
			restore: async () => void (restored += 1),
			shouldDeferModelSwitch: () => true,
			deferModelRestoreWhileStreaming: () => void (restoreDeferred += 1),
		});
		await runtime.enter(makeAgent({ tools: ["read"] }), {}, hooks);
		stub.isStreaming = true; // turn starts after persona entry

		await runtime.exit(hooks);

		expect(restoreDeferred).toBe(1);
		expect(restored).toBe(0); // model restore deferred, not applied
		expect(runtime.policy.isPersonaActive()).toBe(false);
		expect(stub.appendPrompt).toBeUndefined();
		expect(stub.refreshBaseSystemPromptCalls).toBe(2);
	});

	it("exit mid-turn without deferral hooks throws and leaves the persona active", async () => {
		const { stub, session } = makeSessionStub({ isStreaming: false });
		const runtime = makeRuntime(session);
		await runtime.enter(makeAgent(), {}, makeHooks());
		stub.isStreaming = true;

		await expect(runtime.exit(makeHooks())).rejects.toThrow(PersonaSwitchError);

		expect(runtime.policy.isPersonaActive()).toBe(true);
		expect(stub.appendPrompt).toBe("persona prompt");
	});

	it("exit restores presentation from the post-exit effective set, preserving mid-persona toggles", async () => {
		const { stub, session } = makeSessionStub();
		const runtime = makeRuntime(session);
		await runtime.enter(makeAgent({ tools: ["read", "grep"] }), {}, makeHooks());
		runtime.policy.setSessionToolEnabled("bash", false); // user toggle mid-persona

		await runtime.exit(makeHooks());

		const last = stub.presentationCalls.at(-1);
		expect(last?.toolNames).toContain("write"); // pre-persona tool regained
		expect(last?.toolNames).toContain("grep");
		expect(last?.toolNames).not.toContain("bash"); // toggle respected
	});

	it("rollback restores model/thinking through hooks.restore", async () => {
		const { session } = makeSessionStub();
		const runtime = makeRuntime(session);
		const boom = new Error("refresh failed");
		// Fail the transaction AFTER apply so the model channel has mutated state.
		(session as unknown as { refreshBaseSystemPrompt: () => Promise<void> }).refreshBaseSystemPrompt = async () => {
			throw boom;
		};
		let restores = 0;
		await expect(
			runtime.enter(makeAgent(), {}, makeHooks({ restore: async () => void (restores += 1) })),
		).rejects.toThrow(boom);

		expect(restores).toBe(1);
	});

	it("reconcile restores the pre-reconcile persona when enter fails", async () => {
		const { session } = makeSessionStub();
		const runtime = makeRuntime(session);
		await runtime.enter(makeAgent({ name: "first", tools: ["read"] }), {}, makeHooks());
		const boom = new Error("enter failed");
		await expect(
			runtime.reconcile(
				{ agent: makeAgent({ name: "second", tools: ["write"] }) },
				makeHooks({
					apply: async () => {
						throw boom;
					},
				}),
			),
		).rejects.toThrow(boom);

		// Pre-reconcile state restored (first persona still active), not the
		// post-exit default.
		expect(runtime.policy.isPersonaActive()).toBe(true);
		expect(runtime.policy.effective("read")).toBe(true);
		expect(runtime.policy.effective("write")).toBe(false);
	});

	it("rollback: on error mid-enter, snapshot state is restored and the error rethrown", async () => {
		const { stub, session } = makeSessionStub();
		const runtime = makeRuntime(session);
		const boom = new Error("apply failed");
		await expect(
			runtime.enter(
				makeAgent({ tools: ["read"] }),
				{},
				makeHooks({
					apply: async () => {
						throw boom;
					},
				}),
			),
		).rejects.toThrow(boom);

		expect(runtime.policy.isPersonaActive()).toBe(false); // rolled back
		expect(stub.presentationCalls.length).toBeGreaterThan(0); // restore path ran
	});

	it("exit clears the persona and calls hooks.restore", async () => {
		const { session } = makeSessionStub();
		const runtime = makeRuntime(session);
		let restored = 0;
		await runtime.enter(makeAgent({ tools: ["read"] }), {}, makeHooks());
		await runtime.exit(makeHooks({ restore: async () => void (restored += 1) }));

		expect(runtime.policy.isPersonaActive()).toBe(false);
		expect(restored).toBe(1);
	});

	it("reconcile replaces an active persona with the desired one", async () => {
		const { session } = makeSessionStub();
		const runtime = makeRuntime(session);
		await runtime.enter(makeAgent({ name: "first", tools: ["read"] }), {}, makeHooks());
		await runtime.reconcile({ agent: makeAgent({ name: "second", tools: ["write"] }) }, makeHooks());

		expect(runtime.policy.isPersonaActive()).toBe(true);
		expect(runtime.policy.effective("write")).toBe(true);
		expect(runtime.policy.effective("read")).toBe(false);
	});

	it("reconcile enters directly when no persona is active", async () => {
		const { session } = makeSessionStub();
		const runtime = makeRuntime(session);
		let exits = 0;
		await runtime.reconcile(
			{ agent: makeAgent({ tools: ["read"] }) },
			makeHooks({ restore: async () => void (exits += 1) }),
		);
		expect(exits).toBe(0);
		expect(runtime.policy.isPersonaActive()).toBe(true);
	});
});

describe("PersonaSwitchTransaction", () => {
	it("rollback restores the runtime state captured at begin", async () => {
		const { stub, session } = makeSessionStub();
		const runtime = makeRuntime(session);
		runtime.policy.enterPersona(makeAgent({ tools: ["read"] }), {});
		const tx = await import("@oh-my-pi/pi-coding-agent/session/persona-runtime").then(m =>
			m.PersonaSwitchTransaction.begin(runtime),
		);
		runtime.policy.exitPersona();
		await tx.rollback();

		expect(runtime.policy.isPersonaActive()).toBe(true);
		expect(stub.presentationCalls.length).toBe(1);
	});
});
