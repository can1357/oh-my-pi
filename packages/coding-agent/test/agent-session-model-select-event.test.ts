import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type Api, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ModelSelectEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

type GateGlobal = typeof globalThis & {
	__ompModelSelectGate?: Promise<void>;
	/** Park only the handler for this model id; other events pass through. */
	__ompModelSelectParkFor?: string;
};
/**
 * Deterministic delivery signals: one resolver per expected event, resolved
 * by the handler itself, so positive assertions await the real emits instead
 * of a guessed delay.
 */
let deliveries: Array<PromiseWithResolvers<void>> = [];

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

describe("AgentSession model_select extension event", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let events: ModelSelectEvent[];
	let modelChangedCount: number;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-model-select-event-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("model_select", async event => {
					// Park on the optional gate — either unconditionally (detached
					// test) or only for a chosen model id (FIFO test) — proving
					// switches never wait on handlers.
					const gateGlobal = globalThis as GateGlobal;
					const park = gateGlobal.__ompModelSelectParkFor;
					const gate = gateGlobal.__ompModelSelectGate;
					if (gate && (park === undefined || park === event.model.id)) await gate;
					events.push(event);
					deliveries[events.length - 1]?.resolve();
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"model-select-recorder",
		);

		const sessionManager = SessionManager.inMemory(tempDir.path());
		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);

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
		modelChangedCount = 0;
		armDelivery();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			extensionRunner,
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
});

function bundledAnthropicModel(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
	return model;
}
