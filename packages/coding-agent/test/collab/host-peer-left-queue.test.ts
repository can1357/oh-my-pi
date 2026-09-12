/**
 * Contract: a guest that leaves must stop costing the room anything.
 *
 * Two ways that breaks. The queue is shared and strictly FIFO, so a stale
 * targeted batch parked at its head makes every later frame — the next guest's
 * welcome included — wait for a retransmission at a peer id the relay already
 * retired. And because the relay's `peer-left` control is dispatched
 * synchronously while binary frames are still decrypting, a `hello` that
 * arrived *before* the departure can land *after* it and resurrect the peer.
 *
 * Drives the production `CollabHost` over the in-memory relay.
 */
import { afterEach, expect, it, spyOn } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
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

it("discards a departed guest's queued snapshot instead of stalling the next guest's welcome", async () => {
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
	const hostWs = probe.hostSocket();

	const leaver = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => leaver.close());
	const leaverFrames: CollabFrame[] = [];
	const leaverChunked = Promise.withResolvers<void>();
	leaver.onFrame = frame => {
		leaverFrames.push(frame);
		if (frame.t === "snapshot-chunk") leaverChunked.resolve();
	};
	leaver.onOpen = () => leaver.send({ t: "hello", proto: COLLAB_PROTO, name: "leaver" });
	leaver.connect();
	await leaverChunked.promise;

	// Mid-snapshot: the first chunk is on the wire, the rest are still queued.
	expect(hostWs.bufferedAmount).toBeGreaterThanOrEqual(HIGH_WATER_MARK);
	expect(leaverFrames.filter(frame => frame.t === "snapshot-chunk").some(frame => frame.final)).toBe(false);
	const leaverPeer = probe.targets.find(peer => peer !== 0);
	expect(leaverPeer).toBeGreaterThan(0);

	leaver.close();
	await waitFor(
		() => seen.notices.some(notice => notice.includes("left the collab session")),
		"host never observed the guest leaving",
	);
	const queuedAtDeparture = probe.targets.length;

	const rejoiner = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => rejoiner.close());
	const rejoinerFrames: CollabFrame[] = [];
	const rejoinerDone = Promise.withResolvers<void>();
	rejoiner.onFrame = frame => {
		rejoinerFrames.push(frame);
		if (frame.t === "snapshot-chunk" && frame.final) rejoinerDone.resolve();
	};
	rejoiner.onOpen = () => rejoiner.send({ t: "hello", proto: COLLAB_PROTO, name: "rejoiner" });
	rejoiner.connect();

	const drain = setInterval(() => {
		hostWs.bufferedAmount = 0;
	}, 10);
	try {
		await Promise.race([
			rejoinerDone.promise,
			Bun.sleep(5_000).then(() => {
				throw new Error("rejoining guest never received the final snapshot chunk");
			}),
		]);
	} finally {
		clearInterval(drain);
	}

	// Nothing addressed to the retired peer id may reach the wire afterwards.
	expect(probe.targets.slice(queuedAtDeparture)).not.toContain(leaverPeer);
	const welcomeIndex = rejoinerFrames.findIndex(frame => frame.t === "welcome");
	expect(welcomeIndex).toBeGreaterThanOrEqual(0);
	expect(rejoinerFrames.findIndex(frame => frame.t === "snapshot-chunk")).toBeGreaterThan(welcomeIndex);
	const chunks = rejoinerFrames.filter(frame => frame.t === "snapshot-chunk");
	expect(chunks.flatMap(chunk => chunk.entries.map(entry => entry.id))).toEqual(
		snapshot.entries.map(entry => entry.id),
	);
}, 15_000);

it("settles an outstanding guest ask when the room is recreated", async () => {
	const relay = installInMemoryRelay();
	const probe = instrumentRelay(relay, { throttle: false });
	const snapshot = makeSnapshot();
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const host = new CollabHost(makeHostContext(snapshot, seen));
	cleanups.push(() => void host.stop("test done"));

	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const joins = () => seen.notices.filter(notice => notice.includes("joined the collab session")).length;

	const answerer = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => answerer.close());
	answerer.onOpen = () => answerer.send({ t: "hello", proto: COLLAB_PROTO, name: "answerer", writeToken });
	answerer.connect();
	await waitFor(() => joins() >= 1, "host never handled the writable guest");

	// The host asks the guest something and waits on the answer, the way
	// ExtensionUIController#requestGuestUiString does: a bare await, no local race
	// and no timeout of its own.
	const asked = host.requestGuestUi({ kind: "select", title: "pick one", options: [{ label: "a" }, { label: "b" }] });
	if (!asked) throw new Error("host did not offer the ask to the writable guest");

	// The uplink drops: the relay destroys the room and closes the only guest that
	// could answer.
	probe.hostSocket().close();
	await waitFor(() => probe.hostSocket().readyState === FakeWebSocket.OPEN, "host never reconnected", 8_000);

	// Bounded, so a hang fails an assertion instead of the runner's timeout.
	const settled = await Promise.race([asked, Bun.sleep(1_000).then(() => "still-waiting" as const)]);
	expect(settled).toEqual({ kind: "unavailable" });

	// And the question is not re-posed to whoever joins the new room next.
	const latecomer = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => latecomer.close());
	const received: CollabFrame[] = [];
	latecomer.onFrame = frame => received.push(frame);
	latecomer.onOpen = () => latecomer.send({ t: "hello", proto: COLLAB_PROTO, name: "latecomer", writeToken });
	latecomer.connect();
	await waitFor(() => joins() >= 2, "host never handled the latecomer");
	await Bun.sleep(100);
	expect(received.filter(frame => frame.t === "ui-request")).toEqual([]);
}, 30_000);

it("does not let a reissued peer id inherit write permission", async () => {
	const relay = installInMemoryRelay();
	const probe = instrumentRelay(relay, { throttle: false });
	const snapshot = makeSnapshot();
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const context = makeHostContext(snapshot, seen);
	const prompted: unknown[] = [];
	// The only side effect that matters: whether a prompt actually runs.
	(context.session as unknown as { promptCustomMessage: (message: unknown) => Promise<void> }).promptCustomMessage =
		message => {
			prompted.push(message);
			return Promise.resolve();
		};
	const host = new CollabHost(context);
	cleanups.push(() => void host.stop("test done"));

	await host.start("ws://localhost:8788");
	const full = parseCollabLink(host.link);
	const view = parseCollabLink(host.viewLink);
	if ("error" in full) throw new Error(full.error);
	if ("error" in view) throw new Error(view.error);
	expect(view.writeToken).toBeUndefined();
	const joins = () => seen.notices.filter(notice => notice.includes("joined the collab session")).length;

	// A guest with the full link joins and takes the first peer id.
	const writer = new CollabSocket({ wsUrl: full.wsUrl, role: "guest", key: await importRoomKey(full.key) });
	cleanups.push(() => writer.close());
	const writeToken = full.writeToken ? Buffer.from(full.writeToken).toString("base64url") : undefined;
	writer.onOpen = () => writer.send({ t: "hello", proto: COLLAB_PROTO, name: "writer", writeToken });
	writer.connect();
	await waitFor(() => joins() >= 1, "host never handled the writable guest");
	expect(seen.participantCounts.at(-1)).toBe(2);

	// The host uplink drops transiently. The relay destroys the room, closes the
	// guest, and issues ids from 1 again when the host comes back.
	probe.hostSocket().close();
	await waitFor(() => probe.hostSocket().readyState === FakeWebSocket.OPEN, "host never reconnected", 8_000);
	await Bun.sleep(50);

	// A client holding only the view link takes the reissued id and, without ever
	// sending hello, tries to drive the session.
	const viewer = new CollabSocket({ wsUrl: view.wsUrl, role: "guest", key: await importRoomKey(view.key) });
	cleanups.push(() => viewer.close());
	viewer.onOpen = () => viewer.send({ t: "prompt", text: "unauthenticated command" });
	viewer.connect();
	await Bun.sleep(200);

	expect(prompted).toEqual([]);
	expect(joins()).toBe(1);
}, 30_000);

it("ignores a hello that finishes decrypting after its sender's peer-left", async () => {
	const relay = installInMemoryRelay();
	const probe = instrumentRelay(relay, { throttle: false });
	const snapshot = makeSnapshot();
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const host = new CollabHost(makeHostContext(snapshot, seen));
	cleanups.push(() => void host.stop("test done"));

	// Hold the very first decryption — the host opening the guest's hello — so
	// the departure control message overtakes it, exactly as a slow CPU would.
	const realDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
	const held = Promise.withResolvers<void>();
	let holding = false;
	const decrypt = spyOn(crypto.subtle, "decrypt").mockImplementation(
		async (...args: Parameters<typeof crypto.subtle.decrypt>) => {
			if (!holding) {
				holding = true;
				await held.promise;
			}
			return realDecrypt(...args);
		},
	);
	cleanups.push(() => {
		held.resolve();
		decrypt.mockRestore();
	});

	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);

	const flake = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => flake.close());
	flake.onOpen = () => flake.send({ t: "hello", proto: COLLAB_PROTO, name: "flake" });
	flake.connect();
	await waitFor(() => decrypt.mock.calls.length > 0, "host never started decrypting the hello");

	const statusUpdates = seen.participantCounts.length;
	flake.close();
	await waitFor(
		() => seen.participantCounts.length > statusUpdates,
		"host never processed the peer-left control message",
	);

	held.resolve();
	await Bun.sleep(50);

	expect(seen.notices.filter(notice => notice.includes("joined the collab session"))).toEqual([]);
	// A ghost peer would show as a second participant and draw a whole snapshot.
	expect(Math.max(...seen.participantCounts)).toBe(1);
	expect(probe.targets.filter(peer => peer !== 0)).toEqual([]);
}, 15_000);
