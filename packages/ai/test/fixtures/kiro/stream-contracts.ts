import { crc32 } from "@oh-my-pi/pi-ai/providers/aws-eventstream";

export interface SanitizedKiroStreamFrame {
	readonly eventType: string;
	readonly payload: Record<string, unknown>;
}

/**
 * Minimal fields observed in the retained Kiro runtime EventStream evidence.
 * Identifiers and visible text are synthetic and are not captured values.
 */
export const SANITIZED_KIRO_STREAM_FRAMES: readonly SanitizedKiroStreamFrame[] = [
	{
		eventType: "initial-response",
		payload: { requestId: "synthetic-request-id" },
	},
	{
		eventType: "metadataEvent",
		payload: { stopReason: "STOP" },
	},
	{
		eventType: "usageEvent",
		payload: { inputTokens: 3, outputTokens: 2 },
	},
	{
		eventType: "assistantResponseEvent",
		payload: { content: "synthetic visible output" },
	},
];

function encodeStringHeader(name: string, value: string): Uint8Array {
	const nameBytes = new TextEncoder().encode(name);
	const valueBytes = new TextEncoder().encode(value);
	const encoded = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
	const view = new DataView(encoded.buffer);
	let offset = 0;
	view.setUint8(offset, nameBytes.length);
	offset += 1;
	encoded.set(nameBytes, offset);
	offset += nameBytes.length;
	view.setUint8(offset, 7);
	offset += 1;
	view.setUint16(offset, valueBytes.length, false);
	offset += 2;
	encoded.set(valueBytes, offset);
	return encoded;
}

export function encodeSanitizedKiroEvent(frame: SanitizedKiroStreamFrame): Uint8Array {
	const headers = [encodeStringHeader(":message-type", "event"), encodeStringHeader(":event-type", frame.eventType)];
	const headerLength = headers.reduce((total, header) => total + header.length, 0);
	const headerBytes = new Uint8Array(headerLength);
	let headerOffset = 0;
	for (const header of headers) {
		headerBytes.set(header, headerOffset);
		headerOffset += header.length;
	}

	const payload = new TextEncoder().encode(JSON.stringify(frame.payload));
	const totalLength = 4 + 4 + 4 + headerLength + payload.length + 4;
	const encoded = new Uint8Array(totalLength);
	const view = new DataView(encoded.buffer);
	view.setUint32(0, totalLength, false);
	view.setUint32(4, headerLength, false);
	view.setUint32(8, crc32(encoded.subarray(0, 8)), false);
	encoded.set(headerBytes, 12);
	encoded.set(payload, 12 + headerLength);
	view.setUint32(totalLength - 4, crc32(encoded.subarray(0, totalLength - 4)), false);
	return encoded;
}

function splitFrame(frame: Uint8Array): readonly Uint8Array[] {
	const firstCut = Math.min(5, frame.length);
	const secondCut = Math.max(firstCut, frame.length - 3);
	return [frame.subarray(0, firstCut), frame.subarray(firstCut, secondCut), frame.subarray(secondCut)];
}

/** Feed frames through multiple chunks to exercise the production decoder boundary. */
export function createSanitizedKiroStream(): ReadableStream<Uint8Array> {
	const chunks = SANITIZED_KIRO_STREAM_FRAMES.flatMap(frame => splitFrame(encodeSanitizedKiroEvent(frame)));
	let index = 0;
	return new ReadableStream({
		pull(controller) {
			if (index < chunks.length) controller.enqueue(chunks[index++]);
			else controller.close();
		},
	});
}
