import { type } from "@oh-my-pi/omptype";
import type { AuthStorage, ImageContent } from "@oh-my-pi/pi-ai";
import { getProxyForUrl } from "@oh-my-pi/pi-ai/utils/proxy";
import { AudioPlayback } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { resizeImage } from "../utils/image-resize";
import { decodePcm16, encodePcm16 } from "../stt/wav";
import type { LiveClientMessage } from "./protocol";
import {
	geminiCancelArguments,
	geminiDelegateArguments,
	geminiDesktopArguments,
	geminiExecuteArguments,
	type GeminiFunctionCall,
	geminiServerMessage,
} from "./gemini-wire";
import type { GeminiLiveExecution, GeminiLiveExecutionResult } from "./execution";
import type { LiveTransportCallbacks } from "./transport";
import cancelDescription from "./prompts/gemini-cancel.md" with { type: "text" };
import delegateDescription from "./prompts/gemini-delegate.md" with { type: "text" };
import desktopDescription from "./prompts/gemini-desktop.md" with { type: "text" };
import executeDescription from "./prompts/gemini-execute.md" with { type: "text" };

const ENDPOINT =
	"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const CONNECT_TIMEOUT_MS = 20_000;
const SOCKET_LOW_WATER_BYTES = 64 * 1024;
/** One second of 16 kHz input bounds latency while retaining the newest speech under congestion. */
const MAX_QUEUED_AUDIO_SAMPLES = 16_000;
const AUDIO_BURST = 8;
const SEND_PACE_MS = 5;
const MAX_SCREENSHOT_BYTES = 192 * 1024;
const MAX_SCREENSHOT_DIMENSION = 8_192;
const UTF8_DECODER = new TextDecoder();

type Playback = Pick<AudioPlayback, "write" | "stop">;

type ExecutionSurface = Pick<
	GeminiLiveExecution,
	"codeEnabled" | "desktopEnabled" | "executeCode" | "executeDesktop" | "close"
>;

interface OutboundEntry {
	serialized: string;
	audioSamples?: number;
	valid?: () => boolean;
	onSent?: () => void;
}

interface PendingWork {
	name: string;
	controller?: AbortController;
	promise?: Promise<void>;
	delegation: boolean;
}

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
	getBufferedAmount?: (socket: WebSocket) => number;
	execution?: ExecutionSurface;
}

/** Gemini's persistent websocket/audio transport; async tools outlive individual spoken turns. */
export class GeminiLiveTransport {
	readonly #options: GeminiLiveTransportOptions;
	readonly #ready = Promise.withResolvers<void>();
	readonly #pending = new Map<string, PendingWork>();
	readonly #audioQueue: OutboundEntry[] = [];
	readonly #controlQueue: OutboundEntry[] = [];
	#socket: WebSocket | undefined;
	#playback: Playback | undefined;
	#connectPromise: Promise<void> | undefined;
	#closePromise: Promise<void> | undefined;
	#connected = false;
	#closed = false;
	#muted = false;
	#key = "";
	#userTranscript = "";
	#assistantTranscript = "";
	#delegationId: string | undefined;
	#receiveTail: Promise<void> = Promise.resolve();
	#outputTimer: NodeJS.Timeout | undefined;
	#sendTimer: NodeJS.Timeout | undefined;
	#outputEndAt = 0;
	#queuedAudioSamples = 0;
	#audioBurst = 0;

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
				const functionDeclarations: Array<Record<string, unknown>> = [
					{
						name: "delegate",
						description: delegateDescription,
						behavior: "NON_BLOCKING",
						parameters: { type: "OBJECT", properties: { request: { type: "STRING" } }, required: ["request"] },
					},
				];
				if (this.#options.execution?.codeEnabled) {
					functionDeclarations.push({
						name: "execute",
						description: executeDescription,
						behavior: "NON_BLOCKING",
						parameters: {
							type: "OBJECT",
							properties: {
								code: { type: "STRING" },
								language: { type: "STRING", enum: ["js", "py"] },
							},
							required: ["code", "language"],
						},
					});
				}
				if (this.#options.execution?.desktopEnabled) {
					functionDeclarations.push({
						name: "desktop",
						description: desktopDescription,
						behavior: "NON_BLOCKING",
						parameters: {
							type: "OBJECT",
							properties: { code: { type: "STRING" }, read_only: { type: "BOOLEAN" } },
							required: ["code"],
						},
					});
				}
				functionDeclarations.push({
					name: "cancel",
					description: cancelDescription,
					behavior: "NON_BLOCKING",
					parameters: { type: "OBJECT", properties: { id: { type: "STRING" } } },
				});
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
		if (this.#muted || this.#closed || samples.length === 0) return;
		const current =
			samples.length > MAX_QUEUED_AUDIO_SAMPLES
				? samples.subarray(samples.length - MAX_QUEUED_AUDIO_SAMPLES)
				: samples;
		const bytes = encodePcm16(current);
		this.#enqueueAudio(
			{
				realtimeInput: {
					audio: {
						data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
						mimeType: "audio/pcm;rate=16000",
					},
				},
			},
			current.length,
		);
	}

	async setMuted(muted: boolean): Promise<void> {
		this.#muted = muted;
		if (muted) {
			this.#audioQueue.length = 0;
			this.#queuedAudioSamples = 0;
			if (this.#connected && !this.#closed) this.#enqueueControl({ realtimeInput: { audioStreamEnd: true } }, true);
		}
	}

	async send(message: LiveClientMessage): Promise<void> {
		if (message.type === "session.close") {
			await this.close();
		} else if (message.type === "session.context.append") {
			this.#enqueueControl({ realtimeInput: { text: message.content.map(part => part.text).join("\n") } });
		}
		// Delegation progress stays local. Only the complete result fulfills its async function call.
	}

	async completeDelegation(id: string, text: string): Promise<void> {
		const work = this.#pending.get(id);
		if (!work?.delegation || this.#delegationId !== id) return;
		this.#queueWorkResponse(id, work, "delegate", { result: text });
	}

	close(): Promise<void> {
		this.#closePromise ??= this.#close();
		return this.#closePromise;
	}

	async #close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#connected = false;
		this.#ready.reject(new Error("Gemini Live transport is closed"));
		clearTimeout(this.#sendTimer);
		this.#sendTimer = undefined;
		this.#audioQueue.length = 0;
		this.#controlQueue.length = 0;
		this.#queuedAudioSamples = 0;
		const drains = [...this.#pending.keys()].map(id => this.#cancelWork(id, true));
		await Promise.allSettled(drains);
		await this.#options.execution?.close();
		this.#socket?.close();
		this.#socket = undefined;
		this.#stopPlayback();
		this.#key = "";
	}

	#enqueueAudio(payload: unknown, sampleCount: number): void {
		const entry: OutboundEntry = { serialized: JSON.stringify(payload), audioSamples: sampleCount };
		while (this.#audioQueue.length > 0 && this.#queuedAudioSamples + sampleCount > MAX_QUEUED_AUDIO_SAMPLES) {
			this.#queuedAudioSamples -= this.#audioQueue.shift()!.audioSamples ?? 0;
		}
		this.#audioQueue.push(entry);
		this.#queuedAudioSamples += sampleCount;
		this.#scheduleDrain();
	}

	#enqueueControl(payload: unknown, first = false, valid?: () => boolean, onSent?: () => void): void {
		const entry = { serialized: JSON.stringify(payload), valid, onSent };
		if (first) this.#controlQueue.unshift(entry);
		else this.#controlQueue.push(entry);
		this.#scheduleDrain();
	}

	#scheduleDrain(delay = 0): void {
		if (this.#sendTimer || this.#closed) return;
		this.#sendTimer = setTimeout(() => {
			this.#sendTimer = undefined;
			this.#drainOutbound();
		}, delay);
	}

	#drainOutbound(): void {
		const socket = this.#socket;
		if (this.#closed || !this.#connected || socket?.readyState !== WebSocket.OPEN) return;
		const bufferedAmount = this.#options.getBufferedAmount?.(socket) ?? socket.bufferedAmount;
		if (bufferedAmount > SOCKET_LOW_WATER_BYTES) {
			this.#scheduleDrain(SEND_PACE_MS);
			return;
		}
		let entry: OutboundEntry | undefined;
		if (this.#audioQueue.length > 0 && (this.#audioBurst < AUDIO_BURST || this.#controlQueue.length === 0)) {
			entry = this.#audioQueue.shift();
			if (entry) this.#queuedAudioSamples -= entry.audioSamples ?? 0;
			this.#audioBurst++;
		} else {
			entry = this.#controlQueue.shift();
			this.#audioBurst = 0;
		}
		if (!entry) return;
		if (entry.valid?.() === false) {
			this.#scheduleDrain();
			return;
		}
		try {
			socket.send(entry.serialized);
			entry.onSent?.();
		} catch {
			this.#fail("Gemini Live message could not be sent");
			return;
		}
		if (this.#audioQueue.length > 0 || this.#controlQueue.length > 0) this.#scheduleDrain(SEND_PACE_MS);
	}

	#reportToolError(id: string, name: string, response: Record<string, unknown>): void {
		if (typeof response.error !== "string" || response.cancelled === true) return;
		const message = this.#redact(response.error);
		logger.warn("Gemini Live tool failed", { id, name, error: message });
		this.#options.callbacks.onToolError?.(name, message);
	}

	#respond(
		id: string,
		name: string,
		response: Record<string, unknown>,
		parts?: Array<{ inlineData: { data: string; mimeType: string } }>,
	): void {
		this.#reportToolError(id, name, response);
		this.#enqueueControl({
			toolResponse: {
				functionResponses: [{ id, name, response, ...(parts?.length ? { parts } : {}) }],
			},
		});
	}

	#queueWorkResponse(
		id: string,
		work: PendingWork,
		name: string,
		response: Record<string, unknown>,
		parts?: Array<{ inlineData: { data: string; mimeType: string } }>,
	): void {
		this.#reportToolError(id, name, response);
		this.#enqueueControl(
			{
				toolResponse: {
					functionResponses: [{ id, name, response, ...(parts?.length ? { parts } : {}) }],
				},
			},
			false,
			() => this.#pending.get(id) === work,
			() => {
				if (this.#pending.get(id) !== work) return;
				this.#pending.delete(id);
				if (this.#delegationId === id) this.#delegationId = undefined;
			},
		);
	}

	#handleMessage(raw: unknown): void {
		const payload = geminiServerMessage(raw);
		if (payload instanceof type.errors) throw new Error("Gemini Live returned an invalid server message");
		if (payload.error) throw new Error(payload.error.message ?? "Gemini Live request failed");
		if (payload.setupComplete) {
			this.#connected = true;
			this.#ready.resolve();
			this.#options.callbacks.onEvent({ type: "session.started", session: { id: this.#options.sessionId } });
			this.#scheduleDrain();
		}
		const content = payload.serverContent;
		if (content) {
			if (content.interrupted === true) this.#stopPlayback();
			if (content.interimInputTranscription) {
				this.#updateInputTranscript(content.interimInputTranscription.text, false);
			}
			if (content.inputTranscription) {
				this.#updateInputTranscript(content.inputTranscription.text, true);
			}
			if (content.outputTranscription) {
				if (!this.#assistantTranscript) {
					this.#options.callbacks.onEvent({ type: "transcript.started", role: "assistant" });
				}
				this.#assistantTranscript += content.outputTranscription.text;
				this.#options.callbacks.onEvent({
					type: "output_transcript.added",
					item: { text: this.#assistantTranscript },
				});
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
			if (content.generationComplete === true || content.interrupted === true) {
				this.#finishTranscript("assistant");
			}
			if (content.turnComplete === true) this.#finishTranscript("assistant");
			const status = content.interactionStatus ?? content.interaction_status;
			if (status === "IN_PROGRESS" || status === "IDLE") {
				this.#options.callbacks.onEvent({ type: "interaction.status", working: status === "IN_PROGRESS" });
			}
		}
		if (payload.toolCallCancellation) {
			for (const id of payload.toolCallCancellation.ids) {
				void this.#cancelWork(id, true).catch(cause =>
					this.#fail(cause instanceof Error ? cause.message : "Gemini Live cancellation failed"),
				);
			}
		}
		if (payload.toolCall) {
			for (const call of payload.toolCall.functionCalls) this.#handleToolCall(call);
		}
	}

	#handleToolCall(call: GeminiFunctionCall): void {
		const { id, name } = call;
		if (this.#pending.has(id)) return;
		logger.debug("Gemini Live tool requested", { id, name });
		if (name === "delegate") {
			const args = geminiDelegateArguments(call.args ?? {});
			if (args instanceof type.errors) {
				this.#respond(id, name, { error: "Invalid tool arguments" });
			} else if (typeof args.request !== "string" || !args.request.trim()) {
				this.#respond(id, name, { error: "request must be a non-empty string" });
			} else if (this.#delegationId) {
				this.#respond(id, name, {
					error: "A delegated task is still running; cancel it or wait for its result.",
				});
			} else {
				this.#pending.set(id, { name, delegation: true });
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
		if (name === "execute") {
			const args = geminiExecuteArguments(call.args ?? {});
			if (
				args instanceof type.errors ||
				typeof args.code !== "string" ||
				!args.code.trim() ||
				(args.language !== "js" && args.language !== "py")
			) {
				this.#respond(id, name, { error: "code must be non-empty and language must be js or py" });
			} else if (!this.#options.execution?.codeEnabled) {
				this.#respond(id, name, { error: "Direct code execution is disabled" });
			} else {
				this.#startDirect(id, name, signal =>
					this.#options.execution!.executeCode(args.code!, args.language!, signal),
				);
			}
			return;
		}
		if (name === "desktop") {
			const args = geminiDesktopArguments(call.args ?? {});
			if (args instanceof type.errors || typeof args.code !== "string" || !args.code.trim()) {
				this.#respond(id, name, { error: "code must be a non-empty string" });
			} else if (!this.#options.execution?.desktopEnabled) {
				this.#respond(id, name, { error: "Direct desktop control is disabled" });
			} else {
				this.#startDirect(id, name, signal =>
					this.#options.execution!.executeDesktop(args.code!, signal, args.read_only),
				);
			}
			return;
		}
		if (name === "cancel") {
			const args = geminiCancelArguments(call.args ?? {});
			if (args instanceof type.errors || (args.id !== undefined && !args.id.trim())) {
				this.#respond(id, name, { error: "id must be a non-empty string when provided" });
				return;
			}
			const controller = new AbortController();
			const work: PendingWork = { name, controller, delegation: false };
			this.#pending.set(id, work);
			work.promise = this.#runCancel(id, work, args.id);
			return;
		}
		this.#respond(id, name, { error: "Unknown or disabled tool" });
	}

	#startDirect(id: string, name: string, run: (signal: AbortSignal) => Promise<GeminiLiveExecutionResult>): void {
		const controller = new AbortController();
		const work: PendingWork = { name, controller, delegation: false };
		this.#pending.set(id, work);
		work.promise = (async () => {
			try {
				const result = await run(controller.signal);
				if (controller.signal.aborted || this.#pending.get(id) !== work) return;
				const imageResult = await this.#prepareImages(result.images, controller.signal);
				if (controller.signal.aborted || this.#pending.get(id) !== work) return;
				this.#queueWorkResponse(
					id,
					work,
					name,
					{ result: result.text, ...(imageResult.warning ? { image_warning: imageResult.warning } : {}) },
					imageResult.parts,
				);
			} catch (cause) {
				if (controller.signal.aborted || this.#pending.get(id) !== work) return;
				const message = cause instanceof Error ? cause.message : String(cause);
				this.#queueWorkResponse(id, work, name, { error: this.#redact(message) });
			}
		})();
	}

	async #prepareImages(
		images: GeminiLiveExecutionResult["images"],
		signal: AbortSignal,
	): Promise<{
		parts: Array<{ inlineData: { data: string; mimeType: string } }>;
		warning?: string;
	}> {
		const image = images.at(-1);
		if (!image || signal.aborted) return { parts: [] };
		const resized = await resizeImage(
			{ type: "image", data: image.data, mimeType: image.mimeType } satisfies ImageContent,
			{
				maxWidth: MAX_SCREENSHOT_DIMENSION,
				maxHeight: MAX_SCREENSHOT_DIMENSION,
				minDimension: 0,
				maxBytes: MAX_SCREENSHOT_BYTES,
				jpegQuality: 70,
				excludeWebP: true,
			},
		);
		if (signal.aborted) return { parts: [] };
		if (
			resized.decodeFailed ||
			resized.buffer.length > MAX_SCREENSHOT_BYTES ||
			resized.width !== resized.originalWidth ||
			resized.height !== resized.originalHeight
		) {
			return {
				parts: [],
				warning: "Screenshot omitted because it could not be compressed within the transport limit.",
			};
		}
		return {
			parts: [{ inlineData: { data: resized.data, mimeType: resized.mimeType } }],
			...(images.length > 1 ? { warning: "Only the latest screenshot is included." } : {}),
		};
	}

	async #runCancel(id: string, work: PendingWork, requestedId: string | undefined): Promise<void> {
		try {
			const targets = requestedId
				? requestedId === id || !this.#pending.has(requestedId)
					? []
					: [requestedId]
				: [...this.#pending.keys()].filter(target => target !== id);
			await Promise.all(targets.map(target => this.#cancelWork(target, false)));
			if (work.controller?.signal.aborted || this.#pending.get(id) !== work) return;
			const result =
				targets.length === 0
					? requestedId
						? `No pending work matched ${requestedId}.`
						: "No pending work was running."
					: `Stopped ${targets.length} pending ${targets.length === 1 ? "task" : "tasks"}.`;
			this.#queueWorkResponse(id, work, "cancel", { result });
		} catch (cause) {
			if (work.controller?.signal.aborted || this.#pending.get(id) !== work) return;
			this.#queueWorkResponse(id, work, "cancel", {
				error: this.#redact(cause instanceof Error ? cause.message : String(cause)),
			});
		}
	}

	async #cancelWork(id: string, fromServer: boolean): Promise<void> {
		const work = this.#pending.get(id);
		if (!work) return;
		this.#pending.delete(id);
		work.controller?.abort(new Error("Cancelled"));
		if (work.delegation) {
			if (this.#delegationId === id) this.#delegationId = undefined;
			if (this.#options.callbacks.onCancelDelegation) {
				await this.#options.callbacks.onCancelDelegation(id);
			} else {
				this.#options.callbacks.onEvent({ type: "delegation.cancelled", id });
			}
		}
		if (work.promise) await work.promise.catch(() => undefined);
		if (!fromServer && !this.#closed) {
			this.#respond(id, work.name, { error: "Task cancelled", cancelled: true });
		}
	}

	#updateInputTranscript(text: string, final: boolean): void {
		if (!text && !this.#userTranscript) return;
		if (!this.#userTranscript) {
			this.#options.callbacks.onEvent({ type: "transcript.started", role: "user" });
		}
		if (text !== this.#userTranscript) {
			this.#userTranscript = text;
			this.#options.callbacks.onEvent({
				type: "input_transcript.added",
				item: { text: this.#userTranscript },
			});
		}
		if (final) this.#finishTranscript("user");
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
		void this.close().catch(() => undefined);
	}
}
