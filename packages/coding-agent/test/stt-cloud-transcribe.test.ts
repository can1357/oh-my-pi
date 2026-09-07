import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	DEFAULT_CLOUD_STT_MODEL,
	encodeWav16k,
	resolveCloudSttModel,
	startCloudSttStream,
} from "@oh-my-pi/pi-coding-agent/stt/cloud-transcribe-client";
import { resolveSttCloudKey, STTController, type SttState } from "@oh-my-pi/pi-coding-agent/stt/stt-controller";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

function sine16kHz(length = 1600): Float32Array {
	const out = new Float32Array(length);
	for (let i = 0; i < length; i++) out[i] = Math.sin((2 * Math.PI * i) / 100);
	return out;
}

interface StubFetch {
	calls: Array<{ url: string; init: RequestInit }>;
	impl: typeof fetch;
	text: string;
	status: number;
}

function stubFetch(text = "hello world", status = 200): StubFetch {
	const stub: StubFetch = {
		calls: [],
		text,
		status,
		impl: (async (url: string, init: RequestInit) => {
			stub.calls.push({ url, init });
			const body = JSON.stringify({ text: stub.text });
			return new Response(body, { status: stub.status, headers: { "Content-Type": "application/json" } });
		}) as typeof fetch,
	};
	return stub;
}

describe("cloud STT stream", () => {
	it("posts buffered audio as wav and resolves the trimmed transcript", async () => {
		const stub = stubFetch("  hello world  ");
		const handle = startCloudSttStream({
			apiKey: "sk-test",
			language: "en",
			keywords: ["AC-42"],
			fetchImpl: stub.impl,
		});
		handle.pushAudio(sine16kHz(800));
		handle.pushAudio(sine16kHz(800));
		const stopped = handle.stop();
		await expect(stopped).resolves.toBe("hello world");
		expect(stub.calls).toHaveLength(1);
		const [url, init] = [stub.calls[0]!.url, stub.calls[0]!.init];
		expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");
		const form = init.body as FormData;
		expect(form.get("model")).toBe(DEFAULT_CLOUD_STT_MODEL);
		expect(form.get("language")).toBe("en");
		expect(form.get("prompt")).toBe("AC-42");
		expect(form.get("response_format")).toBe("json");
		const file = form.get("file") as File;
		expect(file.name).toBe("dictation.wav");
		expect(file.size).toBe(44 + 1600 * 2);
	});

	it("sends the selected cloud model and falls back for local tier keys", async () => {
		expect(resolveCloudSttModel("gpt-4o-mini-transcribe")).toBe("gpt-4o-mini-transcribe");
		expect(resolveCloudSttModel("gpt-transcribe")).toBe("gpt-transcribe");
		expect(resolveCloudSttModel("whisper-1")).toBe("whisper-1");
		expect(resolveCloudSttModel("parakeet")).toBe(DEFAULT_CLOUD_STT_MODEL);
		expect(resolveCloudSttModel(undefined)).toBe(DEFAULT_CLOUD_STT_MODEL);
		const stub = stubFetch("ok");
		const handle = startCloudSttStream({ apiKey: "sk-test", model: "whisper-1", fetchImpl: stub.impl });
		handle.pushAudio(sine16kHz(160));
		await expect(handle.stop()).resolves.toBe("ok");
		expect((stub.calls[0]!.init.body as FormData).get("model")).toBe("whisper-1");
	});
	it("resolves empty text without a request when nothing was recorded", async () => {
		const stub = stubFetch();
		const handle = startCloudSttStream({ apiKey: "sk-test", fetchImpl: stub.impl });
		await expect(handle.stop()).resolves.toBe("");
		expect(stub.calls).toHaveLength(0);
	});
	it("cancel() discards the late transcript and resolves empty text", async () => {
		const stub = stubFetch();
		const handle = startCloudSttStream({ apiKey: "sk-test", fetchImpl: stub.impl });
		handle.pushAudio(sine16kHz());
		const stopped = handle.stop();
		handle.cancel();
		await expect(stopped).resolves.toBe("");
	});

	it("rejects stop() on an HTTP error", async () => {
		const stub = stubFetch("nope", 401);
		const handle = startCloudSttStream({ apiKey: "sk-test", fetchImpl: stub.impl });
		handle.pushAudio(sine16kHz());
		await expect(handle.stop()).rejects.toThrow("401");
	});
});

describe("encodeWav16k", () => {
	it("writes a valid 16 kHz mono PCM16 header with zeroed silence", () => {
		const buffer = encodeWav16k(new Float32Array(160));
		const view = new DataView(buffer);
		const ascii = (offset: number, length: number): string =>
			String.fromCharCode(...new Uint8Array(buffer, offset, length));
		expect(ascii(0, 4)).toBe("RIFF");
		expect(ascii(8, 4)).toBe("WAVE");
		expect(view.getUint32(24, true)).toBe(16000);
		expect(view.getUint16(22, true)).toBe(1);
		expect(view.getUint32(40, true)).toBe(320);
		expect(new Int16Array(buffer, 44).every(v => v === 0)).toBe(true);
	});
});

describe("cloud backend in STTController", () => {
	let state: SettingsTestState | undefined;

	beforeEach(async () => {
		state = beginSettingsTest();
		await Settings.init({ inMemory: true });
		settings.set("stt.backend", "cloud");
		settings.set("stt.modelName", "gpt-4o-mini-transcribe");
	});

	afterEach(() => {
		restoreSettingsTestState(state);
	});

	it("dictates through the cloud backend and commits the transcript on release", async () => {
		const stub = stubFetch("hello world");
		let onAudio!: (error: Error | null, samples: Float32Array) => void;
		const editor = {
			volatile: "",
			committed: "",
			insertText(_text: string): void {},
			setVolatileText(text: string): void {
				editor.volatile = text;
			},
			clearVolatileText(): void {
				editor.volatile = "";
			},
			commitVolatileText(text: string): void {
				editor.committed += text;
			},
			submit(): void {},
			deleteBeforeCursor(_count: number): void {},
		};
		const warnings: string[] = [];
		const options = {
			showWarning: (msg: string): void => {
				warnings.push(msg);
			},
			showStatus(_msg: string): void {},
			onStateChange(_state: SttState): void {},
		};
		const controller = new STTController(
			callback => {
				onAudio = callback;
				return { stop(): void {} };
			},
			{
				resolveCloudKey: () => Promise.resolve("sk-test"),
				createCloudFetch: stub.impl,
			},
		);
		try {
			await controller.toggle(editor, options);
			expect(controller.state).toBe("recording");
			onAudio(null, sine16kHz());
			await controller.toggle(editor, options);
			expect(controller.state).toBe("idle");
			expect(editor.committed).toContain("hello world");
			expect(stub.calls).toHaveLength(1);
			expect((stub.calls[0]!.init.body as FormData).get("model")).toBe("gpt-4o-mini-transcribe");
		} finally {
			controller.dispose();
		}
	});
});

describe("resolveSttCloudKey", () => {
	function registry(codex: string | undefined, openai: string | undefined) {
		return {
			async getApiKeyForProvider(provider: string): Promise<string | undefined> {
				return provider === "openai-codex" ? codex : openai;
			},
		};
	}

	it("prefers the ChatGPT subscription over the API key", async () => {
		await expect(resolveSttCloudKey(registry("sub-token", "sk-key"), "s1")).resolves.toBe("sub-token");
	});

	it("falls back to the API key without a subscription", async () => {
		await expect(resolveSttCloudKey(registry(undefined, "sk-key"), "s1")).resolves.toBe("sk-key");
	});

	it("resolves nothing without any credential", async () => {
		await expect(resolveSttCloudKey(registry(undefined, undefined), "s1")).resolves.toBeUndefined();
	});
});
