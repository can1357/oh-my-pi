/**
 * Typed surface for Grok Bot InferenceService Stream protobuf helpers.
 * Codec internals live in `proto-codec.ts` under `@ts-nocheck` (hand-rolled wire).
 */
import * as codec from "./proto-codec";

export const CONNECT_END_STREAM_FLAG = codec.CONNECT_END_STREAM_FLAG as 0b00000010;

export type GrokbotProtoRecord = Record<string, unknown>;

export function frameConnectProto(protoBytes: Buffer | Uint8Array, flags = 0): Buffer {
	return codec.frameConnectProto(protoBytes, flags) as Buffer;
}

export function fieldNumbers(buf: Buffer | Uint8Array): number[] {
	return codec.fieldNumbers(buf) as number[];
}

export function encodeInferenceStreamRequest(req: GrokbotProtoRecord): Buffer {
	return codec.encodeInferenceStreamRequest(req) as Buffer;
}

export function decodeInferenceStreamRequest(buf: Buffer | Uint8Array): GrokbotProtoRecord {
	return codec.decodeInferenceStreamRequest(buf) as GrokbotProtoRecord;
}

export function encodeInferenceStreamResponse(resp: GrokbotProtoRecord): Buffer {
	return codec.encodeInferenceStreamResponse(resp) as Buffer;
}

export function decodeInferenceStreamResponse(buf: Buffer | Uint8Array): GrokbotProtoRecord {
	return codec.decodeInferenceStreamResponse(buf) as GrokbotProtoRecord;
}
