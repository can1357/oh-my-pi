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
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
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

it("delivers the admitted header when the live session changes before the welcome drains", async () => {
	const relay = installInMemoryRelay();
	const probe = instrumentRelay(relay, { throttle: false });
	const snapshot = makeSnapshot();
	snapshot.entries = [];
	snapshot.header.cwd = "/tmp/admitted-workspace";
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const ctx = makeHostContext(snapshot, seen);
	ctx.sessionManager.snapshotForReplication = () => snapshot;
	const host = new CollabHost(ctx);
	cleanups.push(() => void host.stop("test done"));
	await host.start("ws://localhost:8788");
	probe.hostSocket().bufferedAmount = HIGH_WATER_MARK;
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => guest.close());
	const frames: CollabFrame[] = [];
	guest.onFrame = frame => frames.push(frame);
	guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "queued-joiner" });
	guest.connect();
	await waitFor(() => seen.notices.some(notice => notice.includes("joined the collab session")), "join not admitted");
	expect(frames).toEqual([]);
	snapshot.header.cwd = "/tmp/later-workspace";
	probe.hostSocket().bufferedAmount = 0;
	await waitFor(() => frames.some(frame => frame.t === "snapshot-chunk" && frame.final), "welcome did not drain");
	const welcome = frames.find(frame => frame.t === "welcome");
	expect(welcome?.header.cwd).toBe("/tmp/admitted-workspace");
});
