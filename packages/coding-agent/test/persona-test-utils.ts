/**
 * Shared persona test fixtures: a stubbed AgentSession exercising the exact
 * surface PersonaRuntime and the `/agent` slash handler touch, plus the
 * DiscoveredAgent/hooks factories the persona suites share.
 */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { PersonaModelApplyHooks } from "@oh-my-pi/pi-coding-agent/session/persona-model-hooks";
import { PersonaRuntime } from "@oh-my-pi/pi-coding-agent/session/persona-runtime";
import { type DiscoveredAgent, SessionToolPolicy } from "@oh-my-pi/pi-coding-agent/session/tool-policy";

export const ALL_TOOLS = new Set(["read", "grep", "glob", "write", "edit", "bash", "task", "hub"]);

/** Default persona frontmatter; `systemPrompt` is asserted through appendPrompt in the runtime suites. */
export function makePersonaAgent(overrides: Partial<DiscoveredAgent> = {}): DiscoveredAgent {
	return {
		name: "persona-a",
		description: "test persona",
		systemPrompt: "persona prompt",
		source: "bundled",
		...overrides,
	};
}

export interface SessionStub {
	isStreaming: boolean;
	enabledToolNames: string[];
	mountedToolNames: string[];
	activeToolNames: string[];
	/** Simulated tool registry (registered ≠ enabled: dormant tools included). */
	registeredToolNames: string[];
	model: { provider: string; id: string } | undefined;
	thinkingLevel: string | undefined;
	// j2g: reconcile's baselineOverride carries a Model-shaped object; the stub
	// stores whatever the test assigns and compares structurally.
	spawnsOverride: string[] | "*" | null;
	appendPrompt: string | undefined;
	setModelCalls: string[];
	setThinkingCalls: Array<string | undefined>;
	modeChangeCalls: Array<{ mode: string; data?: Record<string, unknown> }>;
	clearCacheKeyCalls: number;
	spawnsCalls: Array<string[] | "*" | null>;
	appendPromptCalls: Array<string | undefined>;
	refreshBaseSystemPromptCalls: number;
	presentationCalls: Array<{ toolNames: string[]; mountedToolNames: string[] }>;
	noticeCalls: Array<{ level: string; message: string }>;
}

export interface PersonaSessionStub {
	stub: SessionStub;
	session: AgentSession;
	policy: SessionToolPolicy;
	runtime: PersonaRuntime;
	modeChangeEntries: Array<{ mode: string; data?: Record<string, unknown> }>;
}

/** Registry getter stays live: mid-test registrations must be visible to the policy. */
function makePolicy(stub: SessionStub): SessionToolPolicy {
	return new SessionToolPolicy({
		registry: () => new Set(stub.registeredToolNames),
		isDefaultActive: () => true,
	});
}

/**
 * Stubbed AgentSession + policy + runtime. Covers the union surface the
 * persona-runtime and /agent slash suites exercise; suites that only need part
 * of it ignore the rest.
 */
export function makeSessionStub(overrides: Partial<SessionStub> = {}): PersonaSessionStub {
	const stub: SessionStub = {
		isStreaming: false,
		enabledToolNames: ["read", "grep", "glob", "write"],
		mountedToolNames: ["xd://alpha"],
		activeToolNames: ["read", "grep", "glob", "write"],
		registeredToolNames: [...ALL_TOOLS],
		model: undefined,
		refreshBaseSystemPromptCalls: 0,
		thinkingLevel: undefined,
		spawnsOverride: null,
		appendPrompt: undefined,
		appendPromptCalls: [],
		setModelCalls: [],
		setThinkingCalls: [],
		clearCacheKeyCalls: 0,
		spawnsCalls: [],
		modeChangeCalls: [],
		presentationCalls: [],
		noticeCalls: [],
		...overrides,
	};
	const modeChangeEntries: Array<{ mode: string; data?: Record<string, unknown> }> = [];
	const policy = makePolicy(stub);
	const runtimeRef: { current: PersonaRuntime | undefined } = { current: undefined };
	const session = {
		sessionManager: {
			appendModeChange: (mode: string, data?: Record<string, unknown>) => {
				modeChangeEntries.push({ mode, data });
				return `entry-${modeChangeEntries.length}`;
			},
		},
		get isStreaming() {
			return stub.isStreaming;
		},
		getEnabledToolNames: () => [...stub.enabledToolNames],
		getMountedXdevToolNames: () => [...stub.mountedToolNames],
		getActiveToolNames: () => [...stub.activeToolNames],
		getAllToolNames: () => [...stub.registeredToolNames],
		get model() {
			return stub.model;
		},
		configuredThinkingLevel: () => stub.thinkingLevel,
		setModel: async (model: { provider: string; id: string }) => {
			stub.model = model;
			stub.setModelCalls.push(`${model.provider}/${model.id}`);
		},
		setThinkingLevel: (level: string | undefined) => {
			stub.thinkingLevel = level;
			stub.setThinkingCalls.push(level);
		},
		refreshBaseSystemPrompt: async () => {
			stub.refreshBaseSystemPromptCalls += 1;
		},
		setActiveToolPresentation: async (toolNames: string[], mountedToolNames: string[]) => {
			stub.presentationCalls.push({
				toolNames: [...toolNames],
				mountedToolNames: [...mountedToolNames],
			});
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
		getPersonaRuntime: () => runtimeRef.current,
		getToolPolicy: () => policy,
		emitNotice: (level: string, message: string) => {
			stub.noticeCalls.push({ level, message });
		},
	} as unknown as AgentSession;
	const runtime = new PersonaRuntime(policy, session);
	runtimeRef.current = runtime;
	return { stub, session, policy, runtime, modeChangeEntries };
}

/** Empty apply hooks; override individual channels per test. */
export function makePersonaHooks(overrides: Partial<PersonaModelApplyHooks> = {}): PersonaModelApplyHooks {
	return {
		apply: async () => {},
		...overrides,
	};
}

/** PersonaRuntime over the stub's own policy; pass a stub when its registry was mutated mid-test. */
export function makeRuntime(session: AgentSession, stub?: SessionStub): PersonaRuntime {
	const policy = stub
		? makePolicy(stub)
		: new SessionToolPolicy({ registry: () => ALL_TOOLS, isDefaultActive: () => true });
	return new PersonaRuntime(policy, session);
}
