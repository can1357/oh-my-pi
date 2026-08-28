import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { RpcChunkFrame } from "./rpc-types";

/** Maximum UTF-8 size of one newline-delimited RPC frame, including the newline. */
export const MAX_RPC_FRAME_BYTES = 1024 * 1024;
/** Maximum UTF-8 size of one logical frame reassembled by protocol v2. */
export const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;

const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;

export type RpcProtocolVersion = 1 | 2;

interface PendingRpcChunks {
	chunkId: string;
	count: number;
	byteLength: number;
	nextIndex: number;
	chunks: Buffer[];
	receivedBytes: number;
}

interface ShrinkPass {
	stringCap: number;
	arrayLimit: number;
	objectLimit: number;
}

const SHRINK_PASSES: readonly ShrinkPass[] = [
	{ stringCap: 256 * 1024, arrayLimit: 512, objectLimit: 512 },
	{ stringCap: 64 * 1024, arrayLimit: 256, objectLimit: 256 },
	{ stringCap: 16 * 1024, arrayLimit: 128, objectLimit: 128 },
	{ stringCap: 4 * 1024, arrayLimit: 64, objectLimit: 64 },
	{ stringCap: 1024, arrayLimit: 32, objectLimit: 32 },
	{ stringCap: 256, arrayLimit: 8, objectLimit: 16 },
	{ stringCap: 64, arrayLimit: 1, objectLimit: 8 },
];

const STRING_ELISION_RESERVE = 80;
const METADATA_STRING_CAP = 1024;

function serializedFrameBytes(json: string): number {
	return Buffer.byteLength(json, "utf8") + 1;
}

function shrinkString(value: string, cap: number): string {
	if (value.length <= cap) return value;
	const headLength = Math.max(0, cap - STRING_ELISION_RESERVE);
	return `${value.slice(0, headLength)}\n…[${value.length - headLength} chars elided for RPC frame]`;
}

function shrinkValue(value: unknown, pass: ShrinkPass): unknown {
	if (typeof value === "string") return shrinkString(value, pass.stringCap);
	if (Array.isArray(value)) {
		const keep = Math.min(value.length, pass.arrayLimit);
		const output: unknown[] = new Array(keep + (keep < value.length ? 1 : 0));
		for (let index = 0; index < keep; index++) output[index] = shrinkValue(value[index], pass);
		if (keep < value.length) output[keep] = `…[${value.length - keep} items elided for RPC frame]`;
		return output;
	}
	if (isRecord(value)) {
		const entries = Object.entries(value);
		const keep = Math.min(entries.length, pass.objectLimit);
		const output: Record<string, unknown> = {};
		for (let index = 0; index < keep; index++) {
			const [key, item] = entries[index];
			output[key] = shrinkValue(item, pass);
		}
		if (keep < entries.length) output.rpcFrameElidedKeys = entries.length - keep;
		return output;
	}
	return value;
}

function jsonSnapshot(value: unknown): unknown {
	const json = JSON.stringify(value);
	return json === undefined ? undefined : JSON.parse(json);
}

function encodedMessageSnapshot(encoded: string): { message: unknown } | undefined {
	const frame = JSON.parse(encoded);
	return isRecord(frame) && frame.type === "message_end" && Object.hasOwn(frame, "message")
		? { message: frame.message }
		: undefined;
}

/**
 * Emit protocol v2 chunk frames for one pre-serialized logical frame, one physical
 * JSONL line at a time so callers can write with backpressure instead of holding the
 * whole ~4/3-sized base64 transport in memory. The reassembly ceiling is enforced on
 * `Buffer.byteLength` BEFORE any full-payload allocation.
 */
function* encodeChunkedRpcFrames(frame: object, json: string, chunkId: string): Generator<string> {
	const byteLength = Buffer.byteLength(json, "utf8");
	if (byteLength > MAX_RPC_REASSEMBLED_BYTES) {
		yield `${JSON.stringify(overflowFrame(frame))}\n`;
		return;
	}
	const bytes = Buffer.from(json, "utf8");
	const count = Math.ceil(byteLength / RPC_CHUNK_PAYLOAD_BYTES);
	for (let index = 0; index < count; index++) {
		const chunk: RpcChunkFrame = {
			type: "rpc_chunk",
			chunkId,
			index,
			count,
			byteLength,
			data: bytes
				.subarray(index * RPC_CHUNK_PAYLOAD_BYTES, (index + 1) * RPC_CHUNK_PAYLOAD_BYTES)
				.toString("base64"),
		};
		const line = `${JSON.stringify(chunk)}\n`;
		if (serializedFrameBytes(line.slice(0, -1)) > MAX_RPC_FRAME_BYTES)
			throw new Error("RPC chunk exceeded the transport limit");
		yield line;
	}
}

function isRpcChunkFrame(value: unknown): value is RpcChunkFrame {
	return isRecord(value) && value.type === "rpc_chunk";
}

function decodeBase64(data: unknown): Buffer {
	if (
		typeof data !== "string" ||
		data.length === 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
	)
		throw new Error("invalid rpc chunk data");
	const bytes = Buffer.from(data, "base64");
	if (bytes.toString("base64") !== data) throw new Error("invalid rpc chunk data");
	return bytes;
}

/** Reassemble protocol v2 chunk frames after each JSONL line has been parsed. */
export class RpcFrameDecoder {
	#pending?: PendingRpcChunks;

	push(value: unknown): object | undefined {
		if (!isRpcChunkFrame(value)) {
			if (this.#pending) throw new Error("rpc chunk sequence interrupted");
			if (!isRecord(value)) throw new Error("rpc frame must be an object");
			return value;
		}
		const { chunkId, index, count, byteLength } = value;
		if (
			typeof chunkId !== "string" ||
			chunkId.length === 0 ||
			chunkId.length > 128 ||
			!Number.isSafeInteger(index) ||
			!Number.isSafeInteger(count) ||
			!Number.isSafeInteger(byteLength) ||
			index < 0 ||
			count < 2 ||
			count > Math.ceil(MAX_RPC_REASSEMBLED_BYTES / RPC_CHUNK_PAYLOAD_BYTES) ||
			index >= count ||
			byteLength < MAX_RPC_FRAME_BYTES ||
			byteLength > MAX_RPC_REASSEMBLED_BYTES
		)
			throw new Error("invalid rpc chunk metadata");
		const bytes = decodeBase64(value.data);
		if (bytes.byteLength > RPC_CHUNK_PAYLOAD_BYTES) throw new Error("rpc chunk payload exceeds the transport limit");

		if (!this.#pending) {
			if (index !== 0) throw new Error("rpc chunk sequence must start at index 0");
			this.#pending = { chunkId, count, byteLength, nextIndex: 0, chunks: [], receivedBytes: 0 };
		}
		const pending = this.#pending;
		if (
			pending.chunkId !== chunkId ||
			pending.count !== count ||
			pending.byteLength !== byteLength ||
			pending.nextIndex !== index
		)
			throw new Error("rpc chunk sequence mismatch");
		pending.chunks.push(bytes);
		pending.receivedBytes += bytes.byteLength;
		pending.nextIndex++;
		if (pending.receivedBytes > pending.byteLength) throw new Error("rpc chunk sequence exceeds declared length");
		if (pending.nextIndex < pending.count) return undefined;
		if (pending.receivedBytes !== pending.byteLength) throw new Error("rpc chunk sequence length mismatch");

		this.#pending = undefined;
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks));
		const frame: unknown = JSON.parse(decoded);
		if (!isRecord(frame)) throw new Error("rpc frame must be an object");
		return frame;
	}
}

function compactTerminalFrame(
	frame: object,
	streamedMessageCount: number,
	streamedMessages?: readonly unknown[],
): object {
	if (!isRecord(frame) || frame.type !== "agent_end" || !Array.isArray(frame.messages)) return frame;
	let streamed = Number.isSafeInteger(streamedMessageCount)
		? Math.min(Math.max(0, streamedMessageCount), frame.messages.length)
		: 0;
	if (streamedMessages) {
		streamed = 0;
		const limit = Math.min(streamedMessages.length, frame.messages.length);
		while (
			streamed < limit &&
			isDeepStrictEqual(streamedMessages[streamed], jsonSnapshot(frame.messages[streamed]))
		) {
			streamed++;
		}
	}
	return {
		...frame,
		messages: frame.messages.slice(streamed),
		messageCount: frame.messages.length,
	};
}

function overflowFrame(frame: object): object {
	if (!isRecord(frame)) return { type: "rpc_frame_error", error: "RPC frame exceeded the transport limit" };
	if (frame.type === "response") {
		return {
			id: typeof frame.id === "string" ? shrinkString(frame.id, METADATA_STRING_CAP) : undefined,
			type: "response",
			command: typeof frame.command === "string" ? shrinkString(frame.command, METADATA_STRING_CAP) : "unknown",
			success: false,
			error: "RPC response exceeded the transport limit",
		};
	}
	if (frame.type === "agent_end") {
		return {
			type: "agent_end",
			messages: [],
			messageCount: typeof frame.messageCount === "number" ? frame.messageCount : 0,
		};
	}
	return {
		type: "rpc_frame_error",
		originalType: typeof frame.type === "string" ? shrinkString(frame.type, METADATA_STRING_CAP) : undefined,
		error: "RPC frame exceeded the transport limit",
	};
}

function encodeRpcFrameFromJson(
	frame: object,
	json: string,
	streamedMessageCount: number,
	streamedMessages?: readonly unknown[],
): string {
	if (serializedFrameBytes(json) <= MAX_RPC_FRAME_BYTES) return `${json}\n`;
	if (isRecord(frame) && frame.type === "response") {
		return `${JSON.stringify(overflowFrame(frame))}\n`;
	}

	const compacted = compactTerminalFrame(frame, streamedMessageCount, streamedMessages);
	json = JSON.stringify(compacted);
	if (serializedFrameBytes(json) <= MAX_RPC_FRAME_BYTES) return `${json}\n`;

	for (const pass of SHRINK_PASSES) {
		json = JSON.stringify(shrinkValue(compacted, pass));
		if (serializedFrameBytes(json) <= MAX_RPC_FRAME_BYTES) return `${json}\n`;
	}

	return `${JSON.stringify(overflowFrame(compacted))}\n`;
}

/** Serialize a complete JSONL frame while enforcing the transport byte ceiling. */
export function encodeRpcFrame(frame: object, streamedMessageCount = 0, streamedMessages?: readonly unknown[]): string {
	return encodeRpcFrameFromJson(frame, JSON.stringify(frame), streamedMessageCount, streamedMessages);
}

/** Stateful encoder that tracks which messages a client has already received. */
export class RpcFrameEncoder {
	#streamedMessages: unknown[] = [];
	#protocolVersion: RpcProtocolVersion = 1;
	#chunkCounter = 0;

	setProtocolVersion(version: number): void {
		if (version !== 1 && version !== 2) throw new Error(`Unsupported RPC protocol version: ${version}`);
		this.#protocolVersion = version;
	}

	/**
	 * Encode one logical frame into physical JSONL lines. Encoder bookkeeping runs
	 * eagerly; only chunk emission is lazy, so a chunked result can be streamed to
	 * stdout with backpressure without holding the whole transport in memory. The
	 * returned iterable MUST be fully consumed exactly once.
	 */
	encodeFrames(frame: object): Iterable<string> {
		if (isRecord(frame) && frame.type === "agent_start") this.#streamedMessages = [];
		const json = JSON.stringify(frame);
		let frames: Iterable<string>;
		let singleFrame: string | undefined;
		if (this.#protocolVersion === 2 && serializedFrameBytes(json) > MAX_RPC_FRAME_BYTES) {
			const compacted = compactTerminalFrame(frame, this.#streamedMessages.length, this.#streamedMessages);
			// Reuse the original serialization when compaction was a no-op.
			const compactedJson = compacted === frame ? json : JSON.stringify(compacted);
			if (serializedFrameBytes(compactedJson) > MAX_RPC_FRAME_BYTES) {
				frames = encodeChunkedRpcFrames(compacted, compactedJson, `rpc-${++this.#chunkCounter}`);
			} else {
				singleFrame = `${compactedJson}\n`;
				frames = [singleFrame];
			}
		} else {
			singleFrame = encodeRpcFrameFromJson(frame, json, this.#streamedMessages.length, this.#streamedMessages);
			frames = [singleFrame];
		}
		if (!isRecord(frame)) return frames;
		if (frame.type === "message_end") {
			const snapshot =
				this.#protocolVersion === 2 && Object.hasOwn(frame, "message")
					? (encodedMessageSnapshot(json) ?? { message: jsonSnapshot(frame.message) })
					: singleFrame !== undefined
						? encodedMessageSnapshot(singleFrame)
						: undefined;
			if (snapshot) this.#streamedMessages.push(snapshot.message);
		} else if (frame.type === "agent_end" && frame.willContinue !== true) this.#streamedMessages = [];
		return frames;
	}

	encode(frame: object): string {
		let encoded = "";
		for (const line of this.encodeFrames(frame)) encoded += line;
		return encoded;
	}
}
