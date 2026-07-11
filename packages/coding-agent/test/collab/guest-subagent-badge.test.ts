import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { generateRoomKey, importRoomKey } from "@pk-nerdsaver-ai/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@pk-nerdsaver-ai/pi-coding-agent/collab/guest";
import {
	type AgentSnapshot,
	COLLAB_PROTO,
	type CollabFrame,
	formatCollabLink,
	rewriteEnvelopePeer,
	unpackEnvelope,
} from "@pk-nerdsaver-ai/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@pk-nerdsaver-ai/pi-coding-agent/collab/relay-client";
import {
	countRunningSubagentBadgeAgents,
	getRunningSubagentBadgeRegistry,
} from "@pk-nerdsaver-ai/pi-coding-agent/modes/running-subagent-badge";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import { AgentRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-registry";

let activeRelay: InMemoryRelay | null = null;
const RealWebSocket = globalThis.WebSocket;

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	binaryType = "arraybuffer";
	readyState: number = FakeWebSocket.CONNECTING;
	readonly role: "host" | "guest";
	peerId = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	readonly #relay: InMemoryRelay;

	constructor(url: string) {
		const relay = activeRelay;
		if (!relay) throw new Error("FakeWebSocket: no active in-memory relay");
		this.#relay = relay;
		this.role = new URL(url).searchParams.get("role") === "host" ? "host" : "guest";
		queueMicrotask(() => {
			if (this.readyState !== FakeWebSocket.CONNECTING) return;
			this.readyState = FakeWebSocket.OPEN;
			relay.connect(this);
			this.onopen?.();
		});
	}

	send(data: Uint8Array): void {
		if (this.readyState !== FakeWebSocket.OPEN) return;
		const bytes = new Uint8Array(data);
		queueMicrotask(() => this.#relay.forward(this, bytes));
	}

	close(_code?: number): void {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.#relay.disconnect(this);
		queueMicrotask(() => this.onclose?.({ code: 1000, reason: "closed" }));
	}

	deliver(bytes: Uint8Array): void {
		if (this.readyState !== FakeWebSocket.OPEN) return;
		const copy = new Uint8Array(bytes);
		queueMicrotask(() => this.onmessage?.({ data: copy.buffer }));
	}

	deliverControl(json: string): void {
		if (this.readyState !== FakeWebSocket.OPEN) return;
		queueMicrotask(() => this.onmessage?.({ data: json }));
	}
}

class InMemoryRelay {
	#host: FakeWebSocket | null = null;
	readonly #guests = new Map<number, FakeWebSocket>();
	#nextPeerId = 1;

	connect(ws: FakeWebSocket): void {
		if (ws.role === "host") {
			this.#host = ws;
			return;
		}
		ws.peerId = this.#nextPeerId++;
		this.#guests.set(ws.peerId, ws);
		this.#host?.deliverControl(JSON.stringify({ t: "peer-joined", peer: ws.peerId }));
	}

	forward(from: FakeWebSocket, bytes: Uint8Array): void {
		if (from.role === "host") {
			const envelope = unpackEnvelope(bytes);
			if (!envelope) return;
			if (envelope.peerId === 0) {
				for (const guest of this.#guests.values()) guest.deliver(bytes);
			} else {
				this.#guests.get(envelope.peerId)?.deliver(bytes);
			}
			return;
		}
		rewriteEnvelopePeer(bytes, from.peerId);
		this.#host?.deliver(bytes);
	}

	disconnect(ws: FakeWebSocket): void {
		if (ws.role === "host") {
			if (this.#host === ws) this.#host = null;
			return;
		}
		this.#guests.delete(ws.peerId);
		this.#host?.deliverControl(JSON.stringify({ t: "peer-left", peer: ws.peerId }));
	}
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

function makeAgents(ids: string[]): AgentSnapshot[] {
	return ids.map((id, index) => ({
		id,
		displayName: `Remote ${index + 1}`,
		kind: "sub",
		parentId: "Main",
		status: "running",
		hasSessionFile: true,
		createdAt: 1000 + index,
		lastActivity: 2000 + index,
	}));
}

function makeGuestContext(counts: number[]): InteractiveModeContext {
	let statusLineCount = 0;
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
		},
		statusContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map(),
		loadingAnimation: undefined,
		statusLine: {
			setSubagentCount: (count: number) => {
				statusLineCount = count;
			},
			get subagentCount() {
				return statusLineCount;
			},
			setCollabStatus: () => {},
			invalidate: () => {},
			setSessionStartTime: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		showError: () => {},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		eventController: { handleEvent: () => Promise.resolve() },
		syncRunningSubagentBadge: () => {
			const registry = getRunningSubagentBadgeRegistry(ctx.collabGuest);
			const count = countRunningSubagentBadgeAgents(registry);
			ctx.statusLine.setSubagentCount(count);
			counts.push(count);
		},
	} as unknown as InteractiveModeContext;
	return ctx;
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	activeRelay = new InMemoryRelay();
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
	globalThis.WebSocket = RealWebSocket;
	activeRelay = null;
	AgentRegistry.resetGlobalForTests();
});

describe("collab guest running-subagents badge", () => {
	it("uses the guest mirror registry and refreshes on join, resnapshot, and leave", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const roomId = "badge-room-1";
		const roomKey = generateRoomKey();
		const cryptoKey = await importRoomKey(roomKey);
		const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);
		const hostSocket = new CollabSocket({ wsUrl: `ws://localhost:8788/r/${roomId}`, role: "host", key: cryptoKey });
		const hostOpen = Promise.withResolvers<void>();
		let nextWelcomeAgents = makeAgents(["remote-one"]);
		const sendWelcome = (agents: AgentSnapshot[]) => {
			hostSocket.send({
				t: "welcome",
				proto: COLLAB_PROTO,
				header: { type: "session", id: "remote-session", timestamp: "2026-06-26T00:00:00Z", cwd: "/tmp" },
				state: makeState(),
				agents,
				entryCount: 0,
			});
		};
		hostSocket.onOpen = () => hostOpen.resolve();
		hostSocket.onFrame = frame => {
			if (frame.t === "hello") sendWelcome(nextWelcomeAgents);
		};
		hostSocket.connect();
		await hostOpen.promise;

		const counts: number[] = [];
		const ctx = makeGuestContext(counts);
		const guest = new CollabGuestLink(ctx);

		try {
			await guest.join(link);
			expect(ctx.collabGuest).toBe(guest);
			expect(counts).toEqual([0, 1]);
			expect(ctx.statusLine.subagentCount).toBe(1);

			nextWelcomeAgents = makeAgents(["remote-one", "remote-two"]);
			const secondSnapshot = Promise.withResolvers<void>();
			const originalSync = ctx.syncRunningSubagentBadge.bind(ctx);
			ctx.syncRunningSubagentBadge = () => {
				originalSync();
				if (ctx.statusLine.subagentCount === 2) secondSnapshot.resolve();
			};
			sendWelcome(nextWelcomeAgents);
			await secondSnapshot.promise;
			expect(ctx.statusLine.subagentCount).toBe(2);

			await guest.leave("test cleanup");
			expect(ctx.collabGuest).toBeUndefined();
			expect(ctx.statusLine.subagentCount).toBe(0);
			expect(counts.at(-1)).toBe(0);
		} finally {
			hostSocket.close();
			writeSpy.mockRestore();
			await guest.leave("test cleanup").catch(() => {});
		}
	});
});
