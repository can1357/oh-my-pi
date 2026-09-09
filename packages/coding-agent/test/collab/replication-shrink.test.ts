/**
 * Regression contract for issue #3739: a session entry whose serialized JSON
 * exceeds the relay's per-frame `maxPayloadLength` MUST NOT kill the host's
 * WebSocket. Before the fix, `CollabHost.#sendSnapshotChunks` shipped any
 * single oversized entry as its own oversized chunk; the relay closed the
 * host with `1006 Received too big message`, `CollabSocket` reconnected on
 * the non-fatal code, the next guest hello triggered the same oversized
 * send, and the loop never broke ("/collab disconnects when session is too
 * large").
 *
 * The fixed host runs every replicated entry through
 * `shrinkForReplication` so a head-truncated mirror ships instead. The test
 * stands up a real Bun.serve relay with `maxPayloadLength` set tight, hosts
 * a snapshot containing one ~5 MB entry, and asserts:
 *
 *   1. The host's connection survives — no `Connection ended` close, no
 *      "reconnecting…" status loop.
 *   2. The guest receives a final `snapshot-chunk` train carrying the
 *      oversized entry with its content head-truncated and the elision
 *      marker present.
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
import {
	MAX_REPLICATED_PAYLOAD_BYTES,
	shrinkForReplication,
} from "@oh-my-pi/pi-coding-agent/collab/replication-shrink";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

interface RelayData {
	role: "host" | "guest";
	peerId: number;
}

type RelaySocket = Bun.ServerWebSocket<RelayData>;

interface TestRelay {
	url: string;
	stop(): void;
}

/**
 * Single-room relay mirroring the omp-collab-relay forwarding contract, with
 * a configurable `maxPayloadLength` so the test asserts the same close path
 * the public relay (Bun.serve default = 16 MB, proxies often lower) exposes.
 */
function startTestRelay(maxPayloadLength: number): TestRelay {
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
			maxPayloadLength,
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

interface OversizedSnapshot {
	header: { type: "session"; id: string; timestamp: string; cwd: string };
	entries: SessionEntry[];
	bigEntryId: string;
	bigPayloadLength: number;
}

/**
 * Snapshot with one well-formed small entry plus one ~5 MB entry. The
 * oversized payload sits in a `MessageEntry`'s user `content` because that
 * matches the realistic trigger (a tool result/message accumulated multiple
 * megabytes of `read`/`bash`/`search` output during the host session).
 */
function makeOversizedSnapshot(bigBytes: number): OversizedSnapshot {
	const big = "x".repeat(bigBytes);
	const entries: SessionEntry[] = [
		{
			type: "message",
			id: "small-1",
			parentId: null,
			timestamp: "2026-06-28T00:00:00Z",
			message: { role: "user", content: "hi", timestamp: 0 },
		},
		{
			type: "message",
			id: "big-1",
			parentId: null,
			timestamp: "2026-06-28T00:00:01Z",
			message: { role: "user", content: big, timestamp: 0 },
		},
	];
	return {
		header: { type: "session", id: "sess-big", timestamp: "2026-06-28T00:00:00Z", cwd: "/tmp" },
		entries,
		bigEntryId: "big-1",
		bigPayloadLength: bigBytes,
	};
}

interface HostHarness {
	ctx: InteractiveModeContext;
	statusMessages: string[];
}

function makeHostContext(snapshot: OversizedSnapshot): HostHarness {
	const statusMessages: string[] = [];
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
			isAborting: false,
			queuedMessageCount: 0,
			sessionName: "big",
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
		showStatus: (msg: string) => statusMessages.push(msg),
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
	return { ctx, statusMessages };
}

// ── Fixture ────────────────────────────────────────────────────────────────

/**
 * 5 MB single-entry payload is comfortably above the 1 MB replication ceiling
 * the host's `shrinkForReplication` enforces but well below the relay's
 * `maxPayloadLength` here (8 MB). Pre-fix this entry shipped as its own
 * ~5 MB chunk through the relay; today it ships head-truncated to ~64 KB.
 */
const BIG_PAYLOAD_BYTES = 5 * 1024 * 1024;

/** Tighter than Bun's 16 MB default so the test reliably exercises the same
 * close path real relays expose without making the test heavy. */
const RELAY_MAX_PAYLOAD = 8 * 1024 * 1024;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("collab replication shrinking (#3739)", () => {
	it("ships an oversized entry without disconnecting the host", async () => {
		const relay = startTestRelay(RELAY_MAX_PAYLOAD);
		cleanups.push(() => relay.stop());

		const snapshot = makeOversizedSnapshot(BIG_PAYLOAD_BYTES);
		const harness = makeHostContext(snapshot);
		const host = new CollabHost(harness.ctx);
		await host.start(relay.url);
		cleanups.push(() => host.stop("test done"));

		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
		const key = await importRoomKey(parsed.key);

		const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
		cleanups.push(() => guest.close());

		const frames: CollabFrame[] = [];
		const closes: { reason: string; willReconnect: boolean }[] = [];
		const trainDone = Promise.withResolvers<void>();
		guest.onFrame = frame => {
			frames.push(frame);
			if (frame.t === "snapshot-chunk" && frame.final) trainDone.resolve();
		};
		guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "test", writeToken });
		const guestClosed = Promise.withResolvers<void>();
		guest.onClose = (reason, willReconnect) => {
			closes.push({ reason, willReconnect });
			guestClosed.resolve();
		};
		guest.connect();

		// Pre-fix, the host's oversized chunk killed its WebSocket; the relay
		// then fanned `room closed` (4001) to the guest. Race the train against
		// that close so the test fails fast with a clear cause instead of
		// stalling out the bun:test per-test timeout. Both paths are real
		// signals — no wall-clock sleeps.
		await Promise.race([
			trainDone.promise,
			guestClosed.promise.then(() => {
				throw new Error(`snapshot train aborted by relay close: ${JSON.stringify(closes)}`);
			}),
		]);

		// Host stayed up: no relay-side close fanned the room shutdown to the
		// guest, and no "reconnecting…" status fired.
		expect(closes).toEqual([]);
		expect(harness.statusMessages.some(msg => msg.includes("reconnecting"))).toBe(false);

		// Guest received the welcome plus a chunk train carrying both entries.
		const welcome = frames.find(f => f.t === "welcome");
		expect(welcome).toBeDefined();
		if (welcome?.t !== "welcome") throw new Error("expected welcome frame");
		expect(welcome.entryCount).toBe(snapshot.entries.length);

		const chunkEntries: SessionEntry[] = [];
		for (const f of frames) if (f.t === "snapshot-chunk") chunkEntries.push(...f.entries);
		expect(chunkEntries.map(e => e.id)).toEqual(snapshot.entries.map(e => e.id));

		const bigShrunk = chunkEntries.find(e => e.id === snapshot.bigEntryId);
		if (bigShrunk?.type !== "message") throw new Error("expected shrunk big message entry");
		const bigMessage = bigShrunk.message;
		if (bigMessage.role !== "user") throw new Error("expected shrunk big user message");
		const shrunkContent = bigMessage.content;
		if (typeof shrunkContent !== "string") throw new Error("expected string content after shrink");
		// Original was 5 MB; the head-truncation marker carries the exact
		// number of dropped chars so the guest can show "this was bigger".
		expect(shrunkContent.length).toBeLessThan(snapshot.bigPayloadLength / 10);
		expect(shrunkContent).toContain("chars elided for collab session");
	});
});

describe("shrinkForReplication (#3740 review)", () => {
	it("passes already-small values through by reference", () => {
		const small = { type: "message", id: "x", text: "hi" };
		expect(shrinkForReplication(small)).toBe(small);
	});

	it("clamps a single giant string under the cap with an elision marker", () => {
		const giant = { content: "x".repeat(5 * 1024 * 1024) };
		const shrunk = shrinkForReplication(giant);
		const size = JSON.stringify(shrunk).length;
		expect(size).toBeLessThanOrEqual(MAX_REPLICATED_PAYLOAD_BYTES);
		expect(shrunk).not.toBe(giant);
		expect(shrunk.content).toContain("chars elided for collab session");
	});

	it("clamps a payload built of many short strings (no individual oversized) under the cap", () => {
		// Realistic shape: a tool result content array with thousands of small
		// text blocks. ~3 MB total; no individual string crosses the 64 B
		// floor of the final shrink pass, so the helper MUST clip the array,
		// not just the strings.
		const content = Array.from({ length: 100_000 }, (_, i) => ({
			type: "text",
			text: `block-${i}`,
		}));
		const payload = { role: "toolResult", content };
		const original = JSON.stringify(payload).length;
		expect(original).toBeGreaterThan(MAX_REPLICATED_PAYLOAD_BYTES);
		const shrunk = shrinkForReplication(payload);
		const shrunkSize = JSON.stringify(shrunk).length;
		expect(shrunkSize).toBeLessThanOrEqual(MAX_REPLICATED_PAYLOAD_BYTES);
		// Array was clipped with a summary marker reporting the dropped count.
		const shrunkContent = shrunk.content;
		expect(Array.isArray(shrunkContent)).toBe(true);
		const marker = shrunkContent.find(
			(item: unknown) => typeof item === "string" && item.includes("items elided for collab session"),
		);
		expect(marker).toBeDefined();
	});

	it("preserves the wire discriminator on a fully-shrunk payload", () => {
		// Even the worst-case final pass keeps the discriminator key/value
		// pairs intact (only string leaves and array tails are touched), so
		// guests still see the entry/event as the correct kind.
		const evt = {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: { text: "x".repeat(8 * 1024 * 1024) },
		};
		const shrunk = shrinkForReplication(evt);
		expect(shrunk.type).toBe("tool_execution_end");
		expect(shrunk.toolCallId).toBe("call-1");
		expect(shrunk.toolName).toBe("read");
		expect(JSON.stringify(shrunk).length).toBeLessThanOrEqual(MAX_REPLICATED_PAYLOAD_BYTES);
	});
});
