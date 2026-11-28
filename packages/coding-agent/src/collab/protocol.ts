/**
 * Collab live-session wire protocol.
 *
 * Hub topology: the host is authoritative, guests never peer. All session
 * payloads (`CollabFrame`) travel AES-256-GCM sealed; the relay only sees the
 * plaintext envelope (`[4B uint32 BE peerId][sealed payload]`) plus TEXT JSON
 * control messages that carry no session data.
 */

import type { ImageContent } from "@oh-my-pi/pi-ai";
import type {
	BusChannel,
	CollabUiRequest,
	GuestFrame,
	Participant,
	AgentSnapshot as WireAgentSnapshot,
} from "@oh-my-pi/pi-wire";
import {
	DEFAULT_RELAY_URL,
	ENVELOPE_HEADER_LENGTH,
	formatCollabLink,
	isLocalRelayHostname,
	normalizeRelayOrigin,
	ROOM_ID_BYTES,
} from "@oh-my-pi/pi-wire";
import type { CollabSessionState } from "../modes/view-model/status-line/types";
import type { AgentSessionEvent } from "../session/agent-session";
import type { SessionEntry, SessionHeader } from "../session/session-entries";

export type {
	CollabPromptDetails,
	CollabUiRequest,
	CollabUiRequestDraft,
	CollabUiResponseValue,
	CollabUiSelectItem,
	ParsedCollabLink,
	RelayControlMessage,
	RelayControlToGuest,
	RelayControlToHost,
} from "@oh-my-pi/pi-wire";
export {
	COLLAB_PROMPT_MESSAGE_TYPE,
	COLLAB_PROTO,
	formatCollabLink,
	generateRoomId,
	packEnvelope,
	parseCollabLink,
	rewriteEnvelopePeer,
	unpackEnvelope,
} from "@oh-my-pi/pi-wire";
export { DEFAULT_RELAY_URL, ENVELOPE_HEADER_LENGTH, ROOM_ID_BYTES };

export type CollabParticipant = Participant;
export type AgentSnapshot = WireAgentSnapshot;

export type { CollabSessionState };

/**
 * Encrypted payload frames (inside AES-GCM, JSON). The wire package pins the
 * JSON skeleton (`WireFrame`); host-side frames carry the rich session types
 * that serialize into those shapes.
 */
export type CollabFrame =
	// guest -> host (every guest frame but prompt is taken verbatim from the wire grammar)
	| Exclude<GuestFrame, { t: "prompt" }>
	| { t: "prompt"; text: string; images?: ImageContent[]; followUp?: true }
	// host -> guest
	| {
			t: "welcome";
			proto: number;
			header: SessionHeader;
			state: CollabSessionState;
			agents: AgentSnapshot[];
			/**
			 * Total number of `SessionEntry` items the host will deliver in the
			 * `snapshot-chunk` frames that follow. The guest stays in the
			 * snapshot-loading phase until it has accumulated that many entries
			 * (or a chunk arrives with `final: true`).
			 */
			entryCount: number;
			/** True when this peer joined through a read-only (view) link. */
			readOnly?: boolean;
	  }
	/**
	 * Targeted snapshot fragment delivered after `welcome`. Splits a large
	 * transcript across many small frames so the guest's per-chunk progress
	 * timeout resets each time the relay delivers another batch; without
	 * chunking, a multi-MB session has to fit one giant frame inside the
	 * 30 s first-welcome budget. The last chunk carries `final: true` so the
	 * guest can finalize the replica session.
	 */
	| { t: "snapshot-chunk"; entries: SessionEntry[]; final: boolean }
	| { t: "entry"; entry: SessionEntry }
	| { t: "event"; event: AgentSessionEvent }
	| { t: "state"; state: CollabSessionState }
	/** Mirrored EventBus traffic (task subagent lifecycle/progress channels only). */
	| { t: "bus"; channel: BusChannel; data: unknown }
	/** Full agent-registry snapshot (debounced on registry change). */
	| { t: "agents"; agents: AgentSnapshot[] }
	| { t: "ui-request"; request: CollabUiRequest }
	| { t: "ui-request-end"; reqId: number }
	/** Targeted reply to fetch-transcript; `error` marks a terminal read failure that guests must surface without hot retrying. */
	| { t: "transcript"; reqId: number; text: string; newSize: number; error?: string }
	| { t: "bye"; reason: string }
	/** `resync`: the host no longer counts this guest as joined; the guest should send `hello` again. */
	| { t: "error"; message: string; resync?: true };

/**
 * Max bytes of one `transcript` reply; the guest asks again from `newSize`. A reply short of the file's end
 * stops after its last line break, so a transcript line of this many bytes or more is never served.
 */
export const TRANSCRIPT_READ_CAP = 4 * 1024 * 1024;

// ═══════════════════════════════════════════════════════════════════════════
// Pre-serialized frames: the host bounds replicated payloads by serializing
// them, so the frames that carry them are assembled from that JSON instead of
// stringifying the payload a second time.
// ═══════════════════════════════════════════════════════════════════════════

declare const encodedFrameBrand: unique symbol;

/** A `CollabFrame`'s JSON form, produced only by the encoders below. */
export type EncodedFrame = string & { readonly [encodedFrameBrand]: true };

/**
 * Field table for a `CollabFrame` variant: its tag under `t`, every other
 * field mapped to its own name. Annotating an encoder's table with this makes
 * renaming, adding, or removing a field of that variant a type error here.
 */
type FrameFields<T extends CollabFrame["t"]> = {
	readonly [K in keyof Extract<CollabFrame, { t: T }>]-?: K extends "t" ? T : K;
};

const ENTRY_FIELDS: FrameFields<"entry"> = { t: "entry", entry: "entry" };
const EVENT_FIELDS: FrameFields<"event"> = { t: "event", event: "event" };
const SNAPSHOT_CHUNK_FIELDS: FrameFields<"snapshot-chunk"> = {
	t: "snapshot-chunk",
	entries: "entries",
	final: "final",
};

const ENTRY_FRAME_HEAD = `{"t":"${ENTRY_FIELDS.t}","${ENTRY_FIELDS.entry}":`;
const EVENT_FRAME_HEAD = `{"t":"${EVENT_FIELDS.t}","${EVENT_FIELDS.event}":`;
const SNAPSHOT_CHUNK_HEAD = `{"t":"${SNAPSHOT_CHUNK_FIELDS.t}","${SNAPSHOT_CHUNK_FIELDS.entries}":[`;
const SNAPSHOT_CHUNK_FINAL = `],"${SNAPSHOT_CHUNK_FIELDS.final}":`;

/** The single construction point of {@link EncodedFrame}. */
function encodedFrame(json: string): EncodedFrame {
	return json as EncodedFrame;
}

export function encodeFrame(frame: CollabFrame): EncodedFrame {
	return encodedFrame(JSON.stringify(frame));
}

/** `{ t: "entry", entry }` from the entry's JSON. */
export function encodeEntryFrame(entryJson: string): EncodedFrame {
	return encodedFrame(`${ENTRY_FRAME_HEAD}${entryJson}}`);
}

/** `{ t: "event", event }` from the event's JSON. */
export function encodeEventFrame(eventJson: string): EncodedFrame {
	return encodedFrame(`${EVENT_FRAME_HEAD}${eventJson}}`);
}

/** `{ t: "snapshot-chunk", entries, final }` from each entry's JSON. */
export function encodeSnapshotChunk(entryJsons: readonly string[], final: boolean): EncodedFrame {
	return encodedFrame(`${SNAPSHOT_CHUNK_HEAD}${entryJsons.join(",")}${SNAPSHOT_CHUNK_FINAL}${final}}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Link format: wss://<host[:port]>/r/<roomId>.<base64url-32-byte-key>
// ═══════════════════════════════════════════════════════════════════════════

function normalizeCollabWebBaseUrl(relayUrl: string, webUrl?: string): string {
	const explicitWebUrl = webUrl?.trim();
	if (!explicitWebUrl) {
		const normalized = normalizeRelayOrigin(relayUrl);
		if ("error" in normalized) throw new Error(normalized.error);
		return normalized.origin.startsWith("wss://")
			? `https://${normalized.origin.slice("wss://".length)}`
			: `http://${normalized.origin.slice("ws://".length)}`;
	}

	let url: URL;
	try {
		url = new URL(explicitWebUrl);
	} catch {
		throw new Error("collab.webUrl must start with http:// or https://");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("collab.webUrl must start with http:// or https://");
	}
	if (url.protocol === "http:" && !isLocalRelayHostname(url.hostname)) {
		throw new Error("collab.webUrl must use https:// unless it targets localhost");
	}
	if (url.search || url.hash) {
		throw new Error("collab.webUrl must not include a query string or fragment");
	}
	const path = url.pathname.replace(/\/+$/, "");
	return `${url.origin}${path}`;
}

/**
 * Render the browser deep link. The browser UI may be hosted separately from
 * the relay; the fragment always carries the relay-specific collab link, so
 * room secrets stay out of HTTP path and query bytes.
 */
export function formatCollabWebLink(
	relayUrl: string,
	roomId: string,
	key: Uint8Array,
	writeToken?: Uint8Array,
	webUrl?: string,
): string {
	return `${normalizeCollabWebBaseUrl(relayUrl, webUrl)}/#${formatCollabLink(relayUrl, roomId, key, writeToken)}`;
}
