/**
 * Contract: an exchange the host started has to end, whichever way it ends.
 *
 * Two halves. A `ui-request` the queue refuses leaves nobody able to answer,
 * and the caller awaits `requestGuestUi` with no timeout of its own, so the
 * registration has to settle rather than wait for a reply that cannot come.
 * And a reply computed asynchronously — a transcript read — must not be
 * addressed to an id whose owner left while it was being computed, which
 * `isServing` alone cannot decide because the retirement record it reads is a
 * bounded structure that churn can evict first.
 *
 * Drives the production `CollabHost` over the in-memory relay.
 */
import { afterEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { Stats } from "node:fs";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { FakeWebSocket, installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
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

/** Past `MAX_RETIRED_PEERS`, so eviction runs while the read is still outstanding. */
const RETIREMENT_CHURN = 300;

async function registerTranscript(): Promise<{ agentId: string; stats: Stats }> {
	const agentId = "sub-transcript";
	const file = join(tmpdir(), `collab-transcript-${process.pid}-${Date.now()}-${Math.random()}.jsonl`);
	await fs.writeFile(file, `{"type":"message","id":"a"}\n`);
	cleanups.push(() => void fs.rm(file, { force: true }));
	const stats = await fs.stat(file);
	const registry = AgentRegistry.global();
	const ref = registry.register({
		id: agentId,
		displayName: "transcript",
		kind: "sub",
		session: { abort: async () => {}, dispose: async () => {} } as unknown as AgentSession,
		sessionFile: file,
		status: "running",
	});
	cleanups.push(() => registry.unregister(agentId, ref));
	return { agentId, stats };
}

it("settles a guest ask the queue refused instead of awaiting an answer", async () => {
	const relay = installInMemoryRelay();
	const probe = instrumentRelay(relay, { throttle: true });
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const host = new CollabHost(makeHostContext(makeSnapshot(), seen));
	cleanups.push(() => void host.stop("test done"));

	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;

	const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => guest.close());
	guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "answerer", writeToken });
	guest.connect();
	await waitFor(
		() => seen.notices.some(notice => notice.includes("joined the collab session")),
		"host never welcomed the guest",
	);

	// Preconditions: somebody is entitled to answer, and the transport is stalled
	// with that guest's welcome snapshot still charged against the queue.
	expect(host.participants.filter(participant => participant.role === "guest" && !participant.readOnly)).toHaveLength(
		1,
	);
	await waitFor(
		() => probe.hostSocket().bufferedAmount >= HIGH_WATER_MARK,
		"the host transport never stalled with the snapshot still queued",
	);

	// An ask larger than the whole send budget cannot be admitted behind work that
	// is already queued, so no guest will ever see it.
	const pending = host.requestGuestUi({ kind: "select", title: "y".repeat(17 * 1024 * 1024), options: ["Yes"] });
	expect(pending).not.toBeNull();
	const settled = await Promise.race([pending!, Bun.sleep(2_000).then(() => "never settled" as const)]);
	expect(settled).toEqual({ kind: "unavailable" });
}, 30_000);

it("does not answer a transcript request at an id retired while it was reading", async () => {
	const relay = installInMemoryRelay();
	const probe = instrumentRelay(relay, { throttle: false });
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const host = new CollabHost(makeHostContext(makeSnapshot(), seen));
	cleanups.push(() => void host.stop("test done"));

	const { agentId, stats } = await registerTranscript();

	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);

	const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => guest.close());
	guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "reader" });
	guest.connect();
	await waitFor(
		() => seen.notices.some(notice => notice.includes("joined the collab session")),
		"host never welcomed the guest",
	);
	const peerId = probe.targets.find(peer => peer !== 0);
	if (!peerId) throw new Error("no targeted frame identified the guest's peer id");

	// Park the read so the peer can be retired while the reply is still owed.
	const gate = Promise.withResolvers<typeof stats>();
	const statSpy = spyOn(fs, "stat").mockImplementation(() => gate.promise as never);
	cleanups.push(() => statSpy.mockRestore());
	guest.send({ t: "fetch-transcript", reqId: 1, agentId, fromByte: 0 });
	await waitFor(() => statSpy.mock.calls.length > 0, "host never started reading the transcript");
	const queuedBeforeDeparture = probe.targets.length;

	guest.close();
	await waitFor(
		() => seen.notices.some(notice => notice.includes("left the collab session")),
		"host never observed the guest leaving",
	);
	// Churn past the retirement cap. Eviction must not forget this id while a
	// reply for it is still being computed.
	const hostWs = probe.hostSocket();
	for (let peer = peerId + 1; peer <= peerId + RETIREMENT_CHURN; peer++) {
		hostWs.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer }) } as MessageEvent);
	}
	await Bun.sleep(20);

	gate.resolve(stats);
	await Bun.sleep(50);
	expect(probe.targets.slice(queuedBeforeDeparture).filter(peer => peer === peerId)).toEqual([]);
}, 30_000);

it("does not answer a transcript request in a room the relay recreated", async () => {
	const relay = installInMemoryRelay();
	const probe = instrumentRelay(relay, { throttle: false });
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const host = new CollabHost(makeHostContext(makeSnapshot(), seen));
	cleanups.push(() => void host.stop("test done"));

	const { agentId, stats } = await registerTranscript();

	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);

	const asker = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => asker.close());
	asker.onOpen = () => asker.send({ t: "hello", proto: COLLAB_PROTO, name: "asker" });
	asker.connect();
	await waitFor(
		() => seen.notices.some(notice => notice.includes("joined the collab session")),
		"host never welcomed the asker",
	);

	const gate = Promise.withResolvers<Stats>();
	const statSpy = spyOn(fs, "stat").mockImplementation(() => gate.promise as never);
	cleanups.push(() => statSpy.mockRestore());
	asker.send({ t: "fetch-transcript", reqId: 7, agentId, fromByte: 0 });
	await waitFor(() => statSpy.mock.calls.length > 0, "host never started reading the transcript");

	// The room is destroyed and the next one issues peer ids from 1 again, so the
	// asker's id now belongs to whoever joins next.
	probe.hostSocket().close();
	await waitFor(() => probe.hostSocket().readyState === FakeWebSocket.OPEN, "host never reconnected", 8_000);
	const successor = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => successor.close());
	const received: CollabFrame[] = [];
	successor.onFrame = frame => received.push(frame);
	successor.onOpen = () => successor.send({ t: "hello", proto: COLLAB_PROTO, name: "successor" });
	successor.connect();
	await waitFor(
		() => received.some(frame => frame.t === "snapshot-chunk" && frame.final),
		"successor never received its own snapshot",
	);

	gate.resolve(stats);
	await Bun.sleep(50);
	expect(received.filter(frame => frame.t === "transcript")).toEqual([]);
}, 30_000);
