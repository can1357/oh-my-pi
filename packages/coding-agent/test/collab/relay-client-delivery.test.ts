import { expect, it } from "bun:test";
import { startLocalRelay } from "../../../collab-web/scripts/local-relay";
import { generateRoomKey, importRoomKey } from "../../src/collab/crypto";
import { COLLAB_PROTO, type CollabFrame } from "../../src/collab/protocol";
import { CollabSocket } from "../../src/collab/relay-client";

it("delivers a complete snapshot batch and subsequent live entry through the local relay", async () => {
	const relay = startLocalRelay();
	const key = await importRoomKey(generateRoomKey());
	const wsUrl = `${relay.url}/r/durablebatchroom`;
	const host = new CollabSocket({ wsUrl, role: "host", key });
	const guest = new CollabSocket({ wsUrl, role: "guest", key });
	const ready = Promise.withResolvers<void>();
	const completed = Promise.withResolvers<void>();
	const frames: CollabFrame[] = [];
	const entry = (id: string) => ({
		type: "message" as const,
		id,
		parentId: null,
		timestamp: "2026-09-07T00:00:00Z",
		message: { role: "user" as const, content: id, timestamp: 0 },
	});
	function* snapshot(): Generator<CollabFrame> {
		for (let i = 0; i < 300; i++) {
			yield { t: "snapshot-chunk", entries: [entry(`snapshot-${i}`)], final: i === 299 };
		}
	}
	host.onOpen = ready.resolve;
	host.onFrame = (frame, peer) => {
		if (frame.t !== "hello") return;
		host.sendBatch(snapshot(), peer);
		host.send({ t: "entry", entry: entry("live") }, peer);
	};
	guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "receiver" });
	guest.onFrame = frame => {
		frames.push(frame);
		if (frame.t === "entry" && frame.entry.id === "live") completed.resolve();
	};
	try {
		host.connect();
		await ready.promise;
		guest.connect();
		await completed.promise;
		const chunks = frames.filter(frame => frame.t === "snapshot-chunk");
		expect(chunks.flatMap(chunk => chunk.entries.map(item => item.id))).toEqual(
			Array.from({ length: 300 }, (_, i) => `snapshot-${i}`),
		);
		expect(chunks.filter(chunk => chunk.final)).toEqual([chunks[299]!]);
		expect(frames.at(-1)).toEqual({ t: "entry", entry: entry("live") });
	} finally {
		guest.close();
		host.close();
		relay.stop();
	}
}, 5000);
