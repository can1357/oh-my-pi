/**
 * Contract: a busy host stays shared.
 *
 * A host with many subagents emits live frames faster than a slow guest can
 * take a large welcome. The welcome streams on that guest's own lane while live
 * traffic skips it — the entries it missed follow its last chunk, with fresh
 * state — so the flood never piles up behind the snapshot. A backlog that does
 * outrun the uplink is dropped and its guests welcomed again; the room never ends.
 *
 * Drives the production `CollabHost` over the in-memory relay with the host's
 * uplink throttled by hand.
 */
import { afterEach, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { TASK_SUBAGENT_PROGRESS_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { FakeWebSocket } from "./helpers/in-memory-relay";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import {
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

/** More subagent frames than the send queue admits (256). */
const FLOOD = 2_000;

function note(id: string): SessionEntry {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: "2026-11-01T00:00:00Z",
		customType: "note",
		content: id,
		display: true,
	} as unknown as SessionEntry;
}

function progress(i: number): unknown {
	return { id: `Sub${i % 37}`, index: i % 37, status: "running", progress: { toolCount: i } };
}

async function busyHost() {
	const relay = installInMemoryRelay();
	const probe = instrumentRelay(relay, { throttle: true });
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const ctx = makeHostContext(makeSnapshot(), seen);
	const bus = new EventBus();
	ctx.eventBus = bus;
	const host = new CollabHost(ctx);
	cleanups.push(() => void host.stop("test done"));
	await host.start("ws://localhost:8788");
	const append = (entry: SessionEntry) => ctx.sessionManager.onEntryAppended?.(entry);
	return { host, seen, bus, append, hostWs: probe.hostSocket() };
}

async function joinGuest(link: string): Promise<CollabFrame[]> {
	return (await connectGuest(link)).received;
}

async function connectGuest(link: string): Promise<{ received: CollabFrame[]; guest: CollabSocket }> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	cleanups.push(() => guest.close());
	const received: CollabFrame[] = [];
	guest.onFrame = frame => {
		received.push(frame);
	};
	guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "slow" });
	guest.connect();
	return { received, guest };
}

/**
 * A slow uplink: one write's worth of drain per tick until `done`. Real ticks,
 * not fake timers: the host seals with real WebCrypto, which settles on the
 * platform's own schedule, and the drain has to interleave with it.
 */
async function drainUntil(hostWs: FakeWebSocket, done: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!done()) {
		if (Date.now() > deadline) throw new Error(message);
		hostWs.bufferedAmount = 0;
		await Bun.sleep(2);
	}
}

const ended = (seen: HostObservations) => seen.notices.filter(notice => notice.includes("Collab ended"));

it("streams a slow guest's welcome through a flood of subagent frames, then catches it up", async () => {
	const { host, seen, bus, append, hostWs } = await busyHost();
	const received = await joinGuest(host.link);
	// The welcome and the first chunk leave; the uplink is then full.
	await waitFor(() => received.some(frame => frame.t === "snapshot-chunk"), "first chunk never arrived");
	expect(received.some(frame => frame.t === "snapshot-chunk" && frame.final)).toBe(false);

	for (let i = 0; i < FLOOD; i++) {
		bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progress(i));
		if (i % 500 === 0) append(note(`during-${i}`));
	}
	expect(ended(seen)).toEqual([]);
	expect(host.stopped).toBe(false);

	await drainUntil(hostWs, () => received.some(frame => frame.t === "agents"), "catch-up never arrived");
	const tags = received.map(frame => frame.t);
	const finalAt = received.findIndex(frame => frame.t === "snapshot-chunk" && frame.final);
	expect(tags[0]).toBe("welcome");
	const snapshotIds = received
		.slice(0, finalAt + 1)
		.flatMap(frame => (frame.t === "snapshot-chunk" ? frame.entries.map(entry => entry.id) : []));
	expect(snapshotIds).toEqual(Array.from({ length: 96 }, (_, i) => `e${i}`));
	// Exactly what it missed, in order, after its snapshot; none of the flood.
	expect(received.slice(finalAt + 1).map(frame => (frame.t === "entry" ? frame.entry.id : frame.t))).toEqual([
		"during-0",
		"during-500",
		"during-1000",
		"during-1500",
		"state",
		"agents",
	]);

	// Caught up: live traffic reaches it again.
	bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progress(FLOOD));
	append(note("after"));
	await drainUntil(
		hostWs,
		() => received.some(frame => frame.t === "entry" && frame.entry.id === "after"),
		"live entry never arrived",
	);
	expect(received.filter(frame => frame.t === "bus")).toHaveLength(1);
	expect(ended(seen)).toEqual([]);
}, 20_000);

it("drops a backlog the uplink can't drain and welcomes its guest again instead of ending the room", async () => {
	const { host, seen, bus, append, hostWs } = await busyHost();
	const received = await joinGuest(host.link);
	await drainUntil(hostWs, () => received.some(frame => frame.t === "agents"), "first welcome never finished");

	// A ready guest, an uplink that stopped draining, and more live frames than the queue admits.
	for (let i = 0; i < FLOOD; i++) bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progress(i));
	expect(ended(seen)).toEqual([]);
	expect(host.stopped).toBe(false);
	// The overflow resyncs on a microtask; an entry appended after it is the new welcome's catch-up.
	await Promise.resolve();
	append(note("during-resync"));

	await drainUntil(
		hostWs,
		() => received.filter(frame => frame.t === "agents").length === 2,
		"the guest was never welcomed again",
	);
	expect(received.filter(frame => frame.t === "welcome")).toHaveLength(2);
	const resyncAt = received.findLastIndex(frame => frame.t === "welcome");
	const resynced = received.slice(resyncAt);
	expect(resynced.some(frame => frame.t === "entry" && frame.entry.id === "during-resync")).toBe(true);
	// The overflow dropped the backlog it couldn't hold: the guest got a fresh session, not 2,000 stale frames.
	expect(received.filter(frame => frame.t === "bus").length).toBeLessThan(256);

	const busBefore = received.filter(frame => frame.t === "bus").length;
	bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progress(FLOOD));
	await drainUntil(
		hostWs,
		() => received.filter(frame => frame.t === "bus").length > busBefore,
		"live frames stopped after the resync",
	);
	expect(ended(seen)).toEqual([]);
	expect(host.stopped).toBe(false);
}, 20_000);

it("keeps a ready guest live while another loads, and catches the newcomer up", async () => {
	const { host, seen, bus, append, hostWs } = await busyHost();
	const ready = await joinGuest(host.link);
	await drainUntil(hostWs, () => ready.some(frame => frame.t === "agents"), "first guest never caught up");
	const late = await joinGuest(host.link);
	await drainUntil(hostWs, () => late.some(frame => frame.t === "snapshot-chunk"), "second welcome never started");
	expect(late.some(frame => frame.t === "agents")).toBe(false);

	const readyBefore = ready.length;
	for (let i = 0; i < 50; i++) bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progress(i));
	append(note("while-late-loads"));
	await drainUntil(hostWs, () => late.some(frame => frame.t === "agents"), "second guest never caught up");
	await drainUntil(
		hostWs,
		() => ready.slice(readyBefore).filter(frame => frame.t === "bus").length === 50,
		"the ready guest missed live frames",
	);

	// The ready guest got everything live, once.
	const readyEntries = ready.flatMap(frame => (frame.t === "entry" ? [frame.entry.id] : []));
	expect(readyEntries).toEqual(["while-late-loads"]);
	// The newcomer got none of it live, and the entry in its catch-up.
	const finalAt = late.findIndex(frame => frame.t === "snapshot-chunk" && frame.final);
	expect(late.filter(frame => frame.t === "bus")).toEqual([]);
	expect(late.slice(finalAt + 1).map(frame => (frame.t === "entry" ? frame.entry.id : frame.t))).toEqual([
		"while-late-loads",
		"state",
		"agents",
	]);

	// Both caught up: one more frame reaches both.
	bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progress(50));
	await drainUntil(
		hostWs,
		() =>
			late.some(frame => frame.t === "bus") &&
			ready.slice(readyBefore).filter(frame => frame.t === "bus").length === 51,
		"live frames stopped after the catch-up",
	);
	expect(ended(seen)).toEqual([]);
}, 20_000);

it("welcomes a loading guest again when its own lane overflows, keeping the room", async () => {
	const { host, seen, hostWs } = await busyHost();
	const { received, guest } = await connectGuest(host.link);
	await waitFor(() => received.some(frame => frame.t === "welcome"), "welcome never arrived");
	// More targeted replies than its lane holds while its snapshot is stuck behind a full uplink.
	// In rounds the guest's own queue (256) admits.
	for (let round = 0; round < 3; round++) {
		for (let i = 0; i < 100; i++) {
			guest.send({ t: "fetch-transcript", reqId: round * 100 + i, agentId: "none", fromByte: 0 });
		}
		await guest.flush();
	}

	await drainUntil(hostWs, () => received.some(frame => frame.t === "agents"), "the guest never finished a welcome");
	expect(received.filter(frame => frame.t === "welcome").length).toBeGreaterThanOrEqual(2);
	expect(ended(seen)).toEqual([]);
	expect(host.stopped).toBe(false);
}, 20_000);
