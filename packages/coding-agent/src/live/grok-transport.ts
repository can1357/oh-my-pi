import { getProxyForUrl } from "@oh-my-pi/pi-ai/utils/proxy";
import { AudioPlayback } from "@oh-my-pi/pi-natives";
import { $env } from "@oh-my-pi/pi-utils";
import type { LiveClientMessage } from "./protocol";
import type { ILiveTransport, LiveTransportIdentity, LiveTransportOptions } from "./transport-types";
import { DEFAULT_GROK_LIVE_VOICE, GROK_LIVE_VOICE_LOOKUP } from "./voices";

const DEFAULT_GROK_REALTIME_MODEL = "grok-voice-think-fast-2.0";
const REALTIME_BASE_URL = "wss://api.x.ai/v1/realtime";
const CONNECT_TIMEOUT_MS = 15_000;
const OUTPUT_SAMPLE_RATE = 24_000;
const INPUT_SAMPLE_RATE = 16_000;

type Lifecycle = "idle" | "connecting" | "connected" | "closing" | "closed";

interface PendingFunctionCall {
	callId: string;
	request: string;
}
/** Build the xAI session configuration sent when the realtime socket opens. */
export function buildGrokSessionUpdate(instructions: string, requestedVoice: string): Record<string, unknown> {
	const rawVoice = requestedVoice.trim().toLowerCase();
	const voice = GROK_LIVE_VOICE_LOOKUP[rawVoice] ? rawVoice : DEFAULT_GROK_LIVE_VOICE;
	return {
		type: "session.update",
		session: {
			modalities: ["text", "audio"],
			voice,
			instructions,
			turn_detection: { type: "server_vad" },
			audio: {
				input: {
					format: { type: "audio/pcm", rate: INPUT_SAMPLE_RATE },
					transcription: { model: "grok-transcribe" },
				},
				output: {
					format: { type: "audio/pcm", rate: OUTPUT_SAMPLE_RATE },
				},
			},
			tools: [
				{
					type: "function",
					name: "client_delegate",
					description:
						"Delegate repository work, coding, tool use, command execution, or investigation to the client backend.",
					parameters: {
						type: "object",
						properties: {
							request: {
								type: "string",
								description: "The complete plain-language user request or task to execute.",
							},
						},
						required: ["request"],
					},
				},
			],
		},
	};
}

/** Native WebSocket transport powering Grok Realtime voice sessions (`grok-voice-think-fast-2.0`). */
export class GrokLiveTransport implements ILiveTransport {
	readonly identity: LiveTransportIdentity;
	readonly #options: LiveTransportOptions;
	#socket: Bun.WebSocket | undefined;
	#playback: AudioPlayback | undefined;
	#state: Lifecycle = "idle";
	#connectPromise: Promise<void> | undefined;
	#closePromise: Promise<void> | undefined;
	#sendTail: Promise<void> = Promise.resolve();
	#muted = false;
	#unexpectedFailureReported = false;
	#assistantTranscript = "";
	#realtimeSessionId: string | undefined;
	#outputActiveUntil = 0;
	#outputIdleTimer: NodeJS.Timeout | undefined;
	readonly #delegationContext = new Map<string, string[]>();
	readonly #queuedFunctionCalls: PendingFunctionCall[] = [];
	readonly #pendingFunctionOutputIds = new Set<string>();
	readonly #abortListener: () => void;

	constructor(options: LiveTransportOptions) {
		this.#options = options;
		this.#abortListener = () => {
			void this.close();
		};
		const model = options.model?.trim() || DEFAULT_GROK_REALTIME_MODEL;
		this.identity = {
			voiceProvider: "grok",
			api: "openai-completions",
			provider: "xai",
			model,
		};
		if (!options.signal?.aborted) {
			options.signal?.addEventListener("abort", this.#abortListener, { once: true });
		}
	}

	/** Resolve credentials and establish the WebSocket connection to xAI Realtime API. */
	connect(): Promise<void> {
		if (this.#state === "connected") return Promise.resolve();
		if (this.#connectPromise) return this.#connectPromise;
		if (this.#state === "closing" || this.#state === "closed") {
			return Promise.reject(new Error("Grok live transport is closed"));
		}
		if (this.#options.signal?.aborted) {
			const signal = this.#options.signal;
			const reason =
				signal.reason instanceof Error ? signal.reason : new DOMException("Live connection aborted", "AbortError");
			return Promise.reject(reason);
		}
		this.#state = "connecting";
		const operation = this.#connect().catch(async error => {
			await this.close();
			throw error;
		});
		this.#connectPromise = operation;
		return operation;
	}

	async #connect(): Promise<void> {
		const apiKey =
			(await this.#options.authStorage.getApiKey("xai-oauth", this.#options.sessionId)) ||
			$env.XAI_API_KEY ||
			(await this.#options.authStorage.getApiKey("xai", this.#options.sessionId));

		if (!apiKey) {
			throw new Error(
				"Grok Voice realtime mode requires xAI Grok OAuth (/login xai-oauth) or XAI_API_KEY.",
			);
		}

		const url = `${REALTIME_BASE_URL}?model=${encodeURIComponent(this.identity.model)}`;

		if (typeof AudioPlayback !== "function") {
			throw new Error(
				"Speaker playback is unavailable because the installed native bindings do not include AudioPlayback.",
			);
		}
		try {
			this.#playback = new AudioPlayback(OUTPUT_SAMPLE_RATE);
		} catch (cause) {
			const detail = cause instanceof Error ? cause.message : String(cause);
			throw new Error(`Speaker output initialization failed: ${detail}`, { cause });
		}

		const socketOptions = {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"User-Agent": "oh-my-pi/grok-live",
			},
			proxy: getProxyForUrl("xai", new URL(url)),
		} satisfies Bun.WebSocketOptions;

		const socket: Bun.WebSocket = Reflect.construct(WebSocket, [url, socketOptions]);
		socket.binaryType = "nodebuffer";
		this.#socket = socket;

		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let opened = false;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;

		const cleanup = (): void => {
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			this.#options.signal?.removeEventListener("abort", onAbort);
		};

		const rejectConnect = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};

		const onAbort = (): void => {
			socket.close(1000, "aborted");
			const signal = this.#options.signal;
			const reason =
				signal?.reason instanceof Error ? signal.reason : new DOMException("Live connection aborted", "AbortError");
			rejectConnect(reason);
		};

		socket.onopen = () => {
			if (settled || this.#state !== "connecting" || this.#socket !== socket) {
				socket.close(1000, "stale");
				return;
			}
			opened = true;
			settled = true;
			cleanup();
			this.#state = "connected";

			// Initialize session parameters
			this.#sendSessionUpdate();
			resolve();
		};

		socket.onmessage = event => {
			if (typeof event.data !== "string") {
				this.#reportFailure("Grok realtime API returned an unexpected binary WebSocket frame.");
				return;
			}
			this.handleServerMessage(event.data);
		};

		socket.onerror = event => {
			const detail = event instanceof ErrorEvent && event.message ? `: ${event.message}` : "";
			if (!opened) {
				rejectConnect(new Error(`Grok realtime connection failed${detail}`));
				socket.close(1011, "connection failed");
				return;
			}
			this.#reportFailure(`Grok realtime WebSocket failed${detail}`);
		};

		socket.onclose = event => {
			if (!opened) {
				rejectConnect(new Error(`Grok realtime closed before connecting (${event.code})`));
				return;
			}
			if (this.#socket !== socket) return;
			this.#socket = undefined;
			if (this.#state === "connecting" || this.#state === "connected") {
				const detail = event.reason ? `: ${event.reason}` : "";
				this.#reportFailure(`Grok realtime WebSocket closed (${event.code})${detail}`);
			}
		};

		if (this.#options.signal?.aborted) {
			onAbort();
		} else {
			this.#options.signal?.addEventListener("abort", onAbort, { once: true });
			timeout = setTimeout(() => {
				socket.close(1000, "connect timeout");
				rejectConnect(new Error("Grok realtime connection timed out"));
			}, CONNECT_TIMEOUT_MS);
			timeout.unref?.();
		}

		await promise;
	}

	#sendSessionUpdate(): void {
		this.#sendRaw(buildGrokSessionUpdate(this.#options.instructions, this.#options.voice));
	}

	handleServerMessage(raw: string): void {
		if (this.#state === "closing" || this.#state === "closed") return;
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(raw);
		} catch {
			return;
		}

		const type = String(payload.type ?? "");

		switch (type) {
			case "session.created": {
				const sessionObj =
					typeof payload.session === "object" && payload.session
						? (payload.session as Record<string, unknown>)
						: {};
				this.#realtimeSessionId = String(sessionObj.id ?? crypto.randomUUID());
				this.#options.callbacks.onEvent({
					type: "session.started",
					session: { id: this.#realtimeSessionId },
				});
				break;
			}
			case "session.updated": {
				const sessionObj =
					typeof payload.session === "object" && payload.session
						? (payload.session as Record<string, unknown>)
						: {};
				const instructions = typeof sessionObj.instructions === "string" ? sessionObj.instructions : undefined;
				this.#options.callbacks.onEvent({
					type: "session.updated",
					session: {
						id: this.#realtimeSessionId ?? crypto.randomUUID(),
						...(instructions === undefined ? {} : { instructions }),
					},
				});
				break;
			}
			case "input_audio_buffer.speech_started": {
				this.#clearPlayback();
				break;
			}
			case "conversation.item.input_audio_transcription.completed": {
				const transcript = String(payload.transcript ?? "").trim();
				if (transcript) {
					this.#options.callbacks.onEvent({
						type: "input_transcript.added",
						item: { text: transcript },
					});
					this.#options.callbacks.onEvent({
						type: "turn.done",
						turn: { role: "user", transcript },
					});
				}
				break;
			}
			case "response.output_audio_transcript.delta": {
				const delta = String(payload.delta ?? "");
				if (delta) {
					this.#assistantTranscript += delta;
					this.#options.callbacks.onEvent({
						type: "output_transcript.added",
						item: { text: delta },
					});
				}
				break;
			}
			case "response.output_audio_transcript.done": {
				const transcript = (String(payload.transcript ?? "") || this.#assistantTranscript).trim();
				this.#assistantTranscript = "";
				if (transcript) {
					this.#options.callbacks.onEvent({
						type: "turn.done",
						turn: { role: "assistant", transcript },
					});
				}
				break;
			}
			case "response.output_audio.delta": {
				const delta = String(payload.delta ?? "");
				if (delta) {
					this.#handleAudioOutput(delta);
				}
				break;
			}
			case "response.output_audio.done":
				break;
			case "response.function_call_arguments.done": {
				const callId = String(payload.call_id ?? payload.item_id ?? crypto.randomUUID());
				let request = "";
				try {
					const args = JSON.parse(String(payload.arguments ?? "{}"));
					request = String(args.request ?? "").trim();
				} catch {}
				this.#queuedFunctionCalls.push({ callId, request });
				break;
			}
			case "response.done":
				this.#dispatchFunctionCalls();
				break;
			case "error": {
				const errObj =
					typeof payload.error === "object" && payload.error ? (payload.error as Record<string, unknown>) : {};
				const message = String(errObj.message ?? payload.message ?? "Grok realtime error");
				this.#reportFailure(message);
				break;
			}
		}
	}

	#dispatchFunctionCalls(): void {
		if (this.#queuedFunctionCalls.length === 0) return;
		// Live instructions tell Grok to create a new delegation while work is
		// still running. The session controller only tracks one active
		// delegation id, so extra batches wait instead of aborting the call.
		if (this.#pendingFunctionOutputIds.size > 0) return;

		const calls = this.#queuedFunctionCalls.splice(0);
		if (calls.some(call => !call.request)) {
			this.#reportFailure("Grok function call omitted the required delegation request.");
			return;
		}
		for (const { callId } of calls) {
			this.#pendingFunctionOutputIds.add(callId);
			this.#delegationContext.set(callId, []);
		}
		for (const { callId, request } of calls) {
			this.#options.callbacks.onEvent({
				type: "delegation.created",
				item: {
					type: "delegation",
					target: "client",
					id: callId,
					content: [{ type: "input_text", text: request }],
				},
			});
		}
	}

	#completeFunctionCall(callId: string, output: string): void {
		if (!this.#pendingFunctionOutputIds.delete(callId)) return;
		this.#delegationContext.delete(callId);
		this.#sendRaw({
			type: "conversation.item.create",
			item: {
				type: "function_call_output",
				call_id: callId,
				output,
			},
		});
		if (this.#pendingFunctionOutputIds.size > 0) return;
		if (this.#queuedFunctionCalls.length > 0) {
			this.#dispatchFunctionCalls();
			return;
		}
		this.#sendRaw({ type: "response.create" });
	}

	#handleAudioOutput(base64Pcm: string): void {
		let pcmBuffer: Buffer;
		try {
			pcmBuffer = Buffer.from(base64Pcm, "base64");
		} catch {
			return;
		}

		const numSamples = Math.floor(pcmBuffer.length / 2);
		if (numSamples === 0) return;

		const float32Samples = new Float32Array(numSamples);
		let sumSq = 0;
		for (let i = 0; i < numSamples; i++) {
			const sample = pcmBuffer.readInt16LE(i * 2) / 32768.0;
			float32Samples[i] = sample;
			sumSq += sample * sample;
		}

		const rms = Math.sqrt(sumSq / numSamples);
		this.#options.callbacks.onOutputLevel(Math.min(1, Math.max(0, rms * 3.5)));
		const now = performance.now();
		this.#outputActiveUntil = Math.max(now, this.#outputActiveUntil) + (numSamples / OUTPUT_SAMPLE_RATE) * 1_000;
		clearTimeout(this.#outputIdleTimer);
		this.#outputIdleTimer = setTimeout(() => {
			this.#outputIdleTimer = undefined;
			this.#outputActiveUntil = 0;
			this.#options.callbacks.onOutputLevel(0);
		}, this.#outputActiveUntil - now);
		this.#outputIdleTimer.unref?.();

		if (this.#playback) {
			try {
				this.#playback.write(float32Samples);
			} catch {}
		}
	}

	#clearPlayback(): void {
		if (this.#outputIdleTimer) {
			clearTimeout(this.#outputIdleTimer);
			this.#outputIdleTimer = undefined;
		}
		this.#outputActiveUntil = 0;
		this.#options.callbacks.onOutputLevel(0);
		if (this.#playback) {
			try {
				this.#playback.stop();
			} catch {}
			if (typeof AudioPlayback === "function") {
				try {
					this.#playback = new AudioPlayback(OUTPUT_SAMPLE_RATE);
				} catch {}
			}
		}
	}

	#sendRaw(payload: Record<string, unknown>): void {
		const socket = this.#socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) return;
		try {
			socket.send(JSON.stringify(payload));
		} catch {}
	}

	#reportFailure(message: string): void {
		if ((this.#state !== "connecting" && this.#state !== "connected") || this.#unexpectedFailureReported) {
			return;
		}
		this.#unexpectedFailureReported = true;
		try {
			this.#options.callbacks.onEvent({ type: "error", message });
		} catch {}
	}

	/** Send context appends or close message to Grok realtime session. */
	send(message: LiveClientMessage): Promise<void> {
		const operation = this.#sendTail.then(() => {
			if (this.#state !== "connected") throw new Error("Grok live transport is not connected");

			if (message.type === "session.close") {
				void this.close();
				return;
			}

			const text = message.content
				.filter(item => item.type === "input_text")
				.map(item => item.text)
				.join("\n")
				.trim();
			if (!text) return;

			if (message.type === "delegation.context.append") {
				const context = this.#delegationContext.get(message.delegation_item_id);
				if (!context) return;
				context.push(text);
				if (message.channel !== "speakable") return;
				this.#completeFunctionCall(message.delegation_item_id, context.join("\n"));
				return;
			}

			this.#sendRaw({
				type: "conversation.item.create",
				item: {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text }],
				},
			});
			this.#sendRaw({ type: "response.create" });
		});
		this.#sendTail = operation.catch(() => {});
		return operation;
	}

	/** xAI server VAD receives every unmuted frame, including while output is playing. */
	shouldStreamAudio(_inputLevel: number, _outputLevel: number): boolean {
		return true;
	}

	/** Stream unscaled 16 kHz mono PCM for provider-managed VAD and interruption handling. */
	pushAudio(samples: Float32Array): void {
		if (this.#state !== "connected" || this.#muted || samples.length === 0) return;
		const int16Buffer = Buffer.allocUnsafe(samples.length * 2);
		for (let i = 0; i < samples.length; i++) {
			const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
			int16Buffer.writeInt16LE(sample < 0 ? sample * 0x8000 : sample * 0x7fff, i * 2);
		}
		this.#sendRaw({
			type: "input_audio_buffer.append",
			audio: int16Buffer.toString("base64"),
		});
	}

	/** Mute or unmute microphone audio. */
	async setMuted(muted: boolean): Promise<void> {
		this.#muted = muted;
	}

	/** Close WebSocket and speaker playback cleanly. */
	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#state = "closing";
		const operation = this.#close();
		this.#closePromise = operation;
		return operation;
	}

	async #close(): Promise<void> {
		this.#options.signal?.removeEventListener("abort", this.#abortListener);
		if (this.#outputIdleTimer) {
			clearTimeout(this.#outputIdleTimer);
			this.#outputIdleTimer = undefined;
		}
		const socket = this.#socket;
		const playback = this.#playback;
		this.#socket = undefined;
		this.#playback = undefined;
		this.#queuedFunctionCalls.length = 0;
		this.#pendingFunctionOutputIds.clear();
		this.#delegationContext.clear();

		if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
			try {
				socket.close(1000, "done");
			} catch {}
		}

		if (playback) {
			try {
				playback.stop();
			} catch {}
		}
		this.#state = "closed";
	}
}
