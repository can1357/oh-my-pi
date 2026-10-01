/**
 * Protobuf decoding helpers for Devin's unary Connect RPCs. Kept separate from
 * `wire/devin.ts`: that module stays protobuf-free for the synchronous catalog
 * boot path, while this one is shared by discovery, chat, and usage callers
 * that already load the generated schemas.
 */

import { gunzipSync } from "node:zlib";
import { fromBinary, type MessageCodec, type ProtoMessage } from "../discovery/protobuf";

/**
 * Decode a unary Devin Connect response. Edges variously return bare protobuf
 * or a gzipped protobuf body; Bun's `fetch` normally decompresses first, so the
 * direct decode is attempted before the gzip fallback. Returns `null` when
 * neither representation decodes against `schema`.
 */
export function decodeDevinUnaryMessage<TMessage extends ProtoMessage>(
	schema: MessageCodec<TMessage>,
	payload: Uint8Array,
): TMessage | null {
	try {
		return fromBinary(schema, payload);
	} catch {
		try {
			return fromBinary(schema, gunzipSync(payload));
		} catch {
			return null;
		}
	}
}
