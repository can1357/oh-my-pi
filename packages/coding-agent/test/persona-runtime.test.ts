import { describe, expect, it } from "bun:test";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	deserializePersonaBaseline,
	readPersistedAgentPersona,
	serializePersonaBaseline,
} from "@oh-my-pi/pi-coding-agent/session/persisted-persona";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { PersonaRuntime, PersonaSwitchError } from "@oh-my-pi/pi-coding-agent/session/persona-runtime";
import { SessionToolPolicy } from "@oh-my-pi/pi-coding-agent/session/tool-policy";
import type { PersonaModelApplyHooks } from "@oh-my-pi/pi-coding-agent/session/persona-model-hooks";
import { makePersonaAgent, makePersonaHooks, makeRuntime, makeSessionStub, ALL_TOOLS } from "./persona-test-utils";

const makeAgent = makePersonaAgent;
const makeHooks = makePersonaHooks;

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
		expect(stub.clearCacheKeyCalls).toBe(1);
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
		let restoreDeferred = 0;
		const hooks = makeHooks({
			shouldDeferModelSwitch: () => true,
			deferModelRestoreWhileStreaming: () => void (restoreDeferred += 1),
		});
		await runtime.enter(makeAgent({ tools: ["read"] }), {}, hooks);
		stub.isStreaming = true; // turn starts after persona entry

		await runtime.exit(hooks);

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

	it("exit restores model/thinking from the runtime baseline with FRESH hooks (foxls/foy5h)", async () => {
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
		expect(stub.model).toEqual({ provider: "stub", id: "persona-model" });

		// Exit builds a FRESH hooks object (the production shape: exitAgentPersona
		// constructs new hooks whose per-instance baseline is empty). The model
		// restore must come from the RUNTIME baseline, not hooks.restore.
		await runtime.exit(
			makeHooks({
				deferModelRestoreWhileStreaming: () => {
					throw new Error("not streaming; defer channel must not fire");
				},
			}),
		);

		expect(runtime.policy.isPersonaActive()).toBe(false);
		expect(stub.model).toEqual({ provider: "stub", id: "baseline-model" });
		expect(stub.thinkingLevel).toBe("low");
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
		await runtime.reconcile({ agent: makeAgent({ tools: ["read"] }) }, makeHooks());
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

	// Regression (Codex P2): a mid-turn exit parks its pre-persona baseline in
	// the runtime's deferred slot; the next enter CONSUMES it. If that enter
	// fails and rolls back, the deferred baseline must come back with the
	// transaction — a retry before the turn ends would otherwise capture the
	// still-live persona model as its "pre-persona" state and restore it on the
	// eventual exit.
	it("failed mid-turn retry restores the deferred exit baseline for the next enter", async () => {
		const { stub, session } = makeSessionStub();
		const runtime = makeRuntime(session);
		stub.model = { provider: "stub", id: "pre-a" };
		stub.thinkingLevel = "low";
		await runtime.enter(
			makeAgent({ name: "a", tools: ["read"] }),
			{},
			makeHooks({
				apply: async () => {
					stub.model = { provider: "stub", id: "a-model" };
				},
			}),
		);

		stub.isStreaming = true;
		const deferHooks = () =>
			makeHooks({
				shouldDeferModelSwitch: () => true,
				deferModelSwitchWhileStreaming: () => {},
				deferModelRestoreWhileStreaming: () => {},
				apply: async () => {
					stub.model = { provider: "stub", id: "x-model" };
				},
			});
		// Mid-turn exit of A: the pre-A baseline is parked as the deferred
		// (pre-chain) baseline for the next enter.
		await runtime.exit(deferHooks());
		expect(runtime.getActiveBaseline()).toBeUndefined();

		// Enter B (still mid-turn): consumes the deferred baseline, then fails
		// and rolls back.
		const failingB = makeHooks({
			shouldDeferModelSwitch: () => true,
			deferModelSwitchWhileStreaming: () => {
				throw new Error("queue boom");
			},
			apply: async () => {},
		});
		await expect(runtime.enter(makeAgent({ name: "b", tools: ["write"] }), {}, failingB)).rejects.toThrow(
			"queue boom",
		);
		// The failed enter rolls back to the transaction start: no persona (A's
		// exit succeeded in its own transaction), and the DEFERRED pre-A
		// baseline must be back in the runtime slot for the retry.

		// Retry with C mid-turn: its baseline must be the TRUE pre-A state from
		// the restored deferred slot, not the live a-model.
		await runtime.enter(makeAgent({ name: "c", tools: ["read"] }), {}, deferHooks());
		const retryBaseline = runtime.getActiveBaseline();
		expect(retryBaseline?.model).toMatchObject({ provider: "stub", id: "pre-a" });
		expect(retryBaseline?.thinkingLevel).toBe(Effort.Low);
	});

	// Regression (Codex P2): baselines are RECORDED selectors, not fuzzy
	// patterns. A pinned aggregator baseline (`openrouter/<id>@cerebras`) must
	// round-trip the pin, and a selector the registry cannot reproduce exactly
	// (model dropped, sibling fuzzy-matched, pin no longer expressible) must
	// degrade to `model: undefined` — never re-bind the exit restore to a
	// different model or route.
	it("pinned aggregator baseline round-trips the @upstream route", () => {
		const aggregator = (id: string, compat?: { openRouterRouting: { only: string[] } }): Model<Api> =>
			buildModel({
				id,
				name: id,
				api: "openai-completions",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
				contextWindow: 128000,
				maxTokens: 8192,
				...(compat ? { compat } : {}),
			}) as Model<Api>;
		const sessionFor = (...registry: Model<Api>[]) =>
			({ modelRegistry: { getAvailable: () => registry } }) as unknown as AgentSession;
		const routingOnly = (model: Model<Api> | undefined): string[] | undefined =>
			(model?.compat as { openRouterRouting?: { only?: string[] } } | undefined)?.openRouterRouting?.only;

		const pinned = aggregator("z-ai/glm-4.7", { openRouterRouting: { only: ["cerebras"] } });
		const serialized = serializePersonaBaseline({ model: pinned, thinkingLevel: undefined });
		expect(serialized?.model).toBe("openrouter/z-ai/glm-4.7@cerebras");

		const restored = deserializePersonaBaseline(sessionFor(pinned), {
			model: "openrouter/z-ai/glm-4.7@cerebras",
		});
		expect(restored.model?.provider).toBe("openrouter");
		expect(restored.model?.id).toBe("z-ai/glm-4.7");
		expect(routingOnly(restored.model)).toEqual(["cerebras"]);

		// Unpinned selectors resolve plainly.
		const plain = aggregator("z-ai/glm-4.7");
		const plainSession = deserializePersonaBaseline(sessionFor(plain), { model: "openrouter/z-ai/glm-4.7" });
		expect(plainSession.model?.id).toBe("z-ai/glm-4.7");
		expect(routingOnly(plainSession.model)).toBeUndefined();

		// Fuzzy near-match guard: only a SIBLING exists → the persisted selector
		// must not silently re-bind to it (pre-guard, the fuzzy phase matched
		// `glm-4.7-turbo` and even re-pinned it).
		const siblingOnly = deserializePersonaBaseline(sessionFor(aggregator("z-ai/glm-4.7-turbo")), {
			model: "openrouter/z-ai/glm-4.7@cerebras",
		});
		expect(siblingOnly.model).toBeUndefined();

		// The explicit pin is a user choice: re-applied over the registry
		// model's default routing (here: none), not dropped.
		const repinned = deserializePersonaBaseline(sessionFor(plain), { model: "openrouter/z-ai/glm-4.7@cerebras" });
		expect(repinned.model?.id).toBe("z-ai/glm-4.7");
		expect(routingOnly(repinned.model)).toEqual(["cerebras"]);

		// Literal model ids whose suffix LOOKS like a thinking level or route
		// must round-trip intact (the parser's `:max` alias rules could strip
		// them).
		const maxId = aggregator("nanogpt/coding-router:max");
		expect(serializePersonaBaseline({ model: maxId, thinkingLevel: undefined })?.model).toBe(
			"openrouter/nanogpt/coding-router:max",
		);
		expect(
			deserializePersonaBaseline(sessionFor(maxId), { model: "openrouter/nanogpt/coding-router:max" }).model?.id,
		).toBe("nanogpt/coding-router:max");

		// Selector shapes the pattern parser must not confuse with routing or
		// thinking suffixes: internal colons, `@` inside ids.
		const colonId = aggregator("qwen/qwen3-coder:exacto");
		expect(serializePersonaBaseline({ model: colonId, thinkingLevel: undefined })?.model).toBe(
			"openrouter/qwen/qwen3-coder:exacto",
		);
		expect(
			deserializePersonaBaseline(sessionFor(colonId), { model: "openrouter/qwen/qwen3-coder:exacto" }).model?.id,
		).toBe("qwen/qwen3-coder:exacto");
		const atId = buildModel({
			id: "claude-opus-4-8@default",
			name: "Opus default lane",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		}) as Model<Api>;
		expect(serializePersonaBaseline({ model: atId, thinkingLevel: undefined })?.model).toBe(
			"anthropic/claude-opus-4-8@default",
		);
		expect(
			deserializePersonaBaseline(sessionFor(atId), { model: "anthropic/claude-opus-4-8@default" }).model?.id,
		).toBe("claude-opus-4-8@default");
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

	// fureZ: a defaultInactive tool the user already activated (RPC set-tools,
	// /mcp toggle, extension funnel) before the persona entered must STAY
	// active — the enter filter is the permission question (granted()), not
	// effective(), which would re-derive the dormant default and strip it.
	it("enter keeps a pre-activated defaultInactive tool active (fureZ)", async () => {
		const { stub, session } = makeSessionStub({
			enabledToolNames: ["read", "grep", "dormant"],
			activeToolNames: ["read", "grep", "dormant"],
			registeredToolNames: [...ALL_TOOLS, "dormant"],
		});
		const policy = new SessionToolPolicy({
			registry: () => new Set(stub.registeredToolNames),
			isDefaultActive: name => name !== "dormant",
		});
		const runtime = new PersonaRuntime(policy, session);
		await runtime.enter(makeAgent(), {}, makeHooks()); // unrestricted persona

		const last = stub.presentationCalls.at(-1);
		expect(last?.toolNames).toContain("dormant"); // activation survives enter
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
});
