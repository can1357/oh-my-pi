/**
 * Contract: an ask the host started has to end. A `ui-request` the queue refuses
 * leaves nobody able to answer, and the caller awaits `requestGuestUi` with no
 * timeout of its own, so the registration settles rather than waits; only a peer
 * that was handed the ask may answer it.
 *
 * Drives the production `CollabHost` over the in-memory relay.
 */
import { afterEach, expect, it, spyOn } from "bun:test";
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
it("re-poses a shed guest's asks when it rejoins instead of settling them", async () => {
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

	// Every one of these is offered to a writable guest. The queue takes the first
	// of them behind the stalled snapshot and then sheds the peer holding the lot.
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
	expect(received.filter(frame => frame.t === "ui-request")).toEqual([]);
	expect(host.participants.filter(participant => participant.role === "guest")).toEqual([]);

	// The shed guest was the only writer, and a shed guest rejoins: the ask it held
	// waits for that rather than settling, and the rejoin's welcome re-poses it.
	let settled: unknown;
	void asks[0]!.then(result => {
		settled = result;
	});
	guest.send({ t: "hello", proto: COLLAB_PROTO, name: "answerer", writeToken });
	const hostWs = probe.hostSocket();
	const deadline = Date.now() + 10_000;
	while (!received.some(frame => frame.t === "ui-request" && frame.request.title === "ask 0")) {
		if (Date.now() > deadline) throw new Error("the rejoined guest was never re-posed the ask it held");
		hostWs.bufferedAmount = 0;
		await Bun.sleep(5);
	}
	expect(settled).toBeUndefined();
}, 30_000);

it("ignores an answer from a writer the ask was never delivered to", async () => {
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
	const joinWriter = (name: string): { socket: CollabSocket; received: CollabFrame[] } => {
		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
		cleanups.push(() => socket.close());
		const received: CollabFrame[] = [];
		socket.onFrame = frame => received.push(frame);
		socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
		socket.connect();
		return { socket, received };
	};
	const holder = joinWriter("holder");
	await waitFor(() => seen.notices.some(notice => notice.includes("holder joined")), "holder never joined");
	const outsider = joinWriter("outsider");
	await waitFor(() => seen.notices.some(notice => notice.includes("outsider joined")), "outsider never joined");

	// The queue refuses the outsider's copy: peers are served in join order, so
	// the second `ui-request` addressed is the outsider's.
	const real = CollabSocket.prototype.send;
	let uiRequests = 0;
	const spy = spyOn(CollabSocket.prototype, "send").mockImplementation(
		function (this: CollabSocket, frame, targetPeer) {
			if (typeof frame === "object" && frame.t === "ui-request" && ++uiRequests === 2) return false;
			return real.call(this, frame, targetPeer);
		},
	);
	cleanups.push(() => spy.mockRestore());

	const ask = host.requestGuestUi({ kind: "select", title: "pick one", options: [{ label: "a" }, { label: "b" }] });
	if (!ask) throw new Error("host did not offer the ask");
	await waitFor(() => holder.received.some(frame => frame.t === "ui-request"), "holder never received the dialog");
	const request = holder.received.find(frame => frame.t === "ui-request");
	if (request?.t !== "ui-request") throw new Error("expected a ui-request");
	expect(outsider.received.some(frame => frame.t === "ui-request")).toBe(false);

	let settled: unknown;
	void ask.then(result => {
		settled = result;
	});
	outsider.socket.send({ t: "ui-response", reqId: request.request.reqId, value: "b" });
	// Ordered barrier: the host acknowledges an unknown reqId with `ui-request-end`.
	const sentinel = request.request.reqId + 1_000;
	outsider.socket.send({ t: "ui-response", reqId: sentinel, value: undefined });
	await waitFor(
		() => outsider.received.some(frame => frame.t === "ui-request-end" && frame.reqId === sentinel),
		"host never processed the outsider's answers",
	);
	await Bun.sleep(0);
	expect(settled).toBeUndefined();

	holder.socket.send({ t: "ui-response", reqId: request.request.reqId, value: "a" });
	expect(await ask).toEqual({ kind: "answered", value: "a" });
}, 30_000);
