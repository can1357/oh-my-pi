import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../src/config/model-registry";

import type { AgentSession } from "../src/session/agent-session";
import { createDefaultPersonaModelHooks, type PersonaModelApplyHooks } from "../src/session/persona-model-hooks";
import type { PersonaExplicitOverrides } from "../src/session/tool-policy";

type StubConfiguredThinking = ThinkingLevel;

// A minimal stub of the session surface the default hooks touch: model state
// plus the setters. Cast through `unknown` like the rest of the test suite.
interface StubModel {
	readonly provider: string;
	readonly id: string;
}

type StubThinkingLevel = ThinkingLevel | undefined;

interface StubSessionState {
	model: StubModel | undefined;
	thinkingLevel: StubThinkingLevel | undefined;
}

interface StubCall {
	readonly op: "setModel" | "setThinkingLevel";
	readonly value: string;
}

function makeStubSession(initial?: Partial<StubSessionState>) {
	const state: StubSessionState = {
		model: initial?.model ?? undefined,
		thinkingLevel: initial?.thinkingLevel ?? undefined,
	};
	const calls: StubCall[] = [];
	const session = {
		get model() {
			return state.model;
		},
		get thinkingLevel() {
			return state.thinkingLevel;
		},
		configuredThinkingLevel() {
			return state.thinkingLevel;
		},
		setModel(model: StubModel) {
			state.model = model;
			calls.push({ op: "setModel", value: `${model.provider}/${model.id}` });
			return Promise.resolve({ switched: true });
		},
		setThinkingLevel(level: StubConfiguredThinking) {
			state.thinkingLevel = level;
			calls.push({ op: "setThinkingLevel", value: level });
		},
	} as unknown as AgentSession;
	return { session, calls, state };
}

// Pattern resolution goes through the session's modelRegistry + settings; the
// stub registry resolves any pattern to the persona model so tests exercise
// apply/restore sequencing rather than pattern matching.
const PERSONA_MODEL = { provider: "stub", id: "claude-persona" } as Model;
const BASELINE_MODEL = { provider: "stub", id: "claude-baseline" } as Model;

function stubRegistry(session: AgentSession, models: Model[] = [PERSONA_MODEL]): AgentSession {
	const stubbed = session as AgentSession & { modelRegistry?: unknown };
	stubbed.modelRegistry = {
		getAvailable: () => models,
	} as unknown as ModelRegistry;
	return stubbed;
}

function makeAgent(overrides?: { model?: string[]; thinkingLevel?: StubThinkingLevel }) {
	return {
		name: "test-agent",
		description: "",
		systemPrompt: "",
		source: "bundled" as const,
		model: overrides?.model,
		thinkingLevel: overrides?.thinkingLevel,
	};
}

describe("PersonaModelApplyHooks", () => {
	test("hooks shape: apply only; per-surface channels absent on default hooks", async () => {
		const { session } = makeStubSession();
		const hooks: PersonaModelApplyHooks = createDefaultPersonaModelHooks(session);
		expect(typeof hooks.apply).toBe("function");
		expect(hooks.deferModelSwitchWhileStreaming).toBeUndefined();
		expect(hooks.deferModelRestoreWhileStreaming).toBeUndefined();
		expect(hooks.shouldDeferModelSwitch).toBeUndefined();
	});

	test("apply with persona model + thinking: model and thinking set on session", async () => {
		const stub = makeStubSession({
			model: BASELINE_MODEL,
			thinkingLevel: ThinkingLevel.Medium,
		});
		const hooks = createDefaultPersonaModelHooks(stubRegistry(stub.session));
		await hooks.apply(
			makeAgent({
				model: ["stub/claude-persona"],
				thinkingLevel: ThinkingLevel.High,
			}),
		);

		expect(stub.state.model).toBe(PERSONA_MODEL);
		expect(stub.state.thinkingLevel).toBe(ThinkingLevel.High);
	});

	test("apply with persona thinking only: thinking set, model untouched", async () => {
		const stub = makeStubSession({
			model: BASELINE_MODEL,
			thinkingLevel: ThinkingLevel.Medium,
		});
		const hooks = createDefaultPersonaModelHooks(stub.session);
		await hooks.apply(makeAgent({ thinkingLevel: ThinkingLevel.Low }));

		expect(stub.state.model).toBe(BASELINE_MODEL);
		expect(stub.state.thinkingLevel).toBe(ThinkingLevel.Low);
	});

	test("repeated apply re-captures the session state at each apply (the runtime owns the restore)", async () => {
		const stub = makeStubSession({
			model: BASELINE_MODEL,
			thinkingLevel: ThinkingLevel.Medium,
		});
		const hooks = createDefaultPersonaModelHooks(stubRegistry(stub.session));
		await hooks.apply(
			makeAgent({
				model: ["stub/claude-persona"],
				thinkingLevel: ThinkingLevel.High,
			}),
		);
		expect(stub.state.model).toBe(PERSONA_MODEL);
		expect(stub.state.thinkingLevel).toBe(ThinkingLevel.High);

		// A second apply re-runs the resolution against the (already
		// persona-modeled) session: the hooks object holds no restore channel.
		await hooks.apply(
			makeAgent({
				model: ["stub/claude-persona"],
				thinkingLevel: ThinkingLevel.Low,
			}),
		);
		expect(stub.state.model).toBe(PERSONA_MODEL);
		expect(stub.state.thinkingLevel).toBe(ThinkingLevel.Low);
	});

	test("apply with no persona model and no explicit override leaves session untouched", async () => {
		const stub = makeStubSession({
			model: BASELINE_MODEL,
			thinkingLevel: ThinkingLevel.Medium,
		});
		const hooks = createDefaultPersonaModelHooks(stub.session);
		await hooks.apply(makeAgent());
		expect(stub.state.model).toBe(BASELINE_MODEL);
		expect(stub.state.thinkingLevel).toBe(ThinkingLevel.Medium);
		expect(stub.calls).toHaveLength(0);
	});

	test("apply with unresolvable model pattern leaves model untouched (baseline preserved)", async () => {
		const stub = makeStubSession({ model: BASELINE_MODEL });
		// Registry without the pattern's model: resolution misses, baseline kept.
		const hooks = createDefaultPersonaModelHooks(stubRegistry(stub.session, [BASELINE_MODEL]));
		await hooks.apply(makeAgent({ model: ["stub/claude-persona"] }));
		expect(stub.state.model).toBe(BASELINE_MODEL);
	});

	test("apply resolves explicit override model over the agent definition", async () => {
		const stub = makeStubSession({ model: BASELINE_MODEL });
		const hooks = createDefaultPersonaModelHooks(
			stubRegistry(stub.session, [PERSONA_MODEL, { provider: "stub", id: "claude-explicit" } as Model]),
		);
		const explicit: PersonaExplicitOverrides = {
			model: "stub/claude-explicit",
		};
		await hooks.apply(makeAgent({ model: ["stub/claude-persona"] }), explicit);
		expect(stub.state.model?.id).toBe("claude-explicit");
	});

	test("apply resolves explicit thinking over the agent definition", async () => {
		const stub = makeStubSession({
			model: BASELINE_MODEL,
			thinkingLevel: ThinkingLevel.Medium,
		});
		const hooks = createDefaultPersonaModelHooks(stub.session);
		const explicit: PersonaExplicitOverrides = { thinking: "low" };
		await hooks.apply(makeAgent({ thinkingLevel: ThinkingLevel.High }), explicit);
		expect(stub.state.thinkingLevel).toBe(ThinkingLevel.Low);
	});

	test("apply re-resolution under an explicit override wins over the agent definition again", async () => {
		const stub = makeStubSession({
			model: BASELINE_MODEL,
			thinkingLevel: ThinkingLevel.Medium,
		});
		const hooks = createDefaultPersonaModelHooks(
			stubRegistry(stub.session, [PERSONA_MODEL, { provider: "stub", id: "claude-explicit" } as Model]),
		);
		const explicit: PersonaExplicitOverrides = { model: "stub/claude-explicit" };
		await hooks.apply(makeAgent({ model: ["stub/claude-persona"] }), explicit);
		expect(stub.state.model?.id).toBe("claude-explicit");
	});
});
