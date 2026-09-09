/**
 * Contract: the send budget has to cover what the queue keeps alive, not only
 * what it has already serialized.
 *
 * A welcome snapshot ships as a single lazy queue entry whose iterator holds a
 * whole cloned session until the transport drains it. Charged as zero bytes,
 * repeated `hello` frames from one view-only guest stack clone on clone with
 * nothing but the queue's entry count to stop them — hundreds of megabytes
 * later, for a session of a few megabytes.
 *
 * Drives the production `CollabHost` over the in-memory relay.
 */
import { afterEach, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import {
	HIGH_WATER_MARK,
	type HostObservations,
	instrumentRelay,
	makeHostContext,
	makeSnapshot,
	waitFor,
} from "./helpers/throttled-host";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	uninstallInMemoryRelay();
});

/** Above the 16 MB budget's reach for a 1.5 MB snapshot, below the 256-entry cap's. */
const HELLO_LIMIT = 40;

it("bounds retained welcome snapshots by the send budget rather than the queue's entry count", async () => {
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

	const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => guest.close());
	const opened = Promise.withResolvers<void>();
	guest.onOpen = opened.resolve;
	guest.connect();
	await opened.promise;

	const welcomed = () => seen.notices.filter(notice => notice.includes("joined the collab session")).length;
	const ended = () => seen.notices.some(notice => notice.includes("Collab ended"));

	let sent = 0;
	while (sent < HELLO_LIMIT && !ended()) {
		const before = welcomed();
		guest.send({ t: "hello", proto: COLLAB_PROTO, name: `flood-${sent}` });
		sent++;
		// Lockstep, so the assertion below reads an accounted-for total rather than
		// however many hellos happened to pipeline ahead of the host.
		await waitFor(() => welcomed() > before || ended(), `host never handled hello ${sent}`);
	}

	// Precondition: nothing drained, so every welcome snapshot admitted is still
	// being held by its queue entry.
	expect(probe.hostSocket().bufferedAmount).toBeGreaterThanOrEqual(HIGH_WATER_MARK);
	expect(ended()).toBe(true);
	expect(welcomed()).toBeGreaterThan(1);
	expect(welcomed()).toBeLessThan(20);
}, 20_000);
