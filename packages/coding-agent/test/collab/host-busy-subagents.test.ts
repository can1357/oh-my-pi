/**
 * Contract: a host whose subagents report progress faster than its uplink drains
 * stays shared. A progress frame is a subagent's whole progress so far, so only
 * the newest one per subagent waits in the send queue: dozens of subagents can't
 * fill it behind a slow guest's welcome and end the room.
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
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
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

/** More progress frames than the send queue admits (256 entries). */
const FLOOD = 2_000;
const SUBAGENTS = 37;

function note(id: string): SessionEntry {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: "2026-11-01T00:00:00Z",
		customType: "note",
		content: id,
		display: true,
	} satisfies SessionEntry;
}

interface Progress {
	index: number;
	parentToolCallId: string;
	progress: { toolCount: number };
}

function progress(i: number): Progress {
	return { index: i % SUBAGENTS, parentToolCallId: "call-1", progress: { toolCount: i } };
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
	return received;
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
const busFrames = (received: CollabFrame[], channel: string) =>
	received.flatMap(frame => (frame.t === "bus" && frame.channel === channel ? [frame.data as Progress] : []));

it("keeps a slow guest joined through a flood of subagent progress, with each subagent's newest progress", async () => {
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

	await drainUntil(
		hostWs,
		() => received.some(frame => frame.t === "entry" && frame.entry.id === "during-1500"),
		"entries appended during the welcome never arrived",
	);
	expect(received.some(frame => frame.t === "snapshot-chunk" && frame.final)).toBe(true);
	// Every session entry arrives; of the progress, each subagent's newest, once.
	const entries = received.flatMap(frame => (frame.t === "entry" ? [frame.entry.id] : []));
	expect(entries).toEqual(["during-0", "during-500", "during-1000", "during-1500"]);
	await drainUntil(
		hostWs,
		() => busFrames(received, TASK_SUBAGENT_PROGRESS_CHANNEL).length >= SUBAGENTS,
		"newest progress never arrived",
	);
	const newest = new Map(
		busFrames(received, TASK_SUBAGENT_PROGRESS_CHANNEL).map(data => [data.index, data.progress.toolCount]),
	);
	expect(newest.size).toBe(SUBAGENTS);
	// The last frame each subagent sent: the largest i below FLOOD with i % SUBAGENTS === index.
	for (const [index, toolCount] of newest)
		expect(toolCount).toBe(index + SUBAGENTS * Math.floor((FLOOD - 1 - index) / SUBAGENTS));
	expect(busFrames(received, TASK_SUBAGENT_PROGRESS_CHANNEL).length).toBeLessThan(256);
	expect(ended(seen)).toEqual([]);
}, 20_000);

it("relays every lifecycle frame: only progress is coalesced", async () => {
	const { host, seen, bus, hostWs } = await busyHost();
	const received = await joinGuest(host.link);
	await drainUntil(
		hostWs,
		() => received.some(frame => frame.t === "snapshot-chunk" && frame.final),
		"welcome never finished",
	);

	for (let i = 0; i < 3; i++)
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { index: 0, parentToolCallId: "call-1", status: `s${i}` });
	await drainUntil(
		hostWs,
		() => busFrames(received, TASK_SUBAGENT_LIFECYCLE_CHANNEL).length === 3,
		"lifecycle frames were lost",
	);
	expect(ended(seen)).toEqual([]);
}, 20_000);
