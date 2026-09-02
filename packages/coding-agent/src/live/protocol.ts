/** Frameless Bidi model used by Codex Desktop live calls. */
export const LIVE_MODEL = "gpt-live-1-codex" as const;

/** Maximum UTF-8 payload size accepted by each context append. */
export const CONTEXT_CHUNK_BYTES = 500;

/** Semantic stream selected for appended Frameless Bidi context. */
export type LiveContextChannel = "speakable" | "commentary";

/** Text content item accepted by Frameless Bidi context appends. */
export type LiveInputTextContent = { type: "input_text"; text: string };

/** Session object posted alongside the SDP when opening a live call. */
export type LiveSessionPayload = {
	model: typeof LIVE_MODEL;
	instructions: string;
	audio: { output: { voice: string } };
	delegation: { type: "client" };
};

/** Messages sent by the client over the Frameless Bidi data channel. */
export type LiveClientMessage =
	| {
			type: "delegation.context.append";
			delegation_item_id: string;
			channel?: LiveContextChannel;
			content: LiveInputTextContent[];
	  }
	| {
			type: "session.context.append";
			channel?: LiveContextChannel;
			content: LiveInputTextContent[];
	  }
	| { type: "session.close" };

/** Parsed Frameless Bidi server events, including unsupported wire event types. */
export type LiveServerEvent =
	| {
			type: "session.started" | "session.updated";
			session: { id: string; instructions?: string };
	  }
	| { type: "output_audio.delta"; audio: string }
	| { type: "input_transcript.added" | "output_transcript.added"; item: { text: string } }
	| { type: "turn.done"; turn: { role: "user" | "assistant"; transcript: string } }
	| {
			type: "delegation.created";
			item: {
				type: "delegation";
				target: "client";
				id: string;
				content: LiveInputTextContent[];
			};
	  }
	| { type: "error"; message: string }
	| { type: "unknown"; wireType: string };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayload(payload: unknown): UnknownRecord | null {
	let parsed = payload;
	if (typeof payload === "string") {
		try {
			parsed = JSON.parse(payload);
		} catch {
			return null;
		}
	}
	return isRecord(parsed) ? parsed : null;
}

function parseSessionEvent(
	type: "session.started" | "session.updated",
	payload: UnknownRecord,
): LiveServerEvent | null {
	const session = payload.session;
	if (!isRecord(session) || typeof session.id !== "string") return null;
	if (typeof session.instructions === "string") {
		return { type, session: { id: session.id, instructions: session.instructions } };
	}
	return { type, session: { id: session.id } };
}

function parseTranscriptAddedEvent(
	type: "input_transcript.added" | "output_transcript.added",
	payload: UnknownRecord,
): LiveServerEvent | null {
	const item = payload.item;
	if (!isRecord(item) || typeof item.text !== "string") return null;
	return { type, item: { text: item.text } };
}

function parseTurnDoneEvent(payload: UnknownRecord): LiveServerEvent | null {
	const turn = payload.turn;
	if (!isRecord(turn) || (turn.role !== "user" && turn.role !== "assistant")) return null;
	if (typeof turn.transcript !== "string") return null;
	return { type: "turn.done", turn: { role: turn.role, transcript: turn.transcript } };
}

function parseDelegationCreatedEvent(payload: UnknownRecord): LiveServerEvent | null {
	const item = payload.item;
	if (!isRecord(item) || item.type !== "delegation" || item.target !== "client" || typeof item.id !== "string") {
		return null;
	}
	if (!Array.isArray(item.content)) return null;
	const content: LiveInputTextContent[] = [];
	for (const candidate of item.content) {
		if (!isRecord(candidate) || candidate.type !== "input_text" || typeof candidate.text !== "string") continue;
		content.push({ type: "input_text", text: candidate.text });
	}
	return {
		type: "delegation.created",
		item: { type: "delegation", target: "client", id: item.id, content },
	};
}

function stringifyErrorValue(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value === undefined) return null;
	try {
		return JSON.stringify(value) ?? null;
	} catch {
		return String(value);
	}
}

function parseErrorEvent(payload: UnknownRecord): LiveServerEvent | null {
	if (typeof payload.message === "string") return { type: "error", message: payload.message };
	const error = payload.error;
	if (isRecord(error) && typeof error.message === "string") {
		return { type: "error", message: error.message };
	}
	const message = stringifyErrorValue(error);
	return message === null ? null : { type: "error", message };
}

/** Parse a JSON string or decoded value from the Frameless Bidi data channel. */
export function parseLiveServerEvent(payload: unknown): LiveServerEvent | null {
	const parsed = parsePayload(payload);
	if (!parsed || typeof parsed.type !== "string") return null;

	switch (parsed.type) {
		case "session.started":
		case "session.updated":
			return parseSessionEvent(parsed.type, parsed);
		case "output_audio.delta":
			return typeof parsed.audio === "string" ? { type: parsed.type, audio: parsed.audio } : null;
		case "input_transcript.added":
		case "output_transcript.added":
			return parseTranscriptAddedEvent(parsed.type, parsed);
		case "turn.done":
			return parseTurnDoneEvent(parsed);
		case "delegation.created":
			return parseDelegationCreatedEvent(parsed);
		case "error":
			return parseErrorEvent(parsed);
		default:
			return { type: "unknown", wireType: parsed.type };
	}
}

/** Build the session object posted in the multipart WebRTC call request. */
export function buildLiveSessionPayload(instructions: string, voice: string): LiveSessionPayload {
	return {
		model: LIVE_MODEL,
		instructions,
		audio: { output: { voice } },
		delegation: { type: "client" },
	};
}

/** Build a context append associated with a server-created delegation. */
export function buildDelegationContextAppend(
	delegationItemId: string,
	text: string,
	channel?: LiveContextChannel,
): LiveClientMessage {
	return {
		type: "delegation.context.append",
		delegation_item_id: delegationItemId,
		...(channel === undefined ? {} : { channel }),
		content: [{ type: "input_text", text }],
	};
}

/** Build context appended to the live session outside a delegation. */
export function buildSessionContextAppend(text: string, channel?: LiveContextChannel): LiveClientMessage {
	return {
		type: "session.context.append",
		...(channel === undefined ? {} : { channel }),
		content: [{ type: "input_text", text }],
	};
}

/** Build the message that gracefully closes a live session. */
export function buildSessionClose(): LiveClientMessage {
	return { type: "session.close" };
}

function utf8ByteLength(codePoint: number): number {
	if (codePoint <= 0x7f) return 1;
	if (codePoint <= 0x7ff) return 2;
	if (codePoint <= 0xffff) return 3;
	return 4;
}

/** Split context into character-safe chunks of at most 500 UTF-8 bytes. */
export function chunkLiveContext(text: string): string[] {
	if (text.length === 0) return [""];

	const chunks: string[] = [];
	let chunkStart = 0;
	let chunkBytes = 0;
	let index = 0;
	while (index < text.length) {
		const codePoint = text.codePointAt(index);
		if (codePoint === undefined) break;
		const characterLength = codePoint > 0xffff ? 2 : 1;
		const characterBytes = utf8ByteLength(codePoint);
		if (chunkBytes + characterBytes > CONTEXT_CHUNK_BYTES) {
			chunks.push(text.slice(chunkStart, index));
			chunkStart = index;
			chunkBytes = 0;
		}
		chunkBytes += characterBytes;
		index += characterLength;
	}
	chunks.push(text.slice(chunkStart));
	return chunks;
}
