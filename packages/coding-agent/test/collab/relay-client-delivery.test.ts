import { expect, it } from "bun:test";
import { startLocalRelay } from "../../../collab-web/scripts/local-relay";
import { generateRoomKey, importRoomKey } from "../../src/collab/crypto";
import { COLLAB_PROTO } from "../../src/collab/protocol";
import { CollabSocket } from "../../src/collab/relay-client";

it("serves a joining guest, stops serving it on departure, and serves the next one", async () => {
	const relay = startLocalRelay();
	const key = await importRoomKey(generateRoomKey());
	const wsUrl = `${relay.url}/r/servinglifecycle`;
	const host = new CollabSocket({ wsUrl, role: "host", key });
	const ready = Promise.withResolvers<void>();
	const peers: number[] = [];
	const greeted: Promise<void>[] = [];
	host.onOpen = ready.resolve;
	host.onFrame = (frame, peer) => {
		if (frame.t !== "hello") return;
		peers.push(peer);
		host.send({ t: "error", message: `served ${peer}` }, peer);
	};

	function joinGuest(name: string): CollabSocket {
		const guest = new CollabSocket({ wsUrl, role: "guest", key });
		const seen = Promise.withResolvers<void>();
		guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name });
		guest.onFrame = frame => {
			if (frame.t === "error") seen.resolve();
		};
		greeted.push(seen.promise);
		guest.connect();
		return guest;
	}

	const settle = async (predicate: () => boolean, message: string): Promise<void> => {
		const deadline = Date.now() + 3_000;
		while (!predicate()) {
			if (Date.now() > deadline) throw new Error(message);
			await Bun.sleep(5);
		}
	};

	let first: CollabSocket | undefined;
	let second: CollabSocket | undefined;
	try {
		host.connect();
		await ready.promise;

		first = joinGuest("first");
		await greeted[0];
		const firstPeer = peers[0]!;
		// The happy path must not depend on any admission signal: a guest that has
		// only said hello is served, and its targeted frame arrived above.
		expect(firstPeer).toBeGreaterThan(0);
		expect(host.isServing(firstPeer)).toBe(true);

		first.close();
		await settle(() => !host.isServing(firstPeer), "host kept serving a departed peer");

		second = joinGuest("second");
		await greeted[1];
		const secondPeer = peers[1]!;
		expect(secondPeer).not.toBe(firstPeer);
		expect(host.isServing(secondPeer)).toBe(true);
		expect(host.isServing(firstPeer)).toBe(false);
	} finally {
		second?.close();
		first?.close();
		host.close();
		relay.stop();
	}
}, 10000);
