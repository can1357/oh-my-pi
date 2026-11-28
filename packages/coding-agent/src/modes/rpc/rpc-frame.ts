import { type DeepJsonTextOptions, jsonDeepEquals, stringifyDeepJson } from "@oh-my-pi/pi-utils/json";
import { ContainerPath, type NestedWalk, runNested } from "@oh-my-pi/pi-utils/nested-walk";
import { isNonNullObject, isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { RpcChunkFrame } from "./rpc-types";

/** Maximum UTF-8 size of one newline-delimited RPC frame, including the newline. */
export const MAX_RPC_FRAME_BYTES = 1024 * 1024;
/** Maximum UTF-8 size of one logical frame reassembled by protocol v2. */
export const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;

const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;

export type RpcProtocolVersion = 1 | 2;

/** Stands in for a `message_update`'s shared snapshot while its frame skeleton serializes. */
const SHARED_MESSAGE_PLACEHOLDER = `\u0000omp-rpc-shared-message-${crypto.randomUUID()}\u0000`;
const SHARED_MESSAGE_PLACEHOLDER_JSON = JSON.stringify(SHARED_MESSAGE_PLACEHOLDER);

/**
 * Serialize-once only beats a plain `JSON.stringify` when object structure, not
 * string bytes, dominates the snapshot: JSC copies plain strings nearly at memcpy
 * speed, so splicing a string-heavy or few-block snapshot twice costs more than
 * serializing it twice. Measured in Bun: 1–12 blocks or >512 string chars per block
 * ran 10–90% slower via the splice; ≥16 small blocks ran 10–45% faster.
 */
const SHARED_MESSAGE_MIN_BLOCKS = 16;
const SHARED_MESSAGE_MAX_STRING_CHARS_PER_BLOCK = 512;

/** Whether a snapshot's `content` is block-heavy and string-light enough to serialize once. */
function isStructureHeavy(content: unknown): boolean {
	if (!Array.isArray(content) || content.length < SHARED_MESSAGE_MIN_BLOCKS) return false;
	const budget = content.length * SHARED_MESSAGE_MAX_STRING_CHARS_PER_BLOCK;
	let chars = 0;
	for (const block of content) {
		if (!isRecord(block)) continue;
		for (const key in block) {
			const value = block[key];
			if (typeof value === "string") {
				chars += value.length;
			} else if (isRecord(value)) {
				for (const nestedKey in value) {
					const nested = value[nestedKey];
					if (typeof nested === "string") chars += nested.length;
				}
			}
		}
		if (chars >= budget) return false;
	}
	return true;
}

/**
 * `JSON.stringify(value)` of a frame or a part of one, also where it nests
 * deeper than `JSON.stringify` recurses (`get_tree` nests each entry of a long
 * session under its parent). Typed as `JSON.stringify` is: a frame is an
 * object, which has JSON text.
 */
function frameJson(value: unknown, options?: DeepJsonTextOptions): string {
	return stringifyDeepJson(value, options) as string;
}

/**
 * Tree depth, in entries, past which a `get_tree` answer is written by
 * `stringifyJsonIteratively` instead of `JSON.stringify`: about 4,000 levels,
 * since a node and its `children` each nest one. Bun's `JSON.stringify` slows
 * with depth. Measured on chains of 1 KB messages, a chain of cold entries
 * (whose large values are getters) took it 57 ms at 1,000 entries against
 * the writer's 76 ms, 328 ms at 4,000 against 172 ms and 4.9 s at 12,000
 * against 0.65 s. Whole entries stay faster natively up to about 12,000
 * entries (145 ms against 0.83 s), then take it 4.9 s at 14,000 entries,
 * against the writer's 1.0 s, and run it out of stack at 20,000, after 9.4 s.
 */
export const RPC_TREE_WRITER_DEPTH = 2_000;

/** Whether `frame` answers `get_tree` with a tree deeper than {@link RPC_TREE_WRITER_DEPTH}; the walk stops at the first path past it. */
function isDeepTreeAnswer(frame: Record<string, unknown>): boolean {
	if (frame.type !== "response" || frame.command !== "get_tree" || !isRecord(frame.data)) return false;
	const roots = frame.data.tree;
	if (!Array.isArray(roots)) return false;
	const nodes: unknown[] = [...roots];
	const depths: number[] = roots.map(() => 1);
	while (nodes.length > 0) {
		const node = nodes.pop();
		const depth = depths.pop()!;
		if (depth > RPC_TREE_WRITER_DEPTH) return true;
		if (!isRecord(node) || !Array.isArray(node.children)) continue;
		for (const child of node.children) {
			nodes.push(child);
			depths.push(depth + 1);
		}
	}
	return false;
}

/**
 * `JSON.stringify(frame)`, byte for byte. A `get_tree` answer deeper than
 * {@link RPC_TREE_WRITER_DEPTH} is written by the iterative writer. A
 * streaming `message_update` aliases one cumulative snapshot as both `message`
 * and `assistantMessageEvent.partial`; when that snapshot is structure-heavy
 * it is serialized once and spliced into both positions instead of being
 * re-serialized per position on every token.
 */
function serializeFrame(frame: object): string {
	if (isRecord(frame) && isDeepTreeAnswer(frame)) return frameJson(frame, { deep: true });
	if (isRecord(frame) && frame.type === "message_update" && isRecord(frame.message)) {
		const event = frame.assistantMessageEvent;
		if (isRecord(event) && event.partial === frame.message && isStructureHeavy(frame.message.content)) {
			const messageJson = frameJson(frame.message);
			const skeleton = frameJson({
				...frame,
				message: SHARED_MESSAGE_PLACEHOLDER,
				assistantMessageEvent: { ...event, partial: SHARED_MESSAGE_PLACEHOLDER },
			});
			return skeleton.split(SHARED_MESSAGE_PLACEHOLDER_JSON).join(messageJson);
		}
	}
	return frameJson(frame);
}

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

/**
 * `value` with each string past the pass's cap shortened and each array and object past its
 * limits cut. The walk keeps its own stack ({@link runNested}): an event frame carries a tool's
 * result, as deep as a transcript line holds.
 */
function shrinkValue(value: unknown, pass: ShrinkPass): unknown {
	return isNonNullObject(value) ? runNested(shrunkNode(value, pass, new ContainerPath())) : shrunkLeaf(value, pass);
}

/** {@link shrinkValue} of `value`, no array or record: a string past the pass's cap shortened, anything else as it is. */
function shrunkLeaf(value: unknown, pass: ShrinkPass): unknown {
	return typeof value === "string" ? shrinkString(value, pass.stringCap) : value;
}

/** {@link shrinkValue} of `value`, an array or record `path` is inside of; each child array or record is a nested step. */
function* shrunkNode(value: object, pass: ShrinkPass, path: ContainerPath): NestedWalk {
	path.enter(value);
	if (Array.isArray(value)) {
		const keep = Math.min(value.length, pass.arrayLimit);
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const output: unknown[] = new Array(keep + (keep < value.length ? 1 : 0));
		for (let index = 0; index < keep; index++) {
			const item: unknown = value[index];
			output[index] = isNonNullObject(item) ? yield shrunkNode(item, pass, path) : shrunkLeaf(item, pass);
		}
		if (keep < value.length) output[keep] = `…[${value.length - keep} items elided for RPC frame]`;
		path.leave(value);
		return output;
	}
	const entries = Object.entries(value);
	const keep = Math.min(entries.length, pass.objectLimit);
	const output: Record<string, unknown> = {};
	for (let index = 0; index < keep; index++) {
		const [key, item] = entries[index];
		const child = isNonNullObject(item) ? yield shrunkNode(item, pass, path) : shrunkLeaf(item, pass);
		// Assigning `__proto__` would swap the copy's prototype instead of
		// creating the own data property JSON.parse produces.
		if (key === "__proto__") {
			Object.defineProperty(output, key, { value: child, enumerable: true, writable: true, configurable: true });
		} else {
			output[key] = child;
		}
	}
	if (keep < entries.length) output.rpcFrameElidedKeys = entries.length - keep;
	path.leave(value);
	return output;
}

function jsonSnapshot(value: unknown): unknown {
	const json = stringifyDeepJson(value);
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
		yield `${frameJson(overflowFrame(frame))}\n`;
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
		const line = `${frameJson(chunk)}\n`;
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
		while (streamed < limit && jsonDeepEquals(streamedMessages[streamed], jsonSnapshot(frame.messages[streamed]))) {
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
		return `${frameJson(overflowFrame(frame))}\n`;
	}

	const compacted = compactTerminalFrame(frame, streamedMessageCount, streamedMessages);
	json = frameJson(compacted);
	if (serializedFrameBytes(json) <= MAX_RPC_FRAME_BYTES) return `${json}\n`;

	for (const pass of SHRINK_PASSES) {
		json = frameJson(shrinkValue(compacted, pass));
		if (serializedFrameBytes(json) <= MAX_RPC_FRAME_BYTES) return `${json}\n`;
	}

	return `${frameJson(overflowFrame(compacted))}\n`;
}

/** Serialize a complete JSONL frame while enforcing the transport byte ceiling. */
export function encodeRpcFrame(frame: object, streamedMessageCount = 0, streamedMessages?: readonly unknown[]): string {
	return encodeRpcFrameFromJson(frame, serializeFrame(frame), streamedMessageCount, streamedMessages);
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
	 * Largest UTF-8 JSON size (excluding the newline) of a frame delivered intact under the negotiated
	 * protocol. A larger response is replaced by a transport-limit error; other frames are shrunk.
	 */
	get maxIntactFrameBytes(): number {
		return this.#protocolVersion === 2 ? MAX_RPC_REASSEMBLED_BYTES : MAX_RPC_FRAME_BYTES - 1;
	}

	/**
	 * Encode one logical frame into physical JSONL lines. Encoder bookkeeping runs
	 * eagerly; only chunk emission is lazy, so a chunked result can be streamed to
	 * stdout with backpressure without holding the whole transport in memory. The
	 * returned iterable MUST be fully consumed exactly once.
	 */
	encodeFrames(frame: object): Iterable<string> {
		if (isRecord(frame) && frame.type === "agent_start") this.#streamedMessages = [];
		const json = serializeFrame(frame);
		let frames: Iterable<string>;
		let singleFrame: string | undefined;
		if (this.#protocolVersion === 2 && serializedFrameBytes(json) > MAX_RPC_FRAME_BYTES) {
			const compacted = compactTerminalFrame(frame, this.#streamedMessages.length, this.#streamedMessages);
			// Reuse the original serialization when compaction was a no-op.
			const compactedJson = compacted === frame ? json : frameJson(compacted);
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
