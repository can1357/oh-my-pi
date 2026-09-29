import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Input, TUI } from "@oh-my-pi/pi-tui";
import type { BtwHistoryRecord } from "@oh-my-pi/pi-tui/overlays/btw-history";
import { BtwHistoryPanel } from "@oh-my-pi/pi-tui/overlays/btw-history-panel";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { Settings, settings } from "../src/config/settings";
import * as asrClient from "../src/stt/asr-client";
import * as downloader from "../src/stt/downloader";
import { type DictationTarget, MicCursor } from "../src/stt/push-to-talk";
import { cfgSttSubmitTrigger } from "../src/stt/settings";
import { type Editor, STTController, type STTControllerDependencies, type SttState } from "../src/stt/stt-controller";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

class MinimalTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	kittyEnableSequence: string | null = null;
	keyboardEnhancementEnterSequence: string | null = null;
	keyboardEnhancementExitSequence: string | null = null;
	appearance: TerminalAppearance | undefined;
	#onInput: ((data: string) => void) | undefined;
	output = "";
	cursorHidden = false;
	cursorTransitions = 0;

	start(onInput: (data: string) => void, _onResize: () => void): void {
		this.#onInput = onInput;
	}

	stop(): void {
		this.#onInput = undefined;
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	write(data: string): void {
		this.output += data;
	}

	moveBy(_lines: number): void {}

	hideCursor(): void {
		this.cursorHidden = true;
		this.cursorTransitions += 1;
	}

	showCursor(): void {
		this.cursorHidden = false;
		this.cursorTransitions += 1;
	}

	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	onAppearanceChange(_callback: (appearance: TerminalAppearance) => void): void {}
	sendInput(data: string): void {
		this.#onInput?.(data);
	}
}

const DICTATION_MODELS = [getBundledModel("local", "whisper-base")];
const registry: STTControllerDependencies["registry"] = {
	getError: () => undefined,
	getAvailable: () => DICTATION_MODELS,
	getAll: () => DICTATION_MODELS,
	resolver: () => () => "test-key",
};

describe("Single-line field STT router and feedback", () => {
	let state: SettingsTestState | undefined;
	let controller: STTController | undefined;
	let micCursor: MicCursor | undefined;

	function makeFallbackComposer(): DictationTarget {
		return {
			setVolatileText: vi.fn(),
			clearVolatileText: vi.fn(),
			commitVolatileText: vi.fn(),
			submit: vi.fn(),
			deleteBeforeCursor: vi.fn(),
			cursorOverride: undefined,
			render: (_width: number): string[] => [""],
		};
	}

	function syncMicCursor(
		tui: TUI,
		sttState: SttState,
		fallbackTarget: DictationTarget,
		explicitTarget?: DictationTarget,
	): void {
		if (sttState === "recording") {
			const activeTarget =
				explicitTarget ?? (tui.getFocusedTextEditor() as DictationTarget | null) ?? fallbackTarget;
			micCursor?.dispose();
			micCursor = new MicCursor(tui, activeTarget);
			tui.requestRender();
			return;
		}
		if (sttState === "transcribing") {
			micCursor?.showTranscribing();
			tui.requestRender();
			return;
		}
		micCursor?.dispose();
		micCursor = undefined;
		tui.requestRender();
	}

	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		state = beginSettingsTest();
		await Settings.init({ inMemory: true });
		settings.setModelRole("dictation", "local/whisper-base");
		cfgSttSubmitTrigger.set(settings, "never");
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(downloader, "downloadSttModel").mockResolvedValue(undefined);
	});

	afterEach(() => {
		micCursor?.dispose();
		micCursor = undefined;
		controller?.dispose();
		controller = undefined;
		vi.restoreAllMocks();
		restoreSettingsTestState(state);
	});

	it("routes global key transcript into a focused declared single-line field", async () => {
		vi.spyOn(asrClient.sttClient, "startStream").mockReturnValue({
			pushAudio: vi.fn(),
			stop: vi.fn().mockResolvedValue("single line transcript"),
			cancel: vi.fn(),
		});

		const terminal = new MinimalTerminal();
		const tui = new TUI(terminal);
		const input = new Input();
		input.setValue("prefix ");
		tui.addChild(input);
		tui.start();
		tui.setFocus(input);

		const fallback = makeFallbackComposer();
		controller = new STTController(() => ({ stop: vi.fn() }), { settings, registry });

		const options = {
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			onStateChange: vi.fn(),
			submitEditor: (ed: Editor) => tui.submitFocusedTextEditor(ed),
			subscribeFocus: (listener: () => void) => tui.addFocusListener(listener),
		};

		try {
			await controller.toggle(() => tui.getFocusedTextEditor(), fallback, options);
			expect(controller.state).toBe("recording");

			await controller.toggle(() => tui.getFocusedTextEditor(), fallback, options);
			expect(controller.state).toBe("idle");

			expect(input.getValue()).toBe("prefix single line transcript");
			expect(fallback.commitVolatileText).not.toHaveBeenCalled();
		} finally {
			tui.stop();
		}
	});

	it("targets declared /btw follow-up field when focused and submits on trigger", async () => {
		cfgSttSubmitTrigger.set(settings, "release");
		vi.spyOn(asrClient.sttClient, "startStream").mockReturnValue({
			pushAudio: vi.fn(),
			stop: vi.fn().mockResolvedValue("follow up question here"),
			cancel: vi.fn(),
		});

		const terminal = new MinimalTerminal();
		const tui = new TUI(terminal);
		let followUpSubmitted: string | undefined;

		const record: BtwHistoryRecord = {
			id: "rec-42",
			leafId: "leaf-42",
			question: "How does STT work?",
			answer: "Through audio models.",
			status: "complete",
			createdAt: 100,
			updatedAt: 200,
		};

		const panel = new BtwHistoryPanel({
			records: [record],
			onClose: () => {},
			onCopy: () => {},
			onCancel: () => {},
			canFollowUp: () => true,
			onFollowUp: async (_rec, question) => {
				followUpSubmitted = question;
				return true;
			},
			requestRender: () => tui.requestRender(),
			getHeight: () => 30,
		});
		tui.addChild(panel);
		tui.start();
		tui.setFocus(panel);

		const fallback = makeFallbackComposer();
		controller = new STTController(() => ({ stop: vi.fn() }), { settings, registry });

		const options = {
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			onStateChange: vi.fn(),
			submitEditor: (ed: Editor) => tui.submitFocusedTextEditor(ed),
			subscribeFocus: (listener: () => void) => tui.addFocusListener(listener),
		};

		try {
			// Hub starts with history list focused; follow-up composer closed
			expect(tui.getFocusedTextEditor()).toBeNull();

			// Open follow-up composer via 'f' key
			panel.handleInput("f");
			const followUpField = tui.getFocusedTextEditor();
			expect(followUpField).not.toBeNull();
			expect(followUpField).toBe(panel.getFocusedTextEditor());

			// Start global STT toggle targeting the focused editor
			await controller.toggle(() => tui.getFocusedTextEditor(), fallback, options);
			expect(controller.state).toBe("recording");

			// Stop recording: delivers transcript and submits via submitTrigger
			await controller.toggle(() => tui.getFocusedTextEditor(), fallback, options);
			expect(controller.state).toBe("idle");

			await Promise.resolve();
			await Promise.resolve();

			expect(followUpSubmitted).toBe("follow up question here");
			expect(fallback.commitVolatileText).not.toHaveBeenCalled();
		} finally {
			tui.stop();
		}
	});

	it("renders mic icon at the receiving field cursor while recording via global key and clears on stop", async () => {
		vi.spyOn(asrClient.sttClient, "startStream").mockReturnValue({
			pushAudio: vi.fn(),
			stop: vi.fn().mockResolvedValue("done"),
			cancel: vi.fn(),
		});

		const terminal = new MinimalTerminal();
		const tui = new TUI(terminal);
		const input = new Input();
		input.setValue("prompt ");
		tui.addChild(input);
		tui.start();
		tui.setFocus(input);

		const fallback = makeFallbackComposer();
		controller = new STTController(() => ({ stop: vi.fn() }), { settings, registry });

		const options = {
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			onStateChange: (sttState: SttState) => syncMicCursor(tui, sttState, fallback),
			submitEditor: (ed: Editor) => tui.submitFocusedTextEditor(ed),
			subscribeFocus: (listener: () => void) => {
				return tui.addFocusListener(() => {
					if (controller?.state === "recording") syncMicCursor(tui, "recording", fallback);
					listener();
				});
			},
		};

		try {
			expect(input.cursorOverride).toBeUndefined();

			await controller.toggle(() => tui.getFocusedTextEditor(), fallback, options);
			expect(controller.state).toBe("recording");

			// Mic icon active on the single-line input's cursor
			expect(input.cursorOverride).toBeDefined();
			expect(input.cursorOverride).toContain(theme.icon.mic);
			const rendered = input.render(80)[0];
			expect(rendered).toContain(theme.icon.mic);

			await controller.toggle(() => tui.getFocusedTextEditor(), fallback, options);
			expect(controller.state).toBe("idle");

			// Mic icon cleared after recording ends
			expect(input.cursorOverride).toBeUndefined();
			expect(input.render(80)[0]).not.toContain(theme.icon.mic);
		} finally {
			tui.stop();
		}
	});

	it("renders mic icon at the receiving field cursor while recording via space-hold gesture", async () => {
		const terminal = new MinimalTerminal();
		const tui = new TUI(terminal);
		const input = new Input();
		input.setValue("held text ");
		tui.addChild(input);
		tui.start();
		tui.setFocus(input);

		vi.spyOn(asrClient.sttClient, "startStream").mockReturnValue({
			pushAudio: vi.fn(),
			stop: vi.fn().mockResolvedValue("gesture transcript"),
			cancel: vi.fn(),
		});

		controller = new STTController(() => ({ stop: vi.fn() }), { settings, registry });

		const gestureCallbacks = {
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			onStateChange: (sttState: SttState) => syncMicCursor(tui, sttState, input, input),
		};

		try {
			expect(input.cursorOverride).toBeUndefined();

			// Simulate gesture start (hold Space)
			await controller.start(input, gestureCallbacks);
			expect(controller.state).toBe("recording");

			expect(input.cursorOverride).toBeDefined();
			expect(input.cursorOverride).toContain(theme.icon.mic);
			expect(input.render(80)[0]).toContain(theme.icon.mic);

			// Simulate gesture end (release Space)
			await controller.stop();
			expect(controller.state).toBe("idle");

			expect(input.cursorOverride).toBeUndefined();
			expect(input.render(80)[0]).not.toContain(theme.icon.mic);
		} finally {
			tui.stop();
		}
	});

	it("maintains volatile streaming preview and delivers one-shot block with no duplication", async () => {
		let onPartialCallback: ((text: string) => void) | undefined;
		let onSegmentCallback: ((text: string, index: number) => void) | undefined;

		vi.spyOn(asrClient.sttClient, "startStream").mockImplementation((_model, streamOpts) => {
			onPartialCallback = streamOpts?.onPartial;
			onSegmentCallback = streamOpts?.onSegment;
			return {
				pushAudio: vi.fn(),
				stop: vi.fn().mockResolvedValue("hello world final transcript"),
				cancel: vi.fn(),
			};
		});

		const terminal = new MinimalTerminal();
		const tui = new TUI(terminal);
		const input = new Input();
		tui.addChild(input);
		tui.start();
		tui.setFocus(input);

		const fallback = makeFallbackComposer();
		controller = new STTController(() => ({ stop: vi.fn() }), { settings, registry });

		const options = {
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			onStateChange: vi.fn(),
			submitEditor: (ed: Editor) => tui.submitFocusedTextEditor(ed),
			subscribeFocus: (listener: () => void) => tui.addFocusListener(listener),
		};

		try {
			await controller.toggle(() => tui.getFocusedTextEditor(), fallback, options);
			expect(controller.state).toBe("recording");

			// First volatile partial
			onPartialCallback?.("hello");
			expect(input.getValue()).toBe("hello");

			// Updated volatile partial replaces previous partial
			onPartialCallback?.("hello world");
			expect(input.getValue()).toBe("hello world");

			// Segment arrives: still held in volatile preview, not committed
			onSegmentCallback?.("hello world", 0);
			expect(input.getValue()).toBe("hello world");

			// Subsequent partial extends volatile preview
			onPartialCallback?.("final");
			expect(input.getValue()).toBe("hello world final");

			// Stop recording: volatile preview cleared, final text committed as single block
			await controller.toggle(() => tui.getFocusedTextEditor(), fallback, options);
			expect(controller.state).toBe("idle");
			expect(input.getValue()).toBe("hello world final transcript");

			// Verify single-step undo cleanly removes the whole committed block without residue
			input.handleInput("\x1f"); // Ctrl+_ (undo)
			expect(input.getValue()).toBe("");
		} finally {
			tui.stop();
		}
	});
});
