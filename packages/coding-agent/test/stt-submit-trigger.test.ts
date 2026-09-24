import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings, settings } from "../src/config/settings";
import * as asrClient from "../src/stt/asr-client";
import * as downloader from "../src/stt/downloader";
import { STTController, type STTControllerDependencies, type Editor } from "../src/stt/stt-controller";
import { evaluateSubmitTrigger, type SttSubmitTrigger } from "../src/stt/submit-trigger";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const DICTATION_MODELS = [getBundledModel("local", "whisper-base")];
const registry: STTControllerDependencies["registry"] = {
	getError: () => undefined,
	getAvailable: () => DICTATION_MODELS,
	getAll: () => DICTATION_MODELS,
	resolver: () => () => "test-key",
};

describe("STT Submit Trigger Evaluation", () => {
	describe("never trigger", () => {
		it("should never submit", () => {
			expect(evaluateSubmitTrigger("hello world", "never")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("submit", "never")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("", "never")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
		});
	});

	describe("release trigger", () => {
		it("should only submit if utterance has 2+ words", () => {
			expect(evaluateSubmitTrigger("hello", "release")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("  hello  ", "release")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello world", "release")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello world!", "release")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("one two three", "release")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("", "release")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
		});
	});

	describe("release-complete trigger", () => {
		it("should submit only if utterance ends with terminal punctuation", () => {
			expect(evaluateSubmitTrigger("hello", "release-complete")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello world", "release-complete")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello.", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello?", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello!", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello...", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			// Full-width punctuation
			expect(evaluateSubmitTrigger("hello。", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello？", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello！", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello…", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("", "release-complete")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
		});
	});

	describe("say-submit trigger", () => {
		it("should submit and trim trailing word when last word contains submit", () => {
			// Single word
			expect(evaluateSubmitTrigger("submit", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 6,
			});
			expect(evaluateSubmitTrigger("SUBMIT", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 6,
			});
			expect(evaluateSubmitTrigger("submit!", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 7,
			});

			// Multi word
			expect(evaluateSubmitTrigger("please submit", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 7, // " submit" has length 7
			});
			expect(evaluateSubmitTrigger("please submit.", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 8, // " submit." has length 8
			});
			expect(evaluateSubmitTrigger("please submit?", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 8,
			});
			expect(evaluateSubmitTrigger("please submit  ", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 9, // " submit  " has length 9
			});

			// Word containing submit
			expect(evaluateSubmitTrigger("please autosubmit", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 11, // " autosubmit" has length 11
			});
			expect(evaluateSubmitTrigger("please submitting", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 11,
			});

			// Negative cases
			expect(evaluateSubmitTrigger("submit please", "say-submit")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello", "say-submit")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("", "say-submit")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
		});
	});
});

describe("STTController submit trigger integration", () => {
	let state: SettingsTestState | undefined;
	let controller: STTController | undefined;

	function makeEditor() {
		return {
			insertText: vi.fn(),
			setVolatileText: vi.fn(),
			clearVolatileText: vi.fn(),
			commitVolatileText: vi.fn(),
			submit: vi.fn(),
			deleteBeforeCursor: vi.fn(),
		};
	}

	function makeOptions() {
		return {
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			onStateChange: vi.fn(),
		};
	}

	async function transcribeStream(transcript: string, trigger: SttSubmitTrigger) {
		settings.set("stt.submitTrigger", trigger);
		vi.spyOn(asrClient.sttClient, "startStream").mockReturnValue({
			pushAudio: vi.fn(),
			stop: vi.fn().mockResolvedValue(transcript),
			cancel: vi.fn(),
		});
		const editor = makeEditor();
		const options = {
			...makeOptions(),
			submitEditor: vi.fn((ed: Editor) => ed.submit()),
		};
		controller = new STTController(() => ({ stop: vi.fn() }), { settings, registry });

		await controller.toggle(() => editor, editor, options);
		expect(controller.state).toBe("recording");
		await controller.toggle(() => editor, editor, options);
		expect(controller.state).toBe("idle");

		return { editor, options };
	}

	beforeEach(async () => {
		state = beginSettingsTest();
		await Settings.init({ inMemory: true });
		settings.setModelRole("dictation", "local/whisper-base");
		settings.set("stt.submitTrigger", "never");
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(downloader, "downloadSttModel").mockResolvedValue(undefined);
	});

	afterEach(() => {
		controller?.dispose();
		controller = undefined;
		vi.restoreAllMocks();
		restoreSettingsTestState(state);
	});

	it("submits streaming dictation on release when the transcript has at least two words", async () => {
		const { editor } = await transcribeStream("hello world", "release");

		expect(editor.commitVolatileText).toHaveBeenCalledWith("hello world");
		expect(editor.submit).toHaveBeenCalledTimes(1);
	});

	it("does not submit one-word streaming dictation on release", async () => {
		const { editor } = await transcribeStream("hello", "release");

		expect(editor.commitVolatileText).toHaveBeenCalledWith("hello");
		expect(editor.submit).not.toHaveBeenCalled();
	});

	it("strips the spoken submit command before submitting streaming dictation", async () => {
		const { editor } = await transcribeStream("please review this submit.", "say-submit");

		expect(editor.commitVolatileText).toHaveBeenCalledWith("please review this submit.");
		expect(editor.deleteBeforeCursor).toHaveBeenCalledWith(8);
		expect(editor.submit).toHaveBeenCalledTimes(1);
	});

	it("submits the existing draft when streaming dictation only says submit", async () => {
		const { editor } = await transcribeStream("submit", "say-submit");

		expect(editor.commitVolatileText).toHaveBeenCalledWith("submit");
		expect(editor.deleteBeforeCursor).toHaveBeenCalledWith(6);
		expect(editor.submit).toHaveBeenCalledTimes(1);
	});

	it("routes submit through options.submitEditor when provided", async () => {
		settings.set("stt.submitTrigger", "release");
		vi.spyOn(asrClient.sttClient, "startStream").mockReturnValue({
			pushAudio: vi.fn(),
			stop: vi.fn().mockResolvedValue("submit this please"),
			cancel: vi.fn(),
		});
		const editor = makeEditor();
		const customSubmit = vi.fn();
		const options = {
			...makeOptions(),
			submitEditor: customSubmit,
		};
		controller = new STTController(() => ({ stop: vi.fn() }), { settings, registry });

		await controller.toggle(() => editor, editor, options);
		await controller.toggle(() => editor, editor, options);

		expect(customSubmit).toHaveBeenCalledWith(editor);
		expect(editor.submit).not.toHaveBeenCalled();
	});

	it("updates volatile preview on the newly focused editor and clears the previous editor", async () => {
		let onPartialCallback: ((text: string) => void) | undefined;
		vi.spyOn(asrClient.sttClient, "startStream").mockImplementation((_model, streamOpts) => {
			onPartialCallback = streamOpts?.onPartial;
			return {
				pushAudio: vi.fn(),
				stop: vi.fn().mockResolvedValue("final transcript text"),
				cancel: vi.fn(),
			};
		});
		const editorA = makeEditor();
		const editorB = makeEditor();
		const fallbackComposer = makeEditor();
		let currentFocus: Editor | null = editorA;
		let focusListener: (() => void) | undefined;

		const options = {
			...makeOptions(),
			subscribeFocus: (listener: () => void) => {
				focusListener = listener;
				return () => {
					focusListener = undefined;
				};
			},
		};
		controller = new STTController(() => ({ stop: vi.fn() }), { settings, registry });

		await controller.toggle(() => currentFocus, fallbackComposer, options);
		expect(controller.state).toBe("recording");

		// Partial arrives while editorA is focused.
		onPartialCallback?.("hello");
		expect(editorA.setVolatileText).toHaveBeenCalledWith("hello");

		// Focus shifts to editorB.
		currentFocus = editorB;
		focusListener?.();
		expect(editorA.clearVolatileText).toHaveBeenCalledTimes(1);
		expect(editorB.setVolatileText).toHaveBeenCalledWith("hello");

		// Next partial arrives while editorB is focused.
		onPartialCallback?.("hello world");
		expect(editorB.setVolatileText).toHaveBeenCalledWith("hello world");

		// Final stop commits to currently focused editorB.
		await controller.toggle(() => currentFocus, fallbackComposer, options);
		expect(controller.state).toBe("idle");
		expect(editorB.commitVolatileText).toHaveBeenCalledWith("final transcript text");
		expect(editorA.commitVolatileText).not.toHaveBeenCalled();
	});

	it("displays accumulated segments plus in-progress partial on focus change and preserves full transcript on stop", async () => {
		let onPartialCallback: ((text: string) => void) | undefined;
		let onSegmentCallback: ((text: string, index: number) => void) | undefined;
		vi.spyOn(asrClient.sttClient, "startStream").mockImplementation((_model, streamOpts) => {
			onPartialCallback = streamOpts?.onPartial;
			onSegmentCallback = streamOpts?.onSegment;
			return {
				pushAudio: vi.fn(),
				stop: vi.fn().mockResolvedValue("first segment second segment partial transcript"),
				cancel: vi.fn(),
			};
		});
		const editorA = makeEditor();
		const editorB = makeEditor();
		const fallbackComposer = makeEditor();
		let currentFocus: Editor | null = editorA;
		let focusListener: (() => void) | undefined;

		const options = {
			...makeOptions(),
			subscribeFocus: (listener: () => void) => {
				focusListener = listener;
				return () => {
					focusListener = undefined;
				};
			},
		};
		controller = new STTController(() => ({ stop: vi.fn() }), { settings, registry });

		await controller.toggle(() => currentFocus, fallbackComposer, options);
		expect(controller.state).toBe("recording");

		// First segment commits while editorA is focused.
		onSegmentCallback?.("first segment", 0);
		expect(editorA.setVolatileText).toHaveBeenCalledWith("first segment");

		// Second segment commits while editorA is focused.
		onSegmentCallback?.("second segment", 1);
		expect(editorA.setVolatileText).toHaveBeenCalledWith("first segment second segment");

		// In-progress partial arrives.
		onPartialCallback?.("partial transcript");
		expect(editorA.setVolatileText).toHaveBeenCalledWith("first segment second segment partial transcript");

		// Focus shifts to editorB: previous editor cleared, new editor gets full volatile preview.
		currentFocus = editorB;
		focusListener?.();
		expect(editorA.clearVolatileText).toHaveBeenCalledTimes(1);
		expect(editorB.setVolatileText).toHaveBeenCalledWith("first segment second segment partial transcript");

		// Focus shifts away to null (orphan focus state): editorB cleared.
		currentFocus = null;
		focusListener?.();
		expect(editorB.clearVolatileText).toHaveBeenCalledTimes(1);

		// Focus shifts back to editorB.
		currentFocus = editorB;
		focusListener?.();
		expect(editorB.setVolatileText).toHaveBeenCalledWith("first segment second segment partial transcript");

		// Final stop commits full transcript to focused editorB without persisting segments before stop.
		await controller.toggle(() => currentFocus, fallbackComposer, options);
		expect(controller.state).toBe("idle");
		expect(editorB.commitVolatileText).toHaveBeenCalledWith("first segment second segment partial transcript");
		expect(editorA.commitVolatileText).not.toHaveBeenCalled();
	});
	it("unsubscribes from focus listener on stop", async () => {
		vi.spyOn(asrClient.sttClient, "startStream").mockReturnValue({
			pushAudio: vi.fn(),
			stop: vi.fn().mockResolvedValue(""),
			cancel: vi.fn(),
		});
		const unsubscribe = vi.fn();
		const editor = makeEditor();
		const options = {
			...makeOptions(),
			subscribeFocus: vi.fn(() => unsubscribe),
		};
		controller = new STTController(() => ({ stop: vi.fn() }), { settings, registry });

		await controller.toggle(() => editor, editor, options);
		expect(options.subscribeFocus).toHaveBeenCalledTimes(1);
		expect(unsubscribe).not.toHaveBeenCalled();

		await controller.toggle(() => editor, editor, options);
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it("updates preview and commit target when editor resolver changes asynchronously without focus events", async () => {
		settings.set("stt.submitTrigger", "never");

		let streamOptions: asrClient.SttStreamOptions | undefined;
		vi.spyOn(asrClient.sttClient, "startStream").mockImplementation((_modelKey, options) => {
			streamOptions = options;
			return {
				pushAudio: vi.fn(),
				stop: vi.fn().mockImplementation(async () => {
					streamOptions?.onSegment?.("final confirmed draft", 0);
					return "final confirmed draft";
				}),
				cancel: vi.fn(),
			};
		});

		const editorA = makeEditor();
		const editorB = makeEditor();
		const fallbackComposer = makeEditor();
		let currentFocus: Editor | null = editorA;
		const options = makeOptions();

		controller = new STTController(() => ({ stop: vi.fn() }), { settings, registry });

		await controller.toggle(() => currentFocus, fallbackComposer, options);
		expect(controller.state).toBe("recording");

		streamOptions?.onPartial?.("initial draft");
		expect(editorA.setVolatileText).toHaveBeenCalledWith("initial draft");
		expect(editorB.setVolatileText).not.toHaveBeenCalled();

		// Switch resolver to null without invoking any focus listener (simulates async overlay state)
		currentFocus = null;
		streamOptions?.onPartial?.("intermediate draft");
		expect(editorA.clearVolatileText).toHaveBeenCalled();
		expect(editorB.setVolatileText).not.toHaveBeenCalled();

		// Switch resolver to Editor B without invoking any focus listener
		currentFocus = editorB;
		streamOptions?.onPartial?.("resumed draft in editor b");
		expect(editorB.setVolatileText).toHaveBeenCalledWith("resumed draft in editor b");
		expect(editorA.setVolatileText).not.toHaveBeenCalledWith("resumed draft in editor b");

		// Final stop commits only in Editor B
		await controller.toggle(() => currentFocus, fallbackComposer, options);
		expect(controller.state).toBe("idle");
		expect(editorB.commitVolatileText).toHaveBeenCalledWith("final confirmed draft");
		expect(editorA.commitVolatileText).not.toHaveBeenCalled();
	});
});
