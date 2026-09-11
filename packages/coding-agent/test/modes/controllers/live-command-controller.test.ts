import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController } from "@oh-my-pi/pi-coding-agent/live/controller";
import { LiveVisualizer } from "@oh-my-pi/pi-coding-agent/live/visualizer";
import { LiveCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/live-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

/** Fake InteractiveModeContext plus typed capture channels for focus/mount traffic. */
interface ContextHarness {
	ctx: InteractiveModeContext;
	/** The editor stub the controller must restore after live mode ends. */
	editor: unknown;
	/** Every component handed to `ui.setFocus`, in order. */
	focused: unknown[];
	/** Every component handed to `editorContainer.addChild`, in order. */
	mounted: unknown[];
	clearEditorSlot: () => void;
	/** Resolves when `ui.setFocus` sees the original editor again. */
	editorRefocused: Promise<void>;
}

function createContext(): ContextHarness {
	const editor = {
		getUseTerminalCursor: vi.fn(() => true),
		setUseTerminalCursor: vi.fn(),
	};
	const focused: unknown[] = [];
	const mounted: unknown[] = [];
	const refocused = Promise.withResolvers<void>();
	const clearEditorSlot = vi.fn();
	const ctx = {
		settings: Settings.isolated({ "live.voice": "vale" }),
		keybindings: { getKeys: vi.fn(() => ["ctrl+l"]) },
		session: {},
		extractAssistantText: vi.fn(() => ""),
		editor,
		editorContainer: {
			clear: clearEditorSlot,
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
	return { ctx, editor, focused, mounted, clearEditorSlot, editorRefocused: refocused.promise };
}

afterEach(() => {
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

	it("stops the session and restores the editor when the live-toggle chord hits the focused visualizer", async () => {
		const { ctx, editor, focused, mounted, clearEditorSlot, editorRefocused } = createContext();
		const stop = vi.fn(async () => {});
		const controller = new LiveCommandController(ctx, options => {
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockImplementation(stop);
			return session;
		});

		await controller.handleCommand();
		expect(controller.active).toBe(true);

		// Live mode owns the centered editor slot while active, and the toggle
		// chord must restore the original editor after stopping.
		const visualizer = focused[0];
		if (!(visualizer instanceof LiveVisualizer)) {
			throw new Error("expected the controller to focus a LiveVisualizer");
		}
		visualizer.handleInput("\x0c"); // Ctrl+L — the keypress alone must drive teardown
		await editorRefocused;

		expect(stop).toHaveBeenCalled();
		expect(mounted).toEqual([visualizer, editor]);
		expect(clearEditorSlot).toHaveBeenCalledTimes(2);
		expect(focused.at(-1)).toBe(editor);
		// `active` stays true until #finish's fire-and-forget settling promise
		// clears; drain microtasks deterministically instead of sleeping.
		for (let i = 0; controller.active && i < 20; i++) await Promise.resolve();
		expect(controller.active).toBe(false);
	});
});
