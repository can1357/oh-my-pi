/**
 * Contract: a collab guest mirrors lifecycle-relevant host events into the
 * local extension runner. The guest's own agent loop never runs, so the
 * session's extension-event path stays silent for the whole join — without
 * this mirror, extension-installed lifecycle integrations (e.g. Herdr's
 * pane-state reporter) never observe `agent_start`/`agent_end` and report a
 * stale pane state while the host is streaming or settles.
 *
 * A scripted host socket drives a real CollabGuestLink over the in-memory
 * relay, same contract as the other collab guest tests. Determinism uses the
 * same sentinel-`error`-frame barrier as guest-ui-request.test.ts: frames
 * apply strictly in arrival order, so a barrier after the event frames proves
 * they applied.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { COLLAB_PROTO, type CollabFrame, formatCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { MappedExtensionEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/lifecycle-mirror";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

interface Harness {
	guest: CollabGuestLink;
	hostSocket: CollabSocket;
	/** Mock runner receiving the mirrored events; per-test overrides allowed. */
	runner: {
		hasHandlers: () => boolean;
		emit: (event: MappedExtensionEvent) => Promise<unknown>;
	};
	emitted: MappedExtensionEvent[];

	/** Deterministic apply-chain barrier via a sentinel `error` frame. */
	barrier(): Promise<void>;
	cleanup(): Promise<void>;
}

function makeState(): Extract<CollabFrame, { t: "welcome" }>["state"] {
	return {
		isStreaming: false,
		queuedMessageCount: 0,
		sessionName: "host session",
		cwd: "/tmp",
		participants: [{ name: "Host", role: "host" }],
	};
}

async function makeHarness(roomId: string, options: { isStreaming?: boolean } = {}): Promise<Harness> {
	const roomKey = generateRoomKey();
	const cryptoKey = await importRoomKey(roomKey);
	const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);

	const emitted: MappedExtensionEvent[] = [];
	const runner = {
		hasHandlers: () => true,
		emit: (event: MappedExtensionEvent) => {
			emitted.push(event);
			return Promise.resolve();
		},
	};

	const errorWaiters = new Map<string, () => void>();
	let barrierSeq = 0;
	const barrier = (): Promise<void> => {
		const sentinel = `__barrier_${++barrierSeq}__`;
		const { promise, resolve } = Promise.withResolvers<void>();
		errorWaiters.set(sentinel, resolve);
		const socket = harness.hostSocket;
		socket.send({ t: "error", message: sentinel } as CollabFrame);
		return promise;
	};

	const hostSocket = new CollabSocket({ wsUrl: `ws://localhost:8788/r/${roomId}`, role: "host", key: cryptoKey });
	const hostOpen = Promise.withResolvers<void>();
	hostSocket.onOpen = () => hostOpen.resolve();
	hostSocket.onFrame = frame => {
		if (frame.t === "hello") {
			hostSocket.send({
				t: "welcome",
				proto: COLLAB_PROTO,
				header: { type: "session", id: "remote-session", timestamp: "2026-06-30T00:00:00Z", cwd: "/tmp" },
				state: { ...makeState(), isStreaming: options.isStreaming ?? false },
				agents: [],
				entryCount: 0,
			} as CollabFrame);
		}
	};
	hostSocket.connect();
	await hostOpen.promise;

	const ctx = {
		collabGuest: undefined as CollabGuestLink | undefined,
		settings: { get: () => "" },
		sessionManager: {
			getSessionFile: () => null,
			getSessionName: () => "local session",
			getCwd: () => "/local",
		},
		session: {
			messages: [],
			switchSession: () => Promise.resolve(),
			newSession: () => Promise.resolve(),
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
			},
			extensionRunner: runner,
		},
		statusContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		loadingAnimation: undefined,
		ensureLoadingAnimation: () => {},
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		showError: (message: string) => {
			// The guest prefixes host error frames ("Collab host: <message>");
			// match the embedded sentinel.
			for (const [sentinel, waiter] of errorWaiters) {
				if (message.includes(sentinel)) {
					errorWaiters.delete(sentinel);
					waiter();
					return;
				}
			}
		},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		eventController: { handleEvent: () => Promise.resolve(), takeDisplaceableComponents: () => [] },
		syncRunningSubagentBadge: () => {},
		eventBus: new EventBus(),
	} as unknown as InteractiveModeContext;

	const guest = new CollabGuestLink(ctx);
	const harness: Harness = {
		guest,
		hostSocket,
		runner,
		emitted,
		barrier,
		cleanup: async () => {
			await guest.leave("test cleanup").catch(() => {});
			hostSocket.close();
		},
	};
	await guest.join(link);
	return harness;
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	installInMemoryRelay();
});

afterEach(() => {
	uninstallInMemoryRelay();
	AgentRegistry.resetGlobalForTests();
});

describe("collab guest extension lifecycle mirror", () => {
	it("mirrors agent_start and a terminal agent_end to the extension runner", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const harness = await makeHarness("lifecycle-mirror-room-1");
		try {
			harness.hostSocket.send({ t: "event", event: { type: "agent_start" } } as CollabFrame);
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", messages: [], isTerminal: true },
			} as CollabFrame);
			await harness.barrier();

			expect(harness.emitted.filter(event => event.type === "agent_start").length).toBe(1);
			const ends = harness.emitted.filter(event => event.type === "agent_end");
			expect(ends.length).toBe(1);
			// Terminal settle: no continuation was scheduled on the host.
			expect(ends[0].willContinue).toBeUndefined();
		} finally {
			writeSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("maps a non-terminal agent_end settle to willContinue: true", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const harness = await makeHarness("lifecycle-mirror-room-2");
		try {
			// `isTerminal: false` is the session-layer marker for "a continuation
			// is already scheduled" — lifecycle integrations must not treat it
			// as a user-visible settle.
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", messages: [], isTerminal: false },
			} as CollabFrame);
			await harness.barrier();

			const ends = harness.emitted.filter(event => event.type === "agent_end");
			expect(ends.length).toBe(1);
			expect(ends[0].willContinue).toBe(true);
		} finally {
			writeSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("resets turn numbering on each agent_start like a local session", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const harness = await makeHarness("lifecycle-mirror-room-4");
		try {
			const assistantMessage: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: "mock",
				provider: "mock",
				model: "mock",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const runTurns = (): void => {
				harness.hostSocket.send({ t: "event", event: { type: "turn_start" } } as CollabFrame);
				harness.hostSocket.send({
					t: "event",
					event: { type: "turn_end", message: assistantMessage, toolResults: [] },
				} as CollabFrame);
			};
			// Two host prompts, two turns each: a local session numbers both
			// runs 0,1 — the mirror must not keep counting across agent_start.
			harness.hostSocket.send({ t: "event", event: { type: "agent_start" } } as CollabFrame);
			runTurns();
			runTurns();
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", messages: [], isTerminal: true },
			} as CollabFrame);
			harness.hostSocket.send({ t: "event", event: { type: "agent_start" } } as CollabFrame);
			runTurns();
			runTurns();
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", messages: [], isTerminal: true },
			} as CollabFrame);
			await harness.barrier();

			const starts = harness.emitted.filter(event => event.type === "turn_start");
			expect(starts.map(event => event.turnIndex)).toEqual([0, 1, 0, 1]);
		} finally {
			writeSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("detaches message_end payloads from the transcript's live reference", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const harness = await makeHarness("lifecycle-mirror-room-5");
		try {
			const message: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "live" }],
				api: "mock",
				provider: "mock",
				model: "mock",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			harness.hostSocket.send({ t: "event", event: { type: "message_end", message } } as CollabFrame);
			await harness.barrier();

			const ends = harness.emitted.filter(event => event.type === "message_end");
			expect(ends.length).toBe(1);
			// An extension mutating its notification copy must not rewrite the
			// same object the guest renders from.
			const delivered = ends[0].message;
			expect(delivered).not.toBe(message);
			// The assistant-message shape is the transcript-relevant one here;
			// narrowing via the input object keeps the mutation contract typed.
			const liveAssistant = message as { content: { type: string; text: string }[] };
			const deliveredAssistant = delivered as { content: { type: string; text: string }[] };
			deliveredAssistant.content = [{ type: "text", text: "mutated by extension" }];
			expect(liveAssistant.content[0].text).toBe("live");
		} finally {
			writeSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("delivers mirrored events to handlers in emission order", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		// The mock runner resolves agent_start on an externally-gated promise;
		// unordered fire-and-forget would let the agent_end handler complete
		// first and relatch the pane to working after the host settled.
		const harness = await makeHarness("lifecycle-mirror-room-6");
		try {
			const gate = Promise.withResolvers<void>();
			const completionOrder: string[] = [];
			let sawAgentEnd = false;
			harness.runner.emit = (event: MappedExtensionEvent) => {
				completionOrder.push(event.type);
				if (event.type === "agent_start") {
					return gate.promise as Promise<undefined>;
				}
				sawAgentEnd = true;
				return Promise.resolve(undefined);
			};
			harness.hostSocket.send({ t: "event", event: { type: "agent_start" } } as CollabFrame);
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", messages: [], isTerminal: true },
			} as CollabFrame);
			await harness.barrier();

			// The gated agent_start must hold agent_end back: emission is
			// chained, so agent_end's handler has not even started yet.
			expect(completionOrder).toEqual(["agent_start"]);
			expect(sawAgentEnd).toBe(false);
			gate.resolve();
			await Bun.sleep(10);
			expect(completionOrder).toEqual(["agent_start", "agent_end"]);
		} finally {
			writeSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("synthesizes agent_start when joining while the host is mid-run", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		// The host's agent_start predates the join, so no event frame carries
		// it — the welcome's `isStreaming` is the only signal the mirror gets.
		const harness = await makeHarness("lifecycle-mirror-room-7", { isStreaming: true });
		try {
			expect(harness.emitted.filter(event => event.type === "agent_start").length).toBe(1);
		} finally {
			writeSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("synthesizes a terminal agent_end when leaving mid-run", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const harness = await makeHarness("lifecycle-mirror-room-8");
		try {
			harness.hostSocket.send({ t: "event", event: { type: "agent_start" } } as CollabFrame);
			await harness.barrier();
			expect(harness.emitted.filter(event => event.type === "agent_start").length).toBe(1);

			// /leave before the host settles: the terminal agent_end frame never
			// arrives, the mirror must unlatch the pane on restore.
			await harness.guest.leave("mid-run");
			const ends = harness.emitted.filter(event => event.type === "agent_end");
			expect(ends.length).toBe(1);
			expect(ends[0].willContinue).toBeUndefined();
		} finally {
			writeSpy.mockRestore();
			await harness.cleanup();
		}
	});
});
