import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as asrClient from "@oh-my-pi/pi-coding-agent/stt/asr-client";
import * as downloader from "@oh-my-pi/pi-coding-agent/stt/downloader";
import { STTController, type STTControllerDependencies } from "@oh-my-pi/pi-coding-agent/stt/stt-controller";
import { getTinyModelsCacheDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const WHISPER_BASE_REPO = "onnx-community/whisper-base";
const NEMOTRON_REPO = "csukuangfj2/sherpa-onnx-nemotron-speech-streaming-en-0.6b-160ms-int8-2026-04-25";
const DICTATION_MODELS = [
	getBundledModel("local", "whisper-base"),
	getBundledModel("local", "whisper-small"),
	getBundledModel("local", "whisper-large-v3-turbo"),
	getBundledModel("local", "parakeet-tdt-0.6b-v3"),
	getBundledModel("local", "nemotron-streaming-en-0.6b"),
];
const registry: STTControllerDependencies["registry"] = {
	getError: () => undefined,
	getAvailable: () => DICTATION_MODELS,
	getAll: () => DICTATION_MODELS,
	resolver: () => () => "test-key",
};

async function touch(file: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, "x");
}

describe("isSttModelCached completeness", () => {
	let state: SettingsTestState | undefined;
	let tmp = "";
	let cacheDir = "";

	beforeEach(async () => {
		state = beginSettingsTest();
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stt-cache-"));
		setAgentDir(tmp);
		cacheDir = getTinyModelsCacheDir();
	});

	afterEach(async () => {
		restoreSettingsTestState(state);
		await removeWithRetries(tmp);
	});

	it("treats a transformers model as cached only when both encoder and decoder onnx are present", async () => {
		const repoDir = path.join(cacheDir, WHISPER_BASE_REPO);
		await touch(path.join(repoDir, "config.json"));
		await touch(path.join(repoDir, "onnx", "encoder_model.onnx"));
		// Only the encoder shard landed — an interrupted Whisper download.
		expect(await downloader.isSttModelCached("whisper-base")).toBe(false);

		await touch(path.join(repoDir, "onnx", "decoder_model_merged.onnx"));
		expect(await downloader.isSttModelCached("whisper-base")).toBe(true);
	});

	it("requires complete online model weights rather than interrupted downloads", async () => {
		const key = "nemotron-streaming-en-0.6b";
		const repoDir = path.join(cacheDir, NEMOTRON_REPO);
		const files = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"];
		for (const file of files) {
			await touch(path.join(repoDir, file));
		}
		expect(await downloader.isSttModelCached(key)).toBe(true);

		for (const file of files) {
			const filePath = path.join(repoDir, file);
			await fs.rename(filePath, `${filePath}.part`);
			expect(await downloader.isSttModelCached(key)).toBe(false);
			await fs.rename(`${filePath}.part`, filePath);
		}
	});
});

describe("STTController preflight", () => {
	let state: SettingsTestState | undefined;
	let controller: STTController | undefined;

	function makeEditor() {
		return {
			insertText: vi.fn(),
			setVolatileText: vi.fn(),
			clearVolatileText: vi.fn(),
			commitVolatileText: vi.fn(),
			getText: vi.fn().mockReturnValue(""),
			setText: vi.fn(),
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

	beforeEach(async () => {
		state = beginSettingsTest();
		await Settings.init({ inMemory: true });
		settings.setModelRole("dictation", "local/whisper-base");
		vi.spyOn(asrClient.sttClient, "startStream").mockReturnValue({
			pushAudio: vi.fn(),
			stop: vi.fn().mockResolvedValue(""),
			cancel: vi.fn(),
		});
	});

	afterEach(() => {
		controller?.dispose();
		controller = undefined;
		restoreSettingsTestState(state);
		vi.restoreAllMocks();
	});

	it("cached model: starts recording without awaiting the model load, warming it in the background", async () => {
		const isCached = vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		// A warmup that never resolves would hang #ensureDeps if it were awaited;
		// reaching "recording" proves the fast path does not block on it.
		const download = vi.spyOn(downloader, "downloadSttModel").mockReturnValue(new Promise<void>(() => {}));

		const editor = makeEditor();
		controller = new STTController(() => ({ stop: vi.fn() }), { settings, registry });
		const options = makeOptions();
		await controller.toggle(editor, options);

		expect(controller.state).toBe("recording");
		expect(isCached).toHaveBeenCalledWith("whisper-base");
		expect(asrClient.sttClient.startStream).toHaveBeenCalledWith("whisper-base", expect.anything());
		expect(download).toHaveBeenCalledTimes(1);
		expect(options.showStatus).not.toHaveBeenCalled();
	});

	it("cached online model: opens the microphone only after the recognizer is ready", async () => {
		settings.setModelRole("dictation", "local/nemotron-streaming-en-0.6b");
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		const called = Promise.withResolvers<void>();
		const ready = Promise.withResolvers<void>();
		vi.spyOn(downloader, "downloadSttModel").mockImplementation(() => {
			called.resolve();
			return ready.promise;
		});
		const startCapture = vi.fn(() => ({ stop: vi.fn() }));
		controller = new STTController(startCapture, { settings, registry });

		const toggling = controller.toggle(makeEditor(), makeOptions());
		await called.promise;
		expect(startCapture).not.toHaveBeenCalled();
		expect(asrClient.sttClient.startStream).not.toHaveBeenCalled();

		ready.resolve();
		await toggling;
		expect(startCapture).toHaveBeenCalledTimes(1);
		expect(asrClient.sttClient.startStream).toHaveBeenCalledWith("nemotron-streaming-en-0.6b", expect.anything());
		expect(controller.state).toBe("recording");
	});

	it("does not open the microphone when disposed during online recognizer warmup", async () => {
		settings.setModelRole("dictation", "local/nemotron-streaming-en-0.6b");
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		const called = Promise.withResolvers<void>();
		const ready = Promise.withResolvers<void>();
		vi.spyOn(downloader, "downloadSttModel").mockImplementation(() => {
			called.resolve();
			return ready.promise;
		});
		const startCapture = vi.fn(() => ({ stop: vi.fn() }));
		controller = new STTController(startCapture, { settings, registry });

		const toggling = controller.toggle(makeEditor(), makeOptions());
		await called.promise;
		controller.dispose();
		ready.resolve();
		await toggling;

		expect(startCapture).not.toHaveBeenCalled();
		expect(asrClient.sttClient.startStream).not.toHaveBeenCalled();
		expect(controller.state).toBe("idle");
	});

	it("cancels a start still waiting for its model without a warning, then preflights again", async () => {
		settings.setModelRole("dictation", "local/nemotron-streaming-en-0.6b");
		const called = Promise.withResolvers<void>();
		// Like the worker host: an aborted wait ends as a failed download while the worker keeps loading.
		const download = vi.spyOn(downloader, "downloadSttModel").mockImplementation((_key, _progress, options) => {
			called.resolve();
			const { promise, reject } = Promise.withResolvers<void>();
			options?.signal?.addEventListener("abort", () => reject(new Error("Failed to download speech model")));
			return promise;
		});
		const startCapture = vi.fn(() => ({ stop: vi.fn() }));
		const options = makeOptions();
		controller = new STTController(startCapture, { settings, registry });

		const starting = controller.start(makeEditor(), options);
		await called.promise;
		await controller.stop();
		await starting;

		expect(controller.state).toBe("idle");
		expect(startCapture).not.toHaveBeenCalled();
		expect(asrClient.sttClient.startStream).not.toHaveBeenCalled();
		expect(options.showWarning).not.toHaveBeenCalled();

		download.mockResolvedValue();
		await controller.start(makeEditor(), options);
		expect(download).toHaveBeenCalledTimes(2);
		expect(controller.state).toBe("recording");
	});

	it("uncached model: records only after the foreground download finishes", async () => {
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(false);
		const called = Promise.withResolvers<void>();
		const download = Promise.withResolvers<void>();
		vi.spyOn(downloader, "downloadSttModel").mockImplementation(() => {
			called.resolve();
			return download.promise;
		});

		const editor = makeEditor();
		controller = new STTController(() => ({ stop: vi.fn() }), { settings, registry });
		const toggling = controller.toggle(editor, makeOptions());
		await called.promise;
		expect(controller.state).toBe("idle");
		expect(asrClient.sttClient.startStream).not.toHaveBeenCalled();

		download.resolve();
		await toggling;
		expect(controller.state).toBe("recording");
	});

	it("re-runs preflight when the model changes mid-session", async () => {
		const isCached = vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(downloader, "downloadSttModel").mockReturnValue(new Promise<void>(() => {}));

		const editor = makeEditor();
		controller = new STTController(() => ({ stop: vi.fn() }), { settings, registry });
		await controller.toggle(editor, makeOptions());
		expect(controller.state).toBe("recording");
		expect(isCached).toHaveBeenCalledTimes(1);
		expect(isCached).toHaveBeenLastCalledWith("whisper-base");

		// Switch the role model, then stop and re-start the gesture.
		settings.setModelRole("dictation", "local/whisper-large-v3-turbo");
		await controller.toggle(editor, makeOptions()); // recording -> idle
		expect(controller.state).toBe("idle");
		await controller.toggle(editor, makeOptions()); // idle -> recording

		expect(controller.state).toBe("recording");
		// Preflight ran exactly once for the new model rather than short-circuiting.
		expect(isCached).toHaveBeenCalledTimes(2);
		expect(isCached).toHaveBeenLastCalledWith("whisper-large-v3-turbo");
		expect(asrClient.sttClient.startStream).toHaveBeenLastCalledWith("whisper-large-v3-turbo", expect.anything());

		await controller.toggle(editor, makeOptions()); // recording -> idle
		await controller.toggle(editor, makeOptions()); // same model -> recording
		expect(isCached).toHaveBeenCalledTimes(2);
	});

	it("falls back to the full parakeet id when the dictation chain is empty", async () => {
		settings.setModelRole("dictation", "missing/model");
		const emptyRegistry: STTControllerDependencies["registry"] = {
			getError: () => undefined,
			getAvailable: () => [],
			getAll: () => [],
			resolver: () => () => "test-key",
		};
		const isCached = vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(downloader, "downloadSttModel").mockReturnValue(new Promise<void>(() => {}));
		controller = new STTController(() => ({ stop: vi.fn() }), { settings, registry: emptyRegistry });

		await controller.toggle(makeEditor(), makeOptions());

		expect(isCached).toHaveBeenCalledWith("parakeet-tdt-0.6b-v3");
		expect(asrClient.sttClient.startStream).toHaveBeenCalledWith("parakeet-tdt-0.6b-v3", expect.anything());
	});

	it("stops recording and surfaces asynchronous microphone failures", async () => {
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(downloader, "downloadSttModel").mockReturnValue(new Promise<void>(() => {}));
		let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;
		const stopCapture = vi.fn();
		const editor = makeEditor();
		const options = makeOptions();
		controller = new STTController(
			callback => {
				onAudio = callback;
				return { stop: stopCapture };
			},
			{ settings, registry },
		);
		await controller.toggle(editor, options);

		onAudio?.(new Error("Microphone permission denied"), new Float32Array());

		expect(controller.state).toBe("idle");
		expect(stopCapture).toHaveBeenCalledTimes(1);
		expect(editor.clearVolatileText).toHaveBeenCalledTimes(1);
		expect(options.showWarning).toHaveBeenCalledWith("Microphone permission denied");
	});
});
