import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings, settings } from "../src/config/settings";
import * as asrClient from "../src/stt/asr-client";
import * as downloader from "../src/stt/downloader";
import { STTController } from "../src/stt/stt-controller";
import { evaluateSubmitTrigger, type SttSubmitTrigger } from "../src/stt/submit-trigger";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

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
			requestRender: vi.fn(),
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
		const options = makeOptions();
		controller = new STTController(() => ({ stop: vi.fn() }));

		await controller.toggle(editor, options);
		expect(controller.state).toBe("recording");
		await controller.toggle(editor, options);
		expect(controller.state).toBe("idle");

		return { editor, options };
	}

	beforeEach(async () => {
		state = beginSettingsTest();
		await Settings.init({ inMemory: true });
		settings.set("stt.modelName", "fast");
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
});
