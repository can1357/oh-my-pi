/**
 * Contract: a session larger than the send budget is still shareable, and what
 * a welcome snapshot is charged for is what the queue will hold.
 *
 * The budget admits an entry with nothing ahead of it whatever it costs, which
 * is the only reason an oversized snapshot ships at all. That exception is
 * worthless if the host puts something ahead of it itself, so the welcome and
 * the chunks built with it are one queue entry; and the traffic the same hello
 * generates has to be droppable, or the join notice ends sharing over the
 * snapshot it just admitted.
 *
 * It is equally worthless if the next frame reverses it. Counting that entry's
 * charge leaves the queue over capacity for its whole drain, and over capacity is
 * what every eviction path keys on — so a guest joining a session mid-turn lost
 * its half-delivered snapshot to the turn's next `entry` broadcast, and the
 * rejoin that shed asked for was admitted and shed the same way. The charge is
 * therefore excluded once admitted, and live traffic queues behind the snapshot.
 *
 * The charge is levied at admission and covers the clone the batch's iterator
 * keeps reachable, so it has to be the size of the snapshot actually retained.
 * An image-heavy session is stripped before it is queued and can shrink by an
 * order of magnitude; charged what it measured on arrival instead, a session
 * the budget has ample room for reads as over budget, and the joins that follow
 * pay for memory nobody is holding.
 *
 * Drives the production `CollabHost` over the in-memory relay.
 */
import { afterEach, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { type FakeWebSocket, installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import {
	HIGH_WATER_MARK,
	type HostObservations,
	instrumentRelay,
	makeHostContext,
	type Snapshot,
	waitFor,
} from "./helpers/throttled-host";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	uninstallInMemoryRelay();
});

/**
 * 34 x 512 KiB is ~17 MiB: past `MAX_PENDING_SEND_BYTES`, so nothing but the
 * empty-queue exception can admit it.
 */
function makeOversizedSnapshot(): Snapshot {
	const entries: SessionEntry[] = [];
	for (let i = 0; i < 34; i++) {
		entries.push({
			type: "message",
			id: `big-${i}`,
			parentId: null,
			timestamp: "2026-09-09T00:00:00Z",
			message: { role: "user", content: "x".repeat(512 * 1024), timestamp: 0 },
		});
	}
	return {
		header: { type: "session", id: "sess-large", timestamp: "2026-09-09T00:00:00Z", cwd: "/tmp" },
		entries,
	};
}

/**
 * 26 MiB of base64 image data over 1 MiB of text: past
 * `WELCOME_IMAGE_STRIP_THRESHOLD`, and what survives stripping is small enough
 * that both joiners fit the send budget together. Every entry stays under
 * `MAX_REPLICATED_PAYLOAD_BYTES` so `shrinkForReplication` ships it whole and
 * the delivered ids can be compared against the session.
 */
function makeImageHeavySnapshot(): Snapshot {
	const entries: SessionEntry[] = [];
	for (let i = 0; i < 26; i++) {
		entries.push({
			type: "message",
			id: `img-${i}`,
			parentId: null,
			timestamp: "2026-09-09T00:00:00Z",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "t".repeat(40 * 1024) },
					{ type: "image", data: "A".repeat(1024 * 1024), mimeType: "image/png" },
				],
				timestamp: 0,
			},
		} as SessionEntry);
	}
	return {
		header: { type: "session", id: "sess-images", timestamp: "2026-09-09T00:00:00Z", cwd: "/tmp" },
		entries,
	};
}

async function startHost(snapshot: Snapshot, seen: HostObservations, throttle = false) {
	const relay = installInMemoryRelay();
	const probe = instrumentRelay(relay, { throttle });
	const context = makeHostContext(snapshot, seen);
	const host = new CollabHost(context);
	cleanups.push(() => void host.stop("test done"));
	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	return { host, context, probe, parsed, key: await importRoomKey(parsed.key) };
}

function joinGuest(
	wsUrl: string,
	key: CryptoKey,
	name: string,
	writeToken?: string,
): { frames: CollabFrame[]; close: () => void } {
	const guest = new CollabSocket({ wsUrl, role: "guest", key });
	cleanups.push(() => guest.close());
	const frames: CollabFrame[] = [];
	guest.onFrame = frame => frames.push(frame);
	guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
	guest.connect();
	return { frames, close: () => guest.close() };
}

/** Zero the throttled host transport's buffer for {@link ms}, so its queue drains. */
async function drainFor(hostWs: FakeWebSocket, ms: number): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		hostWs.bufferedAmount = 0;
		await Bun.sleep(5);
	}
}

async function drainUntil(hostWs: FakeWebSocket, done: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (!done()) {
		if (Date.now() > deadline) throw new Error(message);
		hostWs.bufferedAmount = 0;
		await Bun.sleep(5);
	}
}

async function waitForSnapshot(frames: CollabFrame[], message: string, ended: () => boolean): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (!frames.some(frame => frame.t === "snapshot-chunk" && frame.final)) {
		if (ended()) throw new Error(`${message}: sharing ended first`);
		if (Date.now() > deadline) throw new Error(message);
		await Bun.sleep(5);
	}
}

it("welcomes the first guest of a session larger than the whole send budget", async () => {
	const snapshot = makeOversizedSnapshot();
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const { parsed, key } = await startHost(snapshot, seen);
	const ended = () => seen.notices.some(notice => notice.includes("Collab ended"));

	const { frames } = joinGuest(parsed.wsUrl, key, "first-guest");
	await waitForSnapshot(frames, "the first guest never received a complete snapshot", ended);

	// One guest, an empty queue, and the whole replica delivered: a session this
	// size is not an overload the host has to end sharing over.
	expect(seen.notices.filter(notice => notice.includes("Collab ended"))).toEqual([]);
	const welcomes = frames.filter(frame => frame.t === "welcome");
	expect(welcomes.length).toBe(1);
	const header = welcomes[0];
	if (header?.t !== "welcome") throw new Error("expected a welcome frame");
	const delivered = frames
		.filter(frame => frame.t === "snapshot-chunk")
		.flatMap(frame => frame.entries.map(entry => entry.id));
	expect(delivered).toEqual(snapshot.entries.map(entry => entry.id));
	expect(delivered.length).toBe(header.entryCount);
}, 60_000);

it("charges a stripped welcome snapshot for what it retained, not what arrived", async () => {
	const snapshot = makeImageHeavySnapshot();
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const { parsed, key } = await startHost(snapshot, seen);
	const ended = () => seen.notices.some(notice => notice.includes("Collab ended"));

	// Both joins are enqueued before either drains, so the second one is admitted
	// against whatever the first is still charged for.
	const { frames: first } = joinGuest(parsed.wsUrl, key, "first-viewer");
	const { frames: second } = joinGuest(parsed.wsUrl, key, "second-viewer");
	await waitForSnapshot(first, "the first guest never received a complete snapshot", ended);
	await waitForSnapshot(second, "the second guest never received a complete snapshot", ended);

	expect(seen.notices.filter(notice => notice.includes("Collab ended"))).toEqual([]);
	// Stripping is what makes the retained snapshot small; the entries themselves
	// still ship, so each guest holds every entry with the images removed.
	for (const frames of [first, second]) {
		const chunked = frames.filter(frame => frame.t === "snapshot-chunk").flatMap(frame => frame.entries);
		expect(chunked.map(entry => entry.id)).toEqual(snapshot.entries.map(entry => entry.id));
		expect(chunked.filter(entry => JSON.stringify(entry).includes('"type":"image"'))).toEqual([]);
	}
}, 60_000);

it("keeps an oversized snapshot when the turn it is joining keeps broadcasting", async () => {
	const snapshot = makeOversizedSnapshot();
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const { context, probe, parsed, key } = await startHost(snapshot, seen, true);
	const hostWs = probe.hostSocket();
	const appended = context.sessionManager.onEntryAppended;
	if (!appended) throw new Error("the host never tapped entry appends");
	const shedReports = () => seen.notices.filter(notice => notice.includes("fell too far behind"));

	// Three joins in a row, because one shed is a fairness cost and a repeating one
	// is a session nobody can join: the shed asks the guest to rejoin, and the
	// rejoin is admitted by the same floor and met by the same live traffic.
	for (let round = 1; round <= 3; round++) {
		// The floor only admits an oversized batch with nothing ahead of it, so let
		// the previous round's traffic and its state debounce clear first.
		await drainFor(hostWs, 300);
		hostWs.bufferedAmount = 0;

		const joiner = joinGuest(parsed.wsUrl, key, `joiner-${round}`);
		await waitFor(
			() => joiner.frames.some(frame => frame.t === "welcome"),
			`round ${round}: the joiner never received a welcome`,
		);
		// The throttle parks the drain one chunk in, so the snapshot is still queued
		// and still charged when the turn appends its next entry. That broadcast is
		// replica-bearing, so it cannot be dropped — before this was fixed it shed
		// the peer whose half-delivered snapshot was the only thing in the queue.
		appended({
			type: "message",
			id: `live-${round}`,
			parentId: null,
			timestamp: "2026-09-09T00:00:00Z",
			message: { role: "user", content: `turn output ${round}`, timestamp: 0 },
		} as never);

		const complete = () => joiner.frames.some(frame => frame.t === "snapshot-chunk" && frame.final);
		const live = () => joiner.frames.some(frame => frame.t === "entry" && frame.entry.id === `live-${round}`);
		await drainUntil(hostWs, () => complete() && live(), `round ${round}: the joiner was cut off mid-snapshot`);

		expect(shedReports()).toEqual([]);
		expect(seen.notices.filter(notice => notice.includes("Collab ended"))).toEqual([]);
		const delivered = joiner.frames
			.filter(frame => frame.t === "snapshot-chunk")
			.flatMap(frame => frame.entries.map(entry => entry.id));
		expect(delivered).toEqual(snapshot.entries.map(entry => entry.id));
		// Behind, not instead of: the live entry queues after the batch it could not
		// evict, so the guest applies it to a replica that is already complete.
		const finalAt = joiner.frames.findIndex(frame => frame.t === "snapshot-chunk" && frame.final);
		const liveAt = joiner.frames.findIndex(frame => frame.t === "entry" && frame.entry.id === `live-${round}`);
		expect(liveAt).toBeGreaterThan(finalAt);
		joiner.close();
	}
}, 120_000);

it("registers nothing for a join whose welcome the queue refused", async () => {
	const snapshot = makeOversizedSnapshot();
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const { host, context, probe, parsed, key } = await startHost(snapshot, seen, true);
	const hostWs = probe.hostSocket();
	const appended = context.sessionManager.onEntryAppended;
	if (!appended) throw new Error("the host never tapped entry appends");
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	if (!writeToken) throw new Error("expected a write link");

	// A guest that does join, so there is a writable peer to hold an ask.
	const resident = joinGuest(parsed.wsUrl, key, "resident", writeToken);
	await drainUntil(
		hostWs,
		() => resident.frames.some(frame => frame.t === "snapshot-chunk" && frame.final),
		"the resident never received a complete snapshot",
	);
	await drainFor(hostWs, 200);

	const ask = host.requestGuestUi({ kind: "select", title: "pick one", options: [{ label: "yes" }] });
	if (!ask) throw new Error("the host had no writable peer to ask");
	let settled: unknown;
	void ask.then(result => {
		settled = result;
	});

	// One replica-bearing broadcast, admitted while the transport is already past
	// its high-water mark so it stays queued rather than being handed straight to
	// the socket. It cannot be shed and it cannot be dropped, so it keeps the
	// empty-queue floor out of reach and the next oversized welcome has nowhere to
	// go.
	hostWs.bufferedAmount = HIGH_WATER_MARK;
	appended({
		type: "message",
		id: "live",
		parentId: null,
		timestamp: "2026-09-09T00:00:00Z",
		message: { role: "user", content: "q".repeat(200 * 1024), timestamp: 0 },
	} as never);
	await Bun.sleep(50);

	const refused = joinGuest(parsed.wsUrl, key, "refused", writeToken);
	await Bun.sleep(200);

	// No welcome, so no join: the guest applies nothing before one arrives.
	expect(refused.frames.filter(frame => frame.t === "welcome")).toEqual([]);
	expect(seen.notices.filter(notice => notice.includes("refused joined"))).toEqual([]);
	expect(seen.participantCounts.filter(count => count > 2)).toEqual([]);

	// And it was never handed the pending ask. Once the one guest that could answer
	// leaves, the ask has no recipients left and settles, instead of waiting on a
	// participant that never joined.
	resident.close();
	await waitFor(() => settled !== undefined, "the ask never settled after its only recipient left", 8_000);
	expect(settled).toEqual({ kind: "unavailable" });
	refused.close();
}, 120_000);
