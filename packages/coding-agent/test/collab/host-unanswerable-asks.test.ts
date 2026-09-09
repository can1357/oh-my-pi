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

/**
 * Records the verdict of every {@link CollabSocket.addressee} capture as its
 * reply site releases it. That release is the last thing `#handleFetchTranscript`
 * does, so it is a completion barrier for the whole read — `stat`, `open`, `read`
 * and `close` — where a sleep is only a guess at how long the read takes.
 */
function captureAddresseeVerdicts(): boolean[] {
	const verdicts: boolean[] = [];
	const real = CollabSocket.prototype.addressee;
	const spy = spyOn(CollabSocket.prototype, "addressee").mockImplementation(function (
		this: CollabSocket,
		peerId: number,
	) {
		const release = real.call(this, peerId);
		return () => {
			const verdict = release();
			verdicts.push(verdict);
			return verdict;
		};
	});
	cleanups.push(() => spy.mockRestore());
	return verdicts;
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

/** Past the peer's share, so the queue takes some of these and then sheds the peer holding them. */
const ASK_FLOOD = 40;
/** `MAX_PEER_PENDING_SENDS` in relay-client.ts. */
const PEER_SHARE = 32;

it("settles the asks a shed guest was holding", async () => {
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
	const received: CollabFrame[] = [];
	guest.onFrame = frame => received.push(frame);
	guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "answerer", writeToken });
	guest.connect();
	await waitFor(
		() => seen.notices.some(notice => notice.includes("joined the collab session")),
		"host never welcomed the guest",
	);
	await waitFor(
		() => probe.hostSocket().bufferedAmount >= HIGH_WATER_MARK,
		"the host transport never stalled with the snapshot still queued",
	);

	// Every one of these is offered to a writable guest, so every one is
	// registered as an outstanding ask. The queue takes the first of them behind
	// the stalled snapshot and then sheds the peer holding the lot.
	const asks: Promise<unknown>[] = [];
	for (let i = 0; i < ASK_FLOOD; i++) {
		const ask = host.requestGuestUi({ kind: "select", title: `ask ${i}`, options: [{ label: "yes" }] });
		if (!ask) throw new Error(`host stopped offering asks to the writable guest at ${i}`);
		asks.push(ask);
	}
	await waitFor(
		() => seen.notices.some(notice => notice.includes("fell too far behind")),
		"host never shed the guest holding the asks",
	);

	// Nothing was delivered and nobody is left to answer, so no caller may still
	// be waiting: `requestGuestUi` has no timeout of its own.
	expect(received.filter(frame => frame.t === "ui-request")).toEqual([]);
	expect(host.participants.filter(participant => participant.role === "guest")).toEqual([]);
	const settled = await Promise.race([Promise.all(asks), Bun.sleep(2_000).then(() => "still waiting" as const)]);
	expect(settled).toEqual(asks.map(() => ({ kind: "unavailable" })));
}, 30_000);

it("does not shed a bystander when settling the shed guest's ask", async () => {
	const relay = installInMemoryRelay();
	const probe = instrumentRelay(relay, { throttle: true });
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const host = new CollabHost(makeHostContext(makeSnapshot(), seen));
	cleanups.push(() => void host.stop("test done"));

	// Each fetch-transcript is looked up in the registry and answered synchronously
	// from there, so counting lookups is an exact barrier on how many replies the
	// queue has taken — which is what makes the shares below deterministic rather
	// than a race between two guests' frame streams.
	const registry = AgentRegistry.global();
	const lookups = spyOn(registry, "get");
	cleanups.push(() => lookups.mockRestore());

	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const joins = () => seen.notices.filter(notice => notice.includes("joined the collab session")).length;

	const join = (name: string) => {
		const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
		cleanups.push(() => guest.close());
		const frames: CollabFrame[] = [];
		guest.onFrame = frame => frames.push(frame);
		guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
		guest.connect();
		return { guest, frames };
	};
	const greedy = join("greedy");
	await waitFor(() => joins() >= 1, "host never welcomed the first guest");
	const bystander = join("bystander");
	await waitFor(() => joins() >= 2, "host never welcomed the bystander");
	await waitFor(
		() => probe.hostSocket().bufferedAmount >= HIGH_WATER_MARK,
		"the host transport never stalled with the snapshots still queued",
	);

	// Big enough that the second copy does not fit the byte budget, so the ask is
	// admitted for the first guest and dropped for the bystander. That is what
	// makes the first guest its only recipient, and its shed the thing that has to
	// settle the ask.
	const ask = host.requestGuestUi({ kind: "select", title: "y".repeat(9 * 1024 * 1024), options: [{ label: "a" }] });
	if (!ask) throw new Error("host did not offer the ask to a writable guest");

	// The bystander up to its share and no further: its welcome batch plus one
	// reply per fetch is exactly the cap, so the next targeted frame for it is the
	// one that would shed it. Barrier first, or the shed below can land while it is
	// still under its share and the assertions pass for the wrong reason.
	const bystanderFetches = PEER_SHARE - 1;
	for (let i = 0; i < bystanderFetches; i++) {
		bystander.guest.send({ t: "fetch-transcript", reqId: i, agentId: "no-such-agent", fromByte: 0 });
	}
	await waitFor(
		() => lookups.mock.calls.length >= bystanderFetches,
		"host never worked through the bystander's fetches",
	);
	expect(seen.notices.filter(notice => notice.includes("fell too far behind"))).toEqual([]);

	for (let i = 0; i < PEER_SHARE; i++) {
		greedy.guest.send({ t: "fetch-transcript", reqId: i, agentId: "no-such-agent", fromByte: 0 });
	}
	await waitFor(
		() => seen.notices.some(notice => notice.includes("fell too far behind")),
		"host never shed the guest that outran its share",
	);

	// The settlement of the shed guest's ask is addressed to the bystander. That
	// frame may be dropped; it may not cost the bystander its backlog.
	const settled = await Promise.race([ask, Bun.sleep(2_000).then(() => "still waiting" as const)]);
	expect(settled).toEqual({ kind: "unavailable" });
	expect(seen.notices.filter(notice => notice.includes("fell too far behind"))).toEqual([
		"greedy fell too far behind and was dropped; they can rejoin",
	]);

	const hostWs = probe.hostSocket();
	const drain = setInterval(() => {
		hostWs.bufferedAmount = 0;
	}, 10);
	try {
		// Everything it was holding, in queue order: the welcome batch first and then
		// every reply admitted before the shed. All of it was admitted inside its
		// share, so all of it has to arrive.
		await waitFor(
			() =>
				bystander.frames.some(frame => frame.t === "snapshot-chunk" && frame.final) &&
				bystander.frames.filter(frame => frame.t === "transcript").length >= bystanderFetches,
			"the bystander lost the backlog it was inside its share for",
		);
	} finally {
		clearInterval(drain);
	}
	expect(bystander.frames.filter(frame => frame.t === "error" && frame.message.includes("rejoin"))).toEqual([]);
	expect(bystander.frames.filter(frame => frame.t === "transcript").length).toBe(bystanderFetches);
}, 30_000);

it("settles an ask the guest holding it left with", async () => {
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

	const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => guest.close());
	const received: CollabFrame[] = [];
	guest.onFrame = frame => received.push(frame);
	guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "answerer", writeToken });
	guest.connect();
	await waitFor(
		() => seen.notices.some(notice => notice.includes("joined the collab session")),
		"host never welcomed the guest",
	);

	// Delivered this time: the dialog is on the guest's screen when it closes the
	// tab, which leaves the ask with no recipient that can answer it.
	const ask = host.requestGuestUi({ kind: "select", title: "pick one", options: [{ label: "a" }] });
	if (!ask) throw new Error("host did not offer the ask to the writable guest");
	await waitFor(() => received.some(frame => frame.t === "ui-request"), "guest never received the dialog");

	guest.close();
	await waitFor(
		() => seen.notices.some(notice => notice.includes("left the collab session")),
		"host never observed the guest leaving",
	);
	const settled = await Promise.race([ask, Bun.sleep(2_000).then(() => "still waiting" as const)]);
	expect(settled).toEqual({ kind: "unavailable" });
}, 30_000);

it("settles an ask whose holder gave up write permission", async () => {
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
	const joins = () => seen.notices.filter(notice => notice.includes("joined the collab session")).length;

	const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => guest.close());
	const received: CollabFrame[] = [];
	guest.onFrame = frame => received.push(frame);
	guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "answerer", writeToken });
	guest.connect();
	await waitFor(() => joins() >= 1, "host never welcomed the writable guest");

	const ask = host.requestGuestUi({ kind: "select", title: "pick one", options: [{ label: "a" }] });
	if (!ask) throw new Error("host did not offer the ask to the writable guest");
	await waitFor(() => received.some(frame => frame.t === "ui-request"), "guest never received the dialog");

	// The same peer says hello again without the write token. A read-only peer's
	// `ui-response` is rejected, so it is no longer somebody who can answer.
	guest.send({ t: "hello", proto: COLLAB_PROTO, name: "answerer" });
	await waitFor(() => joins() >= 2, "host never handled the second hello");
	const settled = await Promise.race([ask, Bun.sleep(2_000).then(() => "still waiting" as const)]);
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
	// The welcome is sealed asynchronously, so wait for the id to appear on the
	// wire rather than reading whatever has been forwarded by now.
	await waitFor(() => probe.targets.some(peer => peer !== 0), "no targeted frame identified the guest's peer id");
	const peerId = probe.targets.find(peer => peer !== 0);
	if (!peerId) throw new Error("no targeted frame identified the guest's peer id");

	// Park the read so the peer can be retired while the reply is still owed.
	const gate = Promise.withResolvers<typeof stats>();
	const statSpy = spyOn(fs, "stat").mockImplementation(() => gate.promise as never);
	cleanups.push(() => statSpy.mockRestore());
	const verdicts = captureAddresseeVerdicts();
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
	// The read runs to its reply site, which is where the capture reports whether
	// the answer still goes to the peer that asked.
	await waitFor(() => verdicts.length > 0, "the transcript read never reached its reply site");
	expect(verdicts).toEqual([false]);
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
	const verdicts = captureAddresseeVerdicts();
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
	await waitFor(() => verdicts.length > 0, "the transcript read never reached its reply site");
	expect(verdicts).toEqual([false]);
	expect(received.filter(frame => frame.t === "transcript")).toEqual([]);
}, 30_000);
