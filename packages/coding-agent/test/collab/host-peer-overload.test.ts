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
	type HostObservations,
	instrumentRelay,
	makeHostContext,
	makeSnapshot,
	waitFor,
} from "./helpers/throttled-host";

/**
 * Kept under the 256-frame send buffer because the abuser's own socket queues
 * these synchronously: a larger burst would overflow the *guest's* queue and end
 * its own connection instead of exercising the host.
 */
const HELLO_FLOOD = 200;
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	uninstallInMemoryRelay();
});

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
