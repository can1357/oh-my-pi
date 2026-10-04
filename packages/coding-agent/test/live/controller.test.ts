import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController, type LiveTranscript } from "@oh-my-pi/pi-coding-agent/live/controller";
import type { LiveClientMessage, LiveServerEvent } from "@oh-my-pi/pi-coding-agent/live/protocol";
import type { LiveTransport, LiveTransportCallbacks } from "@oh-my-pi/pi-coding-agent/live/transport";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

interface Completion {
	id: string;
	text: string;
}

class Inbox<T> {
	#values: T[] = [];
	#readers: Array<(value: T) => void> = [];

	push(value: T): void {
		const reader = this.#readers.shift();
		if (reader) reader(value);
		else this.#values.push(value);
	}

	next(): Promise<T> {
		const value = this.#values.shift();
		if (value !== undefined) return Promise.resolve(value);
		const pending = Promise.withResolvers<T>();
		this.#readers.push(pending.resolve);
		return pending.promise;
	}
}

class TestTransport implements LiveTransport {
	readonly completions = new Inbox<Completion>();
	readonly pushedAudio: Float32Array[] = [];
	readonly muted: boolean[] = [];
	readonly sent: LiveClientMessage[] = [];

	connect = async (): Promise<void> => undefined;
	pushAudio(samples: Float32Array): void {
		this.pushedAudio.push(samples);
	}
	async setMuted(muted: boolean): Promise<void> {
		this.muted.push(muted);
	}
	sendText = async (): Promise<void> => undefined;
	async send(message: LiveClientMessage): Promise<void> {
		this.sent.push(message);
	}
	close = async (): Promise<void> => undefined;
	async completeDelegation(id: string, text: string): Promise<void> {
		this.completions.push({ id, text });
	}
}

function delegation(id: string, request: string): LiveServerEvent {
	return {
		type: "delegation.created",
		item: { type: "delegation", target: "client", id, content: [{ type: "input_text", text: request }] },
	};
}

function assistantText(message: AssistantMessage): string {
	let text = "";
	for (const content of message.content) {
		if (content.type === "text") text += content.text;
	}
	return text;
}

describe("LiveSessionController delegation ownership", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let controller: LiveSessionController | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-live-controller-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("openai", "test-key");
	});

	afterEach(async () => {
		await controller?.stop();
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	async function harness(responses: MockHandler[], provider: "openai-codex" | "google" = "openai-codex") {
		const mock = createMockModel({ provider: "openai", id: "gpt-live-controller-test", responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const settings = Settings.isolated({
			"live.provider": provider,
			"compaction.enabled": false,
			"todo.enabled": false,
		});
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		const transport = new TestTransport();
		let transportCallbacks: LiveTransportCallbacks | undefined;
		let captureAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;
		const transcripts: LiveTranscript[] = [];
		controller = new LiveSessionController(
			{
				session,
				callbacks: {
					onPhase: () => undefined,
					onLevels: () => undefined,
					onTranscript: transcript => {
						if (transcript) transcripts.push(transcript);
					},
					onTerminal: () => undefined,
				},
				extractAssistantText: assistantText,
			},
			{
				createTransport: callbacks => {
					transportCallbacks = callbacks;
					return transport;
				},
				createRecorder: (_sampleRate, onAudio) => {
					captureAudio = onAudio;
					return { stop: () => undefined };
				},
			},
		);
		await controller.start();
		if (!transportCallbacks || !captureAudio) throw new Error("Live controller dependencies were not initialized");
		return {
			mock,
			transport,
			emit: (event: LiveServerEvent) => transportCallbacks!.onEvent(event),
			outputLevel: (level: number) => transportCallbacks!.onOutputLevel(level),
			captureAudio,
			transcripts,
		};
	}

	it("keeps a typed turn final when a superseded microphone transcript completes late", async () => {
		const h = await harness([]);
		h.emit({ type: "transcript.started", role: "user" });
		h.emit({ type: "input_transcript.added", item: { text: "partial voice" } });

		await controller!.sendText("typed question");
		expect(h.transcripts.at(-1)).toEqual({ role: "user", turn: 2, text: "typed question", final: true });

		h.emit({ type: "input_transcript.added", item: { text: "partial voice completed late" } });
		h.emit({ type: "turn.done", turn: { role: "user", transcript: "partial voice completed late" } });
		expect(h.transcripts.filter(transcript => transcript.text === "typed question")).toHaveLength(1);

		h.emit({ type: "transcript.started", role: "user" });
		h.emit({ type: "input_transcript.added", item: { text: "partial voice completed late" } });
		h.emit({ type: "turn.done", turn: { role: "user", transcript: "partial voice completed late" } });
		expect(h.transcripts.at(-1)).toEqual({
			role: "user",
			turn: 3,
			text: "partial voice completed late",
			final: true,
		});
	});

	it("accepts new speech after typed input even when the interrupted microphone turn never finalized", async () => {
		const h = await harness([]);
		h.emit({ type: "transcript.started", role: "user" });
		h.emit({ type: "input_transcript.added", item: { text: "interrupted voice" } });
		await controller!.sendText("typed request");

		h.emit({ type: "transcript.started", role: "user" });
		h.emit({ type: "input_transcript.added", item: { text: "next spoken request" } });
		h.emit({ type: "turn.done", turn: { role: "user", transcript: "next spoken request" } });
		expect(h.transcripts.at(-1)).toEqual({
			role: "user",
			turn: 3,
			text: "next spoken request",
			final: true,
		});
	});

	it("never attributes a cancelled turn's terminal result to its replacement", async () => {
		const oldStarted = Promise.withResolvers<void>();
		const h = await harness([
			() => {
				oldStarted.resolve();
				return { content: ["old result"], delayMs: 60_000 };
			},
			{ content: ["replacement result"] },
		]);

		h.emit(delegation("old", "old task"));
		await oldStarted.promise;
		h.emit({ type: "delegation.cancelled", id: "old" });
		h.emit(delegation("replacement", "replacement task"));

		expect(await h.transport.completions.next()).toEqual({ id: "replacement", text: "replacement result" });
		expect(h.mock.calls).toHaveLength(2);
	});

	it("cancels a replacement waiting behind abort without creating phantom work", async () => {
		const oldStarted = Promise.withResolvers<void>();
		const h = await harness([
			() => {
				oldStarted.resolve();
				return { content: ["old result"], delayMs: 60_000 };
			},
			{ content: ["survivor result"] },
		]);

		h.emit(delegation("old", "old task"));
		await oldStarted.promise;
		h.emit({ type: "delegation.cancelled", id: "old" });
		h.emit(delegation("cancelled-before-start", "must not run"));
		h.emit({ type: "delegation.cancelled", id: "cancelled-before-start" });
		h.emit(delegation("survivor", "run after cancellation settles"));

		expect(await h.transport.completions.next()).toEqual({ id: "survivor", text: "survivor result" });
		expect(h.mock.calls).toHaveLength(2);
	});

	it("does not start a queued replacement after the live controller stops", async () => {
		const oldStarted = Promise.withResolvers<void>();
		const h = await harness([
			() => {
				oldStarted.resolve();
				return { content: ["old result"], delayMs: 60_000 };
			},
			{ content: ["must not run"] },
		]);
		const oldEnded = Promise.withResolvers<void>();
		const unsubscribe = session!.subscribe(event => {
			if (event.type === "agent_end" && event.isTerminal !== false) oldEnded.resolve();
		});

		h.emit(delegation("old", "old task"));
		await oldStarted.promise;
		h.emit({ type: "delegation.cancelled", id: "old" });
		h.emit(delegation("queued", "must not start"));
		await controller!.stop();
		await oldEnded.promise;
		await setImmediate();
		unsubscribe();

		expect(h.mock.calls).toHaveLength(1);
	});

	it("stopping Gemini Live aborts its owned coding turn before stop resolves", async () => {
		const started = Promise.withResolvers<void>();
		const h = await harness(
			[
				() => {
					started.resolve();
					return { content: ["must not complete after stop"], delayMs: 60_000 };
				},
			],
			"google",
		);
		h.emit(delegation("owned", "long-running Live task"));
		await started.promise;
		expect(session!.isStreaming).toBe(true);

		await controller!.stop();

		expect(session!.isStreaming).toBe(false);
		expect(h.mock.calls).toHaveLength(1);
	});

	it("keeps the Codex microphone echo gate and mute behavior", async () => {
		const h = await harness([]);

		h.outputLevel(0.2);
		h.captureAudio(null, new Float32Array([0.05]));
		h.captureAudio(null, new Float32Array([0.25]));
		h.outputLevel(0);
		h.captureAudio(null, new Float32Array([0.015625]));
		controller!.toggleMute();
		h.captureAudio(null, new Float32Array([1]));

		expect(h.transport.pushedAudio.map(samples => Array.from(samples))).toEqual([[0.25], [0.015625]]);
		expect(h.transport.muted).toEqual([true]);
	});
});
