/**
 * collab-web's entry point for the collab link and wire-envelope helpers. They
 * are implemented in `@oh-my-pi/pi-wire` and shared with the coding-agent host.
 *
 * Link format: `wss://<host[:port]>/r/<roomId>.<base64url-32-byte-key>`
 * Wire envelope: `[4B uint32 BE peerId][sealed payload]` — the guest always
 * sends peerId 0; the relay rewrites it to the sender's id.
 */

export type { ParsedCollabLink } from "@oh-my-pi/pi-wire";
export {
	COLLAB_PROTO,
	DEFAULT_RELAY_URL,
	decodeBase64Url,
	ENVELOPE_HEADER_LENGTH,
	encodeBase64Url,
	formatCollabLink,
	generateRoomId,
	packEnvelope,
	parseCollabLink,
	ROOM_ID_BYTES,
	rewriteEnvelopePeer,
	unpackEnvelope,
} from "@oh-my-pi/pi-wire";
