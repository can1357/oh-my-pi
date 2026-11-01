import { describe, expect, it } from "bun:test";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { startLocalRelay } from "../../../collab-web/scripts/local-relay";

describe("CollabSocket local send admission", () => {
	it("rejects closed and capacity-exceeding sends before enqueue", async () => {
		const key = await importRoomKey(generateRoomKey());
		const socket = new CollabSocket({ wsUrl: "ws://localhost:1/r/AdmissionCapacity", role: "guest", key });
		try {
			// An offline backlog is deliberately admitted; it does not require isOpen.
			for (let i = 0; i < 256; i++) expect(socket.send({ t: "prompt", text: `queued ${i}` })).toBe(true);
			expect(socket.send({ t: "prompt", text: "over capacity" })).toBe(false);
			expect(socket.send({ t: "prompt", text: "closed by overload" })).toBe(false);
		} finally {
			socket.close();
		}
		expect(socket.send({ t: "prompt", text: "explicitly closed" })).toBe(false);
	});

	it("rejects a retired peer while admitting another peer on a real relay", async () => {
		const key = await importRoomKey(generateRoomKey());
		const relay = startLocalRelay();
		const host = new CollabSocket({ wsUrl: `${relay.url}/r/AdmissionRetired`, role: "host", key });
		const guest = new CollabSocket({ wsUrl: `${relay.url}/r/AdmissionRetired`, role: "guest", key });
		const hostOpen = Promise.withResolvers<void>();
		const joined = Promise.withResolvers<number>();
		const left = Promise.withResolvers<void>();
		host.onOpen = () => hostOpen.resolve();
		host.onControl = frame => {
			if (frame.t === "peer-joined") joined.resolve(frame.peer);
			if (frame.t === "peer-left") left.resolve();
		};
		try {
			host.connect();
			await hostOpen.promise;
			guest.connect();
			const peer = await joined.promise;
			guest.close();
			await left.promise;
			expect(host.send({ t: "error", message: "retired" }, peer)).toBe(false);
			expect(host.send({ t: "error", message: "broadcast" })).toBe(true);
		} finally {
			guest.close();
			host.close();
			relay.stop();
		}
	});

	it("admits a real reconnect backlog without replaying it", async () => {
		const key = await importRoomKey(generateRoomKey());
		const relay = startLocalRelay();
		const options = { wsUrl: `${relay.url}/r/AdmissionReconnect`, role: "host" as const, key };
		const host = new CollabSocket(options);
		const nextHost = new CollabSocket(options);
		const guest = new CollabSocket({ ...options, role: "guest" });
		const opened = Promise.withResolvers<void>();
		const guestOpen = Promise.withResolvers<void>();
		const disconnected = Promise.withResolvers<void>();
		const recreated = Promise.withResolvers<void>();
		const received = Promise.withResolvers<void>();
		const prompts: string[] = [];
		host.onOpen = () => opened.resolve();
		guest.onOpen = () => guestOpen.resolve();
		guest.onClose = (_reason, reconnect) => {
			if (reconnect) disconnected.resolve();
		};
		nextHost.onOpen = () => recreated.resolve();
		nextHost.onFrame = frame => {
			if (frame.t === "prompt") prompts.push(frame.text);
			if (frame.t === "abort") received.resolve();
		};
		try {
			host.connect();
			await opened.promise;
			guest.connect();
			await guestOpen.promise;
			host.close();
			await disconnected.promise;
			expect(guest.isOpen).toBe(false);
			expect(guest.send({ t: "prompt", text: "during reconnect" })).toBe(true);
			expect(guest.send({ t: "abort" })).toBe(true);
			nextHost.connect();
			await recreated.promise;
			await received.promise;
			expect(prompts).toEqual(["during reconnect"]);
		} finally {
			guest.close();
			host.close();
			nextHost.close();
			relay.stop();
		}
	});
});
