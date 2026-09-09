import type { ImageContent } from "@oh-my-pi/pi-ai";

const OSC5522_PREFIX = "\x1b]5522;";
const OSC_TERMINATOR_ST = "\x1b\\";
const OSC_TERMINATOR_BEL = "\x07";
const PASTE_EVENT_NAME_BASE64 = Buffer.from("Paste event", "utf8").toString("base64");

const IMAGE_MIME_PRIORITY = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
const TEXT_MIME_TYPE = "text/plain";
/** Kitty's "give me the list of available MIME types" sentinel — see `TARGETS_MIME` in `kitty/clipboard.py`. */
const MIME_LISTING_TARGET = ".";

type PasteReadKind = "image" | "text";

export interface Osc5522Packet {
	metadata: Map<string, string>;
	payload: string;
}

interface PasteListingState {
	phase: "listing";
	mimes: string[];
	kittyDotPayload?: true;
	pw?: string;
	loc?: string;
}

interface PasteReadState {
	phase: "reading";
	kind: PasteReadKind;
	mimeType: string;
	chunks: string[];
}

type PasteState = PasteListingState | PasteReadState;

export interface EnhancedPasteHandlers {
	write(data: string): void;
	pasteText(text: string): void;
	pasteImage(image: ImageContent): void | Promise<void>;
	showStatus(message: string): void;
}

export function isOsc5522Packet(data: string): boolean {
	return data.startsWith(OSC5522_PREFIX) && (data.endsWith(OSC_TERMINATOR_ST) || data.endsWith(OSC_TERMINATOR_BEL));
}

function decodeBase64Utf8(value: string): string | undefined {
	try {
		return Buffer.from(value, "base64").toString("utf8");
	} catch {
		return undefined;
	}
}

function parseMetadata(raw: string): Map<string, string> {
	const metadata = new Map<string, string>();
	for (const part of raw.split(":")) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		metadata.set(part.slice(0, eq), part.slice(eq + 1));
	}
	return metadata;
}

export function parseOsc5522Packet(data: string): Osc5522Packet | undefined {
	if (!isOsc5522Packet(data)) return undefined;
	const bodyEnd = data.endsWith(OSC_TERMINATOR_BEL) ? data.length - 1 : data.length - OSC_TERMINATOR_ST.length;
	const body = data.slice(OSC5522_PREFIX.length, bodyEnd);
	const separator = body.indexOf(";");
	const metadataRaw = separator === -1 ? body : body.slice(0, separator);
	const payload = separator === -1 ? "" : body.slice(separator + 1);
	return { metadata: parseMetadata(metadataRaw), payload };
}

function choosePasteMime(mimes: readonly string[]): { kind: PasteReadKind; mimeType: string } | undefined {
	for (const mimeType of IMAGE_MIME_PRIORITY) {
		if (mimes.includes(mimeType)) return { kind: "image", mimeType };
	}
	return mimes.includes(TEXT_MIME_TYPE) ? { kind: "text", mimeType: TEXT_MIME_TYPE } : undefined;
}

export class EnhancedPasteController {
	#state: PasteState | undefined;
	#handlers: EnhancedPasteHandlers;

	constructor(handlers: EnhancedPasteHandlers) {
		this.#handlers = handlers;
	}

	enable(): void {
		this.#handlers.write("\x1b[?5522h");
	}

	disable(): void {
		this.#handlers.write("\x1b[?5522l");
		this.#state = undefined;
	}

	handleInput(data: string): boolean {
		const packet = parseOsc5522Packet(data);
		if (!packet) return false;
		void this.#handlePacket(packet);
		return true;
	}

	async #handlePacket(packet: Osc5522Packet): Promise<void> {
		const type = packet.metadata.get("type");
		if (type !== "read") return;

		const status = packet.metadata.get("status");
		if (status === "OK") {
			this.#handleOk(packet);
			return;
		}
		if (status === "DATA") {
			this.#handleData(packet);
			return;
		}
		if (status === "DONE") {
			await this.#handleDone();
			return;
		}
		if (status) {
			this.#state = undefined;
			this.#handlers.showStatus(`Enhanced paste failed: ${status}`);
		}
	}

	#handleOk(packet: Osc5522Packet): void {
		if (this.#state?.phase === "reading") return;
		const loc = packet.metadata.get("loc");
		this.#state = {
			phase: "listing",
			mimes: [],
			pw: packet.metadata.get("pw"),
			loc: loc === "primary" ? loc : undefined,
		};
	}

	#handleData(packet: Osc5522Packet): void {
		const state = this.#state;
		if (!state) return;
		const encodedMime = packet.metadata.get("mime");
		if (!encodedMime) return;
		const mimeType = decodeBase64Utf8(encodedMime);
		if (!mimeType) return;

		if (state.phase === "listing") {
			// Kitty (as of writing) implements the "list available MIME types"
			// response shape by sending a single DATA packet with `mime="."` and
			// the available types packed into the payload as a whitespace-
			// separated list (see `fulfill_read_request` in
			// kovidgoyal/kitty:kitty/clipboard.py). The 5522-mode ancillary
			// spec instead encodes each type as its own DATA packet with an
			// empty payload. Support both — fall through to the per-packet
			// form when the dot sentinel has no payload, or when the packet
			// already names a concrete MIME type.
			if (mimeType === MIME_LISTING_TARGET) {
				if (!packet.payload) return;
				const listing = decodeBase64Utf8(packet.payload);
				if (!listing) return;
				state.kittyDotPayload = true;
				for (const candidate of listing.split(/\s+/)) {
					if (candidate && candidate !== MIME_LISTING_TARGET) state.mimes.push(candidate);
				}
				return;
			}
			state.mimes.push(mimeType);
			return;
		}

		if (state.mimeType === mimeType && packet.payload) {
			state.chunks.push(packet.payload);
		}
	}

	async #handleDone(): Promise<void> {
		const state = this.#state;
		if (!state) return;
		if (state.phase === "listing") {
			this.#finishListing(state);
			return;
		}
		this.#state = undefined;
		const bytes = Buffer.concat(state.chunks.map(chunk => Buffer.from(chunk, "base64")));
		if (bytes.byteLength === 0) {
			this.#handlers.showStatus("Clipboard paste was empty");
			return;
		}
		if (state.kind === "text") {
			this.#handlers.pasteText(bytes.toString("utf8"));
			return;
		}
		await this.#handlers.pasteImage({
			type: "image",
			data: bytes.toString("base64"),
			mimeType: state.mimeType,
		});
	}

	#finishListing(state: PasteListingState): void {
		const selected = choosePasteMime(state.mimes);
		if (!selected) {
			this.#state = undefined;
			this.#handlers.showStatus("Clipboard paste has no supported text or image data");
			return;
		}

		this.#state = {
			phase: "reading",
			kind: selected.kind,
			mimeType: selected.mimeType,
			chunks: [],
		};

		const encodedMime = Buffer.from(selected.mimeType, "utf8").toString("base64");
		const metadata = ["type=read"];
		if (state.loc) metadata.push(`loc=${state.loc}`);
		if (state.pw) {
			metadata.push(`pw=${state.pw}`, `name=${PASTE_EVENT_NAME_BASE64}`);
		}
		if (state.kittyDotPayload) {
			this.#handlers.write(`${OSC5522_PREFIX}${metadata.join(":")};${encodedMime}${OSC_TERMINATOR_BEL}`);
			return;
		}
		metadata.push(`mime=${encodedMime}`);
		this.#handlers.write(`${OSC5522_PREFIX}${metadata.join(":")}${OSC_TERMINATOR_BEL}`);
	}
}
