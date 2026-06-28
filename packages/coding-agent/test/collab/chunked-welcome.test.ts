/**
 * Contract: a large session snapshot is delivered as a small `welcome` frame
 * plus a train of `snapshot-chunk` frames, so the guest can clear its 30s
 * first-welcome timeout long before the full transcript arrives — the fix for
 * [#3144](https://github.com/can1357/oh-my-pi/issues/3144) where a multi-MB
 * single-frame welcome timed out on the default relay.
 *
 * The test drives the production `CollabHost` (real sealing, real envelopes)
 * through an in-process relay + fake WebSocket, mirroring the relay's
 * forwarding contract exactly; only the TUI context and the network transport
 * are stubbed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { importRoomKey } from "@pk-nerdsaver-ai/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@pk-nerdsaver-ai/pi-coding-agent/collab/guest";
import { CollabHost } from "@pk-nerdsaver-ai/pi-coding-agent/collab/host";
import {
	COLLAB_PROTO,
	type CollabFrame,
	parseCollabLink,
	rewriteEnvelopePeer,
	unpackEnvelope,
} from "@pk-nerdsaver-ai/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@pk-nerdsaver-ai/pi-coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import type { SessionEntry } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-entries";

// ── In-memory transport (verbatim copy of the relay used in read-only.test.ts) ──

let activeRelay: InMemoryRelay | null = null;

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	binaryType = "blob";
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

// ── Host harness with a configurable transcript ────────────────────────────

interface SizedSnapshot {
	header: { type: "session"; id: string; timestamp: string; cwd: string };
	entries: SessionEntry[];
}

/**
 * Build a synthetic transcript whose total serialized size comfortably
 * exceeds the host's `SNAPSHOT_CHUNK_BYTES` (512 KB), forcing several
 * chunks. Each entry is ~16 KB of repeated text, so 96 entries → ~1.5 MB,
 * cleanly above three chunks without making the test slow.
 */
function makeLargeSnapshot(): SizedSnapshot {
	const body = "x".repeat(16 * 1024);
	const entries: SessionEntry[] = [];
	for (let i = 0; i < 96; i++) {
		entries.push({
			type: "message",
			id: `e${i}`,
			parentId: null,
			timestamp: "2026-06-20T00:00:00Z",
			message: { role: "user", content: body, timestamp: 0 },
		});
	}
	return {
		header: { type: "session", id: "sess-large", timestamp: "2026-06-20T00:00:00Z", cwd: "/tmp" },
		entries,
	};
}

function makeHostContext(snapshot: SizedSnapshot): InteractiveModeContext {
	const ctx = {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => snapshot.header.id,
			getCwd: () => snapshot.header.cwd,
			snapshotForReplication: () => snapshot,
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "large",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	};
	return ctx as unknown as InteractiveModeContext;
}

function makeFailingGuestContext(failure: Error): InteractiveModeContext {
	const ctx = {
		settings: { get: () => "" },
		sessionManager: {
			getSessionFile: () => null,
			switchSession: () => Promise.reject(failure),
		},
		session: {
			newSession: () => Promise.resolve(),
			messages: [],
		},
		statusContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map(),
		loadingAnimation: undefined,
		statusLine: {
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
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		collabGuest: undefined,
	} as unknown as InteractiveModeContext;
	return ctx;
}

// ── Shared host/relay ───────────────────────────────────────────────────────

const RealWebSocket = globalThis.WebSocket;
const snapshot = makeLargeSnapshot();
let host: CollabHost;

beforeAll(async () => {
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	activeRelay = new InMemoryRelay();
	host = new CollabHost(makeHostContext(snapshot));
	await host.start("ws://localhost:8788");
});

afterAll(async () => {
	globalThis.WebSocket = RealWebSocket;
	activeRelay = null;
	await host.stop("test done");
});

const guestCleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
});

describe("collab chunked welcome (#3144)", () => {
	it("delivers a small welcome before chunking the transcript across multiple frames", async () => {
		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
		const key = await importRoomKey(parsed.key);
		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
		guestCleanups.push(() => socket.close());

		const frames: CollabFrame[] = [];
		const trainDone = Promise.withResolvers<void>();
		socket.onFrame = frame => {
			frames.push(frame);
			if (frame.t === "snapshot-chunk" && frame.final) trainDone.resolve();
		};
		socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "test", writeToken });
		socket.connect();
		await trainDone.promise;

		const welcomeIdx = frames.findIndex(f => f.t === "welcome");
		expect(welcomeIdx).toBeGreaterThanOrEqual(0);
		const welcome = frames[welcomeIdx];
		if (welcome?.t !== "welcome") throw new Error("expected welcome frame");

		expect(welcome.entryCount).toBe(snapshot.entries.length);
		expect(welcome.header.id).toBe(snapshot.header.id);
		// Critical fix: the welcome itself MUST NOT carry the transcript inline —
		// inline bytes were what spent the guest's 30s timeout in #3144.
		const welcomeBytes = JSON.stringify(welcome).length;
		const snapshotBytes = JSON.stringify(snapshot).length;
		expect(welcomeBytes).toBeLessThan(snapshotBytes / 10);

		// The chunk train starts immediately after the welcome and the host
		// queues every chunk synchronously, so no other directed frame may
		// interleave between them.
		const chunks: { entries: SessionEntry[]; final: boolean }[] = [];
		for (let i = welcomeIdx + 1; i < frames.length; i++) {
			const f = frames[i];
			if (f?.t !== "snapshot-chunk") {
				throw new Error(`unexpected ${f?.t ?? "missing"} between welcome and final chunk`);
			}
			chunks.push({ entries: f.entries, final: f.final });
			if (f.final) break;
		}
		// Three+ chunks proves we honor the 512 KB cap with the 1.5 MB transcript;
		// only the last carries `final: true`.
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.at(-1)?.final).toBe(true);
		expect(chunks.slice(0, -1).every(c => !c.final)).toBe(true);

		const flattened: SessionEntry[] = [];
		for (const chunk of chunks) flattened.push(...chunk.entries);
		expect(flattened.length).toBe(snapshot.entries.length);
		expect(flattened.map(e => e.id)).toEqual(snapshot.entries.map(e => e.id));
	});

	it("rejects the pending join when snapshot resume fails", async () => {
		const failure = new Error("replica write failed during snapshot resume");
		const writeSpy = spyOn(Bun, "write").mockRejectedValue(failure);
		const guest = new CollabGuestLink(makeFailingGuestContext(failure));
		const joinAttempt = guest.join(host.link);
		try {
			await expect(
				Promise.race([
					joinAttempt,
					Bun.sleep(250).then(() => {
						throw new Error("join did not reject");
					}),
				]),
			).rejects.toThrow("replica write failed during snapshot resume");
		} finally {
			writeSpy.mockRestore();
			await guest.leave("test cleanup").catch(() => {});
		}
	});
});
