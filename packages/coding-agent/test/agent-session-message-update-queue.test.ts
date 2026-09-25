import { expect, test } from "bun:test";
import { Agent, type AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import type { ExtensionAPI } from "../src/extensibility/extensions/types";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { EventBus } from "../src/utils/event-bus";

async function makeSession() {
	const runtime = new ExtensionRuntime();
	const manager = SessionManager.inMemory();
	let api!: ExtensionAPI;
	const extension = await loadExtensionFromFactory(
		extensionApi => {
			api = extensionApi;
		},
		manager.getCwd(),
		new EventBus(),
		runtime,
	);
	const registry = {} as ModelRegistry;
	const runner = new ExtensionRunner([extension], runtime, manager.getCwd(), manager, registry);
	const agent = new Agent({ initialState: { systemPrompt: [], tools: [], messages: [] } });
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: registry,
		extensionRunner: runner,
	});
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "x" }],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	return {
		api,
		runner,
		session,
		emit(delta: string) {
			const update: AgentEvent = {
				type: "message_update",
				message,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: message },
			};
			agent.emitExternalEvent(update);
		},
	};
}

test("late message_update registration observes an update already queued", async () => {
	const { api, runner, session, emit } = await makeSession();
	const received: string[] = [];
	try {
		expect(runner.hasHandlers("message_update")).toBe(false);
		emit("A");
		api.on("message_update", event => {
			if (event.assistantMessageEvent.type === "text_delta") received.push(event.assistantMessageEvent.delta);
		});
		await Bun.sleep(0);
		expect(received).toEqual(["A"]);
	} finally {
		await session.dispose();
	}
});

test("updates queued across a registration microtask keep their delivery order", async () => {
	const { api, session, emit } = await makeSession();
	const received: string[] = [];
	try {
		emit("A");
		queueMicrotask(() => {
			api.on("message_update", event => {
				if (event.assistantMessageEvent.type === "text_delta") received.push(event.assistantMessageEvent.delta);
			});
		});
		emit("B");
		await Bun.sleep(0);
		expect(received).toEqual(["B"]);
	} finally {
		await session.dispose();
	}
});

test("async message_update handlers finish before the next update starts", async () => {
	const { api, session, emit } = await makeSession();
	const firstStarted = Promise.withResolvers<void>();
	const releaseFirst = Promise.withResolvers<void>();
	const secondDone = Promise.withResolvers<void>();
	const order: string[] = [];
	api.on("message_update", async event => {
		if (event.assistantMessageEvent.type !== "text_delta") return;
		const delta = event.assistantMessageEvent.delta;
		order.push(`start:${delta}`);
		if (delta === "A") {
			firstStarted.resolve();
			await releaseFirst.promise;
		}
		order.push(`end:${delta}`);
		if (delta === "B") secondDone.resolve();
	});
	try {
		emit("A");
		emit("B");
		await firstStarted.promise;
		expect(order).toEqual(["start:A"]);
		releaseFirst.resolve();
		await secondDone.promise;
		expect(order).toEqual(["start:A", "end:A", "start:B", "end:B"]);
	} finally {
		releaseFirst.resolve();
		await session.dispose();
	}
});

test("a failing message_update handler does not block later updates", async () => {
	const { api, session, emit } = await makeSession();
	const received: string[] = [];
	api.on("message_update", event => {
		if (event.assistantMessageEvent.type !== "text_delta") return;
		if (event.assistantMessageEvent.delta === "A") throw new Error("expected handler failure");
		received.push(event.assistantMessageEvent.delta);
	});
	try {
		emit("A");
		emit("B");
		await Bun.sleep(0);
		expect(received).toEqual(["B"]);
	} finally {
		await session.dispose();
	}
});
