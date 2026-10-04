import { type } from "@oh-my-pi/omptype";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { getProxyForUrl } from "@oh-my-pi/pi-ai/utils/proxy";
import { AudioPlayback } from "@oh-my-pi/pi-natives";
import { decodePcm16, encodePcm16 } from "../stt/wav";
import type { LiveClientMessage } from "./protocol";
import { type GeminiFunctionCall, geminiServerMessage, geminiToolArguments } from "./gemini-wire";
import type { LiveTransportCallbacks } from "./transport";
import delegateDescription from "./prompts/gemini-delegate.md" with { type: "text" };

type Playback = Pick<AudioPlayback, "write" | "stop">;

export interface GeminiLiveTransportOptions {
	authStorage: AuthStorage;
	sessionId: string;
	model: string;
	voice: string;
	thinkingLevel: "low" | "medium" | "high";
	instructions: string;
	callbacks: LiveTransportCallbacks;
	/** Dependency seams for local protocol smoke runs without microphone/speaker access. */
	createSocket?: (url: string, options: Bun.WebSocketOptions) => WebSocket;
	createPlayback?: () => Playback;
}

/** Gemini's persistent websocket/audio transport; async tools outlive individual spoken turns. */
export class GeminiLiveTransport {
	readonly #options: GeminiLiveTransportOptions;
	readonly #ready = Promise.withResolvers<void>();
	readonly #pending = new Set<string>();
	#socket: WebSocket | undefined;
	#playback: Playback | undefined;
	#connectPromise: Promise<void> | undefined;
	#connected = false;
	#closed = false;
	#muted = false;
	#key = "";
	#userTranscript = "";
	#assistantTranscript = "";
	#delegationId: string | undefined;
	#receiveTail: Promise<void> = Promise.resolve();
	#outputTimer: NodeJS.Timeout | undefined;
	#outputEndAt = 0;

	constructor(options: GeminiLiveTransportOptions) {
		this.#options = options;
		// A stop before connect must not create an unhandled rejection.
		void this.#ready.promise.catch(() => undefined);
	}

	connect(): Promise<void> {
		this.#connectPromise ??= this.#connect().catch(async cause => {
			const error = new Error(
				this.#redact(cause instanceof Error ? cause.message : "Gemini Live connection failed"),
			);
			await this.close();
			throw error;
		});
		return this.#connectPromise;
	}

	async #connect(): Promise<void> {
		if (this.#closed) throw new Error("Gemini Live transport is closed");
		const key = await this.#options.authStorage.keys.get("google", this.#options.sessionId);
		if (!key?.trim())
			throw new Error("Gemini Live requires a Google AI Studio API key; use /login or GEMINI_API_KEY.");
		if (this.#closed) throw new Error("Gemini Live stopped while resolving credentials");
		this.#key = key;
		const url = new URL(ENDPOINT);
		url.searchParams.set("key", key);
		const options: Bun.WebSocketOptions = { proxy: getProxyForUrl("google", url) };
		const socket = this.#options.createSocket
			? this.#options.createSocket(url.toString(), options)
			: (Reflect.construct(WebSocket, [url.toString(), options]) as WebSocket);
		this.#socket = socket;
		const timeout = setTimeout(
			() => this.#ready.reject(new Error("Gemini Live setup timed out")),
			CONNECT_TIMEOUT_MS,
		);
		socket.addEventListener("open", () => {
			if (this.#closed) return;
			try {
				const functionDeclarations = [
					{
						name: "delegate",
						description: delegateDescription,
						behavior: "NON_BLOCKING",
						parameters: { type: "OBJECT", properties: { request: { type: "STRING" } }, required: ["request"] },
					},
				];
				socket.send(
					JSON.stringify({
						setup: {
							model: `models/${this.#options.model.replace(/^models\//, "")}`,
							generationConfig: {
								responseModalities: ["AUDIO"],
								speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.#options.voice } } },
								thinkingConfig: { thinkingLevel: this.#options.thinkingLevel.toUpperCase() },
							},
							systemInstruction: { parts: [{ text: this.#options.instructions }] },
							inputAudioTranscription: {},
							outputAudioTranscription: {},
							tools: [{ functionDeclarations }],
						},
					}),
				);
			} catch {
				this.#fail("Gemini Live setup could not be sent");
			}
		});
		socket.addEventListener("message", event => {
			this.#receiveTail = this.#receiveTail
				.then(async () => {
					if (this.#closed) return;
					const data: unknown = event.data;
					let text: string;
					if (typeof data === "string") text = data;
					else if (data instanceof Blob) text = await data.text();
					else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data))
						text = UTF8_DECODER.decode(data as NodeJS.AllowSharedBufferSource);
					else throw new Error("Gemini Live returned an unsupported websocket payload");
					this.#handleMessage(JSON.parse(text));
				})
				.catch(cause => this.#fail(cause instanceof Error ? cause.message : "Gemini Live message failed"));
		});
		socket.addEventListener("error", () => this.#fail("Gemini Live websocket connection failed"));
		socket.addEventListener("close", event => {
			if (!this.#closed)
				this.#fail(`Gemini Live connection closed (${event.code})${event.reason ? `: ${event.reason}` : ""}`);
		});
		try {
			await this.#ready.promise;
		} finally {
			clearTimeout(timeout);
		}
	}

	pushAudio(samples: Float32Array): void {
		if (this.#muted || this.#closed) return;
		if ((this.#socket?.bufferedAmount ?? 0) > MAX_BUFFERED_AUDIO_BYTES) {
			throw new Error("Gemini Live audio connection cannot keep up with microphone input");
		}
		const bytes = encodePcm16(samples);
		this.#send({
			realtimeInput: {
				audio: {
					data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
					mimeType: "audio/pcm;rate=16000",
				},
			},
		});
	}

	async setMuted(muted: boolean): Promise<void> {
		this.#muted = muted;
		if (muted && this.#connected && !this.#closed) this.#send({ realtimeInput: { audioStreamEnd: true } });
	}

	async send(message: LiveClientMessage): Promise<void> {
		if (message.type === "session.close") {
			await this.close();
		} else if (message.type === "session.context.append") {
			this.#send({ realtimeInput: { text: message.content.map(part => part.text).join("\n") } });
		}
		// Delegation progress stays local. Only the complete result fulfills its async function call.
	}

	async completeDelegation(id: string, text: string): Promise<void> {
		if (this.#delegationId !== id || !this.#pending.has(id)) return;
		this.#respond(id, "delegate", { result: text });
		this.#pending.delete(id);
		this.#delegationId = undefined;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#connected = false;
		this.#ready.reject(new Error("Gemini Live transport is closed"));
		this.#pending.clear();
		this.#socket?.close();
		this.#socket = undefined;
		this.#stopPlayback();
		this.#key = "";
	}

	#send(payload: unknown): void {
		if (this.#closed || !this.#connected || this.#socket?.readyState !== WebSocket.OPEN) {
			throw new Error("Gemini Live transport is not connected");
		}
		this.#socket.send(JSON.stringify(payload));
	}

	#respond(id: string, name: string, response: Record<string, unknown>): void {
		this.#send({ toolResponse: { functionResponses: [{ id, name, response }] } });
	}

	#handleMessage(raw: unknown): void {
		const payload = geminiServerMessage(raw);
		if (payload instanceof type.errors) throw new Error("Gemini Live returned an invalid server message");
		if (payload.error) {
			throw new Error(payload.error.message ?? "Gemini Live request failed");
		}
		if (payload.setupComplete) {
			this.#connected = true;
			this.#ready.resolve();
			this.#options.callbacks.onEvent({ type: "session.started", session: { id: this.#options.sessionId } });
		}
		const content = payload.serverContent;
		if (content) {
			if (content.interrupted === true) this.#stopPlayback();
			for (const role of ["user", "assistant"] as const) {
				const transcription = role === "user" ? content.inputTranscription : content.outputTranscription;
				if (transcription) {
					if (!(role === "user" ? this.#userTranscript : this.#assistantTranscript)) {
						this.#options.callbacks.onEvent({ type: "transcript.started", role });
					}
					if (role === "user") this.#userTranscript += transcription.text;
					else this.#assistantTranscript += transcription.text;
					this.#options.callbacks.onEvent({
						type: role === "user" ? "input_transcript.added" : "output_transcript.added",
						item: { text: role === "user" ? this.#userTranscript : this.#assistantTranscript },
					});
					if (transcription.finished === true) this.#finishTranscript(role);
				}
			}
			if (content.modelTurn?.parts) {
				for (const part of content.modelTurn.parts) {
					if (!part.inlineData) continue;
					const { data, mimeType } = part.inlineData;
					if (!mimeType.startsWith("audio/pcm")) continue;
					const rate = /(?:^|;)rate=(\d+)/.exec(mimeType)?.[1];
					if (rate !== undefined && rate !== "24000")
						throw new Error(`Unsupported Gemini Live audio rate: ${rate}`);
					this.#playAudio(data);
				}
			}
			if (content.turnComplete === true) {
				this.#finishTranscript("user");
				this.#finishTranscript("assistant");
			}
			const status = content.interactionStatus ?? content.interaction_status;
			if (status === "IN_PROGRESS" || status === "IDLE") {
				this.#options.callbacks.onEvent({ type: "interaction.status", working: status === "IN_PROGRESS" });
			}
		}
		const cancellation = payload.toolCallCancellation;
		if (cancellation) {
			for (const id of cancellation.ids) {
				this.#pending.delete(id);
				if (this.#delegationId === id) {
					this.#delegationId = undefined;
					this.#options.callbacks.onEvent({ type: "delegation.cancelled", id });
				}
			}
		}
		const toolCall = payload.toolCall;
		if (toolCall) {
			for (const call of toolCall.functionCalls) this.#handleToolCall(call);
		}
	}

	#handleToolCall(call: GeminiFunctionCall): void {
		const { id, name } = call;
		if (this.#pending.has(id)) return;
		const args = geminiToolArguments(call.args ?? {});
		if (args instanceof type.errors) {
			this.#respond(id, name, { error: "Invalid tool arguments" });
			return;
		}
		if (name === "delegate") {
			if (typeof args.request !== "string" || !args.request.trim()) {
				this.#respond(id, name, { error: "request must be a non-empty string" });
			} else if (this.#delegationId) {
				this.#respond(id, name, {
					error: "A delegated task is still running; wait for its result before delegating another task.",
				});
			} else {
				this.#pending.add(id);
				this.#delegationId = id;
				this.#options.callbacks.onEvent({
					type: "delegation.created",
					item: {
						type: "delegation",
						target: "client",
						id,
						content: [{ type: "input_text", text: args.request }],
					},
				});
			}
			return;
		}
		this.#respond(id, name, { error: "Unknown or disabled tool" });
	}

	#finishTranscript(role: "user" | "assistant"): void {
		const transcript = role === "user" ? this.#userTranscript : this.#assistantTranscript;
		if (!transcript) return;
		this.#options.callbacks.onEvent({ type: "turn.done", turn: { role, transcript } });
		if (role === "user") this.#userTranscript = "";
		else this.#assistantTranscript = "";
	}

	#playAudio(data: string): void {
		const samples = decodePcm16(Buffer.from(data, "base64"));
		this.#playback ??= this.#options.createPlayback?.() ?? new AudioPlayback(24_000);
		this.#playback.write(samples);
		let squares = 0;
		for (const sample of samples) squares += sample * sample;
		this.#options.callbacks.onOutputLevel(samples.length ? Math.sqrt(squares / samples.length) : 0);
		this.#outputEndAt = Math.max(Date.now(), this.#outputEndAt) + samples.length / 24;
		clearTimeout(this.#outputTimer);
		this.#outputTimer = setTimeout(
			() => {
				this.#options.callbacks.onOutputLevel(0);
			},
			Math.max(0, this.#outputEndAt - Date.now()),
		);
	}

	#stopPlayback(): void {
		clearTimeout(this.#outputTimer);
		this.#outputTimer = undefined;
		this.#outputEndAt = 0;
		this.#playback?.stop();
		this.#playback = undefined;
		this.#options.callbacks.onOutputLevel(0);
	}

	#redact(message: string): string {
		if (!this.#key) return message;
		return message.replaceAll(this.#key, "[redacted]").replaceAll(encodeURIComponent(this.#key), "[redacted]");
	}

	#fail(message: string): void {
		if (this.#closed) return;
		const safe = this.#redact(message);
		this.#ready.reject(new Error(safe));
		this.#options.callbacks.onEvent({ type: "error", message: safe });
		void this.close();
	}
}
