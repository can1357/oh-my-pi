import { type ApiKeyResolver, type OAuthAccess, type OAuthAccessSource, seedApiKeyResolver } from "@oh-my-pi/pi-ai";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { kNoAuth } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { createLiveConfigHeaders } from "@oh-my-pi/pi-coding-agent/config/model-config-values";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { DEFAULT_CLOUD_STT_MODEL, resolveCloudSttModel } from "@oh-my-pi/pi-coding-agent/stt/cloud-models";
import { sttClient } from "@oh-my-pi/pi-coding-agent/stt/asr-client";
import * as downloader from "@oh-my-pi/pi-coding-agent/stt/downloader";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";
import { __resetExtraCaCache } from "@oh-my-pi/pi-utils";
import type { CloudSttCredential } from "@oh-my-pi/pi-coding-agent/stt/cloud-transcribe-client";
import {
	AUDIO_LIMIT_MESSAGE,
	MAX_AUDIO_SAMPLES,
	startCloudSttStream,
} from "@oh-my-pi/pi-coding-agent/stt/cloud-transcribe-client";
import { concatenatePcm, encodeWav } from "@oh-my-pi/pi-coding-agent/tts/wav";
import { resolveSttCloudCredential, STTController, type SttState } from "@oh-my-pi/pi-coding-agent/stt/stt-controller";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";
import { getEventListeners } from "node:events";

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

interface OAuthSourceStub {
	resolves: Array<{ forceRefresh: boolean | undefined }>;
	rotations: number;
	source: OAuthAccessSource;
}

/** Fake {@link OAuthAccessSource}: `tokens` are handed out in order, last one sticks. */
function oauthSource(...tokens: string[]): OAuthSourceStub {
	const stub: OAuthSourceStub = {
		resolves: [],
		rotations: 0,
		source: {
			async getOAuthAccess(_provider, _sessionId, options) {
				stub.resolves.push({ forceRefresh: options?.forceRefresh });
				const token = tokens[Math.min(stub.resolves.length - 1, tokens.length - 1)];
				return token ? { accessToken: token, accountId: "account-1" } : undefined;
			},
			async rotateSessionCredential() {
				stub.rotations++;
				return false;
			},
		},
	};
	return stub;
}

describe("cloud STT stream", () => {
	it("posts buffered audio as wav and resolves the trimmed transcript", async () => {
		const stub = stubFetch("  hello world  ");
		const handle = startCloudSttStream({
			credential: { kind: "openai", apiKey: "sk-test" },
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

	it("allows larger accepted recordings proportionally longer to upload", async () => {
		const deadlines: number[] = [];
		const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
			deadlines.push(milliseconds);
			return new AbortController().signal;
		});
		try {
			for (const samples of [160, 16_000]) {
				const handle = startCloudSttStream({
					credential: { kind: "openai", apiKey: "sk-test" },
					fetchImpl: stubFetch("ok").impl,
				});
				handle.pushAudio(sine16kHz(samples));
				await handle.stop();
			}
		} finally {
			timeoutSpy.mockRestore();
		}
		expect(deadlines).toHaveLength(2);
		expect(deadlines[1]!).toBeGreaterThan(deadlines[0]!);
		expect(deadlines[0]!).toBeGreaterThan(60_000);
	});

	it("sends the selected cloud model and falls back for local tier keys", async () => {
		expect(resolveCloudSttModel("gpt-4o-mini-transcribe")).toBe("gpt-4o-mini-transcribe");
		expect(resolveCloudSttModel("gpt-transcribe")).toBe("gpt-transcribe");
		expect(resolveCloudSttModel("whisper-1")).toBe("whisper-1");
		expect(resolveCloudSttModel("parakeet")).toBe(DEFAULT_CLOUD_STT_MODEL);
		expect(resolveCloudSttModel(undefined)).toBe(DEFAULT_CLOUD_STT_MODEL);
		const stub = stubFetch("ok");
		const handle = startCloudSttStream({
			credential: { kind: "openai", apiKey: "sk-test" },
			model: "whisper-1",
			fetchImpl: stub.impl,
		});
		handle.pushAudio(sine16kHz(160));
		await expect(handle.stop()).resolves.toBe("ok");
		expect((stub.calls[0]!.init.body as FormData).get("model")).toBe("whisper-1");
	});

	it("routes credentials to their own endpoint and preserves provider headers", async () => {
		const apiStub = stubFetch("api");
		const api = startCloudSttStream({
			credential: {
				kind: "openai",
				apiKey: "proxy-key",
				baseUrl: "https://proxy.example/v1/",
				headers: { "X-Workspace": "workspace-1" },
			},
			fetchImpl: apiStub.impl,
		});
		api.pushAudio(sine16kHz(160));
		await expect(api.stop()).resolves.toBe("api");
		expect(apiStub.calls[0]!.url).toBe("https://proxy.example/v1/audio/transcriptions");
		expect(apiStub.calls[0]!.init.headers).toEqual({
			"X-Workspace": "workspace-1",
			Authorization: "Bearer proxy-key",
		});

		const codexStub = stubFetch("subscription");
		const codex = startCloudSttStream({
			credential: {
				kind: "codex",
				access: { accessToken: "subscription-token", accountId: "account-1" },
				source: oauthSource("subscription-token").source,
			},
			fetchImpl: codexStub.impl,
		});
		codex.pushAudio(sine16kHz(160));
		await expect(codex.stop()).resolves.toBe("subscription");
		expect(codexStub.calls[0]!.url).toBe("https://chatgpt.com/backend-api/codex/transcribe");
		expect(codexStub.calls[0]!.init.headers).toMatchObject({
			Authorization: "Bearer subscription-token",
			"chatgpt-account-id": "account-1",
			originator: "omp",
		});
		expect((codexStub.calls[0]!.init.body as FormData).has("model")).toBe(false);
	});

	it("drops request-owned override headers so fetch owns boundary and authorization", async () => {
		const stub = stubFetch("ok");
		const handle = startCloudSttStream({
			credential: {
				kind: "openai",
				apiKey: "sk-test",
				headers: {
					"Content-Type": "application/json",
					// Lowercase: a duplicate key would be joined into
					// "Custom stale, Bearer sk-test" by fetch.
					authorization: "Custom stale",
					"X-Workspace": "workspace-1",
				},
			},
			fetchImpl: stub.impl,
		});
		handle.pushAudio(sine16kHz(160));
		await expect(handle.stop()).resolves.toBe("ok");
		expect(stub.calls[0]!.init.headers).toEqual({
			"X-Workspace": "workspace-1",
			Authorization: "Bearer sk-test",
		});
	});

	it("re-resolves a rejected API key through the resolver and retries the upload", async () => {
		const contexts: Array<{ lastChance: boolean; hasError: boolean }> = [];
		const resolver: ApiKeyResolver = ctx => {
			contexts.push({ lastChance: ctx.lastChance, hasError: ctx.error !== undefined });
			return "sk-fresh";
		};
		const keys: string[] = [];
		const fetchImpl = (async (_url: string, init: RequestInit) => {
			const key = (init.headers as Record<string, string>)["Authorization"]!;
			keys.push(key);
			if (key === "Bearer sk-stale") return new Response("unauthorized", { status: 401 });
			return new Response(JSON.stringify({ text: "retried" }), { status: 200 });
		}) as typeof fetch;
		const handle = startCloudSttStream({
			credential: { kind: "openai", apiKey: seedApiKeyResolver("sk-stale", resolver) },
			fetchImpl,
		});
		handle.pushAudio(sine16kHz(160));
		await expect(handle.stop()).resolves.toBe("retried");
		expect(keys).toEqual(["Bearer sk-stale", "Bearer sk-fresh"]);
		// Seeded initial resolve, then step (b): force-refresh the same account.
		expect(contexts).toEqual([{ lastChance: false, hasError: true }]);
	});

	it("materializes live provider headers once per auth attempt", async () => {
		let generation = 0;
		const source = { "Content-Type": "application/json" };
		Object.defineProperty(source, "X-Session-Token", {
			configurable: true,
			enumerable: true,
			get: () => `session-${++generation}`,
		});
		const liveHeaders = createLiveConfigHeaders([source]);
		const seen: string[] = [];
		const fetchImpl = (async (_url: string, init: RequestInit) => {
			const headers = init.headers as Record<string, string>;
			seen.push(headers["X-Session-Token"]!);
			return headers["Authorization"] === "Bearer sk-stale"
				? new Response("unauthorized", { status: 401 })
				: new Response(JSON.stringify({ text: "ok" }), { status: 200 });
		}) as typeof fetch;
		const handle = startCloudSttStream({
			credential: {
				kind: "openai",
				apiKey: seedApiKeyResolver("sk-stale", () => "sk-fresh"),
				headers: liveHeaders,
			},
			fetchImpl,
		});
		handle.pushAudio(sine16kHz(160));
		await expect(handle.stop()).resolves.toBe("ok");
		expect(seen).toEqual(["session-1", "session-2"]);
		expect(generation).toBe(2);
	});

	it("applies NODE_EXTRA_CA_CERTS to the upload's TLS options", async () => {
		const pem = "-----BEGIN CERTIFICATE-----\nMIIBtest\n-----END CERTIFICATE-----";
		const previous = Bun.env.NODE_EXTRA_CA_CERTS;
		Bun.env.NODE_EXTRA_CA_CERTS = pem;
		__resetExtraCaCache();
		try {
			const stub = stubFetch("ok");
			const handle = startCloudSttStream({
				credential: { kind: "openai", apiKey: "sk-test" },
				fetchImpl: stub.impl,
			});
			handle.pushAudio(sine16kHz(160));
			await expect(handle.stop()).resolves.toBe("ok");
			const init = stub.calls[0]!.init;
			const ca =
				"tls" in init && typeof init.tls === "object" && init.tls !== null && "ca" in init.tls
					? init.tls.ca
					: undefined;
			expect(Array.isArray(ca)).toBe(true);
			// The extra bundle is appended to the system roots, not substituted for them.
			expect((ca as unknown[]).at(-1)).toBe(pem);
			expect((ca as unknown[]).length).toBeGreaterThan(1);
		} finally {
			if (previous === undefined) delete Bun.env.NODE_EXTRA_CA_CERTS;
			else Bun.env.NODE_EXTRA_CA_CERTS = previous;
			__resetExtraCaCache();
		}
	});

	it("stops after one attempt for a static key", async () => {
		const stub = stubFetch("nope", 401);
		const handle = startCloudSttStream({ credential: { kind: "openai", apiKey: "sk-static" }, fetchImpl: stub.impl });
		handle.pushAudio(sine16kHz(160));
		await expect(handle.stop()).rejects.toThrow("401");
		expect(stub.calls).toHaveLength(1);
	});

	it("force-refreshes a rejected Codex token and retries the upload", async () => {
		// The stale bearer is the seeded access; the refresh resolve yields the fresh one.
		const oauth = oauthSource("fresh-token");
		const bearers: string[] = [];
		const fetchImpl = (async (url: string, init: RequestInit) => {
			const bearer = (init.headers as Record<string, string>)["Authorization"]!;
			bearers.push(bearer);
			if (bearer.endsWith("stale-token")) return new Response("unauthorized", { status: 401 });
			return new Response(JSON.stringify({ text: "retried" }), { status: 200 });
		}) as typeof fetch;
		const handle = startCloudSttStream({
			credential: {
				kind: "codex",
				access: { accessToken: "stale-token", accountId: "account-1" },
				source: oauth.source,
				sessionId: "s1",
			},
			fetchImpl,
		});
		handle.pushAudio(sine16kHz(160));
		await expect(handle.stop()).resolves.toBe("retried");
		expect(bearers).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
		// Seeded first attempt, then exactly one forced refresh of the same account.
		expect(oauth.resolves).toEqual([{ forceRefresh: true }]);
	});

	it("rotates to a sibling account when Codex denies the account", async () => {
		const oauth = oauthSource("denied-token");
		const fetchImpl = (async (_url: string, _init: RequestInit) =>
			new Response("account denied", { status: 403 })) as typeof fetch;
		const handle = startCloudSttStream({
			credential: {
				kind: "codex",
				access: { accessToken: "denied-token", accountId: "account-1" },
				source: oauth.source,
				sessionId: "s1",
			},
			fetchImpl,
		});
		handle.pushAudio(sine16kHz(160));
		await expect(handle.stop()).rejects.toThrow("403");
		expect(oauth.rotations).toBe(1);
	});
	it("resolves empty text without a request when nothing was recorded", async () => {
		const stub = stubFetch();
		const handle = startCloudSttStream({ credential: { kind: "openai", apiKey: "sk-test" }, fetchImpl: stub.impl });
		await expect(handle.stop()).resolves.toBe("");
		expect(stub.calls).toHaveLength(0);
	});
	it("cancel() discards the late transcript and resolves empty text", async () => {
		const stub = stubFetch();
		const handle = startCloudSttStream({ credential: { kind: "openai", apiKey: "sk-test" }, fetchImpl: stub.impl });
		handle.pushAudio(sine16kHz());
		const stopped = handle.stop();
		handle.cancel();
		await expect(stopped).resolves.toBe("");
		expect((stub.calls[0]!.init.signal as AbortSignal).aborted).toBe(true);
	});

	it("detaches from a shared abort signal once the stream settles", async () => {
		// A library caller reusing one signal across dictations must not
		// accumulate a listener (and its buffered-audio closure) per recording.
		const shared = new AbortController();
		const okStub = stubFetch("ok");
		const okStream = startCloudSttStream({
			credential: { kind: "openai", apiKey: "sk-test" },
			fetchImpl: okStub.impl,
			signal: shared.signal,
		});
		okStream.pushAudio(sine16kHz(160));
		await expect(okStream.stop()).resolves.toBe("ok");
		expect(getEventListeners(shared.signal, "abort")).toHaveLength(0);

		const failedStream = startCloudSttStream({
			credential: { kind: "openai", apiKey: "sk-test" },
			fetchImpl: stubFetch("nope", 500).impl,
			signal: shared.signal,
		});
		failedStream.pushAudio(sine16kHz(160));
		await expect(failedStream.stop()).rejects.toThrow("500");
		expect(getEventListeners(shared.signal, "abort")).toHaveLength(0);

		const silentStream = startCloudSttStream({
			credential: { kind: "openai", apiKey: "sk-test" },
			fetchImpl: stubFetch().impl,
			signal: shared.signal,
		});
		await expect(silentStream.stop()).resolves.toBe("");
		expect(getEventListeners(shared.signal, "abort")).toHaveLength(0);
	});

	it("tunnels each credential's upload through its provider-scoped proxy", async () => {
		const proxied = async (credential: CloudSttCredential, envKey: string): Promise<string | undefined> => {
			const previous = Bun.env[envKey];
			Bun.env[envKey] = "http://proxy.internal:8080";
			__resetProxyCache();
			try {
				const stub = stubFetch("ok");
				const handle = startCloudSttStream({ credential, fetchImpl: stub.impl });
				handle.pushAudio(sine16kHz(160));
				await handle.stop();
				const init = stub.calls[0]!.init;
				return "proxy" in init && typeof init.proxy === "string" ? init.proxy : undefined;
			} finally {
				if (previous === undefined) delete Bun.env[envKey];
				else Bun.env[envKey] = previous;
				__resetProxyCache();
			}
		};
		await expect(proxied({ kind: "openai", apiKey: "sk-test" }, "PI_PROXY_OPENAI")).resolves.toBe(
			"http://proxy.internal:8080",
		);
		await expect(
			proxied(
				{
					kind: "codex",
					access: { accessToken: "subscription-token", accountId: "account-1" },
					source: oauthSource("subscription-token").source,
				},
				"PI_PROXY_OPENAI_CODEX",
			),
		).resolves.toBe("http://proxy.internal:8080");
		// Another provider's proxy variable must not capture this upload.
		await expect(proxied({ kind: "openai", apiKey: "sk-test" }, "PI_PROXY_ANTHROPIC")).resolves.toBeUndefined();
	});

	it("sanitizes a hostile provider error body before it reaches the TUI", async () => {
		const hostile = `\u001b[31mdenied\u001b[0m\tby\nproxy\u0007 ${"x".repeat(400)}`;
		const stub = stubFetch(hostile, 400);
		stub.impl = (async (url: string, init: RequestInit) => {
			stub.calls.push({ url, init });
			return new Response(hostile, { status: 400 });
		}) as typeof fetch;
		const handle = startCloudSttStream({ credential: { kind: "openai", apiKey: "sk-test" }, fetchImpl: stub.impl });
		handle.pushAudio(sine16kHz(160));
		const message = await handle.stop().then(
			() => "resolved",
			(err: Error) => err.message,
		);
		expect(message).toStartWith("Cloud transcription failed (400): ");
		// No ANSI, control characters, tabs, or newlines survive into the warning.
		expect(message).not.toMatch(/[\u0000-\u0008\u000a-\u001f\u007f]/);
		// ANSI stripped, tab widened to spaces, newline collapsed, BEL dropped.
		expect(message).toContain("denied   by proxy ");
		expect(Bun.stringWidth(message)).toBeLessThanOrEqual("Cloud transcription failed (400): ".length + 80);
	});

	it("cancels an oversized provider error stream after a bounded prefix", async () => {
		let pulls = 0;
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				controller.enqueue(new Uint8Array(1024).fill(120));
			},
			cancel() {
				cancelled = true;
			},
		});
		const fetchImpl = (async (_url: string, _init: RequestInit) =>
			new Response(body, { status: 502 })) as typeof fetch;
		const handle = startCloudSttStream({ credential: { kind: "openai", apiKey: "sk-test" }, fetchImpl });
		handle.pushAudio(sine16kHz(160));

		await expect(handle.stop()).rejects.toThrow("Cloud transcription failed (502)");
		expect(cancelled).toBe(true);
		expect(pulls).toBeLessThanOrEqual(17);
	});
});

describe("dictation WAV payload", () => {
	it("concatenates PCM chunks without changing sample order", () => {
		const samples = concatenatePcm(
			[new Float32Array([0.25, -0.5]), new Float32Array(0), new Float32Array([0.75])],
			3,
		);
		expect([...samples]).toEqual([0.25, -0.5, 0.75]);
	});

	it("encodes mic audio as a 16 kHz mono PCM16 file through the shared encoder", () => {
		// The upload's `file.size` assertion above proves the byte count; this
		// pins the header fields the transcription endpoint parses, at the mic
		// sample rate the client passes rather than the TTS rate.
		const bytes = encodeWav(new Float32Array(160), 16_000);
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const ascii = (offset: number, length: number): string =>
			String.fromCharCode(...bytes.subarray(offset, offset + length));
		expect(ascii(0, 4)).toBe("RIFF");
		expect(ascii(8, 4)).toBe("WAVE");
		expect(view.getUint32(24, true)).toBe(16000);
		expect(view.getUint32(28, true)).toBe(32000);
		expect(view.getUint16(22, true)).toBe(1);
		expect(view.getUint16(34, true)).toBe(16);
		expect(view.getUint32(40, true)).toBe(320);
		expect(bytes.subarray(44).every(v => v === 0)).toBe(true);
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

	it("exposes the cloud credential route through the typed STT settings group", () => {
		settings.set("stt.cloudCredential", "api-key");
		const stt = settings.getGroup("stt");
		expect(stt.cloudCredential).toBe("api-key");
	});

	it("dictates through the cloud backend and commits the transcript on release", async () => {
		const stub = stubFetch("hello world");
		let credentialResolutions = 0;
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
				resolveCloudCredential: () => {
					credentialResolutions++;
					return Promise.resolve({ kind: "openai", apiKey: "sk-test" });
				},
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
			await controller.toggle(editor, options);
			onAudio(null, sine16kHz());
			await controller.toggle(editor, options);
			expect(stub.calls).toHaveLength(2);
			expect(credentialResolutions).toBe(2);
		} finally {
			controller.dispose();
		}
	});

	it("says once that the subscription route ignores model, language, and keywords", async () => {
		settings.set("stt.language", "pt");
		settings.set("stt.keywords", "AC-42");
		const stub = stubFetch("hello");
		let onAudio!: (error: Error | null, samples: Float32Array) => void;
		const editor = {
			committed: "",
			insertText(_text: string): void {},
			setVolatileText(_text: string): void {},
			clearVolatileText(): void {},
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
				resolveCloudCredential: () =>
					Promise.resolve({
						kind: "codex",
						access: { accessToken: "subscription-token", accountId: "account-1" },
						source: oauthSource("subscription-token").source,
					}),
				createCloudFetch: stub.impl,
			},
		);
		try {
			await controller.toggle(editor, options);
			onAudio(null, sine16kHz());
			await controller.toggle(editor, options);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("model, language, keywords");
			// The Codex route really does drop them: only the audio file is posted.
			const form = stub.calls[0]!.init.body as FormData;
			expect(form.has("model")).toBe(false);
			expect(form.has("language")).toBe(false);
			expect(form.has("prompt")).toBe(false);
			// Second dictation stays quiet.
			await controller.toggle(editor, options);
			onAudio(null, sine16kHz());
			await controller.toggle(editor, options);
			expect(warnings).toHaveLength(1);
		} finally {
			controller.dispose();
		}
	});

	it("buffers speech while cloud credentials are still resolving", async () => {
		const stub = stubFetch("captured during refresh");
		const credential = Promise.withResolvers<CloudSttCredential | undefined>();
		let onAudio!: (error: Error | null, samples: Float32Array) => void;
		const editor = {
			committed: "",
			insertText(_text: string): void {},
			setVolatileText(_text: string): void {},
			clearVolatileText(): void {},
			commitVolatileText(text: string): void {
				editor.committed += text;
			},
			submit(): void {},
			deleteBeforeCursor(_count: number): void {},
		};
		const options = {
			showWarning(_msg: string): void {},
			showStatus(_msg: string): void {},
			onStateChange(_state: SttState): void {},
		};
		const controller = new STTController(
			callback => {
				onAudio = callback;
				return { stop(): void {} };
			},
			{
				resolveCloudCredential: () => credential.promise,
				createCloudFetch: stub.impl,
			},
		);
		try {
			await controller.toggle(editor, options);
			expect(controller.state).toBe("recording");
			onAudio(null, sine16kHz());
			const stopping = controller.toggle(editor, options);
			expect(controller.state).toBe("transcribing");
			credential.resolve({ kind: "openai", apiKey: "sk-test" });
			await stopping;
			expect(editor.committed).toBe("captured during refresh");
			expect((stub.calls[0]!.init.body as FormData).get("file")).toBeInstanceOf(File);
		} finally {
			controller.dispose();
		}
	});

	it("aborts cloud setup when microphone capture fails to start", async () => {
		let credentialSignal: AbortSignal | undefined;
		const captureError = new Error("Microphone permission denied");
		const editor = {
			insertText(_text: string): void {},
			setVolatileText(_text: string): void {},
			clearVolatileText(): void {},
			commitVolatileText(_text: string): void {},
			submit(): void {},
			deleteBeforeCursor(_count: number): void {},
		};
		const warnings: string[] = [];
		const options = {
			showWarning(message: string): void {
				warnings.push(message);
			},
			showStatus(_message: string): void {},
			onStateChange(_state: SttState): void {},
		};
		const controller = new STTController(
			() => {
				throw captureError;
			},
			{
				resolveCloudCredential: signal => {
					credentialSignal = signal;
					const { promise, reject } = Promise.withResolvers<CloudSttCredential | undefined>();
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					return promise;
				},
			},
		);

		try {
			await controller.toggle(editor, options);
			expect(credentialSignal?.aborted).toBe(true);
			expect(credentialSignal?.reason).toBe(captureError);
			expect(warnings).toEqual([captureError.message]);
			expect(controller.state).toBe("idle");
		} finally {
			controller.dispose();
		}
	});

	it("settles a pending stop and aborts credential resolution when disposed", async () => {
		const credentialStarted = Promise.withResolvers<void>();
		let credentialSignal: AbortSignal | undefined;
		const editor = {
			insertText(_text: string): void {},
			setVolatileText(_text: string): void {},
			clearVolatileText(): void {},
			commitVolatileText(_text: string): void {},
			submit(): void {},
			deleteBeforeCursor(_count: number): void {},
		};
		const options = {
			showWarning(_msg: string): void {},
			showStatus(_msg: string): void {},
			onStateChange(_state: SttState): void {},
		};
		const controller = new STTController(() => ({ stop(): void {} }), {
			resolveCloudCredential: signal => {
				credentialSignal = signal;
				credentialStarted.resolve();
				const { promise, reject } = Promise.withResolvers<CloudSttCredential | undefined>();
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				return promise;
			},
		});

		await controller.toggle(editor, options);
		await credentialStarted.promise;
		const stopping = controller.toggle(editor, options);
		expect(controller.state).toBe("transcribing");
		controller.dispose();
		await stopping;
		expect(credentialSignal?.aborted).toBe(true);
		expect(controller.state).toBe("idle");
	});

	it("aborts an uncached local fallback download when disposed", async () => {
		settings.set("stt.modelName", "gpt-4o-transcribe");
		const cachedSpy = spyOn(downloader, "isSttModelCached").mockResolvedValue(false);
		const downloadStarted = Promise.withResolvers<AbortSignal>();
		const downloadSpy = spyOn(downloader, "downloadSttModel").mockImplementation((_key, _onProgress, options) => {
			const signal = options?.signal;
			if (!signal) throw new Error("Expected the fallback download to receive an abort signal");
			downloadStarted.resolve(signal);
			const { promise, reject } = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			return promise;
		});
		const editor = {
			insertText(_text: string): void {},
			setVolatileText(_text: string): void {},
			clearVolatileText(): void {},
			commitVolatileText(_text: string): void {},
			submit(): void {},
			deleteBeforeCursor(_count: number): void {},
		};
		const warnings: string[] = [];
		const options = {
			showWarning(message: string): void {
				warnings.push(message);
			},
			showStatus(_msg: string): void {},
			onStateChange(_state: SttState): void {},
		};
		const controller = new STTController(() => ({ stop(): void {} }), {
			resolveCloudCredential: () => Promise.resolve(undefined),
		});

		try {
			await controller.toggle(editor, options);
			const signal = await downloadStarted.promise;
			const stopping = controller.toggle(editor, options);
			controller.dispose();
			await stopping;
			expect(signal.aborted).toBe(true);
			expect(controller.state).toBe("idle");
			// Disposal aborted the download; that is not a dependency failure to report.
			expect(warnings).toEqual([
				"No OpenAI credentials for cloud speech-to-text (API key or ChatGPT subscription) — falling back to the local model.",
			]);
		} finally {
			controller.dispose();
			cachedSpy.mockRestore();
			downloadSpy.mockRestore();
		}
	});

	it("aborts a cached local fallback warmup when disposed", async () => {
		settings.set("stt.modelName", "gpt-4o-transcribe");
		const cachedSpy = spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		const warmStarted = Promise.withResolvers<AbortSignal | undefined>();
		const downloadSpy = spyOn(downloader, "downloadSttModel").mockImplementation((_key, _onProgress, options) => {
			const signal = options?.signal;
			warmStarted.resolve(signal);
			const { promise, reject } = Promise.withResolvers<void>();
			signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			return promise;
		});
		const streamSpy = spyOn(sttClient, "startStream").mockReturnValue({
			pushAudio(_audio: Float32Array): void {},
			stop: () => Promise.resolve(""),
			cancel(): void {},
		});
		const editor = {
			insertText(_text: string): void {},
			setVolatileText(_text: string): void {},
			clearVolatileText(): void {},
			commitVolatileText(_text: string): void {},
			submit(): void {},
			deleteBeforeCursor(_count: number): void {},
		};
		const options = {
			showWarning(_message: string): void {},
			showStatus(_msg: string): void {},
			onStateChange(_state: SttState): void {},
		};
		const controller = new STTController(() => ({ stop(): void {} }), {
			resolveCloudCredential: () => Promise.resolve(undefined),
		});

		try {
			await controller.toggle(editor, options);
			expect(controller.state).toBe("recording");
			// The cached warmup is a worker load nobody awaits; without the
			// recording's signal it would outlive dispose() and pin the worker.
			const signal = await warmStarted.promise;
			expect(signal?.aborted).toBe(false);
			controller.dispose();
			expect(signal?.aborted).toBe(true);
			expect(controller.state).toBe("idle");
		} finally {
			controller.dispose();
			cachedSpy.mockRestore();
			downloadSpy.mockRestore();
			streamSpy.mockRestore();
		}
	});

	it("reports a microphone failure once when it cancels the local fallback download", async () => {
		settings.set("stt.modelName", "gpt-4o-transcribe");
		const captureError = new Error("microphone unavailable");
		const cachedSpy = spyOn(downloader, "isSttModelCached").mockResolvedValue(false);
		// Wrapped so resolving does not adopt (and therefore reject with) the download itself.
		const downloadStarted = Promise.withResolvers<{ settled: Promise<void> }>();
		const downloadSpy = spyOn(downloader, "downloadSttModel").mockImplementation((_key, _onProgress, options) => {
			const signal = options?.signal;
			if (!signal) throw new Error("Expected the fallback download to receive an abort signal");
			const { promise, reject } = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			downloadStarted.resolve({ settled: promise.catch(() => {}) });
			return promise;
		});
		let onAudio!: (error: Error | null, samples: Float32Array) => void;
		const editor = {
			insertText(_text: string): void {},
			setVolatileText(_text: string): void {},
			clearVolatileText(): void {},
			commitVolatileText(_text: string): void {},
			submit(): void {},
			deleteBeforeCursor(_count: number): void {},
		};
		const warnings: string[] = [];
		const options = {
			showWarning(message: string): void {
				warnings.push(message);
			},
			showStatus(_msg: string): void {},
			onStateChange(_state: SttState): void {},
		};
		const controller = new STTController(
			callback => {
				onAudio = callback;
				return { stop(): void {} };
			},
			{ resolveCloudCredential: () => Promise.resolve(undefined) },
		);

		try {
			await controller.toggle(editor, options);
			const { settled } = await downloadStarted.promise;
			onAudio(captureError, new Float32Array(0));
			// Our continuation is queued behind the controller's own reaction on the
			// rejected download, so once this settles the fallback path has reported whatever it will.
			await settled;
			expect(controller.state).toBe("idle");
			expect(warnings).toEqual([
				"No OpenAI credentials for cloud speech-to-text (API key or ChatGPT subscription) — falling back to the local model.",
				captureError.message,
			]);
		} finally {
			controller.dispose();
			cachedSpy.mockRestore();
			downloadSpy.mockRestore();
		}
	});

	it("strips control sequences from the transcript it commits to the editor", async () => {
		const stub = stubFetch("\u001b[2Jhello\u0007 \u001b[31mworld\u001b[0m");
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
		const options = {
			showWarning(_msg: string): void {},
			showStatus(_msg: string): void {},
			onStateChange(_state: SttState): void {},
		};
		const controller = new STTController(
			callback => {
				onAudio = callback;
				return { stop(): void {} };
			},
			{
				resolveCloudCredential: () => Promise.resolve({ kind: "openai", apiKey: "sk-test" }),
				createCloudFetch: stub.impl,
			},
		);
		try {
			await controller.toggle(editor, options);
			onAudio(null, sine16kHz());
			await controller.toggle(editor, options);
			expect(editor.committed).toBe("hello world");
		} finally {
			controller.dispose();
		}
	});

	it("stt.cloudCredential=api-key dictates through the API key while a subscription is connected", async () => {
		settings.set("stt.cloudCredential", "api-key");
		settings.set("stt.language", "pt");
		const stub = stubFetch("api route");
		const source = oauthSource("subscription-token").source;
		const registry = {
			authStorage: source,
			async getApiKeyForProvider(): Promise<string | undefined> {
				return "sk-key";
			},
		};
		let onAudio!: (error: Error | null, samples: Float32Array) => void;
		const editor = {
			committed: "",
			insertText(_text: string): void {},
			setVolatileText(_text: string): void {},
			clearVolatileText(): void {},
			commitVolatileText(text: string): void {
				editor.committed += text;
			},
			submit(): void {},
			deleteBeforeCursor(_count: number): void {},
		};
		const warnings: string[] = [];
		const options = {
			showWarning(message: string): void {
				warnings.push(message);
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
				// Same wiring as interactive mode: the controller's route reaches the registry resolver.
				resolveCloudCredential: (signal, route) => resolveSttCloudCredential(registry, "s1", signal, route),
				createCloudFetch: stub.impl,
			},
		);
		try {
			await controller.toggle(editor, options);
			onAudio(null, sine16kHz());
			await controller.toggle(editor, options);
			expect(editor.committed).toBe("api route");
			expect(stub.calls[0]!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
			const form = stub.calls[0]!.init.body as FormData;
			expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
			expect(form.get("language")).toBe("pt");
			// The API-key route honours the settings, so nothing is reported as ignored.
			expect(warnings).toEqual([]);
		} finally {
			controller.dispose();
		}
	});

	it("bounds audio buffered while the backend is still starting", async () => {
		const credential = Promise.withResolvers<CloudSttCredential | undefined>();
		let credentialSignal: AbortSignal | undefined;
		let onAudio!: (error: Error | null, samples: Float32Array) => void;
		const editor = {
			insertText(_text: string): void {},
			setVolatileText(_text: string): void {},
			clearVolatileText(): void {},
			commitVolatileText(_text: string): void {},
			submit(): void {},
			deleteBeforeCursor(_count: number): void {},
		};
		const warnings: string[] = [];
		const options = {
			showWarning(message: string): void {
				warnings.push(message);
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
				resolveCloudCredential: signal => {
					credentialSignal = signal;
					return credential.promise;
				},
			},
		);
		try {
			await controller.toggle(editor, options);
			onAudio(null, sine16kHz());
			onAudio(null, new Float32Array(MAX_AUDIO_SAMPLES));
			// The credential never resolves: the bound must settle the recording on its own.
			await controller.toggle(editor, options);
			expect(controller.state).toBe("idle");
			expect(warnings).toEqual([AUDIO_LIMIT_MESSAGE]);
			expect(credentialSignal?.aborted).toBe(true);
		} finally {
			controller.dispose();
		}
	});

	it("reports a failed local fallback download exactly once", async () => {
		settings.set("stt.modelName", "gpt-4o-transcribe");
		const cachedSpy = spyOn(downloader, "isSttModelCached").mockResolvedValue(false);
		const downloadSpy = spyOn(downloader, "downloadSttModel").mockRejectedValue(
			new Error("Download failed: 503 Service Unavailable"),
		);
		let onAudio!: (error: Error | null, samples: Float32Array) => void;
		const editor = {
			insertText(_text: string): void {},
			setVolatileText(_text: string): void {},
			clearVolatileText(): void {},
			commitVolatileText(_text: string): void {},
			submit(): void {},
			deleteBeforeCursor(_count: number): void {},
		};
		const warnings: string[] = [];
		const options = {
			showWarning(message: string): void {
				warnings.push(message);
			},
			showStatus(_msg: string): void {},
			onStateChange(_state: SttState): void {},
		};
		const controller = new STTController(
			callback => {
				onAudio = callback;
				return { stop(): void {} };
			},
			{ resolveCloudCredential: () => Promise.resolve(undefined) },
		);
		try {
			await controller.toggle(editor, options);
			onAudio(null, sine16kHz());
			await controller.toggle(editor, options);
			expect(controller.state).toBe("idle");
			expect(warnings).toEqual([
				"No OpenAI credentials for cloud speech-to-text (API key or ChatGPT subscription) — falling back to the local model.",
				"Download failed: 503 Service Unavailable",
			]);
		} finally {
			controller.dispose();
			cachedSpy.mockRestore();
			downloadSpy.mockRestore();
		}
	});
});

describe("resolveSttCloudCredential", () => {
	function registry(codex: string | undefined, openai: string | undefined) {
		return {
			authStorage: {
				async getOAuthAccess(): Promise<OAuthAccess | undefined> {
					return codex ? { accessToken: codex, accountId: "account-1" } : undefined;
				},
				async rotateSessionCredential(): Promise<boolean> {
					return false;
				},
			} satisfies OAuthAccessSource,
			async getApiKeyForProvider(): Promise<string | undefined> {
				return openai;
			},
		};
	}

	it("preserves ChatGPT subscription provenance and its retry source", async () => {
		const source = registry("sub-token", "sk-key");
		await expect(resolveSttCloudCredential(source, "s1")).resolves.toEqual({
			kind: "codex",
			access: { accessToken: "sub-token", accountId: "account-1" },
			source: source.authStorage,
			sessionId: "s1",
		});
	});

	it("api-key route selects the OpenAI key even when a subscription is connected", async () => {
		const source = registry("sub-token", "sk-key");
		let subscriptionLookups = 0;
		source.authStorage.getOAuthAccess = async () => {
			subscriptionLookups++;
			return { accessToken: "sub-token", accountId: "account-1" };
		};
		await expect(resolveSttCloudCredential(source, "s1", undefined, "api-key")).resolves.toEqual({
			kind: "openai",
			apiKey: "sk-key",
		});
		expect(subscriptionLookups).toBe(0);
	});

	it("subscription route never falls through to the API key", async () => {
		await expect(
			resolveSttCloudCredential(registry(undefined, "sk-key"), "s1", undefined, "subscription"),
		).resolves.toBeUndefined();
	});

	it("preserves the OpenAI API endpoint and headers", async () => {
		const source = {
			...registry(undefined, "sk-key"),
			getProviderBaseUrl: () => "https://proxy.example/v1",
			getProviderHeaders: () => ({ "X-Workspace": "workspace-1" }),
		};
		await expect(resolveSttCloudCredential(source, "s1")).resolves.toEqual({
			kind: "openai",
			apiKey: "sk-key",
			baseUrl: "https://proxy.example/v1",
			headers: { "X-Workspace": "workspace-1" },
		});
	});

	it("seeds the registry resolver with the preflight key", async () => {
		const resolverCalls: Array<boolean> = [];
		const source = {
			...registry(undefined, "sk-preflight"),
			resolver: (): ApiKeyResolver => ctx => {
				resolverCalls.push(ctx.lastChance);
				return "sk-rotated";
			},
		};
		const credential = await resolveSttCloudCredential(source, "s1");
		if (credential?.kind !== "openai" || !("apiKey" in credential)) {
			throw new Error("expected the API-key route");
		}
		const apiKey = credential.apiKey;
		if (typeof apiKey !== "function") throw new Error("expected a resolver-backed credential");
		// Initial resolve reuses the preflight key without re-entering the registry.
		expect(await apiKey({ lastChance: false, error: undefined })).toBe("sk-preflight");
		expect(resolverCalls).toEqual([]);
		// A rejection delegates to the registry resolver for refresh/rotation.
		expect(await apiKey({ lastChance: true, error: new Error("401") })).toBe("sk-rotated");
		expect(resolverCalls).toEqual([true]);
	});

	it("falls back to the API key when subscription lookup rejects", async () => {
		const source = registry(undefined, "sk-key");
		source.authStorage.getOAuthAccess = async () => {
			throw new Error("OAuth refresh failed");
		};
		await expect(resolveSttCloudCredential(source, "s1")).resolves.toEqual({
			kind: "openai",
			apiKey: "sk-key",
		});
	});

	it("preserves keyless provider authentication headers without a bogus bearer", async () => {
		const source = {
			...registry(undefined, kNoAuth),
			getProviderBaseUrl: () => "https://keyless.example/v1",
			getProviderHeaders: () => ({
				Authorization: "Custom endpoint-token",
				"Content-Type": "application/json",
			}),
		};
		const credential = await resolveSttCloudCredential(source, "s1");
		expect(credential).toEqual({
			kind: "openai",
			keyless: true,
			baseUrl: "https://keyless.example/v1",
			headers: {
				Authorization: "Custom endpoint-token",
				"Content-Type": "application/json",
			},
		});
		if (!credential) throw new Error("expected the keyless route");
		const stub = stubFetch("keyless");
		const handle = startCloudSttStream({ credential, fetchImpl: stub.impl });
		handle.pushAudio(sine16kHz(160));
		await expect(handle.stop()).resolves.toBe("keyless");
		expect(stub.calls[0]!.url).toBe("https://keyless.example/v1/audio/transcriptions");
		expect(stub.calls[0]!.init.headers).toEqual({ Authorization: "Custom endpoint-token" });
	});

	it("resolves nothing without any credential", async () => {
		await expect(resolveSttCloudCredential(registry(undefined, undefined), "s1")).resolves.toBeUndefined();
	});
});
