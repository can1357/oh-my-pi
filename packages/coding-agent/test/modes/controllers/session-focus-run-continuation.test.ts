import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

function createFocusHarness(pause: "continuation" | "async" | "queued", streaming: boolean) {
	let isStreaming = streaming;
	let runStartedAt = streaming ? 1 : undefined;
	let pending = true;
	let runActive = false;
	const idle = Promise.withResolvers<void>();
	const inactive = Promise.withResolvers<void>();
	const runStates = new Set<(state: "running" | "idle") => void>();
	const events = new Set<(event: AgentSessionEvent) => void | Promise<void>>();
	const worker = createInteractiveModeContext({
		session: {
			get isStreaming() {
				return isStreaming;
			},
			get runStartedAt() {
				return runStartedAt;
			},
			get hasLogicalRunActivity() {
				return isStreaming || runStartedAt !== undefined || pending;
			},
			get hasPostPromptWork() {
				return pause === "continuation" && pending;
			},
			get queuedMessageCount() {
				return pause === "queued" && pending ? 1 : 0;
			},
			hasPendingAsyncWork: () => pause === "async" && pending,
			waitForIdle: () => idle.promise,
			settleAsyncWork: () => idle.promise,
			settleInFlightMessagePersistence: async () => {},
			activeToolExecutionUpdates: () => [],
			subscribeRunState: listener => {
				runStates.add(listener);
				return () => {
					runStates.delete(listener);
				};
			},
			subscribe: listener => {
				events.add(listener);
				return () => {
					events.delete(listener);
				};
			},
		},
	}).session;
	const ctx = createInteractiveModeContext({
		session: {
			subscribeRunState: () => () => {},
			settleInFlightMessagePersistence: async () => {},
			activeToolExecutionUpdates: () => [],
		},
		composer: {
			setRunActive: active => {
				runActive = active;
				if (!active) inactive.resolve();
			},
		},
	});
	const registry = new AgentRegistry();
	const lifecycle = new AgentLifecycleManager(registry);
	const focus = new SessionFocusController(ctx, registry, () => lifecycle);
	Object.defineProperty(ctx, "viewSession", { get: () => focus.target ?? ctx.session });
	ctx.eventController = new EventController(ctx);
	registry.register({
		id: "Worker",
		displayName: "Worker",
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		session: worker,
		status: "running",
	});
	return {
		ctx,
		focus,
		worker,
		inactive: inactive.promise,
		runActive: () => runActive,
		async settleStream() {
			isStreaming = false;
			runStartedAt = undefined;
			// AgentSession.#settleAgentEnd publishes idle BEFORE the tagged event.
			for (const listener of runStates) listener("idle");
			// A delayed event must not leave a window for idle-floor promotion.
			expect(runActive).toBe(true);
			for (const listener of events) {
				await listener({
					type: "agent_end",
					messages: [],
					isTerminal: false,
					...(pause === "async" ? { awaitingAsyncWork: true } : {}),
				});
			}
		},
		cancel() {
			pending = false;
			idle.resolve();
		},
		dispose() {
			focus.dispose();
			ctx.unsubscribe?.();
		},
	};
}

describe("focused logical-run activity", () => {
	beforeAll(async () => {
		await initTheme(false);
	});
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		vi.useFakeTimers();
		vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		resetSettingsForTest();
	});

	it.each(["continuation", "async", "queued"] as const)(
		"does not release the chrome floor when idle precedes a nonterminal focused %s settle",
		async pause => {
			const h = createFocusHarness(pause, true);
			try {
				await h.focus.focusAgent("Worker");
				expect(h.runActive()).toBe(true);
				await h.settleStream();
				expect(h.runActive()).toBe(true);
				// Cancellation need not emit another agent_end or another idle pulse.
				h.cancel();
				await h.inactive;
				await h.ctx.eventController.dispatchSessionEvent({ type: "turn_start" });
				expect(h.runActive()).toBe(false);
			} finally {
				h.dispose();
			}
		},
	);

	it.each(["continuation", "async", "queued"] as const)(
		"attaches during a focused %s pause with no run timestamp and releases the floor after cancellation",
		async pause => {
			const h = createFocusHarness(pause, false);
			try {
				await h.focus.focusAgent("Worker");
				expect(h.runActive()).toBe(true);
				h.cancel();
				await h.inactive;
				await h.ctx.eventController.dispatchSessionEvent({ type: "turn_start" });
				expect(h.runActive()).toBe(false);
			} finally {
				h.dispose();
			}
		},
	);

	it("subscribes after a nonterminal main settle and keeps pending recovery active until cancellation", async () => {
		const h = createFocusHarness("continuation", false);
		try {
			h.ctx.session = h.worker;
			h.ctx.eventController.subscribeToAgent();
			expect(h.runActive()).toBe(true);
			h.cancel();
			await h.inactive;
			await h.ctx.eventController.dispatchSessionEvent({ type: "turn_start" });
			expect(h.runActive()).toBe(false);
		} finally {
			h.dispose();
		}
	});

	it("does not let an attached paused worker's cancellation release the newly active main view", async () => {
		const h = createFocusHarness("continuation", false);
		try {
			await h.focus.focusAgent("Worker");
			await h.focus.unfocus();
			await h.ctx.eventController.handleEvent({ type: "agent_start" });
			expect(h.runActive()).toBe(true);
			h.cancel();
			await h.ctx.eventController.dispatchSessionEvent({ type: "turn_start" });
			expect(h.runActive()).toBe(true);
		} finally {
			h.dispose();
		}
	});
});
