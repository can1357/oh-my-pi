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

	// And it was never handed the pending ask. The one guest that could answer then
	// leaves, which returns the ask to the retained state for whichever writer
	// joins next rather than settling it.
	expect(refused.frames.filter(frame => frame.t === "ui-request")).toEqual([]);
	resident.close();
	await waitFor(
		() => seen.notices.some(notice => notice.includes("resident left")),
		"the host never observed the resident leaving",
		8_000,
	);
	await Bun.sleep(100);
	expect(settled).toBeUndefined();
	await host.stop("test done");
	await waitFor(() => settled !== undefined, "stopping the host never settled the retained ask");
	expect(settled).toEqual({ kind: "unavailable" });
	refused.close();
}, 120_000);
