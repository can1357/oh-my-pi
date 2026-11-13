import { describe, expect, it } from "bun:test";
import { AbortError, ConfigurationError, StreamTimeoutError, ValidationError } from "@oh-my-pi/pi-ai/error";
import {
	ANTHROPIC_VOICE_STREAM_PATH,
	type AnthropicVoiceStreamOptions,
	decodePcm16Wav,
	isTranscriptionApi,
	TranscriptionApiError,
	transcribeAnthropicVoiceStream,
	transcribeAudio,
	type VoiceStreamWebSocketLike,
	VoiceStreamTranscriptionError,
} from "@oh-my-pi/pi-ai/transcription";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Api, Model } from "@oh-my-pi/pi-catalog/types";

const OAUTH = "sk-ant-oat01-fixture";

function voiceModel(): Model<Api> {
	return buildModel({
		id: "claude-voice-stream",
		name: "Claude Voice Stream",
		api: "anthropic-voice-stream",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		kind: "stt",
	});
}

/** RIFF/WAVE PCM16 with the given interleaved samples. */
function wav(
	samples: number[],
	{ channels = 1, sampleRate = 16000, dataSize }: { channels?: number; sampleRate?: number; dataSize?: number } = {},
): Uint8Array {
	const bytes = new Uint8Array(44 + samples.length * 2);
	const view = new DataView(bytes.buffer);
	const ascii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
	};
	ascii(0, "RIFF");
	view.setUint32(4, 36 + samples.length * 2, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * 2, true);
	view.setUint16(32, channels * 2, true);
	view.setUint16(34, 16, true);
	ascii(36, "data");
	view.setUint32(40, dataSize ?? samples.length * 2, true);
	samples.forEach((sample, i) => view.setInt16(44 + i * 2, sample, true));
	return bytes;
}

type Script = (socket: MockSocket) => void;

class MockSocket implements VoiceStreamWebSocketLike {
	binaryType = "blob";
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	readonly frames: Uint8Array[] = [];
	readonly controls: string[] = [];
	closedByClient = false;

	constructor(
		readonly url: string,
		readonly headers: Record<string, string>,
		private readonly onControl: (socket: MockSocket, type: string) => void,
	) {}

	send(data: string | Uint8Array): void {
		if (typeof data === "string") {
			const control: { type: string } = JSON.parse(data);
			const type = control.type;
			this.controls.push(type);
			this.onControl(this, type);
		} else this.frames.push(data.slice());
	}

	close(): void {
		this.closedByClient = true;
	}

	open(): void {
		this.onopen?.(new Event("open"));
	}

	emit(frame: object | string): void {
		this.onmessage?.(
			new MessageEvent("message", { data: typeof frame === "string" ? frame : JSON.stringify(frame) }),
		);
	}

	error(message: string): void {
		this.onerror?.(Object.assign(new Event("error"), { message }));
	}

	end(code = 1000, reason = ""): void {
		this.onclose?.(new CloseEvent("close", { code, reason }));
	}
}

function harness(
	onOpen: Script,
	onControl: (socket: MockSocket, type: string) => void = () => {},
): { sockets: MockSocket[]; options: (extra?: Partial<AnthropicVoiceStreamOptions>) => AnthropicVoiceStreamOptions } {
	const sockets: MockSocket[] = [];
	return {
		sockets,
		options: extra => ({
			apiKey: OAUTH,
			webSocketFactory: (url, headers) => {
				const socket = new MockSocket(url, headers, onControl);
				sockets.push(socket);
				queueMicrotask(() => onOpen(socket));
				return socket;
			},
			...extra,
		}),
	};
}

/** Server that answers `CloseStream` with the given frames, then a normal close. */
function finalizingServer(...frames: Array<object | string>): (socket: MockSocket, type: string) => void {
	return (socket, type) => {
		if (type !== "CloseStream") return;
		queueMicrotask(() => {
			for (const frame of frames) socket.emit(frame);
			socket.end(1000);
		});
	};
}

const REQUEST = (audio: Uint8Array) => ({ audio, mimeType: "audio/wav", responseFormat: "json" as const });

describe("anthropic-voice-stream transcription runner", () => {
	it("is a dispatchable transcription API with a bundled stt row", () => {
		expect(isTranscriptionApi("anthropic-voice-stream")).toBe(true);
		const row = getBundledModel("anthropic", "claude-voice-stream");
		expect(row).toMatchObject({ api: "anthropic-voice-stream", kind: "stt", baseUrl: "https://api.anthropic.com" });
	});

	it("streams 100 ms PCM frames, finalizes with CloseStream, and returns the last cumulative text", async () => {
		const samples = Array.from({ length: 4000 }, (_, i) => (i % 200) - 100);
		const { sockets, options } = harness(
			socket => socket.open(),
			finalizingServer(
				{ type: "TranscriptInterim", data: "hel" },
				{ type: "TranscriptText", data: "Hello" },
				{ type: "TranscriptText", data: "Hello brave world." },
				{ type: "TranscriptEndpoint" },
			),
		);
		const result = await transcribeAudio(voiceModel(), { ...REQUEST(wav(samples)), language: "de" }, options());
		expect(result.text).toBe("Hello brave world.");
		expect(result.usage.cost.total).toBe(0);

		const [socket] = sockets;
		const url = new URL(socket.url);
		expect(`${url.origin}${url.pathname}`).toBe(`wss://api.anthropic.com${ANTHROPIC_VOICE_STREAM_PATH}`);
		expect(Object.fromEntries(url.searchParams)).toMatchObject({
			encoding: "linear16",
			sample_rate: "16000",
			channels: "1",
			language: "de",
			use_conversation_engine: "true",
			stt_provider: "deepgram-nova3",
		});
		expect(socket.headers.Authorization).toBe(`Bearer ${OAUTH}`);
		expect(socket.headers["User-Agent"]).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);
		expect(socket.headers["x-app"]).toBe("cli");
		expect(socket.headers["anthropic-client-platform"]).toBe("claude_code_cli");
		expect(socket.binaryType).toBe("arraybuffer");
		// 8000 bytes of PCM → 3200 + 3200 + 1600, header stripped.
		expect(socket.frames.map(frame => frame.length)).toEqual([3200, 3200, 1600]);
		expect(new DataView(socket.frames[0].buffer).getInt16(2, true)).toBe(samples[1]);
		expect(socket.controls).toEqual(["CloseStream"]);
	});

	it("appends an utterance that restarts after an endpoint", async () => {
		const { options } = harness(
			socket => socket.open(),
			finalizingServer(
				{ type: "TranscriptText", data: "First part." },
				{ type: "TranscriptEndpoint" },
				{ type: "TranscriptText", data: "Second" },
				{ type: "TranscriptText", data: "Second part." },
			),
		);
		const result = await transcribeAnthropicVoiceStream(voiceModel(), REQUEST(wav([1, 2])), options());
		expect(result.text).toBe("First part. Second part.");
	});

	it("down-mixes stereo and reads a streamed WAV to the end", () => {
		const stereo = decodePcm16Wav(wav([100, 300, -50, -150], { channels: 2, sampleRate: 48000 }), "x");
		expect(stereo.sampleRate).toBe(48000);
		expect(Array.from(new Int16Array(stereo.samples.slice().buffer))).toEqual([200, -100]);
		const streamed = decodePcm16Wav(wav([7, 8, 9], { dataSize: 0xffffffff }), "x");
		expect(streamed.samples.length).toBe(6);
		expect(() => decodePcm16Wav(new Uint8Array([0x49, 0x44, 0x33, 0x04]), "x")).toThrow(ValidationError);
	});

	it("rejects API keys before connecting", async () => {
		const { sockets, options } = harness(socket => socket.open());
		const pending = transcribeAnthropicVoiceStream(
			voiceModel(),
			REQUEST(wav([1])),
			options({ apiKey: "sk-ant-api03-fixture" }),
		);
		await expect(pending).rejects.toBeInstanceOf(ConfigurationError);
		await expect(pending).rejects.toThrow(/Claude subscription login/);
		expect(sockets).toHaveLength(0);
	});

	it("rejects non-WAV audio and unsupported options", async () => {
		const { options } = harness(socket => socket.open());
		await expect(
			transcribeAnthropicVoiceStream(
				voiceModel(),
				{ ...REQUEST(new Uint8Array([1, 2, 3])), mimeType: "audio/mpeg" },
				options(),
			),
		).rejects.toBeInstanceOf(ValidationError);
		await expect(
			transcribeAnthropicVoiceStream(voiceModel(), { ...REQUEST(wav([1])), prompt: "x" }, options()),
		).rejects.toBeInstanceOf(ValidationError);
	});

	it("surfaces TranscriptError frames as typed errors with the server code", async () => {
		const { sockets, options } = harness(
			socket => socket.open(),
			finalizingServer({ type: "TranscriptError", description: "audio too long", error_code: "too_long" }),
		);
		const error = await transcribeAnthropicVoiceStream(voiceModel(), REQUEST(wav([1])), options()).catch(e => e);
		expect(error).toBeInstanceOf(VoiceStreamTranscriptionError);
		expect(error.code).toBe("too_long");
		expect(error.message).toContain("audio too long");
		expect(sockets[0].closedByClient).toBe(true);
	});

	it("surfaces generic error frames", async () => {
		const { options } = harness(socket => socket.open(), finalizingServer({ type: "error", message: "boom" }));
		await expect(transcribeAnthropicVoiceStream(voiceModel(), REQUEST(wav([1])), options())).rejects.toThrow(
			/voice_stream error: boom/,
		);
	});

	it("maps a refused upgrade to an HTTP status and retries once with a refreshed token", async () => {
		let attempt = 0;
		const { sockets, options } = harness(
			socket => {
				attempt++;
				if (attempt === 1) socket.error("WebSocket connection failed: Expected 101 status code: 401");
				else socket.open();
			},
			finalizingServer({ type: "TranscriptText", data: "ok" }),
		);
		const refreshed = "sk-ant-oat01-refreshed";
		const tokens = [OAUTH, refreshed];
		const result = await transcribeAnthropicVoiceStream(
			voiceModel(),
			REQUEST(wav([1])),
			options({ apiKey: () => tokens.shift() }),
		);
		expect(result.text).toBe("ok");
		expect(sockets.map(socket => socket.headers.Authorization)).toEqual([`Bearer ${OAUTH}`, `Bearer ${refreshed}`]);
	});

	it("reports a 401 upgrade as TranscriptionApiError when no fresh token exists", async () => {
		const { options } = harness(socket => socket.error("Expected 101 status code: 401"));
		const error = await transcribeAnthropicVoiceStream(voiceModel(), REQUEST(wav([1])), options()).catch(e => e);
		expect(error).toBeInstanceOf(TranscriptionApiError);
		expect(error.status).toBe(401);
	});

	it("fails an abnormal close as an incomplete stream", async () => {
		const { options } = harness(socket => {
			socket.open();
			socket.end(1006);
		});
		await expect(transcribeAnthropicVoiceStream(voiceModel(), REQUEST(wav([1])), options())).rejects.toThrow(
			/closed before the transcript was final \(code 1006\)/,
		);
	});

	it("times out a socket that never opens or never finalizes", async () => {
		// The deadlines are the behavior under test; 20 ms real timers keep it cheap.
		const silent = harness(() => {});
		await expect(
			transcribeAnthropicVoiceStream(voiceModel(), REQUEST(wav([1])), silent.options({ connectTimeoutMs: 20 })),
		).rejects.toBeInstanceOf(StreamTimeoutError);
		const stalled = harness(socket => socket.open());
		const error = await transcribeAnthropicVoiceStream(
			voiceModel(),
			REQUEST(wav([1])),
			stalled.options({ finalizeIdleTimeoutMs: 20 }),
		).catch(e => e);
		expect(error).toBeInstanceOf(StreamTimeoutError);
		expect(error.message).toContain("did not finalize");
		expect(stalled.sockets[0].closedByClient).toBe(true);
	});

	it("sends KeepAlive while waiting on the final transcript", async () => {
		const { sockets, options } = harness(
			socket => socket.open(),
			(socket, type) => {
				// Finalize only once the client has kept the session alive twice.
				if (type !== "KeepAlive" || socket.controls.filter(sent => sent === "KeepAlive").length < 2) return;
				socket.emit({ type: "TranscriptText", data: "late" });
				socket.end(1000);
			},
		);
		const result = await transcribeAnthropicVoiceStream(
			voiceModel(),
			REQUEST(wav([1])),
			options({ keepAliveIntervalMs: 5 }),
		);
		expect(result.text).toBe("late");
		expect(sockets[0].controls).toEqual(["CloseStream", "KeepAlive", "KeepAlive"]);
	});

	it("aborts on the caller signal", async () => {
		const controller = new AbortController();
		const { sockets, options } = harness(socket => {
			socket.open();
			controller.abort();
		});
		await expect(
			transcribeAnthropicVoiceStream(voiceModel(), REQUEST(wav([1])), options({ signal: controller.signal })),
		).rejects.toBeInstanceOf(AbortError);
		expect(sockets[0].closedByClient).toBe(true);
	});
});
