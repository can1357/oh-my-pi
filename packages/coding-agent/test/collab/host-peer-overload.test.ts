/**
 * Contract: the host's send queue is shared, so one guest must not be able to
 * fill it and take the room down with it. A read-only viewer can queue host
 * work at will — every `hello` costs a welcome plus a snapshot batch — and
 * when the host uplink is backpressured that work accumulates. Crossing the
 * limit must cost the offending peer its own backlog, not end sharing for
 * everyone.
 */
import { afterEach, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { FakeWebSocket, installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import {
	HIGH_WATER_MARK,
	type HostObservations,
	instrumentRelay,
	makeHostContext,
	makeSnapshot,
	waitFor,
} from "./helpers/throttled-host";

/**
 * Kept under the 256-frame send buffer because the abuser's own socket queues
 * these synchronously: a larger burst would overflow the *guest's* queue and end
 * its own connection instead of exercising the host. The >256 regime, where
 * guest-caused broadcasts rather than targeted work own the host queue, needs
 * pacing and is covered by the view-only flood test below.
 */
const HELLO_FLOOD = 200;
/** Comfortably past MAX_PENDING_SENDS so guest-caused broadcasts alone can fill the queue. */
const BROADCAST_FLOOD = 400;
/** MAX_PEER_PENDING_SENDS in relay-client.ts. */
const PEER_SHARE = 32;

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	uninstallInMemoryRelay();
});

/**
 * Drain the throttled host transport until {@link done} holds, then keep draining
 * one interval longer so a frame that should never arrive still gets the chance
 * to. Quiescence is not completion: one slow interval mid-drain looks exactly
 * like a finished one, and the counts asserted afterwards depend on the
 * difference.
 */
async function drainUntil(hostWs: FakeWebSocket, done: () => boolean, message: string): Promise<void> {
	const drain = setInterval(() => {
		hostWs.bufferedAmount = 0;
	}, 10);
	try {
		await waitFor(done, message, 8_000);
		await Bun.sleep(60);
	} finally {
		clearInterval(drain);
	}
}

it("does not end the room when a guest's renaming drives the state broadcast", async () => {
	const relay = installInMemoryRelay();
	const probe = instrumentRelay(relay, { throttle: true });
	const snapshot = makeSnapshot();
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const context = makeHostContext(snapshot, seen);
	const host = new CollabHost(context);
	cleanups.push(() => void host.stop("test done"));

	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.viewLink);
	if ("error" in parsed) throw new Error(parsed.error);
	expect(parsed.writeToken).toBeUndefined();
	const key = await importRoomKey(parsed.key);
	const hostWs = probe.hostSocket();
	hostWs.bufferedAmount = HIGH_WATER_MARK;

	const viewer = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => viewer.close());
	const joins = () => seen.notices.filter(notice => notice.includes("joined the collab session")).length;
	const ended = () => seen.notices.some(notice => notice.includes("Collab ended"));
	viewer.onOpen = () => viewer.send({ t: "hello", proto: COLLAB_PROTO, name: "viewer-0" });
	viewer.connect();
	await waitFor(() => joins() >= 1, "host never handled the first hello");

	// Fill the queue with replica-bearing broadcasts the host itself generated:
	// entry frames cannot be shed or dropped, which is the state a broadcast is
	// allowed to end the room over.
	const appended = context.sessionManager.onEntryAppended;
	if (!appended) throw new Error("host never tapped entry appends");
	for (let i = 0; i < 250; i++) {
		appended({
			type: "message",
			id: `filler-${i}`,
			parentId: null,
			timestamp: "2026-09-09T00:00:00Z",
			message: { role: "user", content: "f", timestamp: 0 },
		} as never);
	}

	// Now the guest renames itself, which changes the roster and so defeats the
	// state broadcast's JSON dedupe. That frame is guest-caused and addressed to
	// nobody, so it must not be what ends sharing for everyone.
	for (let round = 1; round <= 12 && !ended(); round++) {
		viewer.send({ t: "hello", proto: COLLAB_PROTO, name: `viewer-${round}` });
		await waitFor(() => joins() >= round + 1 || ended(), "host stopped handling hellos");
		await Bun.sleep(120);
	}

	expect(seen.notices.filter(notice => notice.includes("Collab ended"))).toEqual([]);
	expect(hostWs.readyState).toBe(FakeWebSocket.OPEN);
	expect(joins()).toBeGreaterThan(1);
}, 60_000);

it("survives a view-only guest flooding hellos past the broadcast limit", async () => {
	const relay = installInMemoryRelay();
	const probe = instrumentRelay(relay, { throttle: true });
	const snapshot = makeSnapshot();
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const host = new CollabHost(makeHostContext(snapshot, seen));
	cleanups.push(() => void host.stop("test done"));

	await host.start("ws://localhost:8788");
	// A view-only link grants nothing but the right to say hello, and each hello
	// makes the host emit a join notice that the session subscription mirrors as a
	// broadcast. Those are caused by the guest but addressed to nobody, so peer
	// accounting cannot shed them.
	const parsed = parseCollabLink(host.viewLink);
	if ("error" in parsed) throw new Error(parsed.error);
	expect(parsed.writeToken).toBeUndefined();
	const key = await importRoomKey(parsed.key);
	const hostWs = probe.hostSocket();
	hostWs.bufferedAmount = HIGH_WATER_MARK;

	const viewer = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => viewer.close());
	const joins = () => seen.notices.filter(notice => notice.includes("joined the collab session")).length;
	const ended = () => seen.notices.some(notice => notice.includes("Collab ended"));
	viewer.onOpen = () => viewer.send({ t: "hello", proto: COLLAB_PROTO, name: "viewer" });
	viewer.connect();
	// Paced one at a time: a synchronous burst this size would overflow the
	// viewer's own send queue rather than the host's.
	for (let sent = 1; sent < BROADCAST_FLOOD && !ended(); sent++) {
		await waitFor(() => joins() >= sent || ended(), "host stopped handling hellos");
		if (ended()) break;
		viewer.send({ t: "hello", proto: COLLAB_PROTO, name: "viewer" });
	}

	expect(seen.notices.filter(notice => notice.includes("Collab ended"))).toEqual([]);
	expect(joins()).toBeGreaterThanOrEqual(BROADCAST_FLOOD - 1);
	expect(hostWs.readyState).toBe(FakeWebSocket.OPEN);

	// Live host traffic still gets through once the advisory pile-up is shed.
	const live = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => live.close());
	const liveDone = Promise.withResolvers<void>();
	live.onFrame = frame => {
		if (frame.t === "snapshot-chunk" && frame.final) liveDone.resolve();
	};
	live.onOpen = () => live.send({ t: "hello", proto: COLLAB_PROTO, name: "latecomer" });
	live.connect();
	const drain = setInterval(() => {
		hostWs.bufferedAmount = 0;
	}, 10);
	try {
		await Promise.race([
			liveDone.promise,
			Bun.sleep(8_000).then(() => {
				throw new Error("a fresh guest never completed its snapshot after the flood");
			}),
		]);
	} finally {
		clearInterval(drain);
	}
	expect(seen.notices.filter(notice => notice.includes("Collab ended"))).toEqual([]);
}, 60_000);

it("does not broadcast state because of a shed", async () => {
	const relay = installInMemoryRelay();
	const probe = instrumentRelay(relay, { throttle: true });
	const snapshot = makeSnapshot();
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const host = new CollabHost(makeHostContext(snapshot, seen));
	cleanups.push(() => void host.stop("test done"));

	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	const hostWs = probe.hostSocket();
	let draining = true;
	const drain = setInterval(() => {
		if (draining) hostWs.bufferedAmount = 0;
	}, 10);
	cleanups.push(() => clearInterval(drain));

	// A bystander that stays well inside its share, so every state frame it counts
	// is attributable to something other than its own behaviour.
	const bystander = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => bystander.close());
	let states = 0;
	bystander.onFrame = frame => {
		if (frame.t === "state") states++;
	};
	const joins = () => seen.notices.filter(notice => notice.includes("joined the collab session")).length;
	const shed = () => seen.notices.some(notice => notice.includes("fell too far behind"));
	bystander.onOpen = () => bystander.send({ t: "hello", proto: COLLAB_PROTO, name: "bystander" });
	bystander.connect();
	await waitFor(() => joins() >= 1, "host never handled the bystander");

	// The greedy peer joins and its roster update is delivered, so the shed below
	// is a roster change the JSON dedupe cannot absorb.
	const greedy = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => greedy.close());
	greedy.onOpen = () => greedy.send({ t: "hello", proto: COLLAB_PROTO, name: "greedy" });
	greedy.connect();
	await waitFor(() => joins() >= 2, "host never handled the greedy peer");
	await waitFor(() => states >= 1, "bystander never received the roster with both guests");
	await Bun.sleep(250);
	const statesBeforeShed = states;

	// Stall the uplink so the greedy peer's replies pile up to its own share.
	draining = false;
	hostWs.bufferedAmount = HIGH_WATER_MARK;
	for (let i = 0; i < PEER_SHARE + 8; i++) {
		greedy.send({ t: "fetch-transcript", reqId: i, agentId: "no-such-agent", fromByte: 0 });
	}
	await waitFor(shed, "host never shed the greedy peer");
	draining = true;

	// Several debounce intervals with the transport draining: a report must not put
	// a changed roster on the queue. That frame defeats the dedupe, and admitting
	// it into a queue still full sheds the next peer, whose report schedules
	// another — one participant per interval.
	await Bun.sleep(6 * 100);
	expect(states).toBe(statesBeforeShed);
	expect(seen.notices.filter(notice => notice.includes("Collab ended"))).toEqual([]);
}, 30_000);

it("never leaves a superseded welcome without the snapshot built with it", async () => {
	const relay = installInMemoryRelay();
	const probe = instrumentRelay(relay, { throttle: true });
	const snapshot = makeSnapshot();
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const host = new CollabHost(makeHostContext(snapshot, seen));
	cleanups.push(() => void host.stop("test done"));

	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	const hostWs = probe.hostSocket();
	hostWs.bufferedAmount = HIGH_WATER_MARK;

	const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => guest.close());
	const frames: CollabFrame[] = [];
	guest.onFrame = frame => frames.push(frame);
	const joins = () => seen.notices.filter(notice => notice.includes("joined the collab session")).length;
	guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "repeater" });
	guest.connect();
	await waitFor(() => joins() >= 1, "host never handled the first hello");

	// The session grows between hellos, so the two generations disagree on
	// entryCount — the field that makes a mispairing corrupting rather than merely
	// redundant, since the guest finalizes on entries.length >= entryCount.
	snapshot.entries.push({
		type: "message",
		id: "late-entry",
		parentId: null,
		timestamp: "2026-09-09T00:00:00Z",
		message: { role: "user", content: "y".repeat(16 * 1024), timestamp: 0 },
	});
	guest.send({ t: "hello", proto: COLLAB_PROTO, name: "repeater" });
	await waitFor(() => joins() >= 2, "host never handled the second hello");

	await drainUntil(
		hostWs,
		() =>
			frames.some(frame => frame.t === "welcome") &&
			frames.some(frame => frame.t === "snapshot-chunk" && frame.final),
		"the surviving welcome and its snapshot never both arrived",
	);

	// The superseded generation's welcome must go with its batch. A surviving
	// welcome whose batch was discarded is the frame that later, under a saturated
	// queue, becomes the metadata a newer snapshot's chunks are filed under.
	const welcomes = frames.filter(frame => frame.t === "welcome");
	expect(welcomes.length).toBe(1);
	const header = welcomes[0];
	if (header?.t !== "welcome") throw new Error("expected a welcome frame");
	const delivered = frames
		.filter(frame => frame.t === "snapshot-chunk")
		.flatMap(frame => frame.entries.map(entry => entry.id));
	expect(delivered.length).toBe(header.entryCount);
	expect(delivered).toContain("late-entry");
}, 30_000);

it("keeps only the newest snapshot batch when a guest repeats hello", async () => {
	const relay = installInMemoryRelay();
	const probe = instrumentRelay(relay, { throttle: true });
	const snapshot = makeSnapshot();
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const host = new CollabHost(makeHostContext(snapshot, seen));
	cleanups.push(() => void host.stop("test done"));

	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	const hostWs = probe.hostSocket();
	hostWs.bufferedAmount = HIGH_WATER_MARK;

	const repeater = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => repeater.close());
	const repeaterFrames: CollabFrame[] = [];
	repeater.onFrame = frame => repeaterFrames.push(frame);
	const HELLOS = 8;
	repeater.onOpen = () => {
		for (let i = 0; i < HELLOS; i++) repeater.send({ t: "hello", proto: COLLAB_PROTO, name: "repeater" });
	};
	repeater.connect();
	await waitFor(
		() => seen.notices.filter(notice => notice.includes("joined the collab session")).length >= HELLOS,
		"host never worked through the repeated hellos",
	);
	// Well under the per-peer entry cap, so nothing was shed: what bounds the
	// queue here is the batch cap alone.
	expect(seen.notices.filter(notice => notice.includes("fell too far behind"))).toEqual([]);

	// Past the terminator and one interval further, so the count below reflects
	// everything that was queued rather than everything that had arrived by then.
	await drainUntil(
		hostWs,
		() => repeaterFrames.some(frame => frame.t === "snapshot-chunk" && frame.final),
		"the surviving snapshot never terminated",
	);

	const chunks = repeaterFrames.filter(frame => frame.t === "snapshot-chunk");
	// Eight hellos, one transcript on the wire: the older batches were superseded
	// before they could occupy the head of the shared queue.
	expect(chunks.filter(chunk => chunk.final).length).toBe(1);
	expect(chunks.flatMap(chunk => chunk.entries.map(entry => entry.id))).toEqual(
		snapshot.entries.map(entry => entry.id),
	);
}, 20_000);

it("does not queue a snapshot for a peer shed earlier in the same hello", async () => {
	const relay = installInMemoryRelay();
	const probe = instrumentRelay(relay, { throttle: true });
	const snapshot = makeSnapshot();
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const host = new CollabHost(makeHostContext(snapshot, seen));
	cleanups.push(() => void host.stop("test done"));

	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	const hostWs = probe.hostSocket();

	// Stall the uplink outright so nothing drains and the peer's queued entries
	// only accumulate.
	hostWs.bufferedAmount = HIGH_WATER_MARK;

	const greedy = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => greedy.close());
	const greedyFrames: CollabFrame[] = [];
	greedy.onFrame = frame => greedyFrames.push(frame);
	// One hello to register a name, then fill the peer's share with unresolvable
	// transcript fetches: each queues exactly one targeted reply, and unlike a
	// repeated hello they do not supersede one another. A repeated hello cannot
	// build a backlog any more — its welcome and snapshot are one entry that
	// replaces itself — which is the point of the pairing fix.
	const joins = () => seen.notices.filter(notice => notice.includes("joined the collab session")).length;
	const shed = () => seen.notices.some(notice => notice.includes("fell too far behind"));
	greedy.onOpen = () => greedy.send({ t: "hello", proto: COLLAB_PROTO, name: "greedy" });
	greedy.connect();
	await waitFor(() => joins() >= 1, "host never handled the first hello");
	for (let i = 0; i < PEER_SHARE; i++) {
		greedy.send({ t: "fetch-transcript", reqId: i, agentId: "no-such-agent", fromByte: 0 });
	}
	// The hello that finds the peer at its share: its welcome and snapshot are
	// refused as one, so neither reaches the guest.
	await waitFor(() => shed() || joins() >= 2, "host never worked through the transcript fetches");
	if (!shed()) greedy.send({ t: "hello", proto: COLLAB_PROTO, name: "greedy" });
	await waitFor(shed, "host never shed the greedy peer");
	// The precondition the assertions below depend on, stated rather than assumed:
	// no hello outlived the shed, so nothing legitimately re-served the peer.
	const shedAt = seen.notices.findIndex(notice => notice.includes("fell too far behind"));
	expect(seen.notices.slice(shedAt + 1).filter(notice => notice.includes("joined"))).toEqual([]);

	const drain = setInterval(() => {
		hostWs.bufferedAmount = 0;
	}, 10);
	try {
		await waitFor(
			() => greedyFrames.some(frame => frame.t === "error" && frame.message.includes("rejoin to resync")),
			"shed guest was never told to rejoin",
		);
		await Bun.sleep(100);
	} finally {
		clearInterval(drain);
	}

	// The welcome was shed, so every chunk on the wire is an orphan the guest
	// cannot apply, sitting ahead of the resync error and of every other peer.
	const replication = greedyFrames.filter(frame => frame.t === "welcome" || frame.t === "snapshot-chunk");
	expect(replication.map(frame => frame.t)).toEqual([]);
}, 20_000);

it("sheds a flooding guest's backlog instead of ending the room for everyone", async () => {
	const relay = installInMemoryRelay();
	const probe = instrumentRelay(relay, { throttle: true });
	const snapshot = makeSnapshot();
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const host = new CollabHost(makeHostContext(snapshot, seen));
	cleanups.push(() => void host.stop("test done"));

	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	const hostWs = probe.hostSocket();

	// A well-behaved guest, mid-snapshot when the flood starts.
	const bystander = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => bystander.close());
	const bystanderFrames: CollabFrame[] = [];
	const bystanderChunked = Promise.withResolvers<void>();
	const bystanderDone = Promise.withResolvers<void>();
	bystander.onFrame = frame => {
		bystanderFrames.push(frame);
		if (frame.t === "snapshot-chunk") bystanderChunked.resolve();
		if (frame.t === "snapshot-chunk" && frame.final) bystanderDone.resolve();
	};
	bystander.onOpen = () => bystander.send({ t: "hello", proto: COLLAB_PROTO, name: "bystander" });
	bystander.connect();
	await bystanderChunked.promise;
	expect(bystanderFrames.filter(frame => frame.t === "snapshot-chunk").some(frame => frame.final)).toBe(false);

	// The abuser holds a view-only link: it cannot prompt, but it can say hello.
	const abuser = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => abuser.close());
	const abuserFrames: CollabFrame[] = [];
	abuser.onFrame = frame => abuserFrames.push(frame);
	// Hello first for a name, then a flood of unresolvable transcript fetches:
	// one targeted reply each, so the peer's share fills and keeps refilling.
	abuser.onOpen = () => {
		abuser.send({ t: "hello", proto: COLLAB_PROTO, name: "abuser" });
		for (let i = 0; i < HELLO_FLOOD; i++) {
			abuser.send({ t: "fetch-transcript", reqId: i, agentId: "no-such-agent", fromByte: 0 });
		}
	};
	abuser.connect();
	await waitFor(
		() =>
			seen.notices.some(notice => notice.includes("fell too far behind")) ||
			seen.notices.some(notice => notice.includes("Collab ended")),
		"host never worked through the abusive flood",
	);

	// The flood may cost the abuser its backlog; it must not cost anyone the room.
	expect(seen.notices.filter(notice => notice.includes("Collab ended"))).toEqual([]);
	expect(hostWs.readyState).toBe(FakeWebSocket.OPEN);

	let bystanderComplete = false;
	void bystanderDone.promise.then(() => {
		bystanderComplete = true;
	});
	const drain = setInterval(() => {
		hostWs.bufferedAmount = 0;
	}, 10);
	try {
		await waitFor(
			() =>
				bystanderComplete &&
				abuserFrames.some(frame => frame.t === "error" && frame.message.includes("rejoin to resync")),
			"bystander never completed its snapshot, or the shed guest was never told to rejoin",
		);
	} finally {
		clearInterval(drain);
	}

	const chunks = bystanderFrames.filter(frame => frame.t === "snapshot-chunk");
	expect(chunks.flatMap(chunk => chunk.entries.map(entry => entry.id))).toEqual(
		snapshot.entries.map(entry => entry.id),
	);
	// The shed peer is told to resync rather than left guessing.
	expect(seen.notices.some(notice => notice.includes("fell too far behind"))).toBe(true);
	expect(hostWs.readyState).toBe(FakeWebSocket.OPEN);
}, 20_000);
