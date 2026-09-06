import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	isLiveActivityEvent,
	LIVE_ACTIVITY_EVENT_CHANNEL,
	type LiveActivityEvent,
} from "@oh-my-pi/pi-coding-agent/live/activity-events";
import { type LiveSessionCallbacks, LiveSessionController } from "@oh-my-pi/pi-coding-agent/live/controller";
import { LiveVisualizer } from "@oh-my-pi/pi-coding-agent/live/visualizer";
import { LiveCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/live-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

/** Fake InteractiveModeContext plus typed capture channels for focus/mount traffic. */
interface ContextHarness {
	ctx: InteractiveModeContext;
	/** The editor stub the controller must restore after live mode ends. */
	editor: unknown;
	/** Every component handed to `ui.setFocus`, in order. */
	focused: unknown[];
	/** Every component handed to `editorContainer.addChild`, in order. */
	mounted: unknown[];
	/** Resolves when `ui.setFocus` sees the original editor again. */
	editorRefocused: Promise<void>;
	/** Extension event channel receiving privacy-bounded live activity. */
	eventBus: EventBus;
}

function createContext(): ContextHarness {
	const editor = {
		getUseTerminalCursor: vi.fn(() => true),
		setUseTerminalCursor: vi.fn(),
	};
	const focused: unknown[] = [];
	const mounted: unknown[] = [];
	const refocused = Promise.withResolvers<void>();
	const eventBus = new EventBus();
	const ctx = {
		eventBus,
		settings: Settings.isolated({ "live.voice": "vale" }),
		keybindings: { getKeys: vi.fn(() => ["ctrl+l"]) },
		session: {},
		extractAssistantText: vi.fn(() => ""),
		editor,
		editorContainer: {
			clear: vi.fn(),
			addChild: vi.fn((component: unknown) => {
				mounted.push(component);
			}),
		},
		ui: {
			getShowHardwareCursor: vi.fn(() => true),
			setShowHardwareCursor: vi.fn(),
			setFocus: vi.fn((component: unknown) => {
				focused.push(component);
				if (component === editor) refocused.resolve();
			}),
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
		},
		showError: vi.fn(),
		chatContainer: { children: [] },
		present: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, editor, focused, mounted, editorRefocused: refocused.promise, eventBus };
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("LiveCommandController", () => {
	it("forwards the selected voice across the live-session boundary", async () => {
		const { ctx } = createContext();
		let receivedVoice: string | undefined;
		const controller = new LiveCommandController(ctx, options => {
			receivedVoice = options.voice;
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockResolvedValue();
			return session;
		});

		try {
			await controller.handleCommand();
			expect(receivedVoice).toBe("vale");
		} finally {
			await controller.stop();
		}
	});

	it("publishes bounded live activity without exposing realtime audio data", async () => {
		vi.useFakeTimers();
		const { ctx, eventBus } = createContext();
		const activity: LiveActivityEvent[] = [];
		const unsubscribe = eventBus.on(LIVE_ACTIVITY_EVENT_CHANNEL, value => {
			if (!isLiveActivityEvent(value)) throw new Error("invalid live activity event");
			activity.push(value);
		});
		expect(isLiveActivityEvent({ phase: "listening", inputLevel: 2, outputLevel: 0 })).toBe(false);
		const arrayPayload = Object.assign([], { phase: "listening", inputLevel: 0, outputLevel: 0 });
		expect(isLiveActivityEvent(arrayPayload)).toBe(false);
		let callbacks: LiveSessionCallbacks | undefined;
		const controller = new LiveCommandController(ctx, options => {
			callbacks = options.callbacks;
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockResolvedValue();
			return session;
		});

		try {
			await controller.handleCommand();
			expect(activity).toEqual([{ phase: "connecting", inputLevel: 0, outputLevel: 0 }]);
			if (!callbacks) throw new Error("expected live session callbacks");

			callbacks.onLevels(0.25, 2);
			vi.advanceTimersByTime(79);
			expect(activity).toHaveLength(1);
			vi.advanceTimersByTime(1);
			expect(activity.at(-1)).toEqual({
				phase: "connecting",
				inputLevel: 0.25,
				outputLevel: 1,
			});

			callbacks.onPhase("speaking");
			expect(activity.at(-1)).toEqual({
				phase: "speaking",
				inputLevel: 0.25,
				outputLevel: 1,
			});
			callbacks.onLevels(Number.NaN, Number.POSITIVE_INFINITY);
			vi.advanceTimersByTime(80);
			expect(activity.at(-1)).toEqual({
				phase: "speaking",
				inputLevel: 0,
				outputLevel: 0,
			});
			const settledCount = activity.length;
			vi.advanceTimersByTime(80);
			expect(activity).toHaveLength(settledCount);

			await controller.stop();
			expect(activity.at(-1)).toEqual({ phase: "inactive", inputLevel: 0, outputLevel: 0 });
			for (const event of activity) {
				expect(Object.keys(event).sort()).toEqual(["inputLevel", "outputLevel", "phase"]);
			}
		} finally {
			unsubscribe();
			await controller.stop();
		}
	});

	it("coalesces changing levels while an extension observer is busy", async () => {
		vi.useFakeTimers();
		const { ctx, eventBus } = createContext();
		const releaseObserver = Promise.withResolvers<void>();
		const receivedLatest = Promise.withResolvers<void>();
		const activity: LiveActivityEvent[] = [];
		let first = true;
		const unsubscribe = eventBus.on(LIVE_ACTIVITY_EVENT_CHANNEL, async value => {
			if (!isLiveActivityEvent(value)) throw new Error("invalid live activity event");
			activity.push(value);
			if (first) {
				first = false;
				await releaseObserver.promise;
			} else {
				receivedLatest.resolve();
			}
		});
		let callbacks: LiveSessionCallbacks | undefined;
		const controller = new LiveCommandController(ctx, options => {
			callbacks = options.callbacks;
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockResolvedValue();
			return session;
		});

		try {
			await controller.handleCommand();
			if (!callbacks) throw new Error("expected live session callbacks");
			callbacks.onLevels(0.1, 0.2);
			vi.advanceTimersByTime(80);
			callbacks.onLevels(0.3, 0.4);
			vi.advanceTimersByTime(80);

			expect(activity).toEqual([{ phase: "connecting", inputLevel: 0, outputLevel: 0 }]);
			releaseObserver.resolve();
			await receivedLatest.promise;
			expect(activity).toEqual([
				{ phase: "connecting", inputLevel: 0, outputLevel: 0 },
				{ phase: "connecting", inputLevel: 0.3, outputLevel: 0.4 },
			]);
		} finally {
			unsubscribe();
			releaseObserver.resolve();
			await controller.stop();
		}
	});

	it("stops the session and restores the editor when the live-toggle chord hits the focused visualizer", async () => {
		const { ctx, editor, focused, mounted, editorRefocused } = createContext();
		const stop = vi.fn(async () => {});
		const controller = new LiveCommandController(ctx, options => {
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockImplementation(stop);
			return session;
		});

		await controller.handleCommand();
		expect(controller.active).toBe(true);

		// The controller replaces and focuses the editor with the visualizer;
		// Ctrl+L must end the call from there, not just from the editor.
		const visualizer = focused[0];
		if (!(visualizer instanceof LiveVisualizer)) {
			throw new Error("expected the controller to focus a LiveVisualizer");
		}
		visualizer.handleInput("\x0c"); // Ctrl+L — the keypress alone must drive teardown
		await editorRefocused;

		expect(stop).toHaveBeenCalled();
		expect(mounted.at(-1)).toBe(editor);
		expect(focused.at(-1)).toBe(editor);
		// `active` stays true until #finish's fire-and-forget settling promise
		// clears; drain microtasks deterministically instead of sleeping.
		for (let i = 0; controller.active && i < 20; i++) await Promise.resolve();
		expect(controller.active).toBe(false);
	});
});
