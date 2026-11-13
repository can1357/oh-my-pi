import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import { isAnthropicOAuthToken } from "@oh-my-pi/pi-catalog/utils";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import { getClaudeCodeUserAgent } from "../providers/claude-code-fingerprint";
import { decodeTranscriptionUsage, type TranscriptionOptions, TranscriptionApiError } from "./openai-transcriptions";
import type { TranscriptionRequest, TranscriptionResult } from "./types";

/** Path of Claude Code's `/voice` speech-to-text socket, relative to the Anthropic API origin. */
export const ANTHROPIC_VOICE_STREAM_PATH = "/api/ws/speech_to_text/voice_stream";
/** Frames carry 100 ms of audio, as Claude Code's `/voice` sends them. */
const FRAMES_PER_SECOND = 10;
/** Claude Code sends a KeepAlive every 8 s so a silent or slow session is not reaped. */
const KEEP_ALIVE_INTERVAL_MS = 8_000;
const CONNECT_TIMEOUT_MS = 15_000;
/** Silence allowed after `CloseStream` before the final transcript is declared lost. */
const FINALIZE_IDLE_TIMEOUT_MS = 20_000;

/** Minimal WebSocket surface the runner drives; Bun's `WebSocket` satisfies it. */
export interface VoiceStreamWebSocketLike {
	binaryType: string;
	onopen: ((event: Event) => void) | null;
	onmessage: ((event: MessageEvent) => void) | null;
	onerror: ((event: Event) => void) | null;
	onclose: ((event: CloseEvent) => void) | null;
	send(data: string | Uint8Array): void;
	close(code?: number, reason?: string): void;
}

export type VoiceStreamWebSocketFactory = (url: string, headers: Record<string, string>) => VoiceStreamWebSocketLike;

export interface AnthropicVoiceStreamOptions extends TranscriptionOptions {
	/** Test seam: replaces the Bun `WebSocket` constructor. */
	webSocketFactory?: VoiceStreamWebSocketFactory;
	connectTimeoutMs?: number;
	finalizeIdleTimeoutMs?: number;
	keepAliveIntervalMs?: number;
}

/** `TranscriptError`/`error` frame from the voice_stream socket. */
export class VoiceStreamTranscriptionError extends AIError.ProviderResponseError {
	readonly code: string | undefined;

	constructor(message: string, options: { provider: string; code?: string }) {
		super(message, { provider: options.provider, kind: "output" });
		this.name = "VoiceStreamTranscriptionError";
		this.code = options.code;
	}
}

interface Pcm16Audio {
	samples: Uint8Array;
	sampleRate: number;
}

/**
 * Transcribe through Claude Code's subscription speech-to-text socket
 * (`wss://api.anthropic.com/api/ws/speech_to_text/voice_stream`, Deepgram Nova-3).
 * Only claude.ai OAuth access tokens are accepted; API keys are rejected before
 * connecting. The WAV payload is streamed as PCM16 mono frames, then
 * `CloseStream` asks the server to finalize. With the conversation engine the
 * server's `TranscriptText` is cumulative for the whole session, so the last one
 * received before the socket closes is the transcript.
 */
export async function transcribeAnthropicVoiceStream(
	model: Model<Api>,
	request: TranscriptionRequest,
	options: AnthropicVoiceStreamOptions,
): Promise<TranscriptionResult> {
	const label = `${model.provider}/${model.id}`;
	if (request.prompt !== undefined) throw new AIError.ValidationError(`${label} does not support prompt`);
	if (request.temperature !== undefined) throw new AIError.ValidationError(`${label} does not support temperature`);
	if (request.timestampGranularities?.length) {
		throw new AIError.ValidationError(`${label} does not support timestamp granularities`);
	}
	const audio = decodePcm16Wav(
		request.audio instanceof Uint8Array ? request.audio : new Uint8Array(await request.audio.arrayBuffer()),
		label,
	);
	const url = new URL(ANTHROPIC_VOICE_STREAM_PATH, model.baseUrl.replace(/^http/, "ws"));
	url.search = new URLSearchParams({
		encoding: "linear16",
		sample_rate: String(audio.sampleRate),
		channels: "1",
		endpointing_ms: "300",
		utterance_end_ms: "1000",
		language: request.language?.trim() || "en",
		use_conversation_engine: "true",
		stt_provider: "deepgram-nova3",
	}).toString();

	const text = await withAuth(
		options.apiKey,
		async key => {
			if (!isAnthropicOAuthToken(key)) {
				throw new AIError.ConfigurationError(
					`${label} needs a Claude subscription login (/login anthropic); Anthropic API keys cannot use voice_stream`,
				);
			}
			const headers: Record<string, string> = {
				Authorization: `Bearer ${key}`,
				"User-Agent": getClaudeCodeUserAgent(),
				"x-app": "cli",
				"anthropic-client-platform": "claude_code_cli",
			};
			return streamVoice(url.toString(), headers, audio, model, options);
		},
		{ signal: options.signal },
	);
	return { text, usage: decodeTranscriptionUsage(model, undefined).usage };
}

function streamVoice(
	url: string,
	headers: Record<string, string>,
	audio: Pcm16Audio,
	model: Model<Api>,
	options: AnthropicVoiceStreamOptions,
): Promise<string> {
	const label = `${model.provider}/${model.id}`;
	const { samples: pcm } = audio;
	// 100 ms of PCM16 mono at the clip's own rate (3200 bytes at 16 kHz).
	const frameBytes = Math.max(2, Math.floor(audio.sampleRate / FRAMES_PER_SECOND) * 2);
	const provider = model.provider;
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const signal = options.signal;
	if (signal?.aborted) return Promise.reject(new AIError.AbortError(`${label} transcription aborted`));

	const factory = options.webSocketFactory ?? defaultWebSocketFactory;
	const ws = factory(url, headers);
	ws.binaryType = "arraybuffer";
	let settled = false;
	let closeSent = false;
	let transcript = "";
	/** Text finalized before the latest `TranscriptEndpoint`, kept in case a later utterance restarts from empty. */
	let committed = "";
	let keepAlive: NodeJS.Timeout | undefined;
	let timer: NodeJS.Timeout | undefined;

	const arm = (ms: number, message: string): void => {
		clearTimeout(timer);
		timer = setTimeout(() => fail(new AIError.StreamTimeoutError(message)), ms);
	};
	const cleanup = (): void => {
		clearTimeout(timer);
		clearInterval(keepAlive);
		signal?.removeEventListener("abort", onAbort);
		ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
	};
	const finish = (): void => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(transcript.trim());
	};
	const fail = (error: Error): void => {
		if (settled) return;
		settled = true;
		cleanup();
		try {
			ws.close();
		} catch {}
		reject(error);
	};
	const onAbort = (): void => fail(new AIError.AbortError(`${label} transcription aborted`));
	signal?.addEventListener("abort", onAbort, { once: true });
	arm(options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, `${label} voice_stream did not connect in time`);

	ws.onopen = () => {
		if (settled) return;
		keepAlive = setInterval(() => {
			try {
				ws.send(KEEP_ALIVE);
			} catch {}
		}, options.keepAliveIntervalMs ?? KEEP_ALIVE_INTERVAL_MS);
		try {
			for (let offset = 0; offset < pcm.length; offset += frameBytes) {
				ws.send(pcm.subarray(offset, offset + frameBytes));
			}
			ws.send(CLOSE_STREAM);
		} catch (error) {
			fail(
				new AIError.ProviderResponseError(`${label} voice_stream send failed`, {
					provider,
					kind: "incomplete-stream",
					cause: error,
				}),
			);
			return;
		}
		closeSent = true;
		arm(options.finalizeIdleTimeoutMs ?? FINALIZE_IDLE_TIMEOUT_MS, `${label} voice_stream did not finalize`);
	};

	ws.onmessage = event => {
		if (settled || typeof event.data !== "string") return;
		if (closeSent)
			arm(options.finalizeIdleTimeoutMs ?? FINALIZE_IDLE_TIMEOUT_MS, `${label} voice_stream did not finalize`);
		let frame: { type?: unknown; data?: unknown; description?: unknown; error_code?: unknown; message?: unknown };
		try {
			frame = JSON.parse(event.data);
		} catch {
			fail(
				new AIError.ProviderResponseError(`${label} voice_stream sent a non-JSON frame`, {
					provider,
					kind: "envelope",
				}),
			);
			return;
		}
		switch (frame.type) {
			case "TranscriptText":
				if (typeof frame.data === "string") {
					transcript = committed && !frame.data.startsWith(committed) ? `${committed} ${frame.data}` : frame.data;
				}
				return;
			case "TranscriptEndpoint":
				committed = transcript;
				return;
			case "TranscriptError": {
				const code = typeof frame.error_code === "string" ? frame.error_code : undefined;
				const detail = typeof frame.description === "string" ? frame.description : "transcription failed";
				fail(new VoiceStreamTranscriptionError(`${label} voice_stream error: ${detail}`, { provider, code }));
				return;
			}
			case "error": {
				const detail =
					typeof frame.message === "string"
						? frame.message
						: typeof frame.description === "string"
							? frame.description
							: event.data;
				fail(new VoiceStreamTranscriptionError(`${label} voice_stream error: ${detail}`, { provider }));
				return;
			}
			default:
				// TranscriptInterim and future informational frames carry nothing the buffered result needs.
				return;
		}
	};

	ws.onerror = event => {
		const message = "message" in event && typeof event.message === "string" ? event.message : "";
		// Bun reports a refused upgrade as "Expected 101 status code: <status>".
		const status = /Expected 101 status code:\s*(\d{3})/.exec(message)?.[1];
		if (status) {
			fail(
				new TranscriptionApiError(`${label} voice_stream upgrade rejected (${status})`, Number(status), {
					code: `http_${status}`,
				}),
			);
			return;
		}
		fail(
			new AIError.ProviderResponseError(`${label} voice_stream connection failed${message ? `: ${message}` : ""}`, {
				provider,
				kind: "incomplete-stream",
			}),
		);
	};

	ws.onclose = event => {
		if (closeSent && event.code === 1000) {
			finish();
			return;
		}
		fail(
			new AIError.ProviderResponseError(
				`${label} voice_stream closed before the transcript was final (code ${event.code}${event.reason ? `: ${event.reason}` : ""})`,
				{ provider, kind: "incomplete-stream" },
			),
		);
	};

	return promise;
}

const KEEP_ALIVE = JSON.stringify({ type: "KeepAlive" });
const CLOSE_STREAM = JSON.stringify({ type: "CloseStream" });

function defaultWebSocketFactory(url: string, headers: Record<string, string>): VoiceStreamWebSocketLike {
	return new WebSocket(url, { headers });
}

/**
 * Pull 16-bit PCM out of a RIFF/WAVE container, down-mixing to mono. A streamed
 * WAV whose `data` size is 0xFFFFFFFF (or overruns the buffer) is read to the end.
 */
export function decodePcm16Wav(bytes: Uint8Array, label: string): Pcm16Audio {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const tag = (offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + 4));
	if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
		throw new AIError.ValidationError(`${label} accepts 16-bit PCM WAV audio only`);
	}
	let format: { channels: number; sampleRate: number; bits: number; codec: number } | undefined;
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		const id = tag(offset);
		const size = view.getUint32(offset + 4, true);
		const body = offset + 8;
		if (id === "fmt " && body + 16 <= bytes.length) {
			format = {
				codec: view.getUint16(body, true),
				channels: view.getUint16(body + 2, true),
				sampleRate: view.getUint32(body + 4, true),
				bits: view.getUint16(body + 14, true),
			};
		} else if (id === "data") {
			if (!format || format.codec !== 1 || format.bits !== 16 || format.channels < 1) {
				throw new AIError.ValidationError(`${label} accepts 16-bit PCM WAV audio only`);
			}
			const end = Math.min(bytes.length, body + size);
			const data = bytes.subarray(body, end - ((end - body) % (2 * format.channels)));
			return {
				samples: format.channels === 1 ? data : downmix(data, format.channels),
				sampleRate: format.sampleRate,
			};
		}
		offset = body + size + (size % 2);
	}
	throw new AIError.ValidationError(`${label} accepts 16-bit PCM WAV audio only`);
}

function downmix(interleaved: Uint8Array, channels: number): Uint8Array {
	const input = new DataView(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength);
	const frames = interleaved.byteLength / (2 * channels);
	const out = new Uint8Array(frames * 2);
	const output = new DataView(out.buffer);
	for (let frame = 0; frame < frames; frame++) {
		let sum = 0;
		for (let channel = 0; channel < channels; channel++)
			sum += input.getInt16((frame * channels + channel) * 2, true);
		output.setInt16(frame * 2, Math.round(sum / channels), true);
	}
	return out;
}
