import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as transcription from "@oh-my-pi/pi-ai/transcription";
import type { TranscriptionResult } from "@oh-my-pi/pi-ai/transcription";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as asrClient from "@oh-my-pi/pi-coding-agent/stt/asr-client";
import * as downloader from "@oh-my-pi/pi-coding-agent/stt/downloader";
import { STTController } from "@oh-my-pi/pi-coding-agent/stt/stt-controller";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

function registryFor(model: Model) {
	return {
		getError: () => undefined,
		getAvailable: () => [model],
		getAll: () => [model],
		resolver: vi.fn(() => vi.fn().mockResolvedValue("cloud-key")),
	};
}

describe("STTController cloud transcription", () => {
	let state: SettingsTestState | undefined;
	let controller: STTController | undefined;

	beforeEach(async () => {
		state = beginSettingsTest();
		await Settings.init({ inMemory: true });
		settings.set("stt.submitTrigger", "never");
	});

	afterEach(() => {
		controller?.dispose();
		controller = undefined;
		restoreSettingsTestState(state);
	});

	it("buffers microphone PCM into a valid mono 16-bit WAV and commits the cloud transcript", async () => {
		const model = getBundledModel("openai", "whisper-1");
		settings.setModelRole("dictation", "openai/whisper-1");
		settings.set("stt.language", "en");
		const registry = registryFor(model);
		const transcribe = vi.spyOn(transcription, "transcribeAudio").mockResolvedValue({
			text: "cloud transcript",
			usage: ZERO_USAGE,
		});
		let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;
		const stopCapture = vi.fn();
		controller = new STTController(
			callback => {
				onAudio = callback;
				return { stop: stopCapture };
			},
			{ settings, registry, getSessionId: () => "session-1" },
		);
		const editor = makeEditor();
		const options = makeOptions();

		await controller.toggle(editor, options);
		onAudio?.(null, new Float32Array([-1, -0.5, 0, 0.5, 1]));
		await controller.toggle(editor, options);

		expect(stopCapture).toHaveBeenCalledTimes(1);
		expect(transcribe).toHaveBeenCalledTimes(1);
		const [calledModel, request, callOptions] = transcribe.mock.calls[0]!;
		expect(calledModel).toBe(model);
		expect(request).toMatchObject({
			mimeType: "audio/wav",
			fileName: "dictation.wav",
			responseFormat: "json",
			language: "en",
		});
		expect(registry.resolver).toHaveBeenCalledWith(model, "session-1");
		expect(callOptions.signal).toBeInstanceOf(AbortSignal);

		const wav = request.audio;
		const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
		expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
		expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
		expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
		expect(new TextDecoder().decode(wav.subarray(12, 16))).toBe("fmt ");
		expect(view.getUint32(16, true)).toBe(16);
		expect(view.getUint16(20, true)).toBe(1);
		expect(view.getUint16(22, true)).toBe(1);
		expect(view.getUint32(24, true)).toBe(16_000);
		expect(view.getUint32(28, true)).toBe(32_000);
		expect(view.getUint16(32, true)).toBe(2);
		expect(view.getUint16(34, true)).toBe(16);
		expect(new TextDecoder().decode(wav.subarray(36, 40))).toBe("data");
		expect(view.getUint32(40, true)).toBe(10);
		expect(Array.from({ length: 5 }, (_, index) => view.getInt16(44 + index * 2, true))).toEqual([
			-32_768, -16_384, 0, 16_383, 32_767,
		]);
		expect(editor.commitVolatileText).toHaveBeenCalledWith("cloud transcript");
		expect(options.onStateChange.mock.calls.map(([next]) => next)).toEqual(["recording", "transcribing", "idle"]);
		expect(options.showStatus).toHaveBeenCalledWith("Transcribing...");
	});

	it("aborts an in-flight cloud request when the controller is disposed", async () => {
		const model = getBundledModel("openai", "whisper-1");
		settings.setModelRole("dictation", "openai/whisper-1");
		const registry = registryFor(model);
		let requestSignal: AbortSignal | undefined;
		const pending = Promise.withResolvers<TranscriptionResult>();
		vi.spyOn(transcription, "transcribeAudio").mockImplementation((_model, _request, options) => {
			requestSignal = options.signal;
			options.signal?.addEventListener(
				"abort",
				() => pending.reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError")),
				{ once: true },
			);
			return pending.promise;
		});
		let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;
		controller = new STTController(
			callback => {
				onAudio = callback;
				return { stop: vi.fn() };
			},
			{ settings, registry, getSessionId: () => "session-2" },
		);

		await controller.toggle(makeEditor(), makeOptions());
		onAudio?.(null, new Float32Array([0.25]));
		const stopping = controller.toggle(makeEditor(), makeOptions());
		expect(requestSignal?.aborted).toBe(false);
		controller.dispose();
		expect(requestSignal?.aborted).toBe(true);
		await stopping;
	});

	it("keeps local-inference models on the streaming worker path", async () => {
		const model = getBundledModel("local", "whisper-base");
		settings.setModelRole("dictation", "local/whisper-base");
		const registry = registryFor(model);
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(downloader, "downloadSttModel").mockResolvedValue(undefined);
		const pushAudio = vi.fn();
		const stop = vi.fn().mockResolvedValue("local transcript");
		const startStream = vi.spyOn(asrClient.sttClient, "startStream").mockReturnValue({
			pushAudio,
			stop,
			cancel: vi.fn(),
		});
		const cloudTranscribe = vi.spyOn(transcription, "transcribeAudio");
		let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;
		controller = new STTController(
			callback => {
				onAudio = callback;
				return { stop: vi.fn() };
			},
			{ settings, registry },
		);
		const editor = makeEditor();
		const options = makeOptions();
		const samples = new Float32Array([0.1, -0.1]);

		await controller.toggle(editor, options);
		onAudio?.(null, samples);
		await controller.toggle(editor, options);

		expect(startStream).toHaveBeenCalledWith("whisper-base", expect.anything());
		expect(pushAudio).toHaveBeenCalledWith(samples);
		expect(stop).toHaveBeenCalledTimes(1);
		expect(cloudTranscribe).not.toHaveBeenCalled();
		expect(editor.commitVolatileText).toHaveBeenCalledWith("local transcript");
	});
});
