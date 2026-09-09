/**
 * Contract: a guest prompt that arrives while the host agent is streaming is
 * steered AND becomes visible as a queued message. The host sends the guest text
 * as `queueChipText` on the queued custom message; the session derives
 * `queuedMessageCount` from the agent-core queue for host and guest UI state.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import {
	COLLAB_PROTO,
	type CollabFrame,
	parseCollabLink,
	rewriteEnvelopePeer,
	unpackEnvelope,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

interface RelayData {
	role: "host" | "guest";
	peerId: number;
}

type RelaySocket = Bun.ServerWebSocket<RelayData>;

/** Single-room relay mirroring the omp-collab-relay forwarding contract. */
function startTestRelay(): { url: string; stop(): void } {
	let host: RelaySocket | null = null;
	const guests = new Map<number, RelaySocket>();
	let nextPeerId = 1;
	const server = Bun.serve({
		port: 0,
		fetch(req, srv): Response | undefined {
			const role = new URL(req.url).searchParams.get("role") === "host" ? "host" : "guest";
			const data: RelayData = { role, peerId: 0 };
			if (srv.upgrade(req, { data })) return undefined;
			return new Response("upgrade failed", { status: 400 });
		},
		websocket: {
			open(ws: RelaySocket): void {
				if (ws.data.role === "host") {
					host = ws;
					return;
				}
				ws.data.peerId = nextPeerId++;
				guests.set(ws.data.peerId, ws);
				host?.send(JSON.stringify({ t: "peer-joined", peer: ws.data.peerId }));
			},
			message(ws: RelaySocket, message: string | Buffer): void {
				if (typeof message === "string") return;
				const bytes = new Uint8Array(message);
				if (ws.data.role === "host") {
					const envelope = unpackEnvelope(bytes);
					if (!envelope) return;
					if (envelope.peerId === 0) {
						for (const guest of guests.values()) guest.send(bytes);
					} else {
						guests.get(envelope.peerId)?.send(bytes);
					}
					return;
				}
				rewriteEnvelopePeer(bytes, ws.data.peerId);
				host?.send(bytes);
			},
			close(ws: RelaySocket): void {
				if (ws.data.role === "guest") {
					guests.delete(ws.data.peerId);
					host?.send(JSON.stringify({ t: "peer-left", peer: ws.data.peerId }));
				}
			},
		},
	});
	return { url: `ws://localhost:${server.port}`, stop: () => server.stop(true) };
}

interface CapturedPrompt {
	details?: { from?: string };
	options?: { streamingBehavior?: "steer"; queueChipText?: string };
}

interface StreamingHostHarness {
	ctx: InteractiveModeContext;
	prompts: CapturedPrompt[];
	nextPrompt(): Promise<CapturedPrompt>;
}

/** Context double for a host whose agent is mid-turn (isStreaming === true). */
function makeStreamingHostContext(): StreamingHostHarness {
	const prompts: CapturedPrompt[] = [];
	const promptWaiters: ((prompt: CapturedPrompt) => void)[] = [];
	const ctx = {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => "sess-1",
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-1", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: true,
			get queuedMessageCount(): number {
				return prompts.filter(prompt => prompt.options?.queueChipText).length;
			},
			isAborting: false,
			sessionName: "test",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: (message: CapturedPrompt, options?: CapturedPrompt["options"]) => {
				const captured: CapturedPrompt = { details: message.details, options };
				prompts.push(captured);
				for (const waiter of promptWaiters.splice(0)) waiter(captured);
				return Promise.resolve();
			},
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		updatePendingMessagesDisplay: () => {},
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
	const nextPrompt = (): Promise<CapturedPrompt> => {
		const { promise, resolve } = Promise.withResolvers<CapturedPrompt>();
		promptWaiters.push(resolve);
		return promise;
	};
	return { ctx, prompts, nextPrompt };
}

interface TestGuest {
	socket: CollabSocket;
	nextFrame(): Promise<CollabFrame>;
}

async function joinAsGuest(link: string, name: string): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const queue: CollabFrame[] = [];
	const waiters: ((frame: CollabFrame) => void)[] = [];
	socket.onFrame = frame => {
		// The host follows every welcome with a `snapshot-chunk` train carrying
		// the transcript. This harness ships zero entries, so the chunks are
		// pure noise around the welcome/prompt-reply assertions.
		if (frame.t === "snapshot-chunk") return;
		const waiter = waiters.shift();
		if (waiter) waiter(frame);
		else queue.push(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
	socket.connect();
	const nextFrame = (): Promise<CollabFrame> => {
		const queued = queue.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<CollabFrame>();
		waiters.push(resolve);
		return promise;
	};
	return { socket, nextFrame };
}

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("collab mid-turn guest prompts", () => {
	it("registers the steer as a queued message and reports it to guests via state", async () => {
		const relay = startTestRelay();
		cleanups.push(relay.stop);
		const harness = makeStreamingHostContext();
		const host = new CollabHost(harness.ctx);
		await host.start(relay.url);
		cleanups.push(() => host.stop("test done"));

		const guest = await joinAsGuest(host.link, "writer");
		cleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		const prompted = harness.nextPrompt();
		guest.socket.send({ t: "prompt", text: "steer the host" });
		const prompt = await prompted;

		expect(prompt.details).toEqual({ from: "writer" });
		expect(prompt.options).toEqual({ streamingBehavior: "steer", queueChipText: "steer the host" });

		// The queued steer must reach guests through state.queuedMessageCount —
		// that field drives the web composer's "queued ×N" badge.
		let sawQueuedCount = false;
		for (let i = 0; i < 10 && !sawQueuedCount; i++) {
			const frame = await guest.nextFrame();
			if (frame.t === "state" && frame.state.queuedMessageCount === 1) sawQueuedCount = true;
		}
		expect(sawQueuedCount).toBe(true);
	});
});
