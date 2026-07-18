/**
 * Collab room coordination logic, extracted from the `CollabRoom` Durable
 * Object so it can be unit-tested against fake sockets/storage (same pattern
 * as `share-service` / `hub-service`).
 *
 * Reliability contract:
 * - A host disconnect does NOT close the room immediately. Guests get a
 *   `host-away` control message and the room stays open for `HOST_GRACE_MS`;
 *   if the host reconnects in time guests get `host-back`, otherwise the
 *   alarm broadcasts `room-closed` and closes every guest (4001) as before.
 * - A new host connection replaces a lingering half-open host socket (closed
 *   with 4010) instead of being rejected, so a host that lost its network can
 *   always re-claim its room. Host attachments carry an epoch so the stale
 *   socket's close event cannot be mistaken for the live host going away.
 * - Guests that leave while the host is away are recorded and replayed as
 *   `peer-left` control messages when the host returns.
 */

export type RelayRole = "host" | "guest";

export interface SocketAttachment {
	role: RelayRole;
	peerId: number;
	/** Host connection generation; a close event from an older epoch is a replaced socket, not the live host. */
	epoch?: number;
}

export interface RoomSocket {
	attachment(): SocketAttachment | null;
	setAttachment(attachment: SocketAttachment): void;
	send(data: Uint8Array | string): void;
	close(code: number, reason: string): void;
}

export interface RoomStorage {
	get<T = unknown>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
	delete(keys: string[]): Promise<unknown>;
	setAlarm(scheduledTime: number): Promise<void>;
	deleteAlarm(): Promise<void>;
}

export interface RoomDeps {
	/** Currently connected sockets (closed sockets excluded). */
	sockets(): RoomSocket[];
	storage: RoomStorage;
	now(): number;
}

export const ENVELOPE_HEADER_LENGTH = 4;
/** How long a room survives without its host before guests are closed. */
export const HOST_GRACE_MS = 45_000;
const MAX_PEER_ID = 0xfffffffe;

export const CLOSE_ROOM_CLOSED = 4001;
export const CLOSE_NO_ROOM = 4004;
export const CLOSE_HOST_REPLACED = 4010;
export const CLOSE_ROOM_FULL = 4029;

const KEY_NEXT_PEER_ID = "nextPeerId";
const KEY_HOST_AWAY = "hostAway";
const KEY_HOST_EPOCH = "hostEpoch";
const KEY_PENDING_PEER_LEFTS = "pendingPeerLefts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAttachment(value: unknown): SocketAttachment | null {
	if (!isRecord(value)) return null;
	if ((value.role !== "host" && value.role !== "guest") || typeof value.peerId !== "number") return null;
	return {
		role: value.role,
		peerId: value.peerId,
		epoch: typeof value.epoch === "number" ? value.epoch : undefined,
	};
}

function readPeerId(bytes: Uint8Array): number | null {
	if (bytes.byteLength < ENVELOPE_HEADER_LENGTH) return null;
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
}

function rewritePeerId(bytes: Uint8Array, peerId: number): void {
	new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(0, peerId, false);
}

function hostOf(sockets: RoomSocket[]): RoomSocket | undefined {
	return sockets.find(socket => socket.attachment()?.role === "host");
}

function guestsOf(sockets: RoomSocket[]): RoomSocket[] {
	return sockets.filter(socket => socket.attachment()?.role === "guest");
}

/** Handle a freshly accepted socket. May close it (no room / room full). */
export async function roomConnect(deps: RoomDeps, socket: RoomSocket, role: RelayRole): Promise<void> {
	const host = hostOf(deps.sockets());
	if (role === "host") {
		// Last-writer-wins: after a network drop the previous host socket can
		// linger half-open and would otherwise lock the room out (4009 forever).
		if (host) host.close(CLOSE_HOST_REPLACED, "replaced by a newer host connection");
		const epoch = ((await deps.storage.get<number>(KEY_HOST_EPOCH)) ?? 0) + 1;
		await deps.storage.put(KEY_HOST_EPOCH, epoch);
		socket.setAttachment({ role: "host", peerId: 0, epoch });
		if ((await deps.storage.get<number>(KEY_HOST_AWAY)) === undefined) return;
		await deps.storage.delete([KEY_HOST_AWAY]);
		await deps.storage.deleteAlarm();
		const pending = (await deps.storage.get<number[]>(KEY_PENDING_PEER_LEFTS)) ?? [];
		if (pending.length > 0) await deps.storage.delete([KEY_PENDING_PEER_LEFTS]);
		const back = JSON.stringify({ t: "host-back" });
		for (const guest of guestsOf(deps.sockets())) guest.send(back);
		for (const peer of pending) socket.send(JSON.stringify({ t: "peer-left", peer }));
		return;
	}
	if (!host) {
		socket.close(CLOSE_NO_ROOM, "no such room");
		return;
	}
	const peerId = (await deps.storage.get<number>(KEY_NEXT_PEER_ID)) ?? 1;
	if (peerId > MAX_PEER_ID) {
		socket.close(CLOSE_ROOM_FULL, "room is full");
		return;
	}
	await deps.storage.put(KEY_NEXT_PEER_ID, peerId + 1);
	socket.setAttachment({ role: "guest", peerId });
	host.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
}

/** Route a sealed envelope. Guest frames go to the host (peerId stamped); host frames fan out to target guests. */
export function roomMessage(deps: RoomDeps, sender: SocketAttachment, bytes: Uint8Array): void {
	if (bytes.byteLength < ENVELOPE_HEADER_LENGTH) return;
	const sockets = deps.sockets();
	const host = hostOf(sockets);
	if (!host) return;
	if (sender.role === "guest") {
		rewritePeerId(bytes, sender.peerId);
		host.send(bytes);
		return;
	}
	// A frame queued on a replaced host socket must not fan out as the live host's.
	if ((sender.epoch ?? 0) !== (host.attachment()?.epoch ?? 0)) return;
	const targetPeer = readPeerId(bytes);
	if (targetPeer === null) return;
	for (const socket of sockets) {
		const attachment = socket.attachment();
		if (attachment?.role !== "guest") continue;
		if (targetPeer === 0 || targetPeer === attachment.peerId) socket.send(bytes);
	}
}

/** Handle a socket close. The closing socket is already gone from `deps.sockets()`. */
export async function roomClose(deps: RoomDeps, attachment: SocketAttachment): Promise<void> {
	const sockets = deps.sockets();
	if (attachment.role === "guest") {
		const host = hostOf(sockets);
		if (host) {
			host.send(JSON.stringify({ t: "peer-left", peer: attachment.peerId }));
			return;
		}
		if ((await deps.storage.get<number>(KEY_HOST_AWAY)) === undefined) return;
		const pending = (await deps.storage.get<number[]>(KEY_PENDING_PEER_LEFTS)) ?? [];
		pending.push(attachment.peerId);
		await deps.storage.put(KEY_PENDING_PEER_LEFTS, pending);
		return;
	}
	const epoch = (await deps.storage.get<number>(KEY_HOST_EPOCH)) ?? 0;
	if ((attachment.epoch ?? 0) !== epoch) return;
	const guests = guestsOf(sockets);
	if (guests.length === 0) return;
	const now = deps.now();
	await deps.storage.put(KEY_HOST_AWAY, now);
	await deps.storage.setAlarm(now + HOST_GRACE_MS);
	const away = JSON.stringify({ t: "host-away", graceMs: HOST_GRACE_MS });
	for (const guest of guests) guest.send(away);
}

/** Grace window expired: close the room unless the host made it back. */
export async function roomAlarm(deps: RoomDeps): Promise<void> {
	const sockets = deps.sockets();
	if (hostOf(sockets)) {
		await deps.storage.delete([KEY_HOST_AWAY, KEY_PENDING_PEER_LEFTS]);
		return;
	}
	const away = await deps.storage.get<number>(KEY_HOST_AWAY);
	if (away !== undefined && away + HOST_GRACE_MS > deps.now()) {
		// A stale alarm (at-least-once delivery racing a newer grace window)
		// must not cut the current window short: re-arm to its real deadline.
		await deps.storage.setAlarm(away + HOST_GRACE_MS);
		return;
	}
	await deps.storage.delete([KEY_HOST_AWAY, KEY_PENDING_PEER_LEFTS]);
	for (const guest of guestsOf(sockets)) {
		guest.send(JSON.stringify({ t: "room-closed" }));
		guest.close(CLOSE_ROOM_CLOSED, "room closed");
	}
}
