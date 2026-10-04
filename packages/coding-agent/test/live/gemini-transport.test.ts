import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { type } from "@oh-my-pi/omptype";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { GeminiLiveTransport, type GeminiLiveTransportOptions } from "../../src/live/gemini-transport";
import type { LiveServerEvent } from "../../src/live/protocol";

class Inbox<T> {
	#values: T[] = [];
	#readers: Array<(value: T) => void> = [];
	push(value: T): void {
		const reader = this.#readers.shift();
		if (reader) reader(value);
		else this.#values.push(value);
	}
	next(): Promise<T> {
		if (this.#values.length) return Promise.resolve(this.#values.shift()!);
		const pending = Promise.withResolvers<T>();
		this.#readers.push(pending.resolve);
		return pending.promise;
	}
}

type ExecutionSeam = NonNullable<GeminiLiveTransportOptions["execution"]>;

async function harness(
	payloadType: "string" | "buffer" | "arraybuffer" = "string",
	options: {
		execution?: ExecutionSeam;
		getBufferedAmount?: (socket: WebSocket) => number;
		onCancelDelegation?: (id: string) => Promise<void>;
	} = {},
) {
	const incoming = new Inbox<unknown>();
	const events = new Inbox<LiveServerEvent>();
	const played = new Inbox<Float32Array>();
	const toolErrors = new Inbox<{ name: string; message: string }>();
	const stopped = new Inbox<void>();
	const accepted = Promise.withResolvers<Bun.ServerWebSocket<undefined>>();
	const received: unknown[] = [];
	let setupReceived = false;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request)) return;
			return new Response("WebSocket required", { status: 400 });
		},
		websocket: {
			open(socket) {
				accepted.resolve(socket);
			},
			message(socket, data) {
				received.push(JSON.parse(String(data)) as unknown);
				incoming.push(JSON.parse(String(data)) as unknown);
				if (!setupReceived) {
					setupReceived = true;
					const reply = JSON.stringify({ setupComplete: {} });
					socket.send(payloadType === "string" ? reply : Buffer.from(reply));
				}
			},
		},
	});
	const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	await auth.credentials.reload();
	auth.keys.setRuntime("google", "local-test-key");
	const transport = new GeminiLiveTransport({
		authStorage: auth,
		sessionId: "local-live-session",
		model: "gemini-3.8-live-extended-thinking",
		voice: "Aoede",
		thinkingLevel: "high",
		instructions: "Local protocol test",
		createSocket: () => {
			const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
			if (payloadType === "arraybuffer") socket.binaryType = "arraybuffer";
			return socket;
		},
		createPlayback: () => ({ write: samples => played.push(samples), stop: () => stopped.push() }),
		...(options.execution ? { execution: options.execution } : {}),
		...(options.getBufferedAmount ? { getBufferedAmount: options.getBufferedAmount } : {}),
		callbacks: {
			onEvent: event => events.push(event),
			onOutputLevel: () => undefined,
			onToolError: (name, message) => toolErrors.push({ name, message }),
			...(options.onCancelDelegation ? { onCancelDelegation: options.onCancelDelegation } : {}),
		},
	});
	try {
		await transport.connect();
		const peer = await accepted.promise;
		const setup = setupInput.assert(await incoming.next());
		await events.next(); // Connected notification.
		return {
			transport,
			peer,
			incoming,
			events,
			toolErrors,
			played,
			received,
			setup,
			stopped,
			async close() {
				await transport.close();
				server.stop(true);
				auth.close();
			},
		};
	} catch (cause) {
		await transport.close();
		server.stop(true);
		auth.close();
		throw cause;
	}
}

const setupInput = type({
	setup: {
		tools: type({
			functionDeclarations: type({ name: "string", behavior: "string" }).array(),
		}).array(),
	},
});

const audioInput = type({ realtimeInput: { audio: { data: "string", mimeType: "string" } } });

describe("Gemini Live websocket", () => {
	test.each(["string", "buffer", "arraybuffer"] as const)(
		"%s replies complete setup and decode Unicode transcripts",
		async payloadType => {
			const h = await harness(payloadType);
			try {
				const packet = { serverContent: { inputTranscription: { text: "café 漢字 😀" } } };
				const encoded = JSON.stringify(packet);
				h.peer.send(payloadType === "string" ? encoded : Buffer.from(encoded));
				expect(await h.events.next()).toEqual({ type: "transcript.started", role: "user" });
				expect(await h.events.next()).toEqual({
					type: "input_transcript.added",
					item: { text: "café 漢字 😀" },
				});
			} finally {
				await h.close();
			}
		},
	);

	test("voice setup advertises non-blocking delegation and cancellation", async () => {
		const h = await harness();
		try {
			expect(
				h.setup.setup.tools.flatMap(tool =>
					tool.functionDeclarations.map(({ name, behavior }) => ({ name, behavior })),
				),
			).toEqual([
				{ name: "delegate", behavior: "NON_BLOCKING" },
				{ name: "cancel", behavior: "NON_BLOCKING" },
			]);
		} finally {
			await h.close();
		}
	});

	test("microphone PCM is clipped/encoded; mute ends input; barge-in drops queued playback", async () => {
		const h = await harness();
		try {
			h.transport.pushAudio(new Float32Array([-2, -0.5, 0, 0.5, 2]));
			const packet = audioInput.assert(await h.incoming.next());
			const bytes = Buffer.from(packet.realtimeInput.audio.data, "base64");
			expect(Array.from({ length: 5 }, (_, index) => bytes.readInt16LE(index * 2))).toEqual([
				-32768, -16384, 0, 16383, 32767,
			]);
			expect(packet.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
			await h.transport.setMuted(true);
			expect(await h.incoming.next()).toEqual({ realtimeInput: { audioStreamEnd: true } });
			h.transport.pushAudio(new Float32Array([1]));
			await h.transport.setMuted(false);
			h.transport.pushAudio(new Float32Array([0.25]));
			const resumed = audioInput.assert(await h.incoming.next());
			expect(Buffer.from(resumed.realtimeInput.audio.data, "base64").readInt16LE()).toBe(8191);
			h.peer.send(
				JSON.stringify({
					serverContent: {
						modelTurn: {
							parts: [
								{
									inlineData: {
										data: Buffer.from([0, 128, 0, 0, 255, 127]).toString("base64"),
										mimeType: "audio/pcm;rate=24000",
									},
								},
							],
						},
					},
				}),
			);
			expect(Array.from(await h.played.next())).toEqual([-1, 0, 32767 / 32768]);
			h.peer.send(JSON.stringify({ serverContent: { interrupted: true } }));
			await h.stopped.next();
			// A following chunk opens a new playback stream rather than playing the interrupted queue.
			h.peer.send(
				JSON.stringify({
					serverContent: {
						modelTurn: {
							parts: [
								{
									inlineData: {
										data: "AEA=",
										mimeType: "audio/pcm;rate=24000",
									},
								},
							],
						},
					},
				}),
			);
			expect(Array.from(await h.played.next())).toEqual([0.5]);
		} finally {
			await h.close();
		}
	});

	test("async delegation remains usable after turnComplete and completes with its matching function ID", async () => {
		const h = await harness();
		try {
			h.peer.send(JSON.stringify({ serverContent: { turnComplete: true, interactionStatus: "IN_PROGRESS" } }));
			expect(await h.events.next()).toEqual({ type: "interaction.status", working: true });
			h.peer.send(
				JSON.stringify({
					toolCall: {
						functionCalls: [{ id: "work-1", name: "delegate", args: { request: "Inspect the build" } }],
					},
				}),
			);
			expect(await h.events.next()).toMatchObject({ type: "delegation.created", item: { id: "work-1" } });
			await h.transport.completeDelegation("work-1", "The build fails because its entry is missing.");
			expect(await h.incoming.next()).toEqual({
				toolResponse: {
					functionResponses: [
						{
							id: "work-1",
							name: "delegate",
							response: { result: "The build fails because its entry is missing." },
						},
					],
				},
			});
			h.peer.send(JSON.stringify({ serverContent: { interactionStatus: "IDLE" } }));
			expect(await h.events.next()).toEqual({ type: "interaction.status", working: false });
		} finally {
			await h.close();
		}
	});

	test("cancelled delegation cannot answer a later call; unknown functions are rejected", async () => {
		const h = await harness();
		try {
			h.peer.send(
				JSON.stringify({
					toolCall: { functionCalls: [{ id: "old", name: "delegate", args: { request: "Old task" } }] },
				}),
			);
			await h.events.next();
			h.peer.send(JSON.stringify({ toolCallCancellation: { ids: ["old"] } }));
			expect(await h.events.next()).toEqual({ type: "delegation.cancelled", id: "old" });
			h.peer.send(
				JSON.stringify({
					toolCall: { functionCalls: [{ id: "new", name: "delegate", args: { request: "New task" } }] },
				}),
			);
			await h.events.next();
			await h.transport.completeDelegation("old", "Stale result");
			await h.transport.completeDelegation("new", "Current result");
			expect(await h.incoming.next()).toEqual({
				toolResponse: {
					functionResponses: [
						{
							id: "new",
							name: "delegate",
							response: { result: "Current result" },
						},
					],
				},
			});
			h.peer.send(
				JSON.stringify({
					toolCall: {
						functionCalls: [{ id: "unknown", name: "unavailable", args: {} }],
					},
				}),
			);
			expect(await h.incoming.next()).toEqual({
				toolResponse: {
					functionResponses: [
						{ id: "unknown", name: "unavailable", response: { error: "Unknown or disabled tool" } },
					],
				},
			});
		} finally {
			await h.close();
		}
	});

	test("final input transcriptions are independent and do not wait for assistant turn completion", async () => {
		const h = await harness();
		try {
			h.peer.send(JSON.stringify({ serverContent: { inputTranscription: { text: "first request" } } }));
			expect(await h.events.next()).toEqual({ type: "transcript.started", role: "user" });
			expect(await h.events.next()).toEqual({
				type: "input_transcript.added",
				item: { text: "first request" },
			});
			expect(await h.events.next()).toEqual({
				type: "turn.done",
				turn: { role: "user", transcript: "first request" },
			});

			h.peer.send(JSON.stringify({ serverContent: { turnComplete: true } }));
			h.peer.send(JSON.stringify({ serverContent: { inputTranscription: { text: "late request" } } }));
			expect(await h.events.next()).toEqual({ type: "transcript.started", role: "user" });
			expect(await h.events.next()).toEqual({
				type: "input_transcript.added",
				item: { text: "late request" },
			});
			expect(await h.events.next()).toEqual({
				type: "turn.done",
				turn: { role: "user", transcript: "late request" },
			});
		} finally {
			await h.close();
		}
	});

	test("interim input transcription streams replacements before the independent final transcript", async () => {
		const h = await harness();
		try {
			h.peer.send(JSON.stringify({ serverContent: { interimInputTranscription: { text: "inter" } } }));
			expect(await h.events.next()).toEqual({ type: "transcript.started", role: "user" });
			expect(await h.events.next()).toEqual({
				type: "input_transcript.added",
				item: { text: "inter" },
			});
			h.peer.send(JSON.stringify({ serverContent: { interimInputTranscription: { text: "interim" } } }));
			expect(await h.events.next()).toEqual({
				type: "input_transcript.added",
				item: { text: "interim" },
			});
			h.peer.send(JSON.stringify({ serverContent: { inputTranscription: { text: "final input" } } }));
			expect(await h.events.next()).toEqual({
				type: "input_transcript.added",
				item: { text: "final input" },
			});
			expect(await h.events.next()).toEqual({
				type: "turn.done",
				turn: { role: "user", transcript: "final input" },
			});
		} finally {
			await h.close();
		}
	});

	test("output transcription finalizes at generationComplete before turnComplete", async () => {
		const h = await harness();
		try {
			h.peer.send(JSON.stringify({ serverContent: { outputTranscription: { text: "done" } } }));
			expect(await h.events.next()).toEqual({ type: "transcript.started", role: "assistant" });
			expect(await h.events.next()).toEqual({
				type: "output_transcript.added",
				item: { text: "done" },
			});
			h.peer.send(JSON.stringify({ serverContent: { generationComplete: true } }));
			expect(await h.events.next()).toEqual({
				type: "turn.done",
				turn: { role: "assistant", transcript: "done" },
			});
		} finally {
			await h.close();
		}
	});

	test("direct tool errors redact credentials and keep subsequent speech active", async () => {
		const h = await harness("string", {
			execution: {
				codeEnabled: true,
				desktopEnabled: false,
				async executeCode() {
					throw new Error("Connection refused: local-test-key");
				},
				async executeDesktop() {
					throw new Error("Desktop disabled");
				},
				async close() {},
			},
		});
		try {
			h.peer.send(
				JSON.stringify({
					toolCall: {
						functionCalls: [{ id: "failed", name: "execute", args: { code: "connect()", language: "js" } }],
					},
				}),
			);
			expect(await h.toolErrors.next()).toEqual({ name: "execute", message: "Connection refused: [redacted]" });
			expect(await h.incoming.next()).toEqual({
				toolResponse: {
					functionResponses: [
						{ id: "failed", name: "execute", response: { error: "Connection refused: [redacted]" } },
					],
				},
			});
			h.peer.send(JSON.stringify({ serverContent: { inputTranscription: { text: "Keep listening" } } }));
			expect(await h.events.next()).toEqual({ type: "transcript.started", role: "user" });
			expect(await h.events.next()).toEqual({ type: "input_transcript.added", item: { text: "Keep listening" } });
			expect(await h.events.next()).toEqual({
				type: "turn.done",
				turn: { role: "user", transcript: "Keep listening" },
			});
		} finally {
			await h.close();
		}
	});

	test("cancel drains old direct work before replacement and suppresses its stale response", async () => {
		const started = new Inbox<string>();
		const execution: ExecutionSeam = {
			codeEnabled: true,
			desktopEnabled: false,
			executeCode(code, _language, signal) {
				started.push(code);
				if (code === "new") return Promise.resolve({ text: "replacement", images: [] });
				const pending = Promise.withResolvers<{ text: string; images: [] }>();
				signal?.addEventListener("abort", () => pending.resolve({ text: "stale completion", images: [] }), {
					once: true,
				});
				return pending.promise;
			},
			async executeDesktop() {
				throw new Error("disabled");
			},
			async close() {},
		};
		const h = await harness("string", { execution });
		try {
			h.peer.send(
				JSON.stringify({
					toolCall: {
						functionCalls: [{ id: "old", name: "execute", args: { code: "old", language: "js" } }],
					},
				}),
			);
			expect(await started.next()).toBe("old");
			h.peer.send(
				JSON.stringify({
					toolCall: { functionCalls: [{ id: "stop", name: "cancel", args: { id: "old" } }] },
				}),
			);
			expect(await h.incoming.next()).toMatchObject({
				toolResponse: {
					functionResponses: [{ id: "old", name: "execute", response: { cancelled: true } }],
				},
			});
			expect(await h.incoming.next()).toEqual({
				toolResponse: {
					functionResponses: [{ id: "stop", name: "cancel", response: { result: "Stopped 1 pending task." } }],
				},
			});
			h.peer.send(
				JSON.stringify({
					toolCall: {
						functionCalls: [{ id: "new", name: "execute", args: { code: "new", language: "js" } }],
					},
				}),
			);
			expect(await started.next()).toBe("new");
			expect(await h.incoming.next()).toEqual({
				toolResponse: {
					functionResponses: [{ id: "new", name: "execute", response: { result: "replacement" } }],
				},
			});
		} finally {
			await h.close();
		}
	});

	test("explicit cancellation waits for delegated work to drain before confirming", async () => {
		const cancellationStarted = new Inbox<string>();
		const drained = Promise.withResolvers<void>();
		const h = await harness("string", {
			onCancelDelegation: async id => {
				cancellationStarted.push(id);
				await drained.promise;
			},
		});
		try {
			h.peer.send(
				JSON.stringify({
					toolCall: {
						functionCalls: [{ id: "delegated", name: "delegate", args: { request: "Long work" } }],
					},
				}),
			);
			await h.events.next();
			h.peer.send(
				JSON.stringify({
					toolCall: { functionCalls: [{ id: "stop", name: "cancel", args: {} }] },
				}),
			);
			expect(await cancellationStarted.next()).toBe("delegated");
			expect(h.received.some(packet => Object.hasOwn(packet as object, "toolResponse"))).toBe(false);
			drained.resolve();
			expect(await h.incoming.next()).toMatchObject({
				toolResponse: {
					functionResponses: [{ id: "delegated", name: "delegate", response: { cancelled: true } }],
				},
			});
			expect(await h.incoming.next()).toEqual({
				toolResponse: {
					functionResponses: [{ id: "stop", name: "cancel", response: { result: "Stopped 1 pending task." } }],
				},
			});
			await h.transport.completeDelegation("delegated", "stale delegated result");
		} finally {
			await h.close();
		}
	});
	test("congestion bounds queued microphone audio and sends it ahead of a compressed screenshot", async () => {
		const seed = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3MxZ5wAAAABJRU5ErkJggg==",
			"base64",
		);
		const screenshot = await new Bun.Image(seed).resize(2_000, 1_200).png().toBase64();
		let congested = true;
		const backpressureObserved = new Inbox<void>();
		const execution: ExecutionSeam = {
			codeEnabled: false,
			desktopEnabled: true,
			async executeCode() {
				throw new Error("disabled");
			},
			async executeDesktop() {
				return { text: "screen observed", images: [{ data: screenshot, mimeType: "image/png" }] };
			},
			async close() {},
		};
		const h = await harness("string", {
			execution,
			getBufferedAmount: () => {
				if (congested) backpressureObserved.push();
				return congested ? 2_000_000 : 0;
			},
		});
		try {
			h.peer.send(
				JSON.stringify({
					toolCall: {
						functionCalls: [{ id: "screen", name: "desktop", args: { code: "await desktop.screen()" } }],
					},
				}),
			);
			await backpressureObserved.next();
			for (let index = 0; index < 10; index++) {
				h.transport.pushAudio(new Float32Array(8_000).fill((index + 1) / 20));
			}
			congested = false;
			const audio = audioInput.assert(await h.incoming.next());
			expect(Buffer.from(audio.realtimeInput.audio.data, "base64").readInt16LE()).toBe(14_745);
			const newestAudio = audioInput.assert(await h.incoming.next());
			expect(Buffer.from(newestAudio.realtimeInput.audio.data, "base64").readInt16LE()).toBe(16_383);
			const response = (await h.incoming.next()) as {
				toolResponse: {
					functionResponses: Array<{
						response: { result: string };
						parts: Array<{ inlineData: { data: string; mimeType: string } }>;
					}>;
				};
			};
			const functionResponse = response.toolResponse.functionResponses[0]!;
			expect(functionResponse.response.result).toBe("screen observed");
			expect(functionResponse.parts).toHaveLength(1);
			const image = functionResponse.parts[0]!.inlineData;
			expect(Buffer.from(image.data, "base64").byteLength).toBeLessThanOrEqual(192 * 1024);
			const metadata = await new Bun.Image(Buffer.from(image.data, "base64")).metadata();
			expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 2_000, height: 1_200 });
		} finally {
			await h.close();
		}
	});
});
