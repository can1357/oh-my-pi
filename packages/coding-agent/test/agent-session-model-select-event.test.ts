import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { applyModelPreset, saveModelPreset } from "@oh-my-pi/pi-coding-agent/config/model-presets";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { applyUpstreamRouting, formatModelStringWithRouting } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	ExtensionRunner,
	SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS,
	testSetExtensionHandlerTimeoutMs,
	testSetSessionShutdownHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionError,
	ExtensionUIContext,
	ModelSelectEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

type GateGlobal = typeof globalThis & {
	__ompModelSelectGate?: Promise<void>;
	/** Park only the handler for this model id; other events pass through. */
	__ompModelSelectParkFor?: string;
	/** Throw from the next delivery (handler-error isolation test). */
	__ompModelSelectThrowOnce?: boolean;
	/** Per-test action run inside the handler before the event is recorded. */
	__ompModelSelectAction?: (api: ExtensionAPI, event: ModelSelectEvent, ctx: ExtensionContext) => void | Promise<void>;
};
/**
 * Deterministic delivery signals: one resolver per expected event, resolved
 * by the handler itself, so positive assertions await the real emits instead
 * of a guessed delay.
 */
let deliveries: Array<PromiseWithResolvers<void>> = [];
/** Delivery order across model_select and session_shutdown handlers. */
let order: string[] = [];
let runner: ExtensionRunner;

function armDelivery(count = 1): void {
	deliveries = Array.from({ length: count }, () => Promise.withResolvers<void>());
}

async function waitForDeliveries(): Promise<void> {
	await Promise.all(deliveries.map(d => d.promise));
}

/** Drain the microtask queue so a wrongly-fired event would land; no wall-clock wait. */
async function drainMicrotasks(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
	}
}

// Module-scoped so the file-level buildSwitchPair helper can reach them.
let tempDir: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

describe("AgentSession model_select extension event", () => {
	let session: AgentSession;
	let events: ModelSelectEvent[];
	let modelChangedCount: number;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-model-select-event-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("openrouter", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("model_select", async (event, ctx) => {
					const gateGlobal = globalThis as GateGlobal;
					if (gateGlobal.__ompModelSelectThrowOnce) {
						gateGlobal.__ompModelSelectThrowOnce = false;
						throw new Error("model_select handler exploded");
					}
					const action = gateGlobal.__ompModelSelectAction;
					if (action) await action(pi, event, ctx);
					// Park on the optional gate — either unconditionally (detached
					// test) or only for a chosen model id (FIFO test) — proving
					// switches never wait on handlers.
					const park = gateGlobal.__ompModelSelectParkFor;
					const gate = gateGlobal.__ompModelSelectGate;
					if (gate && (park === undefined || park === event.model.id)) await gate;
					events.push(event);
					order.push("model_select");
					deliveries[events.length - 1]?.resolve();
				});
				pi.on("session_shutdown", () => {
					order.push("session_shutdown");
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"model-select-recorder",
		);

		const sessionManager = SessionManager.inMemory(tempDir.path());
		runner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);

		const model = bundledAnthropicModel("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		events = [];
		order = [];
		modelChangedCount = 0;
		armDelivery();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			extensionRunner: runner,
		});
		session.subscribe(event => {
			if (event.type === "model_changed") modelChangedCount++;
		});
	});

	afterEach(async () => {
		try {
			await session.dispose();
		} finally {
			const gateGlobal = globalThis as GateGlobal;
			gateGlobal.__ompModelSelectGate = undefined;
			gateGlobal.__ompModelSelectParkFor = undefined;
			gateGlobal.__ompModelSelectThrowOnce = undefined;
			gateGlobal.__ompModelSelectAction = undefined;
		}
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("fires once per real switch with model, previousModel, and source set", async () => {
		const initialModel = bundledAnthropicModel("claude-sonnet-4-5");
		const nextModel = bundledAnthropicModel("claude-sonnet-4-6");

		await session.setModel(nextModel);
		await waitForDeliveries();

		expect(events).toHaveLength(1);
		expect(events[0]?.source).toBe("set");
		expect(events[0]?.model.id).toBe(nextModel.id);
		expect(events[0]?.model.provider).toBe(nextModel.provider);
		expect(events[0]?.previousModel?.id).toBe(initialModel.id);
		expect(events[0]?.previousModel?.provider).toBe(initialModel.provider);
		expect(modelChangedCount).toBe(1);
		expect(session.model?.id).toBe(nextModel.id);
	});

	it("does not fire when the same model is selected again", async () => {
		const nextModel = bundledAnthropicModel("claude-sonnet-4-6");

		await session.setModel(nextModel);
		await waitForDeliveries();

		await session.setModel(nextModel);
		await drainMicrotasks();

		expect(events).toHaveLength(1);
		expect(modelChangedCount).toBe(1);
	});

	it("labels cycleModel() (RPC cycle_model / SDK) as cycle", async () => {
		const result = await session.cycleModel("forward");
		if (!result) throw new Error("cycleModel returned no result");
		await waitForDeliveries();

		expect(events).toHaveLength(1);
		expect(events[0]?.source).toBe("cycle");
		expect(events[0]?.model.id).toBe(result.model.id);
		expect(events[0]?.previousModel?.id).toBe("claude-sonnet-4-5");
	});

	it("delivers detached from the switch", async () => {
		const gate = Promise.withResolvers<void>();
		(globalThis as GateGlobal).__ompModelSelectGate = gate.promise;

		// Resolves even though the only model_select handler is parked on the gate.
		await session.setModel(bundledAnthropicModel("claude-sonnet-4-6"));

		gate.resolve();
		await waitForDeliveries();

		expect(events).toHaveLength(1);
		expect(events[0]?.source).toBe("set");
	});

	it("delivers rapid successive switches in FIFO order", async () => {
		armDelivery(2);
		const second = bundledAnthropicModel("claude-sonnet-4-6");
		const third = bundledAnthropicModel("claude-opus-4-5");
		const gate = Promise.withResolvers<void>();
		const gateGlobal = globalThis as GateGlobal;
		gateGlobal.__ompModelSelectGate = gate.promise;
		gateGlobal.__ompModelSelectParkFor = second.id;

		// Two switches complete while the first handler is still parked. The
		// second notification must queue behind the first (FIFO): without
		// serialization the second event's handler starts while the first
		// handler is still parked, and the first event's delivery order is
		// no longer observable.
		await session.setModel(second);
		await session.setModel(third);

		gate.resolve();
		await waitForDeliveries();

		expect(events.map(e => e.model.id)).toEqual([second.id, third.id]);
		expect(events[0]?.previousModel?.id).toBe("claude-sonnet-4-5");
		expect(events[1]?.previousModel?.id).toBe(second.id);
	});

	it("delivers after the switch transaction commits", async () => {
		// The runtime actions (`pi.setThinkingLevel`) only exist once a host
		// initializes the runner — the same wiring a mode controller does.
		runner.initialize(
			{
				sendMessage: () => {},
				sendUserMessage: () => {},
				appendEntry: () => {},
				setLabel: () => {},
				getActiveTools: () => [],
				getAllTools: () => [],
				setActiveTools: async () => {},
				getCommands: () => [],
				setModel: async () => false,
				getThinkingLevel: () => session.thinkingLevel,
				setThinkingLevel: level => session.setThinkingLevel(level),
				getSessionName: () => undefined,
				setSessionName: async () => {},
			},
			{
				getModel: () => session.model,
				isIdle: () => !session.isStreaming,
				abort: () => {},
				hasPendingMessages: () => false,
				shutdown: () => {},
				getContextUsage: () => undefined,
				compact: async () => {},
				getSystemPrompt: () => [],
			},
		);
		const target = bundledAnthropicModel("claude-sonnet-4-6");
		// A defaultLevel forces `setModel` to re-apply the thinking level AFTER
		// the swap; if the notification fired mid-transaction, this handler's
		// `pi.setThinkingLevel("high")` would be overwritten by that re-apply.
		if (!target.thinking) throw new Error("Expected claude-sonnet-4-6 to carry a thinking config");
		const withDefaultLevel: Model<Api> = { ...target, thinking: { ...target.thinking, defaultLevel: Effort.Low } };
		let observed: { modelMatches: boolean; lastModelChange: string | undefined } | undefined;
		(globalThis as GateGlobal).__ompModelSelectAction = (pi, event) => {
			pi.setThinkingLevel(Effort.High);
			const lastChange = session.sessionManager.getBranch().findLast(entry => entry.type === "model_change");
			observed = {
				modelMatches: session.model?.id === event.model.id,
				lastModelChange: lastChange?.type === "model_change" ? lastChange.model : undefined,
			};
		};

		await session.setModel(withDefaultLevel);
		await waitForDeliveries();

		expect(session.thinkingLevel).toBe(Effort.High);
		expect(observed?.modelMatches).toBe(true);
		expect(observed?.lastModelChange).toBe("anthropic/claude-sonnet-4-6");
	});

	it("delivers after a role switch applies its explicit thinking level", async () => {
		runner.initialize(
			{
				sendMessage: () => {},
				sendUserMessage: () => {},
				appendEntry: () => {},
				setLabel: () => {},
				getActiveTools: () => [],
				getAllTools: () => [],
				setActiveTools: async () => {},
				getCommands: () => [],
				setModel: async () => false,
				getThinkingLevel: () => session.thinkingLevel,
				setThinkingLevel: level => session.setThinkingLevel(level),
				getSessionName: () => undefined,
				setSessionName: async () => {},
			},
			{
				getModel: () => session.model,
				isIdle: () => !session.isStreaming,
				abort: () => {},
				hasPendingMessages: () => false,
				shutdown: () => {},
				getContextUsage: () => undefined,
				compact: async () => {},
				getSystemPrompt: () => [],
			},
		);
		const target = bundledAnthropicModel("claude-sonnet-4-6");
		if (!target.thinking) throw new Error("Expected claude-sonnet-4-6 to carry a thinking config");
		// The role's explicit level (low) differs from the model default the
		// handler observes; a post-transaction tail would overwrite the
		// handler's `pi.setThinkingLevel("high")` with "low" after delivery.
		const withDefaultLevel: Model<Api> = { ...target, thinking: { ...target.thinking, defaultLevel: Effort.Low } };
		let observedLevel: string | undefined;
		(globalThis as GateGlobal).__ompModelSelectAction = pi => {
			observedLevel = session.thinkingLevel;
			pi.setThinkingLevel(Effort.High);
		};

		await session.applyRoleModel({
			role: "slow",
			model: withDefaultLevel,
			thinkingLevel: Effort.Low,
			explicitThinkingLevel: true,
		});
		await waitForDeliveries();

		// The handler saw the role's explicit low, and its high survives — the
		// role tail no longer runs after the `model_select` commit.
		expect(observedLevel).toBe(Effort.Low);
		expect(session.thinkingLevel).toBe(Effort.High);
	});

	it("delivers after a preset applies its explicit thinking level", async () => {
		runner.initialize(
			{
				sendMessage: () => {},
				sendUserMessage: () => {},
				appendEntry: () => {},
				setLabel: () => {},
				getActiveTools: () => [],
				getAllTools: () => [],
				setActiveTools: async () => {},
				getCommands: () => [],
				setModel: async () => false,
				getThinkingLevel: () => session.thinkingLevel,
				setThinkingLevel: level => session.setThinkingLevel(level),
				getSessionName: () => undefined,
				setSessionName: async () => {},
			},
			{
				getModel: () => session.model,
				isIdle: () => !session.isStreaming,
				abort: () => {},
				hasPendingMessages: () => false,
				shutdown: () => {},
				getContextUsage: () => undefined,
				compact: async () => {},
				getSystemPrompt: () => [],
			},
		);
		session.settings.setModelRole("default", "anthropic/claude-sonnet-4-6:medium");
		cfgDefaultThinkingLevel.set(session.settings, Effort.Low);
		saveModelPreset(session.settings, "focus");
		let observedLevel: string | undefined;
		(globalThis as GateGlobal).__ompModelSelectAction = pi => {
			observedLevel = session.thinkingLevel;
			pi.setThinkingLevel(Effort.High);
		};

		const result = await applyModelPreset(session.settings, session, "focus");
		await waitForDeliveries();

		expect(result.kind).toBe("switched");
		expect(observedLevel).toBe(Effort.Medium);
		expect(session.thinkingLevel).toBe(Effort.High);
	});

	it("resolves dispose within the shutdown bound while a handler is parked, then fences new deliveries", async () => {
		testSetSessionShutdownHandlerTimeoutMs(50);
		try {
			const gate = Promise.withResolvers<void>();
			(globalThis as GateGlobal).__ompModelSelectGate = gate.promise;
			await session.setModel(bundledAnthropicModel("claude-sonnet-4-6"));

			// The only model_select handler is parked mid-delivery; dispose must
			// not wait for it beyond the shutdown drain bound.
			await session.dispose();

			gate.resolve();
			await waitForDeliveries();
			await drainMicrotasks();
			expect(events).toHaveLength(1);
			// Post-shutdown emits are no-ops: nothing is delivered after the
			// session (and its extension host) is gone.
			runner.emitModelSelect({
				model: bundledAnthropicModel("claude-opus-4-5"),
				previousModel: undefined,
				source: "set",
			});
			await drainMicrotasks();
			expect(events).toHaveLength(1);
		} finally {
			testSetSessionShutdownHandlerTimeoutMs(SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS);
		}
	});

	it("delivers an in-flight model_select before session_shutdown handlers", async () => {
		// Park the handler mid-delivery with a short wall sleep so delivery is
		// REALLY in flight when dispose starts — a microtask-only chain would
		// settle before dispose's first await and the test could not
		// discriminate (the shutdown drain is what guarantees the order).
		(globalThis as GateGlobal).__ompModelSelectAction = async () => {
			await Bun.sleep(5);
		};
		await session.setModel(bundledAnthropicModel("claude-sonnet-4-6"));
		await session.dispose();
		expect(order).toEqual(["model_select", "session_shutdown"]);
	});

	it("delivers reserved slots in reservation order regardless of commit order", async () => {
		armDelivery(2);
		const first = runner.reserveModelSelect();
		const second = runner.reserveModelSelect();
		if (!first || !second) throw new Error("Expected reserved model_select slots");

		// The later-reserved slot commits first: overlapping switch
		// transactions whose tails finish in reverse order. Delivery must
		// still follow reservation (switch) order.
		second.commit({
			model: bundledAnthropicModel("claude-opus-4-5"),
			previousModel: bundledAnthropicModel("claude-sonnet-4-6"),
			source: "set",
		});
		first.commit({
			model: bundledAnthropicModel("claude-sonnet-4-6"),
			previousModel: undefined,
			source: "set",
		});
		await waitForDeliveries();

		expect(events.map(event => event.model.id)).toEqual(["claude-sonnet-4-6", "claude-opus-4-5"]);
	});

	it("abandons a never-committed slot without wedging the chain", async () => {
		testSetExtensionHandlerTimeoutMs(25);
		try {
			// Never committed — simulates a caller bug that loses the
			// ModelSwitchResult; the runner must drop the slot after the
			// handler budget instead of blocking later deliveries.
			runner.reserveModelSelect();
			armDelivery();
			const slot = runner.reserveModelSelect();
			slot?.commit({
				model: bundledAnthropicModel("claude-sonnet-4-6"),
				previousModel: undefined,
				source: "set",
			});
			await waitForDeliveries();

			expect(events.map(event => event.model.id)).toEqual(["claude-sonnet-4-6"]);
		} finally {
			testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
		}
	});

	it("releases an uncommitted slot on shutdown without keeping the process alive", async () => {
		const probe = `
			import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
			import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
			import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
			import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
			import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
			import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
			const auth = await AuthStorage.create(":memory:");
			const registry = new ModelRegistry(auth);
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(pi => {
				pi.on("model_select", () => {});
			}, process.cwd(), new EventBus(), runtime, "model-select-shutdown-probe");
			const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), registry);
			runner.reserveModelSelect();
			runner.beginShutdown();
			await runner.drainModelSelect(100);
			auth.close();
		`;
		const child = Bun.spawn([process.execPath, "--eval", probe], {
			cwd: process.cwd(),
			stdout: "ignore",
			stderr: "pipe",
		});
		const outcome = await Promise.race([
			child.exited.then(exitCode => ({ exitCode })),
			Bun.sleep(10_000).then(() => ({ timedOut: true })),
		]);
		if ("timedOut" in outcome) child.kill();
		await child.exited;
		const stderr = await new Response(child.stderr).text();

		expect({ outcome, stderr }).toEqual({ outcome: { exitCode: 0 }, stderr: "" });
	}, 15_000);

	it("cancels the in-flight delivery when the shutdown drain expires", async () => {
		testSetSessionShutdownHandlerTimeoutMs(50);
		try {
			const handlerStarted = Promise.withResolvers<void>();
			const dialogCancelled = Promise.withResolvers<void>();
			// A real signal surface a parked handler sits behind: `ctx.ui.confirm`
			// receives the handler's cancellation signal on its dialog options.
			const confirm: ExtensionUIContext["confirm"] = (_title, _message, dialogOptions) =>
				new Promise<boolean>(resolve => {
					const signal = dialogOptions?.signal;
					if (!signal) throw new Error("expected the handler's cancellation signal on the dialog options");
					const settle = () => {
						dialogCancelled.resolve();
						resolve(false);
					};
					if (signal.aborted) settle();
					else signal.addEventListener("abort", settle, { once: true });
				});
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => session.thinkingLevel,
					setThinkingLevel: level => session.setThinkingLevel(level),
					getSessionName: () => undefined,
					setSessionName: async () => {},
				},
				{
					getModel: () => session.model,
					isIdle: () => !session.isStreaming,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
				undefined,
				// Two prototype layers: overrides must NOT be own properties of the
				// proxy target (`createHandlerUIContext` returns different wrapped
				// functions, which a frozen own prop would turn into a TypeError).
				Object.create(Object.create(runner.getUIContext(), { confirm: { value: confirm } })),
			);
			(globalThis as GateGlobal).__ompModelSelectAction = async (_pi, _event, ctx) => {
				handlerStarted.resolve();
				// Park exactly like a real extension would: inside a dialog wired
				// to the handler's cancellation signal. Only the drain's cancel
				// (not its 30s per-handler budget) can end this wait inside the
				// 50ms shutdown bound.
				await ctx.ui.confirm("park", "parked until the drain cancels the pass");
			};
			await session.setModel(bundledAnthropicModel("claude-sonnet-4-6"));
			await handlerStarted.promise; // the delivery is REALLY in flight

			// Dispose's drain expires at the 50ms bound and must cancel the
			// in-flight pass — aborting the parked dialog — not just log it.
			await session.dispose();

			await dialogCancelled.promise;
			expect(order).toContain("session_shutdown");
		} finally {
			testSetSessionShutdownHandlerTimeoutMs(SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS);
		}
	});

	it("cancelling an in-flight delivery does not keep the process alive", async () => {
		const probe = `
			import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
			import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
			import { ExtensionRunner, testSetExtensionHandlerTimeoutMs } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
			import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
			import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
			import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
			import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
			const auth = await AuthStorage.create(":memory:");
			const registry = new ModelRegistry(auth);
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(pi => {
				// Ignores every cancellation surface and parks forever — a
				// misbehaving handler. Its armed per-handler timeout timer must
				// be cleared by the drain's cancel, or this child stays alive
				// for the full 60s budget.
				pi.on("model_select", () => new Promise(() => {}));
			}, process.cwd(), new EventBus(), runtime, "model-select-cancel-probe");
			const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), registry);
			testSetExtensionHandlerTimeoutMs(60_000);
			const slot = runner.reserveModelSelect();
			slot?.commit({
				model: getBundledModel("anthropic", "claude-sonnet-4-5"),
				previousModel: undefined,
				source: "set",
			});
			await Bun.sleep(20); // let the chain head reach the parked handler
			runner.beginShutdown();
			await runner.drainModelSelect(100);
			auth.close();
		`;
		const child = Bun.spawn([process.execPath, "--eval", probe], {
			cwd: process.cwd(),
			stdout: "ignore",
			stderr: "pipe",
		});
		const outcome = await Promise.race([
			child.exited.then(exitCode => ({ exitCode })),
			Bun.sleep(10_000).then(() => ({ timedOut: true })),
		]);
		if ("timedOut" in outcome) child.kill();
		await child.exited;
		const stderr = await new Response(child.stderr).text();

		expect({ outcome, stderr }).toEqual({ outcome: { exitCode: 0 }, stderr: "" });
	}, 15_000);

	it("treats an @upstream re-pin as a real switch", async () => {
		armDelivery(2);
		const base = openRouterHostedModel("claude-sonnet-4-6");
		const routeA = applyUpstreamRouting(base, "vendor-a");
		const routeB = applyUpstreamRouting(base, "vendor-b");

		await session.setModel(routeA);
		await session.setModel(routeB);
		await waitForDeliveries();

		expect(events).toHaveLength(2);
		expect(formatModelStringWithRouting(events[0]!.model)).toBe("openrouter/claude-sonnet-4-6@vendor-a");
		expect(formatModelStringWithRouting(events[1]!.model)).toBe("openrouter/claude-sonnet-4-6@vendor-b");
		expect(formatModelStringWithRouting(events[1]!.previousModel!)).toBe("openrouter/claude-sonnet-4-6@vendor-a");
		expect(modelChangedCount).toBe(2);
	});

	it("does not fire when the same @upstream route is re-selected", async () => {
		const routeA = applyUpstreamRouting(openRouterHostedModel("claude-sonnet-4-6"), "vendor-a");

		await session.setModel(routeA);
		await waitForDeliveries();
		await session.setModel(routeA);
		await drainMicrotasks();

		expect(events).toHaveLength(1);
		expect(modelChangedCount).toBe(1);
	});

	it("labels a session-switch model restore as restore", async () => {
		const target = bundledAnthropicModel("claude-sonnet-4-6");
		const { switcher, restoreEvents, delivered, targetFile } = await buildSwitchPair(target);
		try {
			expect(await switcher.switchSession(targetFile)).toBe(true);
			await delivered;

			expect(restoreEvents).toHaveLength(1);
			expect(restoreEvents[0]?.source).toBe("restore");
			expect(restoreEvents[0]?.model.id).toBe(target.id);
			expect(restoreEvents[0]?.previousModel?.id).toBe("claude-sonnet-4-5");
			expect(switcher.model?.id).toBe(target.id);
		} finally {
			await switcher.dispose();
		}
	});

	it("reports the attempted restore then the rollback restore when a switch fails mid-tail", async () => {
		const target = bundledAnthropicModel("claude-sonnet-4-6");
		const { switcher, restoreEvents, targetFile } = await buildSwitchPair(target);
		// Cheapest injectable failure AFTER the model-restore block: the first
		// `defaultThinkingLevel` read of the switch tail (`parseConfiguredThinkingLevel`
		// below the restore) — every later seam is either wrapped in try/catch or
		// internal. Throwing there lands in the rollback catch with the restore
		// already committed.
		const getSpy = vi.spyOn(cfgDefaultThinkingLevel, "get").mockImplementation(() => {
			throw new Error("injected post-restore failure");
		});
		try {
			await expect(switcher.switchSession(targetFile)).rejects.toThrow("injected post-restore failure");

			expect(
				restoreEvents.map(event => ({
					source: event.source,
					model: event.model.id,
					previousModel: event.previousModel?.id,
				})),
			).toEqual([
				// The attempted restore (committed by the catch), then the rollback.
				{ source: "restore", model: target.id, previousModel: "claude-sonnet-4-5" },
				{ source: "restore", model: "claude-sonnet-4-5", previousModel: target.id },
			]);
			expect(switcher.model?.id).toBe("claude-sonnet-4-5");
		} finally {
			getSpy.mockRestore();
			await switcher.dispose();
		}
	});

	it("a throwing handler does not wedge the chain", async () => {
		const gateGlobal = globalThis as GateGlobal;
		gateGlobal.__ompModelSelectThrowOnce = true;
		const handlerErrors: ExtensionError[] = [];
		runner.onError(error => handlerErrors.push(error));

		await session.setModel(bundledAnthropicModel("claude-sonnet-4-6"));
		await drainMicrotasks();
		expect(events).toHaveLength(0);

		armDelivery();
		await session.setModel(bundledAnthropicModel("claude-opus-4-5"));
		await waitForDeliveries();

		expect(events.map(event => event.model.id)).toEqual(["claude-opus-4-5"]);
		expect(handlerErrors).toHaveLength(1);
		expect(handlerErrors[0]?.event).toBe("model_select");
	});
});

async function buildSwitchPair(target: Model<Api>): Promise<{
	switcher: AgentSession;
	restoreEvents: ModelSelectEvent[];
	delivered: Promise<void>;
	targetFile: string;
	settings: Settings;
}> {
	// The shared session's in-memory manager cannot load another session's
	// file, so build a file-backed switch pair (the beforeEach session stays
	// untouched; callers dispose the switcher themselves).
	const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
	// A message entry is required for flush() to materialize the file; the
	// model_change entry is what switchSession restores the model from.
	targetManager.appendMessage({ role: "user", content: "target session", timestamp: 1 });
	targetManager.appendModelChange(`${target.provider}/${target.id}`, "default");
	await targetManager.ensureOnDisk();
	await targetManager.flush();
	const targetFile = targetManager.getSessionFile();
	await targetManager.close();
	if (!targetFile) throw new Error("Expected target session file");

	const runtime = new ExtensionRuntime();
	const delivered = Promise.withResolvers<void>();
	const restoreEvents: ModelSelectEvent[] = [];
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("model_select", event => {
				restoreEvents.push(event);
				delivered.resolve();
			});
		},
		tempDir.path(),
		new EventBus(),
		runtime,
		"model-select-restore-recorder",
	);
	const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	const restoreRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
	const settings = Settings.isolated({ "compaction.enabled": false });
	const switcher = new AgentSession({
		agent: new Agent({
			initialState: {
				model: bundledAnthropicModel("claude-sonnet-4-5"),
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		}),
		sessionManager,
		settings,
		modelRegistry: modelRegistry,
		extensionRunner: restoreRunner,
	});
	return { switcher, restoreEvents, delivered: delivered.promise, targetFile, settings };
}
function bundledAnthropicModel(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
	return model;
}

/**
 * A bundled row re-hosted on OpenRouter as an `openai-completions` aggregator
 * row, so `applyUpstreamRouting` pins the `@upstream` route exactly as real
 * selector resolution does (`buildModel` only preserves the routing compat
 * block for that api; `modelMatchesHost` matches by provider).
 */
function openRouterHostedModel(id: string): Model<Api> {
	return buildModel({
		...bundledAnthropicModel(id),
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
	});
}
