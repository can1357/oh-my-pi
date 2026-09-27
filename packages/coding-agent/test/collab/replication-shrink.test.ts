/**
 * Regression contract for issue #3739: a session entry whose serialized JSON
 * exceeds the relay's per-frame `maxPayloadLength` MUST NOT kill the host's
 * WebSocket. Before that fix, `CollabHost.#sendSnapshotChunks` shipped any
 * single oversized entry as its own oversized chunk; the relay closed the
 * host with `1006 Received too big message`, `CollabSocket` reconnected on
 * the non-fatal code, the next guest hello triggered the same oversized
 * send, and the loop never broke ("/collab disconnects when session is too
 * large").
 *
 * The fixed host runs every replicated entry through `shrinkReplicatedEntry`
 * so a head-truncated mirror ships instead. The test stands up a real
 * Bun.serve relay with `maxPayloadLength` set tight, hosts a snapshot
 * containing one ~5 MB entry, and asserts:
 *
 *   1. The host's connection survives — no `Connection ended` close, no
 *      "reconnecting…" status loop.
 *   2. The guest receives a final `snapshot-chunk` train carrying the
 *      oversized entry with its content head-truncated and the elision
 *      marker present.
 *
 * Regression contract for issue #11433: the ceiling is *enforced*, not
 * approached. String/array shrinking cannot touch size that lives in object
 * keys, the walk used to recurse into a `RangeError` on a deep entry, and the
 * cap was compared against UTF-16 code units instead of the bytes the relay
 * sees. Each of those is reproduced below against the fixed helper, whose
 * observable contract is: never throws, always returns something under
 * {@link MAX_REPLICATED_PAYLOAD_BYTES}, and preserves the entry's
 * `id`/`parentId` so the guest's branch chain stays connected.
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
	COLLAB_ENTRY_OMITTED_CUSTOM_TYPE,
	copyForReplication,
	MAX_REPLICATED_PAYLOAD_BYTES,
	oversizedEntryNotice,
	type ReplicatedEntry,
	replicationByteLength,
	shrinkReplicatedEntry,
	shrinkReplicatedEvent,
} from "@oh-my-pi/pi-coding-agent/collab/replication-shrink";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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

interface HostSnapshot {
	header: { type: "session"; id: string; timestamp: string; cwd: string };
	entries: SessionEntry[];
}

interface OversizedSnapshot extends HostSnapshot {
	bigEntryId: string;
	bigPayloadLength: number;
}

function userMessage(id: string, parentId: string | null, timestamp: string, content: string): ReplicatedEntry {
	return { type: "message", id, parentId, timestamp, message: { role: "user", content, timestamp: 0 } };
}

/**
 * Snapshot with one well-formed small entry plus one ~5 MB entry. The
 * oversized payload sits in a `MessageEntry`'s user `content` because that
 * matches the realistic trigger (a tool result/message accumulated multiple
 * megabytes of `read`/`bash`/`search` output during the host session). This
 * one is *shrinkable*: the size lives in a single string leaf.
 */
function makeOversizedSnapshot(bigBytes: number): OversizedSnapshot {
	const big = "x".repeat(bigBytes);
	return {
		header: { type: "session", id: "sess-big", timestamp: "2026-06-28T00:00:00Z", cwd: "/tmp" },
		entries: [
			userMessage("small-1", null, "2026-06-28T00:00:00Z", "hi"),
			userMessage("big-1", "small-1", "2026-06-28T00:00:01Z", big),
		],
		bigEntryId: "big-1",
		bigPayloadLength: bigBytes,
	};
}

/**
 * Snapshot whose second entry is *unshrinkable*: its size lives entirely in a
 * single 17 MiB object key, which no string/array pass may drop because keys
 * are identity. Pre-#11433 this entry shipped at full size (17.8 MB), tripping
 * the relay's frame limit; the fixed host substitutes a typed placeholder
 * that keeps the entry's id, so the chunk train still terminates.
 */
function makeUnshrinkableSnapshot(): HostSnapshot & { omittedEntryId: string } {
	const giantKey = "k".repeat(17 * 1024 * 1024);
	return {
		header: { type: "session", id: "sess-key", timestamp: "2026-09-13T00:00:00Z", cwd: "/tmp" },
		entries: [
			userMessage("small-1", null, "2026-09-13T00:00:00Z", "hi"),
			{
				type: "message",
				id: "huge-key-1",
				parentId: "small-1",
				timestamp: "2026-09-13T00:00:01Z",
				message: { role: "user", content: "", timestamp: 0, blob: { [giantKey]: 1 } },
			} as unknown as ReplicatedEntry,
		],
		omittedEntryId: "huge-key-1",
	};
}

interface HostHarness {
	ctx: InteractiveModeContext;
	statusMessages: string[];
}

/**
 * The slice of `SessionManager` the host actually drives. Narrowing it here is
 * what lets a case supply either a fixture snapshot or the real manager — and
 * the real manager is the interesting one, because it owns the deep copy the
 * host performs before the shrinker runs.
 */
interface HostReplicationSource {
	getSessionId(): string;
	getCwd(): string;
	snapshotForReplication(copy?: <T>(value: T) => T): HostSnapshot;
	onEntryAppended?: ((entry: SessionEntry) => void) | undefined;
}

function makeHostContext(snapshot: HostSnapshot): HostHarness {
	return makeHostHarness({
		getSessionId: () => snapshot.header.id,
		getCwd: () => snapshot.header.cwd,
		snapshotForReplication: () => snapshot,
		onEntryAppended: undefined,
	});
}

function makeHostHarness(sessionManager: HostReplicationSource): HostHarness {
	const statusMessages: string[] = [];
	const ctx = {
		settings: Settings.isolated(),
		sessionManager,
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

/**
 * Connect a real guest to `host` and collect its frames until the snapshot
 * train reports `final`. Races the train against a relay close so a
 * regression fails with the close reason instead of stalling out the test
 * timeout — both paths are real signals, no wall-clock sleeps.
 */
async function collectSnapshotTrain(host: CollabHost): Promise<{
	frames: CollabFrame[];
	closes: { reason: string; willReconnect: boolean }[];
}> {
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const key = await importRoomKey(parsed.key);

	const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => guest.close());

	const frames: CollabFrame[] = [];
	const closes: { reason: string; willReconnect: boolean }[] = [];
	const trainDone = Promise.withResolvers<void>();
	const guestClosed = Promise.withResolvers<void>();
	guest.onFrame = frame => {
		frames.push(frame);
		if (frame.t === "snapshot-chunk" && frame.final) trainDone.resolve();
	};
	guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "test", writeToken });
	guest.onClose = (reason, willReconnect) => {
		closes.push({ reason, willReconnect });
		guestClosed.resolve();
	};
	guest.connect();

	await Promise.race([
		trainDone.promise,
		guestClosed.promise.then(() => {
			throw new Error(`snapshot train aborted by relay close: ${JSON.stringify(closes)}`);
		}),
	]);
	return { frames, closes };
}

/** Bound assertion used by every #11433 case: measurable and under the ceiling. */
function expectBounded(value: unknown): number {
	const bytes = replicationByteLength(value);
	if (bytes === null) throw new Error("expected a serializable, measurable payload");
	expect(bytes).toBeLessThanOrEqual(MAX_REPLICATED_PAYLOAD_BYTES);
	return bytes;
}

// ── Fixture ────────────────────────────────────────────────────────────────

/**
 * 5 MB single-entry payload is comfortably above the 1 MB replication ceiling
 * the host's `shrinkReplicatedEntry` enforces but well below the relay's
 * `maxPayloadLength` here (8 MB). Pre-#3739 this entry shipped as its own
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

		const { frames, closes } = await collectSnapshotTrain(host);

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

describe("shrinkReplicatedEntry (#11433)", () => {
	it("does not substitute a placeholder for an entry that already fits", () => {
		// Negative contract: the ceiling may only rewrite a payload it cannot
		// bound. An entry under it must reach the guest verbatim — substituting
		// here would show every ordinary entry as "too large to replicate".
		const small = userMessage("m1", null, "2026-09-13T00:00:00Z", "hi");
		const shrunk = shrinkReplicatedEntry(small);
		expect(shrunk.type).toBe("message");
		const serialized = JSON.stringify(shrunk);
		expect(serialized).not.toContain(COLLAB_ENTRY_OMITTED_CUSTOM_TYPE);
		expect(serialized).not.toContain("elided for collab session");
	});

	it("clamps a single giant string under the ceiling with an elision marker", () => {
		const entry = userMessage("m1", null, "2026-09-13T00:00:00Z", "x".repeat(5 * 1024 * 1024));
		const shrunk = shrinkReplicatedEntry(entry);
		expect(shrunk).not.toBe(entry);
		expectBounded(shrunk);
		if (shrunk.type !== "message" || shrunk.message.role !== "user") throw new Error("expected user message");
		expect(shrunk.message.content).toContain("chars elided for collab session");
	});

	it("clamps a payload built of many short strings (no individual oversized)", () => {
		// Realistic shape: a tool result content array with thousands of small
		// text blocks. No individual string crosses the final pass's 64 B
		// floor, so the helper MUST clip the array, not just the strings.
		const content = Array.from({ length: 100_000 }, (_, i) => ({ type: "text", text: `block-${i}` }));
		const entry = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-09-13T00:00:00Z",
			message: { role: "toolResult", content, timestamp: 0 },
		} as unknown as ReplicatedEntry;
		expect(replicationByteLength(entry) ?? 0).toBeGreaterThan(MAX_REPLICATED_PAYLOAD_BYTES);

		const shrunk = shrinkReplicatedEntry(entry);
		expectBounded(shrunk);
		if (shrunk.type !== "message") throw new Error("expected message entry");
		const shrunkContent = (shrunk.message as unknown as { content: unknown[] }).content;
		expect(Array.isArray(shrunkContent)).toBe(true);
		expect(
			shrunkContent.some(item => typeof item === "string" && item.includes("items elided for collab session")),
		).toBe(true);
	});

	it("replaces an entry whose size lives in one giant object key", () => {
		// Pre-fix: 17,825,798 bytes shipped untouched, because keys are identity
		// and every pass only walked string leaves and array tails.
		const giantKey = "k".repeat(17 * 1024 * 1024);
		const entry = {
			type: "message",
			id: "m1",
			parentId: "parent-1",
			timestamp: "2026-09-13T00:00:00Z",
			message: { role: "user", content: "", timestamp: 0, blob: { [giantKey]: 1 } },
		} as unknown as ReplicatedEntry;

		const shrunk = shrinkReplicatedEntry(entry);
		expect(shrunk.type).toBe("custom_message");
		expectBounded(shrunk);
		if (shrunk.type !== "custom_message") throw new Error("expected typed placeholder");
		expect(shrunk.customType).toBe(COLLAB_ENTRY_OMITTED_CUSTOM_TYPE);
		// Identity survives, which is what keeps the guest's branch connected.
		expect(shrunk.id).toBe("m1");
		expect(shrunk.parentId).toBe("parent-1");
	});

	it("replaces an entry whose size lives in the number of its keys", () => {
		// Pre-fix: 200,000 short keys shipped as ~5 MB, untouched.
		const blob: Record<string, number> = {};
		for (let i = 0; i < 200_000; i++) blob[`k${i}`] = i;
		const entry = {
			type: "message",
			id: "m2",
			parentId: "parent-2",
			timestamp: "2026-09-13T00:00:00Z",
			message: { role: "user", content: "", timestamp: 0, blob },
		} as unknown as ReplicatedEntry;

		const shrunk = shrinkReplicatedEntry(entry);
		expect(shrunk.type).toBe("custom_message");
		expectBounded(shrunk);
		expect(shrunk.id).toBe("m2");
	});

	it("degrades a 50,000-deep entry instead of blowing the stack", () => {
		// Pre-fix: recursive walk threw `RangeError: Maximum call stack size
		// exceeded`, and every caller swallows it — the live path silently
		// dropped the entry, the snapshot path stranded the joining guest
		// without a `final` chunk.
		let deep: unknown = "leaf";
		for (let i = 0; i < 50_000; i++) deep = { a: deep };
		const entry = {
			type: "message",
			id: "m3",
			parentId: "parent-3",
			timestamp: "2026-09-13T00:00:00Z",
			message: { role: "user", content: "", timestamp: 0, blob: deep },
		} as unknown as ReplicatedEntry;

		const shrunk = shrinkReplicatedEntry(entry);
		// The depth cap is what makes this serializable at all: the engine's own
		// `JSON.stringify`/`structuredClone` throw at ~40,000 levels, so the
		// walk must emit a shallower clone than it was given.
		expectBounded(shrunk);
		expect(shrunk.id).toBe("m3");
		const roundTripped = JSON.parse(JSON.stringify(shrunk)) as SessionEntry;
		expect(roundTripped.id).toBe("m3");
	});

	it("measures the ceiling in UTF-8 bytes, not UTF-16 code units", () => {
		// 400,000 CJK chars: ~400 KB of code units, so the old
		// `JSON.stringify(...).length` check passed it through untouched, while
		// the relay saw ~1.2 MB — a 3x overshoot on top of the intended cap.
		const entry = userMessage("m4", null, "2026-09-13T00:00:00Z", "中".repeat(400_000));
		const asJson = JSON.stringify(entry);
		expect(asJson.length).toBeLessThanOrEqual(MAX_REPLICATED_PAYLOAD_BYTES);
		expect(Buffer.byteLength(asJson, "utf8")).toBeGreaterThan(MAX_REPLICATED_PAYLOAD_BYTES);

		const shrunk = shrinkReplicatedEntry(entry);
		expect(shrunk).not.toBe(entry);
		expectBounded(shrunk);
	});

	it("degrades a cyclic payload to a marker instead of looping forever", () => {
		// The recursive walk threw on a cycle; an iterative walk would instead
		// follow it forever. Neither is acceptable, and an entry that only has a
		// cycle in one branch should keep the rest of its shape.
		const cyclic: Record<string, unknown> = { id: "m5" };
		cyclic.self = cyclic;
		const entry = {
			type: "message",
			id: "m5",
			parentId: null,
			timestamp: "2026-09-13T00:00:00Z",
			message: { role: "user", content: "", timestamp: 0, blob: cyclic },
		} as unknown as ReplicatedEntry;

		// `JSON.stringify` refuses it outright, so the ceiling cannot even be
		// measured — that is what routes it through the walk rather than
		// returning it by reference.
		expect(replicationByteLength(entry)).toBeNull();

		const shrunk = shrinkReplicatedEntry(entry);
		expectBounded(shrunk);
		expect(shrunk.id).toBe("m5");
		if (shrunk.type !== "message") throw new Error("expected the message entry to survive");
		const blob = (shrunk.message as unknown as { blob: { self: unknown } }).blob;
		expect(typeof blob.self).toBe("string");
		expect(blob.self).toContain("cyclic reference elided for collab session");
	});

	it("keeps the guest's branch connected across an omitted entry", () => {
		// The full point of preserving id/parentId: the entry after the omitted
		// one still resolves against a branch the guest can walk.
		const giantKey = "k".repeat(17 * 1024 * 1024);
		const omitted = {
			type: "message",
			id: "omitted",
			parentId: "prior",
			timestamp: "2026-09-13T00:00:00Z",
			message: { role: "user", content: "", timestamp: 0, blob: { [giantKey]: 1 } },
		} as unknown as ReplicatedEntry;
		const successor = userMessage("successor", "omitted", "2026-09-13T00:00:01Z", "after");

		const manager = SessionManager.inMemory();
		manager.ingestReplicatedEntry(userMessage("prior", null, "2026-09-13T00:00:00Z", "before"));
		manager.ingestReplicatedEntry(shrinkReplicatedEntry(omitted));
		manager.ingestReplicatedEntry(successor);

		expect(manager.getBranch().map(entry => entry.id)).toEqual(["prior", "omitted", "successor"]);
	});
});

describe("shrinkReplicatedEvent (#11433)", () => {
	it("does not substitute a notice for an event that already fits", () => {
		const event: AgentSessionEvent = { type: "agent_end", messages: [] } as unknown as AgentSessionEvent;
		const shrunk = shrinkReplicatedEvent(event);
		expect(shrunk.type).toBe("agent_end");
		expect(JSON.stringify(shrunk)).not.toContain("Host event omitted");
	});

	it("still shrinks an event whose size lives in a string leaf", () => {
		const event = {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: { text: "x".repeat(8 * 1024 * 1024) },
		} as unknown as AgentSessionEvent;

		const shrunk = shrinkReplicatedEvent(event);
		expect(shrunk).not.toBe(event);
		expect(shrunk.type).toBe("tool_execution_end");
		expectBounded(shrunk);
	});

	it("replaces an unshrinkable event with a notice naming the omitted type", () => {
		// Events carry no id to preserve, and a notice never enters agent state
		// or the model context — so the substitution stays out of the guest's
		// conversation instead of silently diverging from the host's view.
		const giantKey = "k".repeat(17 * 1024 * 1024);
		const event = {
			type: "tool_execution_end",
			toolCallId: "call-2",
			toolName: "read",
			result: { [giantKey]: 1 },
		} as unknown as AgentSessionEvent;

		const shrunk = shrinkReplicatedEvent(event);
		expect(shrunk.type).toBe("notice");
		expectBounded(shrunk);
		if (shrunk.type !== "notice") throw new Error("expected notice event");
		expect(shrunk.level).toBe("warning");
		expect(shrunk.message).toContain("tool_execution_end");
	});
});

/** `depth`-level nested object. 50 000 is past what the engine's own
 * `structuredClone`/`JSON.stringify` accept on Bun (both throw `RangeError` at
 * roughly 40 000), which is the shape this case needs. */
function nest(depth: number): unknown {
	let node: unknown = "leaf";
	for (let i = 0; i < depth; i++) node = { next: node };
	return node;
}

describe("collab snapshot train over a real SessionManager (#11433)", () => {
	it("degrades a too-deep entry instead of aborting the train before the shrinker", async () => {
		const relay = startTestRelay(RELAY_MAX_PAYLOAD);
		cleanups.push(() => relay.stop());

		// Every other host case injects a snapshot object literal, which skips
		// `snapshotForReplication` entirely. This one runs the real manager, so
		// the host's own deep copy of the entries is on the path being tested —
		// the copy that used to throw before the shrinker could bound anything.
		const manager = SessionManager.inMemory();
		manager.ingestReplicatedEntry(userMessage("small-1", null, "2026-09-13T00:00:00Z", "hi"));
		manager.ingestReplicatedEntry({
			type: "message",
			id: "deep-1",
			parentId: "small-1",
			timestamp: "2026-09-13T00:00:01Z",
			message: { role: "user", content: "probe", timestamp: 0, blob: nest(50_000) },
		} as unknown as ReplicatedEntry);

		const harness = makeHostHarness(manager);
		const host = new CollabHost(harness.ctx);
		await host.start(relay.url);
		cleanups.push(() => host.stop("test done"));

		// Pre-fix this rejected: the throw left `#handleHello` before the chunk
		// train started, so the guest never received a `final` chunk.
		const { frames, closes } = await collectSnapshotTrain(host);
		expect(closes).toEqual([]);

		const chunkEntries: SessionEntry[] = [];
		for (const f of frames) if (f.t === "snapshot-chunk") chunkEntries.push(...f.entries);
		expect(chunkEntries.map(entry => entry.id)).toEqual(["small-1", "deep-1"]);

		// Bounding the depth, not the entry: the too-deep branch is elided, so
		// the entry keeps its own identity and still fits the ceiling — it is
		// not one of the typed placeholders reserved for payloads that cannot be
		// bounded at all.
		const deep = chunkEntries.find(entry => entry.id === "deep-1");
		if (deep?.type !== "message") throw new Error("expected the deep entry to survive as a message entry");
		expect(deep.parentId).toBe("small-1");
		expect(JSON.stringify(deep)).toContain("deeper levels elided for collab session");
		expectBounded(deep);

		const replica = SessionManager.inMemory();
		for (const entry of chunkEntries) replica.ingestReplicatedEntry(entry);
		expect(replica.getBranch().map(entry => entry.id)).toEqual(["small-1", "deep-1"]);
	});
});

describe("collab snapshot train under an unshrinkable entry (#11433)", () => {
	it("terminates the train with final:true and substitutes a typed placeholder", async () => {
		const relay = startTestRelay(RELAY_MAX_PAYLOAD);
		cleanups.push(() => relay.stop());

		const snapshot = makeUnshrinkableSnapshot();
		const harness = makeHostContext(snapshot);
		const host = new CollabHost(harness.ctx);
		await host.start(relay.url);
		cleanups.push(() => host.stop("test done"));

		// Pre-fix the 17.8 MB entry either shipped whole (relay close, guest
		// join aborted) or, once the walk was reached with a deep payload, threw
		// out of the chunker — which `.catch`es to a debug log and leaves the
		// guest waiting for a `final` chunk that never comes.
		const { frames, closes } = await collectSnapshotTrain(host);

		expect(closes).toEqual([]);
		expect(harness.statusMessages.some(msg => msg.includes("reconnecting"))).toBe(false);

		const chunkEntries: SessionEntry[] = [];
		for (const f of frames) if (f.t === "snapshot-chunk") chunkEntries.push(...f.entries);
		expect(chunkEntries.map(entry => entry.id)).toEqual(snapshot.entries.map(entry => entry.id));

		const omitted = chunkEntries.find(entry => entry.id === snapshot.omittedEntryId);
		if (omitted?.type !== "custom_message") throw new Error("expected the typed placeholder entry");
		expect(omitted.customType).toBe(COLLAB_ENTRY_OMITTED_CUSTOM_TYPE);
		expect(omitted.parentId).toBe("small-1");
		expect(omitted.display).toBe(true);

		// The replica the guest walks keeps the chain across the substitution.
		const replica = SessionManager.inMemory();
		for (const entry of chunkEntries) replica.ingestReplicatedEntry(entry);
		expect(replica.getBranch().map(entry => entry.id)).toEqual(snapshot.entries.map(entry => entry.id));
	});
});

describe("copyForReplication JSON contract (PR #11999 review)", () => {
	it("preserves own __proto__ keys as data instead of mutating the clone's prototype", () => {
		// structuredClone round-trips an own `__proto__` key as data; the walker
		// must too. A plain `{}` destination routes the key through the
		// inherited setter: the metadata silently drops from the guest's JSONL
		// replica and the clone's prototype changes.
		const value: Record<string, unknown> = Object.create(null);
		Object.defineProperty(value, "__proto__", {
			value: { injected: true },
			writable: true,
			enumerable: true,
			configurable: true,
		});
		value.normal = "metadata";

		const copy = copyForReplication(value) as Record<string, unknown>;
		expect(Object.getPrototypeOf(copy)).toBe(null);
		expect(Object.prototype.hasOwnProperty.call(copy, "__proto__")).toBe(true);
		expect((copy.__proto__ as { injected: boolean }).injected).toBe(true);
		// Exact bytes: the own `__proto__` key must appear in the serialized
		// payload (built as a literal it would invoke the setter and vanish).
		expect(JSON.stringify(copy)).toBe('{"__proto__":{"injected":true},"normal":"metadata"}');

		// Nested containers get the same protection: the poisoned key lives one
		// level down, exactly where an extension payload would carry it.
		const nested = copyForReplication({ details: value }) as { details: Record<string, unknown> };
		expect(Object.prototype.hasOwnProperty.call(nested.details, "__proto__")).toBe(true);
		expect(JSON.stringify(nested.details)).toContain("injected");
	});

	it("honors own toJSON on snapshot leaves instead of walking them as empty objects", () => {
		// A Date survives structuredClone and serializes through its `toJSON`;
		// the walker must reflect that contract, not emit `{}` from the Date's
		// empty own-key view. Extension custom_message details are the
		// realistic carrier.
		const date = new Date("2026-09-13T12:00:00.000Z");
		const value = { details: { at: date, label: "x" } };

		const copy = copyForReplication(value) as { details: { at: unknown; label: string } };
		expect(JSON.stringify(copy)).toBe('{"details":{"at":"2026-09-13T12:00:00.000Z","label":"x"}}');
		expect(replicationByteLength(copy)).not.toBe(null);
	});
});

describe("live oversized-entry substitution is guest-visible (PR #11999 review)", () => {
	it("accompanies a live placeholder with a notice event on the event stream", () => {
		// Guests only apply `message` entries to their live agent context, so
		// the placeholder entry alone would be silently invisible there. The
		// host must emit a notice with the same visible text; notices never
		// enter agent state, so this stays display-only.
		const giantKey = "k".repeat(2 * MAX_REPLICATED_PAYLOAD_BYTES);
		const entry = {
			type: "message",
			id: "huge-live-1",
			parentId: null,
			timestamp: "2026-09-13T00:00:00Z",
			message: { role: "user", content: "", timestamp: 0, blob: { [giantKey]: 1 } },
		} as unknown as ReplicatedEntry;

		const shrunk = shrinkReplicatedEntry(entry);
		expect(shrunk.type).toBe("custom_message");
		if (shrunk.type !== "custom_message") throw new Error("expected the typed placeholder");
		expect(shrunk.customType).toBe(COLLAB_ENTRY_OMITTED_CUSTOM_TYPE);
		expectBounded(shrunk);

		const notice = oversizedEntryNotice("message");
		expect(notice.type).toBe("notice");
		expect(notice.level).toBe("warning");
		expect(notice.source).toBe("collab");
		expect(notice.message).toContain("too large to replicate");
		expect(notice.message).toContain("(message)");
	});
});
