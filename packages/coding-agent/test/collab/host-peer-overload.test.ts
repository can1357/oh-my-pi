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

it("tells a served peer it never welcomed to resync instead of rejecting it as read-only", async () => {
	const relay = installInMemoryRelay();
	instrumentRelay(relay, { throttle: false });
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const host = new CollabHost(makeHostContext(makeSnapshot(), seen));
	cleanups.push(() => void host.stop("test done"));

	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;

	// On the relay, never registered: the state a shed leaves a guest in.
	const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => guest.close());
	const received: CollabFrame[] = [];
	guest.onFrame = frame => received.push(frame);
	const opened = Promise.withResolvers<void>();
	guest.onOpen = () => opened.resolve();
	guest.connect();
	await opened.promise;

	guest.send({ t: "prompt", text: "hi" });
	await waitFor(() => received.some(frame => frame.t === "error"), "host never answered the unregistered peer");
	const [reply] = received.filter(frame => frame.t === "error");
	expect(reply).toEqual({ t: "error", message: expect.stringContaining("rejoin"), resync: true });

	guest.send({ t: "hello", proto: COLLAB_PROTO, name: "returning", writeToken });
	await waitFor(() => received.some(frame => frame.t === "welcome"), "the resync hello was never welcomed");
}, 20_000);
