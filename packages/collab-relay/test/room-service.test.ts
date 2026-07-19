import { describe, expect, test } from "bun:test";
import {
	CLOSE_HOST_REPLACED,
	CLOSE_NO_ROOM,
	CLOSE_ROOM_CLOSED,
	HOST_GRACE_MS,
	parseAttachment,
	type RoomDeps,
	type RoomSocket,
	type RoomStorage,
	roomAlarm,
	roomClose,
	roomConnect,
	roomMessage,
	type SocketAttachment,
} from "../src/room-service";

class FakeSocket implements RoomSocket {
	sent: (string | Uint8Array)[] = [];
	closed: { code: number; reason: string } | null = null;
	#attachment: SocketAttachment | null = null;

	attachment(): SocketAttachment | null {
		return this.#attachment;
	}
	setAttachment(attachment: SocketAttachment): void {
		this.#attachment = attachment;
	}
	send(data: Uint8Array | string): void {
		this.sent.push(data);
	}
	close(code: number, reason: string): void {
		this.closed = { code, reason };
	}

	controls(): { t: string; peer?: number; graceMs?: number }[] {
		return this.sent
			.filter((data): data is string => typeof data === "string")
			.map(data => JSON.parse(data) as { t: string; peer?: number; graceMs?: number });
	}
}

class FakeRoom {
	sockets: FakeSocket[] = [];
	now = 1_000_000;
	alarmAt: number | null = null;
	#map = new Map<string, unknown>();

	deps(): RoomDeps {
		const storage: RoomStorage = {
			get: <T>(key: string) => Promise.resolve(this.#map.get(key) as T | undefined),
			put: (key, value) => {
				this.#map.set(key, value);
				return Promise.resolve();
			},
			delete: (keys: string[]) => {
				for (const key of keys) this.#map.delete(key);
				return Promise.resolve(keys.length);
			},
			setAlarm: scheduledTime => {
				this.alarmAt = scheduledTime;
				return Promise.resolve();
			},
			deleteAlarm: () => {
				this.alarmAt = null;
				return Promise.resolve();
			},
		};
		// Mirrors the DO runtime: closed sockets drop out of getWebSockets().
		return { sockets: () => this.sockets.filter(socket => !socket.closed), storage, now: () => this.now };
	}

	async connect(role: "host" | "guest"): Promise<FakeSocket> {
		const socket = new FakeSocket();
		this.sockets.push(socket);
		await roomConnect(this.deps(), socket, role);
		return socket;
	}

	async disconnect(socket: FakeSocket): Promise<void> {
		const attachment = socket.attachment();
		this.sockets = this.sockets.filter(candidate => candidate !== socket);
		if (attachment) await roomClose(this.deps(), attachment);
	}
}

function envelope(peerId: number, payload: number[]): Uint8Array {
	const bytes = new Uint8Array(4 + payload.length);
	new DataView(bytes.buffer).setUint32(0, peerId, false);
	bytes.set(payload, 4);
	return bytes;
}

describe("roomConnect", () => {
	test("guest without a host is closed with 4004", async () => {
		const room = new FakeRoom();
		const guest = await room.connect("guest");
		expect(guest.closed).toEqual({ code: CLOSE_NO_ROOM, reason: "no such room" });
	});

	test("guest join assigns a peer id and notifies the host", async () => {
		const room = new FakeRoom();
		const host = await room.connect("host");
		const guest = await room.connect("guest");
		expect(guest.closed).toBeNull();
		expect(guest.attachment()).toEqual({ role: "guest", peerId: 1, epoch: undefined });
		expect(host.controls()).toEqual([{ t: "peer-joined", peer: 1 }]);
	});

	test("a newer host connection replaces a lingering host socket", async () => {
		const room = new FakeRoom();
		const stale = await room.connect("host");
		const guest = await room.connect("guest");
		const fresh = await room.connect("host");
		expect(stale.closed).toEqual({ code: CLOSE_HOST_REPLACED, reason: "replaced by a newer host connection" });
		expect(fresh.closed).toBeNull();
		expect((fresh.attachment()?.epoch ?? 0) > (stale.attachment()?.epoch ?? 0)).toBe(true);
		// Guest frames now route to the fresh host.
		roomMessage(room.deps(), guest.attachment()!, envelope(0, [7]));
		expect(fresh.sent).toHaveLength(1);
	});
});

describe("host grace window", () => {
	test("host drop notifies guests and arms the alarm instead of closing them", async () => {
		const room = new FakeRoom();
		const host = await room.connect("host");
		const guest = await room.connect("guest");
		await room.disconnect(host);
		expect(guest.closed).toBeNull();
		expect(guest.controls()).toEqual([{ t: "host-away", graceMs: HOST_GRACE_MS }]);
		expect(room.alarmAt).toBe(room.now + HOST_GRACE_MS);
	});

	test("host drop with no guests arms nothing", async () => {
		const room = new FakeRoom();
		const host = await room.connect("host");
		await room.disconnect(host);
		expect(room.alarmAt).toBeNull();
	});

	test("host reconnect within the window sends host-back and disarms the alarm", async () => {
		const room = new FakeRoom();
		const host = await room.connect("host");
		const guest = await room.connect("guest");
		await room.disconnect(host);
		const returned = await room.connect("host");
		expect(room.alarmAt).toBeNull();
		expect(guest.controls()).toEqual([{ t: "host-away", graceMs: HOST_GRACE_MS }, { t: "host-back" }]);
		expect(returned.controls()).toEqual([]);
		// The room keeps working after the reconnect.
		roomMessage(room.deps(), guest.attachment()!, envelope(0, [1]));
		expect(returned.sent).toHaveLength(1);
	});

	test("guests leaving while the host is away are replayed as peer-left on reconnect", async () => {
		const room = new FakeRoom();
		const host = await room.connect("host");
		const staying = await room.connect("guest");
		const leaving = await room.connect("guest");
		await room.disconnect(host);
		await room.disconnect(leaving);
		const returned = await room.connect("host");
		expect(returned.controls()).toEqual([{ t: "peer-left", peer: leaving.attachment()?.peerId }]);
		expect(staying.closed).toBeNull();
	});

	test("expired alarm closes every guest with room-closed", async () => {
		const room = new FakeRoom();
		const host = await room.connect("host");
		const guest = await room.connect("guest");
		await room.disconnect(host);
		room.now += HOST_GRACE_MS;
		await roomAlarm(room.deps());
		expect(guest.controls()).toEqual([{ t: "host-away", graceMs: HOST_GRACE_MS }, { t: "room-closed" }]);
		expect(guest.closed).toEqual({ code: CLOSE_ROOM_CLOSED, reason: "room closed" });
	});

	test("a stale alarm before the deadline re-arms instead of closing", async () => {
		const room = new FakeRoom();
		const host = await room.connect("host");
		const guest = await room.connect("guest");
		await room.disconnect(host);
		const deadline = room.now + HOST_GRACE_MS;
		room.now += 1_000;
		room.alarmAt = 0;
		await roomAlarm(room.deps());
		expect(guest.closed).toBeNull();
		expect(room.alarmAt).toBe(deadline);
	});

	test("alarm racing a returned host closes nothing", async () => {
		const room = new FakeRoom();
		const host = await room.connect("host");
		const guest = await room.connect("guest");
		await room.disconnect(host);
		await room.connect("host");
		await roomAlarm(room.deps());
		expect(guest.closed).toBeNull();
	});

	test("frames from a replaced host socket are not fanned out to guests", async () => {
		const room = new FakeRoom();
		const stale = await room.connect("host");
		const guest = await room.connect("guest");
		await room.connect("host");
		roomMessage(room.deps(), stale.attachment()!, envelope(0, [3]));
		expect(guest.sent.filter(data => typeof data !== "string")).toHaveLength(0);
	});

	test("a replaced host socket's close does not start the grace window", async () => {
		const room = new FakeRoom();
		const stale = await room.connect("host");
		const guest = await room.connect("guest");
		await room.connect("host");
		// The replaced socket's close event arrives late; its epoch is outdated.
		await roomClose(room.deps(), stale.attachment()!);
		expect(room.alarmAt).toBeNull();
		expect(guest.controls()).toEqual([]);
	});
});

describe("roomMessage", () => {
	test("guest envelopes are stamped with the sender peer id", async () => {
		const room = new FakeRoom();
		const host = await room.connect("host");
		const guest = await room.connect("guest");
		roomMessage(room.deps(), guest.attachment()!, envelope(0, [9]));
		const [received] = host.sent.filter((data): data is Uint8Array => typeof data !== "string");
		expect(new DataView(received!.buffer).getUint32(0, false)).toBe(guest.attachment()!.peerId);
	});

	test("host broadcast (peer 0) reaches all guests, targeted frames only one", async () => {
		const room = new FakeRoom();
		const host = await room.connect("host");
		const first = await room.connect("guest");
		const second = await room.connect("guest");
		roomMessage(room.deps(), host.attachment()!, envelope(0, [1]));
		roomMessage(room.deps(), host.attachment()!, envelope(second.attachment()!.peerId, [2]));
		expect(first.sent).toHaveLength(1);
		expect(second.sent).toHaveLength(2);
	});
});

describe("parseAttachment", () => {
	test("accepts pre-epoch attachments from hibernating sockets", () => {
		expect(parseAttachment({ role: "host", peerId: 0 })).toEqual({ role: "host", peerId: 0, epoch: undefined });
	});

	test("rejects malformed values", () => {
		expect(parseAttachment(null)).toBeNull();
		expect(parseAttachment({ role: "spectator", peerId: 1 })).toBeNull();
		expect(parseAttachment({ role: "guest" })).toBeNull();
	});
});
