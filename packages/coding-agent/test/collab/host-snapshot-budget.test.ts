/**
 * Contract: the send budget has to cover what the queue keeps alive, not only
 * what it has already serialized.
 *
 * A welcome snapshot ships as a single lazy queue entry whose iterator holds a
 * whole cloned session until the transport drains it. Charged as zero bytes,
 * one clone per joiner accumulated with nothing but the queue's entry count to
 * stop it — hundreds of megabytes later, for a session of a few megabytes.
 *
 * Repeated hellos from one guest are already bounded by the per-peer batch cap
 * (`host-peer-overload.test.ts`), so what is left to bound is the room filling
 * up with joiners, each holding a clone it is entitled to.
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

/** Past the 16 MB budget's reach for a 1.5 MB snapshot, inside the 256-entry cap's. */
const JOINERS = 14;

it("sheds an earlier guest's retained snapshot instead of holding every joiner's clone", async () => {
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

	const welcomed = () => seen.notices.filter(notice => notice.includes("joined the collab session")).length;
	const dropped = () => seen.notices.filter(notice => notice.includes("fell too far behind")).length;
	const ended = () => seen.notices.some(notice => notice.includes("Collab ended"));

	for (let i = 0; i < JOINERS && !ended(); i++) {
		const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
		cleanups.push(() => guest.close());
		const before = welcomed();
		guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: `joiner-${i}` });
		guest.connect();
		// Lockstep, so the totals below read admitted work rather than however many
		// joins happened to pipeline ahead of the host.
		await waitFor(() => welcomed() > before || ended(), `host never welcomed joiner ${i}`);
	}

	// Precondition: nothing drained, so every welcome snapshot still admitted is
	// still being held by its queue entry.
	expect(probe.hostSocket().bufferedAmount).toBeGreaterThanOrEqual(HIGH_WATER_MARK);
	// Room capacity is made by discarding the oldest retained snapshot, so every
	// joiner is still welcomed and sharing survives.
	expect(ended()).toBe(false);
	expect(welcomed()).toBe(JOINERS);
	expect(dropped()).toBeGreaterThan(0);
}, 30_000);
