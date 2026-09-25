import { afterEach, describe, expect, it } from "bun:test";
import { type LocalRelay, startLocalRelay } from "../../../collab-web/scripts/local-relay";
import { generateRoomKey, importRoomKey, seal } from "../../src/collab/crypto";
import { type CollabFrame, packEnvelope } from "../../src/collab/protocol";
import { CollabSocket } from "../../src/collab/relay-client";

let relay: LocalRelay | undefined;
const sockets: Array<CollabSocket | WebSocket> = [];

afterEach(() => {
	for (const socket of sockets.splice(0)) socket.close();
	relay?.stop();
	relay = undefined;
});

async function connect(role: "host" | "guest", key: CryptoKey): Promise<CollabSocket> {
	const socket = new CollabSocket({ wsUrl: `${relay!.url}/r/IsolationRoom_123`, role, key });
	sockets.push(socket);
	const opened = Promise.withResolvers<void>();
	socket.onOpen = () => opened.resolve();
	socket.connect();
	await opened.promise;
	return socket;
}

describe("collab peer isolation", () => {
	for (const corruption of ["truncated", "wrong-key"] as const) {
		it(`keeps the room usable after a guest sends a ${corruption} frame`, async () => {
			relay = startLocalRelay();
			const key = await importRoomKey(generateRoomKey());
			const host = await connect("host", key);
			const guest = await connect("guest", key);
			const closed: string[] = [];
			const afterCorruption = Promise.withResolvers<string>();
			host.onClose = reason => {
				closed.push(`host: ${reason}`);
				afterCorruption.resolve(reason);
			};
			guest.onClose = reason => closed.push(`guest: ${reason}`);
			const received = Promise.withResolvers<CollabFrame>();
			guest.onFrame = frame => received.resolve(frame);
			host.onFrame = frame => {
				if (frame.t === "prompt" && frame.text === "after corruption") afterCorruption.resolve("delivered");
				if (frame.t === "prompt" && frame.text === "healthy guest") {
					host.send({ t: "error", message: "healthy reply" });
				}
			};
			const sender = new WebSocket(`${relay.url}/r/IsolationRoom_123?role=guest`);
			sockets.push(sender);
			const opened = Promise.withResolvers<void>();
			sender.onopen = () => opened.resolve();
			await opened.promise;
			const payload =
				corruption === "truncated"
					? new Uint8Array(1)
					: await seal(await importRoomKey(generateRoomKey()), { t: "abort" });
			sender.send(packEnvelope(0, payload));
			sender.send(packEnvelope(0, await seal(key, { t: "prompt", text: "after corruption" })));
			expect(await afterCorruption.promise).toBe("delivered");
			guest.send({ t: "prompt", text: "healthy guest" });
			expect(await received.promise).toEqual({ t: "error", message: "healthy reply" });
			expect(closed).toEqual([]);
			expect(host.isOpen).toBe(true);
			expect(guest.isOpen).toBe(true);
		});
	}

	it("closes a guest with the wrong room key without retrying", async () => {
		relay = startLocalRelay();
		const host = await connect("host", await importRoomKey(generateRoomKey()));
		const guest = await connect("guest", await importRoomKey(generateRoomKey()));
		const closed = Promise.withResolvers<{ reason: string; retry: boolean }>();
		guest.onClose = (reason, retry) => closed.resolve({ reason, retry });
		host.send({ t: "error", message: "encrypted host traffic" });
		expect(await closed.promise).toEqual({ reason: "bad key or corrupted frame", retry: false });
		expect(guest.isOpen).toBe(false);
		expect(host.isOpen).toBe(true);
	});
});
