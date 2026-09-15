/**
 * Recovers the serving model id Anthropic embeds in thinking-block signatures.
 *
 * A signature is a base64 protobuf: outer `{1: version, 2: envelope}`, envelope
 * `{1: header, 2..5: nonce/ciphertext/tag}`, header
 * `{1: schema, 5: hash, 6: model, 8: "thinking", 11: org uuid, 15: profile, 21: unix ts}`.
 * Field 6 names the model that actually produced the block — a concrete
 * snapshot (`claude-haiku-4-5-20251001`) or an internal codename
 * (`numbat-v6-…`) — which lets a caller notice a gateway serving something other
 * than the requested model. The v4 outer format (`CAQS…`) ships a header
 * without field 6; the decoder then yields nothing.
 */

const OUTER_ENVELOPE_FIELD = 2;
const ENVELOPE_HEADER_FIELD = 1;
const HEADER_MODEL_FIELD = 6;
const MAX_MODEL_ID_LENGTH = 128;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/** Returns the first length-delimited field `field` in `message`, or undefined. */
function lengthDelimitedField(message: Uint8Array, field: number): Uint8Array | undefined {
	let offset = 0;
	while (offset < message.length) {
		let tag = 0;
		let shift = 0;
		let byte: number;
		do {
			if (offset >= message.length) return undefined;
			byte = message[offset++];
			tag |= (byte & 0x7f) << shift;
			shift += 7;
		} while (byte & 0x80);
		const fieldNumber = tag >>> 3;
		const wireType = tag & 7;
		switch (wireType) {
			case 0: {
				do {
					if (offset >= message.length) return undefined;
					byte = message[offset++];
				} while (byte & 0x80);
				break;
			}
			case 1:
				offset += 8;
				break;
			case 2: {
				let length = 0;
				shift = 0;
				do {
					if (offset >= message.length) return undefined;
					byte = message[offset++];
					length |= (byte & 0x7f) << shift;
					shift += 7;
				} while (byte & 0x80);
				if (offset + length > message.length) return undefined;
				if (fieldNumber === field) return message.subarray(offset, offset + length);
				offset += length;
				break;
			}
			case 5:
				offset += 4;
				break;
			default:
				return undefined;
		}
	}
	return undefined;
}

/**
 * Model id embedded in an Anthropic thinking signature, or undefined when the
 * signature is malformed, uses a format without a cleartext header, or names
 * nothing resembling a model id.
 */
export function servedModelFromAnthropicSignature(signature: string): string | undefined {
	if (signature.length < 8 || signature.length > 8192) return undefined;
	let raw: Uint8Array;
	try {
		raw = Buffer.from(signature, "base64");
	} catch {
		return undefined;
	}
	const envelope = lengthDelimitedField(raw, OUTER_ENVELOPE_FIELD);
	if (!envelope) return undefined;
	const header = lengthDelimitedField(envelope, ENVELOPE_HEADER_FIELD);
	if (!header) return undefined;
	const modelBytes = lengthDelimitedField(header, HEADER_MODEL_FIELD);
	if (!modelBytes || modelBytes.length === 0 || modelBytes.length > MAX_MODEL_ID_LENGTH) return undefined;
	const model = Buffer.from(modelBytes).toString("utf8");
	return MODEL_ID_PATTERN.test(model) ? model : undefined;
}

/**
 * Model id from an OpenRouter reasoning item — a `reasoning_details` entry on
 * chat completions or a Responses `reasoning` output item — which forwards the
 * upstream Anthropic signature as `{ format: "anthropic-claude-v1", signature }`.
 * Undefined for other formats.
 */
export function servedModelFromOpenRouterReasoning(item: unknown): string | undefined {
	if (!item || typeof item !== "object" || !("format" in item) || !("signature" in item)) return undefined;
	if (item.format !== "anthropic-claude-v1" || typeof item.signature !== "string") return undefined;
	return servedModelFromAnthropicSignature(item.signature);
}
