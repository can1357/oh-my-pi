/**
 * Contract: what a welcome snapshot is charged for is what the queue will hold.
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
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import { type HostObservations, instrumentRelay, makeHostContext, type Snapshot } from "./helpers/throttled-host";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	uninstallInMemoryRelay();
});

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

async function startHost(snapshot: Snapshot, seen: HostObservations) {
	const relay = installInMemoryRelay();
	const probe = instrumentRelay(relay, { throttle: false });
	const host = new CollabHost(makeHostContext(snapshot, seen));
	cleanups.push(() => void host.stop("test done"));
	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	return { host, probe, parsed, key: await importRoomKey(parsed.key) };
}

function joinGuest(wsUrl: string, key: CryptoKey, name: string): CollabFrame[] {
	const guest = new CollabSocket({ wsUrl, role: "guest", key });
	cleanups.push(() => guest.close());
	const frames: CollabFrame[] = [];
	guest.onFrame = frame => frames.push(frame);
	guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name });
	guest.connect();
	return frames;
}

async function waitForSnapshot(frames: CollabFrame[], message: string, ended: () => boolean): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (!frames.some(frame => frame.t === "snapshot-chunk" && frame.final)) {
		if (ended()) throw new Error(`${message}: sharing ended first`);
		if (Date.now() > deadline) throw new Error(message);
		await Bun.sleep(5);
	}
}

it("charges a stripped welcome snapshot for what it retained, not what arrived", async () => {
	const snapshot = makeImageHeavySnapshot();
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const { parsed, key } = await startHost(snapshot, seen);
	const ended = () => seen.notices.some(notice => notice.includes("Collab ended"));

	// Both joins are enqueued before either drains, so the second one is admitted
	// against whatever the first is still charged for.
	const first = joinGuest(parsed.wsUrl, key, "first-viewer");
	const second = joinGuest(parsed.wsUrl, key, "second-viewer");
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
