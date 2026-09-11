import { beforeAll, describe, expect, it } from "bun:test";
import { Container } from "@oh-my-pi/pi-tui";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

interface SessionStub {
	session: AgentSession;
	/** Emit an event through the listener captured by the last subscribe(). */
	emit: (event: unknown) => Promise<void>;
	unsubscribeCalls: () => number;
	setStreaming: (streaming: boolean) => void;
	/** Seed the steering/follow-up queue that getQueuedMessages() returns. */
	setQueue: (queue: { steering?: string[]; followUp?: string[] }) => void;
}

function makeSessionStub(opts: { isStreaming?: boolean } = {}): SessionStub {
	let listener: ((event: AgentSessionEvent) => Promise<void> | void) | undefined;
	let unsubscribeCalls = 0;
	let queue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
	const stub = {
		isStreaming: opts.isStreaming ?? false,
		subscribe(fn: (event: AgentSessionEvent) => Promise<void> | void) {
			listener = fn;
			return () => {
				unsubscribeCalls++;
			};
		},
		async settleInFlightMessagePersistence() {},
		activeToolExecutionUpdates: () => [],
		getQueuedMessages: () => queue,
	};
	return {
		session: stub as unknown as AgentSession,
		emit: async event => {
			if (!listener) throw new Error("no listener captured: subscribe() was never called");
			await listener(event as AgentSessionEvent);
		},
		unsubscribeCalls: () => unsubscribeCalls,
		setStreaming: streaming => {
			stub.isStreaming = streaming;
		},
		setQueue: next => {
			queue = { steering: next.steering ?? [], followUp: next.followUp ?? [] };
		},
	};
}

interface Harness {
	ctx: InteractiveModeContext;
	controller: SessionFocusController;
	registry: AgentRegistry;
	main: SessionStub;
	handledEvents: unknown[];
	setSessionCalls: Array<[AgentSession, string | undefined]>;
	reloadTodoSessions: AgentSession[];
	pendingMessagesContainer: Container;
	counts: {
		clearTransientSessionUi: () => number;
		resetTranscriptAnchors: () => number;
		renderInitialMessages: () => number;
		mainUnsubscribe: () => number;
	};
}

function makeHarness(options: { renderInitialMessages?: () => void | Promise<void> } = {}): Harness {
	const main = makeSessionStub();
	const handledEvents: unknown[] = [];
	const setSessionCalls: Array<[AgentSession, string | undefined]> = [];
	const reloadTodoSessions: AgentSession[] = [];
	const pendingMessagesContainer = new Container();
	let clearTransientSessionUi = 0;
	let resetTranscriptAnchors = 0;
	let renderInitialMessages = 0;
	let mainUnsubscribe = 0;

	const ctx = {
		session: main.session,
		get viewSession() {
			return controller.target ?? main.session;
		},
		pendingMessagesContainer,
		compactionQueuedMessages: [],
		keybindings: { getDisplayString: () => "Alt+Up" },
		unsubscribe: () => {
			mainUnsubscribe++;
		},
		eventController: {
			handleEvent: async (event: unknown) => {
				handledEvents.push(event);
			},
			resetTranscriptAnchors: () => {
				resetTranscriptAnchors++;
			},
		},
		statusLine: {
			setSession: (session: AgentSession, focusedAgentId?: string) => {
				setSessionCalls.push([session, focusedAgentId]);
			},
			invalidate() {},
		},
		clearTransientSessionUi: () => {
			clearTransientSessionUi++;
			// Mirror interactive-mode.ts: focus teardown disposes the pending block.
			pendingMessagesContainer.disposeChildren();
		},
		renderInitialMessages: async () => {
			renderInitialMessages++;
			await options.renderInitialMessages?.();
		},
		reloadTodos: async (source?: AgentSession) => {
			reloadTodoSessions.push(source ?? main.session);
		},
		updatePendingMessagesDisplay: () => uiHelpers.updatePendingMessagesDisplay(),
		updateEditorBorderColor() {},
		ui: { requestRender() {}, requestComponentRender() {} },
		showStatus() {},
		collabGuest: undefined,
	} as unknown as InteractiveModeContext;

	const registry = new AgentRegistry();
	const lifecycle = new AgentLifecycleManager(registry);
	const controller = new SessionFocusController(ctx, registry, () => lifecycle);
	const uiHelpers = new UiHelpers(ctx);

	return {
		ctx,
		controller,
		registry,
		main,
		handledEvents,
		setSessionCalls,
		reloadTodoSessions,
		pendingMessagesContainer,
		counts: {
			clearTransientSessionUi: () => clearTransientSessionUi,
			resetTranscriptAnchors: () => resetTranscriptAnchors,
			renderInitialMessages: () => renderInitialMessages,
			mainUnsubscribe: () => mainUnsubscribe,
		},
	};
}

function registerSub(registry: AgentRegistry, id: string, session: AgentSession, parentId?: string) {
	return registry.register({ id, displayName: id, kind: "sub", parentId, session, status: "running" });
}

/** Settle the async unfocus chain (registry event → void unfocus() → #attach). */
async function flushAsync(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("SessionFocusController", () => {
	beforeAll(async () => {
		// updatePendingMessagesDisplay renders through the global theme singleton.
		await initTheme(false);
	});

	it("focusAgent retargets subscription, transcript anchors, and status line onto the worker session", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		await h.controller.focusAgent("Worker");

		expect(h.controller.focusedAgentId).toBe("Worker");
		expect(h.controller.target).toBe(worker.session);
		expect(h.counts.mainUnsubscribe()).toBe(1);
		expect(h.counts.clearTransientSessionUi()).toBe(1);
		expect(h.counts.resetTranscriptAnchors()).toBe(1);
		expect(h.counts.renderInitialMessages()).toBe(1);
		expect(h.reloadTodoSessions).toEqual([worker.session]);
		expect(h.setSessionCalls).toEqual([[worker.session, "Worker"]]);

		const event = { type: "message_start", message: { role: "user" } };
		await worker.emit(event);
		expect(h.handledEvents).toEqual([event]);
	});

	it("re-attaching the main session refreshes the todo HUD so it can't freeze at the pre-focus snapshot (#9571)", async () => {
		// While a subagent is focused the main session's `todo` completions never
		// reach the HUD (the event subscription points at the subagent). Returning
		// to the main session rebuilds the transcript from committed messages but
		// must also reload the HUD, or it stays stuck on the pre-focus snapshot
		// (e.g. a `todo init` 0/N) while the transcript shows current progress.
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		await h.controller.focusAgent("Worker");
		expect(h.reloadTodoSessions).toEqual([worker.session]);

		await h.controller.unfocus();
		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.setSessionCalls.at(-1)).toEqual([h.main.session, undefined]);
		expect(h.reloadTodoSessions).toEqual([worker.session, h.main.session]);
	});

	it("re-renders the pending steering block against the attached session's real queue on both focus directions (#11379)", async () => {
		// clearTransientSessionUi() disposes pendingMessagesContainer on every attach.
		// The queue survives, but nothing repainted it, so returning from a focused
		// agent left the steering block permanently blank. #attach() must rebuild the
		// real container from viewSession's queue in both directions: the subagent's
		// own queue on focus, main's queue on unfocus.
		const h = makeHarness();
		const worker = makeSessionStub();
		h.main.setQueue({ steering: ["main steer alpha"] });
		worker.setQueue({ steering: ["worker steer beta"] });
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		const rendered = () => h.pendingMessagesContainer.render(80).join("\n");

		await h.controller.focusAgent("Worker");
		expect(rendered()).toContain("worker steer beta");
		expect(rendered()).not.toContain("main steer alpha");

		await h.controller.unfocus();
		expect(rendered()).toContain("main steer alpha");
		expect(rendered()).not.toContain("worker steer beta");
	});

	it("does not let a superseded focus attachment restore the worker todo HUD after unfocusing", async () => {
		let releaseWorkerRender: (() => void) | undefined;
		let markWorkerRenderStarted: (() => void) | undefined;
		const workerRender = new Promise<void>(resolve => {
			releaseWorkerRender = resolve;
		});
		const workerRenderStarted = new Promise<void>(resolve => {
			markWorkerRenderStarted = resolve;
		});
		let renderCalls = 0;
		const h = makeHarness({
			renderInitialMessages: () => {
				renderCalls++;
				if (renderCalls !== 1) return;
				markWorkerRenderStarted?.();
				return workerRender;
			},
		});
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		const focus = h.controller.focusAgent("Worker");
		await workerRenderStarted;
		await h.controller.unfocus();
		expect(h.reloadTodoSessions).toEqual([h.main.session]);

		releaseWorkerRender?.();
		await focus;
		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.setSessionCalls.at(-1)).toEqual([h.main.session, undefined]);
		expect(h.reloadTodoSessions).toEqual([h.main.session]);
	});

	it("mid-turn attach synthesizes agent_start, and an orphaned assistant message_update gets a synthesized message_start", async () => {
		const h = makeHarness();
		const worker = makeSessionStub({ isStreaming: true });
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		await h.controller.focusAgent("Worker");
		expect(h.handledEvents).toEqual([{ type: "agent_start" }]);

		const message = { role: "assistant", content: "partial" };
		await worker.emit({ type: "message_update", message });
		expect(h.handledEvents.slice(1)).toEqual([
			{ type: "message_start", message },
			{ type: "message_update", message },
		]);

		// Guard fires once: subsequent updates pass through unsynthesized.
		await worker.emit({ type: "message_update", message });
		expect(h.handledEvents.slice(3)).toEqual([{ type: "message_update", message }]);
	});

	it("focusParent walks parentId to a registered non-main agent, then re-attaches the main session", async () => {
		const h = makeHarness();
		const parent = makeSessionStub();
		const worker = makeSessionStub();
		registerSub(h.registry, "Parent", parent.session, MAIN_AGENT_ID);
		registerSub(h.registry, "Worker", worker.session, "Parent");

		await h.controller.focusAgent("Worker");
		await h.controller.focusParent();
		expect(h.controller.focusedAgentId).toBe("Parent");
		expect(h.setSessionCalls).toEqual([
			[worker.session, "Worker"],
			[parent.session, "Parent"],
		]);

		// Parent's parent is Main → unfocus back to ctx.session.
		await h.controller.focusParent();
		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.controller.target).toBeUndefined();
		expect(h.setSessionCalls).toEqual([
			[worker.session, "Worker"],
			[parent.session, "Parent"],
			[h.main.session, undefined],
		]);
	});

	it("parking the focused agent auto-unfocuses back to the main session", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		await h.controller.focusAgent("Worker");
		expect(h.controller.focusedAgentId).toBe("Worker");

		h.registry.setStatus("Worker", "parked");
		await flushAsync();

		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.setSessionCalls).toEqual([
			[worker.session, "Worker"],
			[h.main.session, undefined],
		]);
	});
});
