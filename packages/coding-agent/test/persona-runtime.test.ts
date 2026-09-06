import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { PersonaModelApplyHooks } from "@oh-my-pi/pi-coding-agent/session/persona-model-hooks";
import {
	readPersistedAgentPersona,
	serializePersonaBaseline,
} from "@oh-my-pi/pi-coding-agent/session/persisted-persona";
import {
	PersonaRuntime,
	PersonaSwitchError,
	PersonaSwitchTransaction,
} from "@oh-my-pi/pi-coding-agent/session/persona-runtime";
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
}

function makeSessionStub(overrides: Partial<SessionStub> = {}): {
	stub: SessionStub;
	session: AgentSession;
	eventListeners: Array<(event: { type: string }) => void>;
} {
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
		...overrides,
	};
	const eventListeners: Array<(event: { type: string }) => void> = [];
	const session = {
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
		subscribe: (listener: (event: { type: string }) => void) => {
			eventListeners.push(listener);
			return () => {
				const index = eventListeners.indexOf(listener);
				if (index >= 0) eventListeners.splice(index, 1);
			};
		},
		sessionManager: {
			appendModeChange: (mode: string, data?: Record<string, unknown>) => {
				stub.modeChangeCalls.push({ mode, data });
				return `entry-${stub.modeChangeCalls.length}`;
			},
		},
	} as unknown as AgentSession;
	return { stub, session, eventListeners };
}

function makeHooks(overrides: Partial<PersonaModelApplyHooks> = {}): PersonaModelApplyHooks {
	return {
		apply: async () => {},
		restore: async () => {},
		...overrides,
	};
}
function makeRuntime(session: AgentSession, stub?: SessionStub): PersonaRuntime {
	const policy = new SessionToolPolicy({
		registry: () => (stub ? new Set(stub.registeredToolNames) : ALL_TOOLS),
		isDefaultActive: () => true,
	});
	return new PersonaRuntime(policy, session);
}

describe("PersonaRuntime", () => {
	it("snapshot captures all PersonaSwitchSnapshot fields", async () => {
		const { stub, session } = makeSessionStub();
		const runtime = makeRuntime(session);
		runtime.policy.enterPersona(makeAgent({ tools: ["read"] }), {});

		const snap = await runtime.snapshot();
		expect(snap.policy.persona?.agent.name).toBe("persona-a");
		expect(snap.policy.sessionToggles).toBeInstanceOf(Map);
		expect([...snap.tools]).toEqual(stub.enabledToolNames);
		expect([...snap.mountedToolNames]).toEqual(stub.mountedToolNames);
		expect(snap.baseModelOverride).toEqual({
			model: undefined,
			thinkingLevel: undefined,
		});
		expect(snap.appendPrompt).toBeUndefined();
		expect(snap.spawns).toBe("*"); // no persona: effective host spawns value
		expect(snap.activeBaseline).toBeUndefined(); // enterPersona bypasses runtime baseline capture
		expect(Object.keys(snap).sort()).toEqual([
			"activeBaseline",
			"activePresentationSnapshot",
			"appendPrompt",
			"baseModelOverride",
			"enterRegistryNames",
			"mountedToolNames",
			"policy",
			"spawns",
			"tools",
		]);
		expect(snap.activePresentationSnapshot).toBeUndefined();
	});

	it("restore round-trips a snapshot (policy persona + presentation)", async () => {
		const { stub, session } = makeSessionStub();
		const runtime = makeRuntime(session);
		runtime.policy.enterPersona(makeAgent({ tools: ["read", "write"] }), {});
		const snap = await runtime.snapshot();

		// Mutate after capture
		runtime.policy.exitPersona();
		stub.enabledToolNames = ["bash"];
		stub.mountedToolNames = ["xd://helper"];

		await runtime.restore(snap);

		expect(runtime.policy.isPersonaActive()).toBe(true);
		expect(runtime.policy.effective("read")).toBe(true);
		expect(runtime.policy.effective("bash")).toBe(false); // persona grant narrows
		expect(stub.presentationCalls).toEqual([
			{
				toolNames: [...snap.tools],
				mountedToolNames: [...snap.mountedToolNames],
			},
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

	it("exit restores presentation from the post-exit effective set", async () => {
		const { stub, session } = makeSessionStub();
		const runtime = makeRuntime(session);
		await runtime.enter(makeAgent({ tools: ["read", "grep"] }), {}, makeHooks());

		await runtime.exit(makeHooks());

		const last = stub.presentationCalls.at(-1);
		expect(last?.toolNames).toContain("write"); // pre-persona tool regained
		expect(last?.toolNames).toContain("grep");
	});

	it("rollback restores model/thinking from the runtime baseline, not hooks.restore", async () => {
		const { stub, session } = makeSessionStub();
		const runtime = makeRuntime(session);
		const boom = new Error("refresh failed");
		// Fail the transaction AFTER apply so the model channel has mutated state.
		(session as unknown as { refreshBaseSystemPrompt: () => Promise<void> }).refreshBaseSystemPrompt = async () => {
			throw boom;
		};
		// Simulate the persona's apply: hooks capture a pre-apply baseline, then
		// mutate the session like the real apply would.
		const hooks = makeHooks({
			apply: async () => {
				stub.model = { provider: "stub", id: "persona-model" };
				stub.thinkingLevel = Effort.High;
			},
			// hooks.restore MUST NOT be the rollback's model channel: the hook
			// instance that ran apply does not survive to the rollback site in
			// production (exit builds fresh hooks). If restore() were required,
			// this counter would stay 0 in the real bug this test guards.
			restore: async () => {
				throw new Error("hooks.restore must not drive runtime rollback");
			},
		});
		stub.model = { provider: "stub", id: "baseline-model" };
		stub.thinkingLevel = "low";
		await expect(runtime.enter(makeAgent(), {}, hooks)).rejects.toThrow(boom);

		// Runtime baseline captured at enter: rolled back to pre-apply state.
		expect(stub.model).toEqual({ provider: "stub", id: "baseline-model" });
		expect(stub.thinkingLevel).toBe("low");
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

	it("failed persona-to-persona switch keeps the surviving persona's runtime baseline", async () => {
		// foy5k regression: the exit half of a persona→persona switch consumed
		// persona A's baseline, and the rollback snapshot carried none — leaving
		// the reinstated A baseline-less, so a later exit leaked A's model.
		const { stub, session } = makeSessionStub();
		const runtime = makeRuntime(session);
		stub.model = { provider: "stub", id: "pre-a-model" };
		stub.thinkingLevel = "low";
		await runtime.enter(
			makeAgent({ name: "a", tools: ["read"] }),
			{},
			makeHooks({
				apply: async () => {
					stub.model = { provider: "stub", id: "a-model" };
					stub.thinkingLevel = Effort.High;
				},
			}),
		);

		const boom = new Error("enter B failed");
		await expect(
			runtime.enter(
				makeAgent({ name: "b", tools: ["write"] }),
				{},
				makeHooks({
					apply: async () => {
						throw boom;
					},
				}),
			),
		).rejects.toThrow(boom);

		// Rollback reinstated persona A; a subsequent exit must restore the
		// PRE-A baseline from the runtime, not leak A's model.
		expect(runtime.policy.isPersonaActive()).toBe(true);
		expect(stub.model).toEqual({ provider: "stub", id: "a-model" }); // restore reverts from snapshot, not baseline
		await runtime.exit(makeHooks());
		expect(stub.model).toEqual({ provider: "stub", id: "pre-a-model" });
		expect(stub.thinkingLevel).toBe("low");
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

	const { stub, session } = makeSessionStub();
	it("exit restores model/thinking from the runtime baseline with FRESH hooks (foxls/foy5h)", async () => {
		const runtime = makeRuntime(session);
		// Enter hooks capture baseline and mutate the session like the real apply.
		stub.model = { provider: "stub", id: "baseline-model" };
		stub.thinkingLevel = "low";
		await runtime.enter(
			makeAgent({ tools: ["read"] }),
			{},
			makeHooks({
				apply: async () => {
					stub.model = { provider: "stub", id: "persona-model" };
					stub.thinkingLevel = Effort.High;
				},
			}),
		);
		expect(stub.model).toEqual({ provider: "stub", id: "persona-model" });

		// Exit builds a FRESH hooks object (the production shape: exitAgentPersona
		// constructs new hooks whose per-instance baseline is empty). The model
		// restore must come from the RUNTIME baseline, not hooks.restore.
		let hookRestores = 0;
		await runtime.exit(
			makeHooks({
				restore: async () => void (hookRestores += 1),
				deferModelRestoreWhileStreaming: () => {
					throw new Error("not streaming; defer channel must not fire");
				},
			}),
		);

		expect(runtime.policy.isPersonaActive()).toBe(false);
		expect(stub.model).toEqual({ provider: "stub", id: "baseline-model" });
		expect(stub.thinkingLevel).toBe("low");
		// hooks.restore is no longer the exit model channel.
		expect(hookRestores).toBe(0);
	});

	it("exit defers the model restore and passes the runtime baseline to the hook", async () => {
		const { stub, session } = makeSessionStub();
		const runtime = makeRuntime(session);
		stub.model = { provider: "stub", id: "baseline-model" };
		stub.thinkingLevel = "low";
		await runtime.enter(
			makeAgent({ tools: ["read"] }),
			{},
			makeHooks({
				apply: async () => {
					stub.model = { provider: "stub", id: "persona-model" };
					stub.thinkingLevel = Effort.High;
				},
			}),
		);
		stub.isStreaming = true; // turn starts after persona entry

		const queued: Array<{ model: unknown; thinkingLevel: unknown }> = [];
		await runtime.exit(
			makeHooks({
				shouldDeferModelSwitch: () => true,
				deferModelRestoreWhileStreaming: baseline => queued.push(baseline),
			}),
		);

		expect(queued).toEqual([
			{
				model: { provider: "stub", id: "baseline-model" },
				thinkingLevel: "low",
			},
		]);
		expect(stub.model).toEqual({ provider: "stub", id: "persona-model" }); // untouched mid-turn
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
	it("mid-turn A→B switch keeps the TRUE pre-A baseline for B's exit (fr-vV)", async () => {
		// Persona A is active, the turn is streaming, and A is exited mid-turn:
		// the exit QUEUES A's baseline restore (flushed only at turn end). Enter
		// B while still streaming — the live model is still A's persona model,
		// so B's baseline must come from the pre-chain root, not the live model.
		// B's exit must restore the true pre-A model, not A's persona model.
		const { stub, session } = makeSessionStub({ isStreaming: false });
		const runtime = makeRuntime(session);
		stub.model = { provider: "stub", id: "pre-a-model" };
		stub.thinkingLevel = "low";
		const queuedRestores: Array<{ model: unknown; thinkingLevel: unknown }> = [];
		// `applyModel` mutates the session like a real hooks apply; the empty
		// string skips the mutation (a persona with no model of its own).
		const hooksFor = (applyModel?: string): PersonaModelApplyHooks =>
			makeHooks({
				apply: async () => {
					if (applyModel) stub.model = { provider: "stub", id: applyModel };
				},
				shouldDeferModelSwitch: () => true,
				deferModelSwitchWhileStreaming: () => {},
				deferModelRestoreWhileStreaming: baseline => queuedRestores.push(baseline),
			});

		// Persona A entered BETWEEN turns: its model apply ran, the live session
		// is on A's persona model.
		await runtime.enter(makeAgent({ name: "a", tools: ["read"] }), {}, hooksFor("a-model"));
		expect(stub.model).toEqual({ provider: "stub", id: "a-model" });

		// A turn starts and A is exited MID-TURN: the exit QUEUES its baseline
		// restore (flushed only at turn end).
		stub.isStreaming = true;
		await runtime.exit(hooksFor());
		expect(queuedRestores).toHaveLength(1);
		expect(queuedRestores[0]?.model).toEqual({ provider: "stub", id: "pre-a-model" });

		// Enter B mid-turn, BEFORE the queued restore flushes: the live model is
		// still A's persona model. B's baseline must be the pre-chain root.
		await runtime.enter(makeAgent({ name: "b", tools: ["write"] }), {}, hooksFor("b-model"));
		expect(stub.model).toEqual({ provider: "stub", id: "a-model" }); // B's switch also deferred

		// Turn ends; the surface flushes A's queued restore; B exits.
		stub.isStreaming = false;
		stub.model = { provider: "stub", id: "pre-a-model" };
		stub.thinkingLevel = "low";
		await runtime.exit(makeHooks());

		// Regression guard: pre-fix, B's baseline captured the live A model, so
		// the exit restored A's persona model here instead of the true pre-A
		// baseline.
		expect(stub.model).toEqual({ provider: "stub", id: "pre-a-model" });
		expect(stub.thinkingLevel).toBe("low");
	});

	it("a user model change between mid-turn switches re-roots the baseline (fr-vV)", async () => {
		// The queued restore flushed, then the user deliberately picked a
		// different model — all before B's mid-turn enter. The root only bridges
		// ONE queued-restore gap: B's enter must baseline from the session as it
		// now stands (the user's model), not from the pre-A snapshot.
		const { stub, session } = makeSessionStub({ isStreaming: false });
		const runtime = makeRuntime(session);
		stub.model = { provider: "stub", id: "pre-a-model" };
		stub.thinkingLevel = "low";
		const hooksFor = (): PersonaModelApplyHooks =>
			makeHooks({
				shouldDeferModelSwitch: () => true,
				deferModelSwitchWhileStreaming: () => {},
			});

		await runtime.enter(makeAgent({ name: "a", tools: ["read"] }), {}, hooksFor());
		stub.isStreaming = true;
		await runtime.exit(hooksFor()); // A's restore queued; root = pre-a-model

		// Turn end: the queued restore flushes (InteractiveMode's queue calls
		// onPendingModelRestoreFlushed, which spends the root), and then the
		// user deliberately picks a different model before B's next enter.
		runtime.onPendingModelRestoreFlushed();
		stub.model = { provider: "stub", id: "user-model" };
		stub.thinkingLevel = Effort.High;
		stub.isStreaming = true;

		// B enters MID-TURN (deferred): the spent root cannot baseline from
		// pre-a-model; the user's deliberate /model pick is now authoritative.
		await runtime.enter(makeAgent({ name: "b", tools: ["write"] }), {}, hooksFor());
		stub.isStreaming = false; // turn ends: B's restore is applied live
		await runtime.exit(makeHooks());

		expect(stub.model).toEqual({ provider: "stub", id: "user-model" });
		expect(stub.thinkingLevel).toBe(Effort.High);
	});

	it("baseline serialization round-trips through the journal contract", () => {
		expect(serializePersonaBaseline({ model: { provider: "stub", id: "m" }, thinkingLevel: "high" })).toEqual({
			model: "stub/m",
			thinkingLevel: Effort.High,
		});
		// No captured state: omitted entirely (the writer drops the key).
		expect(serializePersonaBaseline({ model: undefined, thinkingLevel: undefined })).toBeUndefined();
	});

	it("persisted persona reader parses and rejects the baseline contract", () => {
		expect(
			readPersistedAgentPersona([
				{
					type: "mode_change",
					mode: "agent",
					data: { name: "a", baseline: { model: "p/m", thinkingLevel: "high" } },
				},
			]),
		).toEqual({ name: "a", baseline: { model: "p/m", thinkingLevel: "high" } });
		expect(
			readPersistedAgentPersona([{ type: "mode_change", mode: "agent", data: { name: "a", baseline: "junk" } }]),
		).toEqual({ name: "a" });
		expect(
			readPersistedAgentPersona([
				{ type: "mode_change", mode: "agent", data: { name: "a", baseline: { model: 42 } } },
			]),
		).toEqual({ name: "a" });
	});

	it("enter keeps mounted xd:// devices presented (j2i)", async () => {
		// j2i regression: enter's presentation filter must source from the FULL
		// enabled set (incl. mounted xd:// names). getActiveToolNames() excludes
		// mounted names, so a mounted device vanished from the live presentation
		// the moment a persona entered.
		const { stub, session } = makeSessionStub({
			enabledToolNames: ["read", "grep", "glob", "write", "xd://alpha"],
			mountedToolNames: ["xd://alpha"],
			activeToolNames: ["read", "grep", "glob", "write"], // provider-facing: mount excluded
		});
		// The mount name must be registry-visible (production: xd:// aliases live
		// in the canonical registry) or the policy filter would deny it.
		stub.registeredToolNames = [...ALL_TOOLS, "xd://alpha"];
		const runtime = makeRuntime(session, stub);
		await runtime.enter(makeAgent(), {}, makeHooks()); // unrestricted persona: everything stays granted

		const last = stub.presentationCalls.at(-1);
		expect(last?.toolNames).toContain("xd://alpha");
		expect(last?.mountedToolNames).toContain("xd://alpha");
	});

	// j2l regression: exit restored the POST-exit policy derivation (the
	// unrestricted default set), erasing user/extension deactivations made
	// before the persona entered. Exit must restore the PRE-ENTER presentation.
	it("exit restores the pre-enter presentation, not the unrestricted default (j2l)", async () => {
		const { stub, session } = makeSessionStub();
		const runtime = makeRuntime(session);
		// Pre-enter: the user deactivated `glob` (and never re-enabled it).
		stub.enabledToolNames = ["read", "grep", "write"];
		await runtime.enter(makeAgent({ tools: ["read", "grep", "glob"] }), {}, makeHooks());

		await runtime.exit(makeHooks());

		const last = stub.presentationCalls.at(-1);
		expect(last?.toolNames).toEqual(["read", "grep", "write"]); // glob stays OUT
		expect(last?.mountedToolNames).toEqual(["xd://alpha"]);
	});

	// j2l merge regression: a tool REGISTERED while the persona was active is
	// absent from the frozen pre-enter snapshot — a naive restore would drop it.
	it("exit keeps tools registered mid-persona (j2l merge)", async () => {
		const { stub, session } = makeSessionStub();
		const runtime = makeRuntime(session, stub);
		// Registry BEFORE enter: the built-ins, no extension tool yet; the
		// pre-persona presentation has `glob` DEACTIVATED (in registry, not
		// enabled) so the test also pins that the merge stays selective.
		stub.registeredToolNames = ["read", "grep", "glob", "write", "edit", "bash", "task", "hub"];
		stub.enabledToolNames = ["read", "grep", "write"];
		await runtime.enter(makeAgent(), {}, makeHooks());
		// Mid-persona: an extension registers a default-active tool; the funnel
		// presents it (a null, registry-wide grant covers registered names).
		stub.registeredToolNames = [...stub.registeredToolNames, "extension-tool"];
		stub.enabledToolNames = [...stub.enabledToolNames, "extension-tool"];
		await runtime.exit(makeHooks());

		const last = stub.presentationCalls.at(-1);
		// Post-exit: pre-persona tools restored AND the mid-persona registration
		// survives (live registry ∩ post-exit effective set, not in the snapshot).
		expect(last?.toolNames).toContain("extension-tool");
		expect(last?.toolNames).toContain("write");
	});

	// j2l merge: the union must not resurrect a pre-entry deactivation — a name
	// the user toggled OFF before the persona entered stays off after exit.
	it("exit does not resurrect pre-entry deactivations via the merge (j2l)", async () => {
		const { stub, session } = makeSessionStub();
		const runtime = makeRuntime(session);
		stub.enabledToolNames = ["read", "grep", "write"]; // `glob` deactivated pre-entry
		await runtime.enter(makeAgent({ tools: ["read", "grep", "glob"] }), {}, makeHooks());
		await runtime.exit(makeHooks());

		const last = stub.presentationCalls.at(-1);
		expect(last?.toolNames).not.toContain("glob");
		expect(last?.mountedToolNames).toEqual(["xd://alpha"]);
	});

	// j2o regression: the truthiness guard skipped restoring an UNDEFINED
	// baseline field, leaking the persona's thinking (or model slot) into the
	// post-exit session.
	it("exit restores an undefined thinking baseline (j2o)", async () => {
		const { stub, session } = makeSessionStub();
		const runtime = makeRuntime(session);
		// Pre-persona: nothing configured (the stub default).
		await runtime.enter(
			makeAgent({ tools: ["read"] }),
			{},
			makeHooks({
				apply: async () => {
					stub.thinkingLevel = Effort.High;
				},
			}),
		);
		expect(stub.thinkingLevel).toBe(Effort.High);

		await runtime.exit(makeHooks());
		expect(stub.thinkingLevel).toBeUndefined();
		expect(stub.setThinkingCalls.at(-1)).toBeUndefined(); // explicit restore call, not a skip
	});

	// oeb regression: restore() ended without a prompt refresh, so restored
	// appendPrompt/model state could leave a stale cached system prompt when
	// the presentation signature did not change.
	it("restore refreshes the base system prompt (oeb)", async () => {
		const { stub, session } = makeSessionStub({ refreshBaseSystemPromptCalls: 0 });
		const runtime = makeRuntime(session);
		runtime.policy.enterPersona(makeAgent({ tools: ["read"] }), {});
		const snap = await runtime.snapshot();

		await runtime.restore(snap);

		expect(stub.refreshBaseSystemPromptCalls).toBe(1);
	});

	// j2g: reconcile's baselineOverride replaces the live capture as the enter
	// baseline, so exiting after a resume restores the PRE-persona state.
	it("reconcile adopts the persisted baseline override (j2g)", async () => {
		const { stub, session } = makeSessionStub();
		const runtime = makeRuntime(session);
		await runtime.reconcile(
			{
				agent: makeAgent({ name: "resumed", tools: ["read"] }),
				baselineOverride: {
					model: undefined,
					thinkingLevel: Effort.High,
				},
			},
			makeHooks({
				apply: async () => {
					stub.model = { provider: "stub", id: "persona-model" };
					stub.thinkingLevel = Effort.Max;
				},
			}),
		);

		await runtime.exit(makeHooks());
		// The PERSISTED baseline ("high") is the exit restore target — not the
		// persona-applied level ("max", which a live re-capture would restore).
		// The undefined MODEL field is a no-op (the session has no "clear model"
		// API — `setModel` requires a Model — so it can only be skipped).
		expect(stub.thinkingLevel).toBe(Effort.High);
		expect(stub.setThinkingCalls.at(-1)).toBe(Effort.High); // explicit restore ran
		expect(stub.model).toEqual({ provider: "stub", id: "persona-model" });
	});

	// j2p: a user model/thinking change made while the persona is active
	// re-roots the runtime baseline — the persona's exit restores the USER's
	// newer model, not the stale pre-enter one.
	it("noteUserModelChange re-roots the baseline; exit restores the user model (j2p)", async () => {
		const { stub, session } = makeSessionStub();
		const runtime = makeRuntime(session);
		stub.model = { provider: "stub", id: "m0" };
		stub.thinkingLevel = "low";
		await runtime.enter(
			makeAgent({ tools: ["read"] }),
			{},
			makeHooks({
				apply: async () => {
					stub.model = { provider: "stub", id: "persona-model" };
					stub.thinkingLevel = Effort.High;
				},
			}),
		);

		// The user picks M1 mid-persona (session state mutated, then notified —
		// the exact shape AgentSession.setModelTemporary produces).
		stub.model = { provider: "stub", id: "m1" };
		stub.thinkingLevel = Effort.Medium;
		expect(runtime.isApplyingPersonaModel).toBe(false);
		runtime.noteUserModelChange();

		await runtime.exit(makeHooks());
		expect(stub.model).toEqual({ provider: "stub", id: "m1" });
		expect(stub.thinkingLevel).toBe(Effort.Medium);
	});

	// j2p: without a user pick, exit still restores the ORIGINAL baseline —
	// noteUserModelChange is an opt-in re-root, not a live-capture on exit.
	it("noteUserModelChange is not called by the persona's own apply (j2p)", async () => {
		const { stub, session } = makeSessionStub();
		const runtime = makeRuntime(session);
		stub.model = { provider: "stub", id: "m0" };
		await runtime.enter(
			makeAgent({ tools: ["read"] }),
			{},
			makeHooks({
				apply: async () => {
					// hooks.apply runs with the re-entrancy flag set.
					expect(runtime.isApplyingPersonaModel).toBe(true);
					stub.model = { provider: "stub", id: "persona-model" };
				},
			}),
		);
		expect(runtime.isApplyingPersonaModel).toBe(false);

		await runtime.exit(makeHooks());
		expect(stub.model).toEqual({ provider: "stub", id: "m0" });
	});

	// j2p: a re-root with NO baseline captured (deferred enter) is a no-op —
	// the surface queue owns the pending persona model; nothing to re-root.
	it("noteUserModelChange without a captured baseline is a no-op (j2p)", async () => {
		const { stub, session } = makeSessionStub({ isStreaming: true });
		const runtime = makeRuntime(session);
		await runtime.enter(
			makeAgent({ tools: ["read"] }),
			{},
			makeHooks({
				shouldDeferModelSwitch: () => true,
				deferModelSwitchWhileStreaming: () => {},
			}),
		);
		stub.model = { provider: "stub", id: "user-model" };
		runtime.noteUserModelChange();

		// Exit mid-turn: the (still absent) baseline queues nothing model-side;
		// the surface queue owns the pending state.
		await runtime.exit(
			makeHooks({
				shouldDeferModelSwitch: () => true,
				deferModelRestoreWhileStreaming: () => {},
			}),
		);
		expect(stub.model).toEqual({ provider: "stub", id: "user-model" });
	});
});
describe("PersonaSwitchTransaction", () => {
	it("rollback restores the runtime state captured at begin", async () => {
		const { stub, session } = makeSessionStub();
		const runtime = makeRuntime(session);
		runtime.policy.enterPersona(makeAgent({ tools: ["read"] }), {});
		const tx = await PersonaSwitchTransaction.begin(runtime);
		runtime.policy.exitPersona();
		await tx.rollback();

		expect(runtime.policy.isPersonaActive()).toBe(true);
		expect(stub.presentationCalls.length).toBe(1);
	});
});
