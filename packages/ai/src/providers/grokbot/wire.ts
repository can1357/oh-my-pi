/**
 * Typed protobuf wire codec for Grok Bot `aiserver.v1.InferenceService/Stream`.
 *
 * Hand-rolled by design: the endpoint is Connect-RPC with protobuf payloads and
 * depending on @connectrpc/protobuf would pull the full Connect client stack
 * into the provider for a single streaming method. The field maps below were
 * verified against the provider protocol; tests retain only synthetic fixtures:
 *
 * InferenceStreamRequest  { 1 messages, 2 tools, 4 model_config, 6 invocation_id,
 *                           7 requested_model, 8 conversation_id }
 * InferenceCoreMessage    { 1 role enum, 2 text, 3 parts, 4 tool_calls, 6 tool_content,
 *                           7 reasoning_parts }
 * InferenceStreamResponse oneof { 1 text_part, 2 tool_call_part, 3 usage,
 *                           4 response_info, 5 extended_usage, 6 provider_metadata,
 *                           7 invocation_id, 8 error, 9 thinking_part }
 *
 * Streaming semantics verified on the wire:
 * - TextPart deltas concatenate; `isFinal` (field 2) closes the block.
 * - ThinkingPart: field 1 text delta, field 2 signature, field 3 isFinal
 *   (off-by-one vs TextPart — signature-only frames are common: grok-4.6 ships
 *   an opaque reasoning signature without plaintext reasoning).
 * - ToolCallPart: field 3 raw args are INCREMENTS on open frames and the FULL
 *   accumulated args on the completing frame (field 4 = isComplete). Parallel
 *   calls have distinct ids; correlation uses the complete call id.
 */

// ---------------------------------------------------------------------------
// Writer primitives
// ---------------------------------------------------------------------------

const WIRE_VARINT = 0;
const WIRE_64 = 1;
const WIRE_LEN = 2;
const WIRE_32 = 5;

function concat(chunks: Array<Buffer | undefined>): Buffer {
	return Buffer.concat(chunks.filter((c): c is Buffer => c !== undefined && c.length > 0));
}

function encodeVarint(value: number): Buffer {
	const n = BigInt(Math.trunc(value) >>> 0);
	const out: number[] = [];
	let rest = n;
	while (rest > 0x7fn) {
		out.push(Number((rest & 0x7fn) | 0x80n));
		rest >>= 7n;
	}
	out.push(Number(rest));
	return Buffer.from(out);
}

function encodeTag(fieldNo: number, wire: number): Buffer {
	return encodeVarint((fieldNo << 3) | wire);
}

/** Length-delimited string field. Empty string omitted unless `force`. */
function encodeString(fieldNo: number, s: string | undefined | null, force = false): Buffer {
	if (s == null) return Buffer.alloc(0);
	if (!force && s === "") return Buffer.alloc(0);
	const payload = Buffer.from(String(s), "utf8");
	return concat([encodeTag(fieldNo, WIRE_LEN), encodeVarint(payload.length), payload]);
}

function encodeBool(fieldNo: number, v: boolean | null | undefined, force = false): Buffer {
	if (v == null) return Buffer.alloc(0);
	if (!force && !v) return Buffer.alloc(0);
	return concat([encodeTag(fieldNo, WIRE_VARINT), encodeVarint(v ? 1 : 0)]);
}

/**
 * proto3 int32. Non-zero values emit minimal varint; negatives emit the
 * canonical 10-byte two's-complement form so every consumer parses them alike.
 */
function encodeInt32(fieldNo: number, n: number | null | undefined, force = false): Buffer {
	if (n == null || !Number.isFinite(n)) return Buffer.alloc(0);
	const v = n | 0;
	if (!force && v === 0) return Buffer.alloc(0);
	if (v < 0) {
		let x = BigInt(v) & 0xffffffffffffffffn;
		const out: number[] = [];
		for (let i = 0; i < 10; i++) {
			const more = i < 9;
			out.push(Number((x & 0x7fn) | (more ? 0x80n : 0n)));
			x >>= 7n;
		}
		return concat([encodeTag(fieldNo, WIRE_VARINT), Buffer.from(out)]);
	}
	return concat([encodeTag(fieldNo, WIRE_VARINT), encodeVarint(v)]);
}

function encodeFloat(fieldNo: number, n: number | null | undefined): Buffer {
	if (n == null || !Number.isFinite(n)) return Buffer.alloc(0);
	const buf = Buffer.alloc(4);
	buf.writeFloatLE(n, 0);
	return concat([encodeTag(fieldNo, WIRE_32), buf]);
}

function encodeDouble(fieldNo: number, n: number | null | undefined, force = false): Buffer {
	if (n == null || !Number.isFinite(n)) return Buffer.alloc(0);
	if (!force && n === 0) return Buffer.alloc(0);
	const buf = Buffer.alloc(8);
	buf.writeDoubleLE(n, 0);
	return concat([encodeTag(fieldNo, WIRE_64), buf]);
}

/** Length-delimited sub-message. Empty payload omitted unless `always`. */
function encodeMessage(fieldNo: number, bytes: Buffer | undefined, always = false): Buffer {
	if (!bytes) return Buffer.alloc(0);
	if (!always && bytes.length === 0) return Buffer.alloc(0);
	return concat([encodeTag(fieldNo, WIRE_LEN), encodeVarint(bytes.length), bytes]);
}

// ---------------------------------------------------------------------------
// google.protobuf.Struct (tool parameters, structured tool args)
// ---------------------------------------------------------------------------

function encodeValue(js: unknown): Buffer {
	if (js === null || js === undefined) return encodeInt32(1, 0, true);
	if (typeof js === "number") {
		if (!Number.isFinite(js)) return encodeInt32(1, 0, true);
		return encodeDouble(2, js, true);
	}
	if (typeof js === "string") return encodeString(3, js, true);
	if (typeof js === "boolean") return encodeBool(4, js, true);
	if (Array.isArray(js)) return encodeMessage(6, encodeListValue(js), true);
	if (typeof js === "object") return encodeMessage(5, encodeStruct(js), true);
	return encodeString(3, String(js), true);
}

function encodeListValue(arr: ReadonlyArray<unknown>): Buffer {
	const chunks: Buffer[] = [];
	for (const item of arr) chunks.push(encodeMessage(1, encodeValue(item), true));
	return Buffer.concat(chunks);
}

function encodeStruct(obj: unknown): Buffer {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return Buffer.alloc(0);
	const chunks: Buffer[] = [];
	for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
		const entry = concat([encodeString(1, key, true), encodeMessage(2, encodeValue(val), true)]);
		chunks.push(encodeMessage(1, entry, true));
	}
	return Buffer.concat(chunks);
}

function decodeValue(buf: Buffer): unknown {
	for (const f of decodeFields(buf)) {
		if (f.fieldNo === 1) return null;
		if (f.fieldNo === 2) return asDouble(f);
		if (f.fieldNo === 3) return asString(f);
		if (f.fieldNo === 4) return asBool(f);
		if (f.fieldNo === 5 && f.bytes) return decodeStruct(f.bytes);
		if (f.fieldNo === 6 && f.bytes) return decodeListValue(f.bytes);
	}
	return undefined;
}

function decodeListValue(buf: Buffer): unknown[] {
	return fieldsOf(buf, 1).map(f => decodeValue(f.bytes!));
}

function decodeStruct(buf: Buffer): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const entry of fieldsOf(buf, 1)) {
		if (!entry.bytes) continue;
		const ef = decodeFields(entry.bytes);
		const key = asString(getField(ef, 1));
		const valField = getField(ef, 2);
		out[key] = valField?.bytes ? decodeValue(valField.bytes) : undefined;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Request encoding
// ---------------------------------------------------------------------------

export interface InferenceRequestedParameter {
	id: string;
	value: string;
}

export interface InferenceRequestedModel {
	modelId: string;
	maxMode?: boolean;
	parameters?: InferenceRequestedParameter[];
	builtInModel?: boolean;
}

export interface InferenceModelConfig {
	maxTokens?: number;
	temperature?: number;
	topP?: number;
	stopSequences?: string[];
}

export interface InferenceToolCall {
	toolCallId: string;
	toolName: string;
	/** Struct args for native tools. */
	args?: Record<string, unknown>;
	/** Raw payload for grammar/custom-format tools (field 4, replayed verbatim). */
	rawToolCallArgs?: string;
}

export interface InferenceReasoningPart {
	isRedacted?: boolean;
	text: string;
	redactedData?: string;
	signature?: string;
	modelName?: string;
}

export type InferenceContentPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType?: string };

export interface InferenceToolResultPart {
	toolCallId: string;
	toolName: string;
	result?: unknown;
	isError?: boolean;
	experimentalContent?: InferenceContentPart[];
}

/** Role enum on the wire: user=1, assistant=2, tool=3, system/developer=4. */
export const INFERENCE_ROLE = {
	user: 1,
	assistant: 2,
	tool: 3,
	system: 4,
	developer: 4,
} as const;

export interface InferenceCoreMessage {
	role: number;
	text?: string;
	/** User-content parts (text + image). */
	parts?: { parts: InferenceContentPart[] };
	toolContent?: { parts: InferenceToolResultPart[] };
	toolCalls?: InferenceToolCall[];
	reasoningParts?: InferenceReasoningPart[];
}

export interface InferenceTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	customToolFormat?: { type: string; definition: string; syntax: string };
}

export interface InferenceStreamRequest {
	messages: InferenceCoreMessage[];
	tools?: InferenceTool[];
	modelConfig?: InferenceModelConfig;
	invocationId?: string;
	requestedModel?: InferenceRequestedModel;
	conversationId?: string;
}

function encodeContentPart(part: InferenceContentPart): Buffer {
	if (part.type === "image") {
		return encodeMessage(2, concat([encodeString(1, part.data, true), encodeString(2, part.mimeType)]));
	}
	return encodeMessage(1, encodeString(1, part.text, true));
}

function encodeContentParts(parts: ReadonlyArray<InferenceContentPart>): Buffer {
	const chunks: Buffer[] = [];
	for (const part of parts) chunks.push(encodeMessage(1, encodeContentPart(part)));
	return Buffer.concat(chunks);
}

function encodeReasoningPart(part: InferenceReasoningPart): Buffer {
	return concat([
		encodeBool(1, part.isRedacted),
		encodeString(2, part.text),
		part.signature ? encodeString(3, part.signature, true) : Buffer.alloc(0),
		part.redactedData ? encodeString(4, part.redactedData, true) : Buffer.alloc(0),
		part.modelName ? encodeString(5, part.modelName, true) : Buffer.alloc(0),
	]);
}

function encodeToolCall(tc: InferenceToolCall): Buffer {
	const chunks = [encodeString(1, tc.toolCallId), encodeString(2, tc.toolName)];
	if (tc.args && typeof tc.args === "object") chunks.push(encodeMessage(3, encodeStruct(tc.args)));
	if (typeof tc.rawToolCallArgs === "string" && tc.rawToolCallArgs) {
		chunks.push(encodeString(4, tc.rawToolCallArgs, true));
	}
	return concat(chunks);
}

function encodeToolResultPart(part: InferenceToolResultPart): Buffer {
	const chunks = [encodeString(1, part.toolCallId), encodeString(2, part.toolName)];
	if (part.result !== undefined) chunks.push(encodeMessage(3, encodeValue(part.result), true));
	if (part.isError) chunks.push(encodeBool(4, true));
	if (part.experimentalContent) {
		for (const item of part.experimentalContent) chunks.push(encodeMessage(5, encodeContentPart(item)));
	}
	return concat(chunks);
}

function encodeCoreMessage(msg: InferenceCoreMessage): Buffer {
	const chunks: Buffer[] = [encodeInt32(1, msg.role)];
	if (msg.toolContent) {
		const parts = concat((msg.toolContent.parts ?? []).map(part => encodeMessage(1, encodeToolResultPart(part))));
		chunks.push(encodeMessage(6, parts, true));
	} else if (msg.parts) {
		chunks.push(encodeMessage(3, encodeContentParts(msg.parts.parts), true));
	} else if (typeof msg.text === "string") {
		chunks.push(encodeString(2, msg.text, true));
	}
	for (const tc of msg.toolCalls ?? []) chunks.push(encodeMessage(4, encodeToolCall(tc)));
	for (const rp of msg.reasoningParts ?? []) chunks.push(encodeMessage(7, encodeReasoningPart(rp)));
	return concat(chunks);
}

function encodeParameter(p: InferenceRequestedParameter): Buffer {
	return concat([encodeString(1, p.id), encodeString(2, p.value == null ? "" : String(p.value))]);
}

function encodeRequestedModel(rm: InferenceRequestedModel): Buffer {
	const chunks = [encodeString(1, rm.modelId), encodeBool(2, Boolean(rm.maxMode))];
	for (const p of rm.parameters ?? []) chunks.push(encodeMessage(3, encodeParameter(p)));
	if (rm.builtInModel) chunks.push(encodeBool(4, true));
	return concat(chunks);
}

function encodeTool(tool: InferenceTool): Buffer {
	const chunks = [
		encodeString(1, tool.name),
		encodeString(2, tool.description),
		encodeMessage(3, encodeStruct(tool.parameters ?? { type: "object", properties: {} })),
	];
	if (tool.customToolFormat) {
		chunks.push(
			encodeMessage(
				4,
				concat([
					encodeString(1, tool.customToolFormat.type),
					encodeString(2, tool.customToolFormat.definition),
					encodeString(3, tool.customToolFormat.syntax),
				]),
			),
		);
	}
	return concat(chunks);
}

function encodeModelConfig(cfg: InferenceModelConfig): Buffer {
	const chunks: Buffer[] = [];
	if (typeof cfg.maxTokens === "number") chunks.push(encodeInt32(1, cfg.maxTokens, true));
	if (typeof cfg.temperature === "number") chunks.push(encodeFloat(2, cfg.temperature));
	if (typeof cfg.topP === "number") chunks.push(encodeFloat(3, cfg.topP));
	for (const stop of cfg.stopSequences ?? []) chunks.push(encodeString(4, stop));
	return concat(chunks);
}

export function encodeInferenceStreamRequest(req: InferenceStreamRequest): Buffer {
	const chunks: Buffer[] = [];
	for (const m of req.messages ?? []) chunks.push(encodeMessage(1, encodeCoreMessage(m)));
	for (const t of req.tools ?? []) chunks.push(encodeMessage(2, encodeTool(t)));
	if (req.modelConfig) chunks.push(encodeMessage(4, encodeModelConfig(req.modelConfig)));
	if (req.invocationId) chunks.push(encodeString(6, req.invocationId));
	if (req.requestedModel) chunks.push(encodeMessage(7, encodeRequestedModel(req.requestedModel)));
	if (req.conversationId) chunks.push(encodeString(8, req.conversationId));
	return concat(chunks);
}

// ---------------------------------------------------------------------------
// Reader primitives
// ---------------------------------------------------------------------------

interface RawField {
	fieldNo: number;
	wire: number;
	value?: number | bigint;
	bytes?: Buffer;
}

function decodeVarint(buf: Buffer, pos: number): [number | bigint, number] {
	let n = 0n;
	let shift = 0n;
	while (pos < buf.length) {
		const b = BigInt(buf[pos++]!);
		n |= (b & 0x7fn) << shift;
		if ((b & 0x80n) === 0n) return [n <= 0xffffffffn ? Number(n) : n, pos];
		shift += 7n;
		if (shift > 70n) throw new Error("varint too long");
	}
	throw new Error("truncated varint");
}

function decodeFields(buf: Buffer): RawField[] {
	const out: RawField[] = [];
	let pos = 0;
	while (pos < buf.length) {
		const [tag, tagEnd] = decodeVarint(buf, pos);
		const tagNum = Number(tag);
		const fieldNo = tagNum >>> 3;
		const wire = tagNum & 7;
		pos = tagEnd;
		// Field number 0 is illegal; zero-tag frames must fail loudly instead of
		// decoding as an empty no-op message.
		if (fieldNo === 0) throw new Error("protobuf field number must be non-zero");
		if (wire === WIRE_VARINT) {
			const [v, end] = decodeVarint(buf, pos);
			out.push({ fieldNo, wire, value: v });
			pos = end;
		} else if (wire === WIRE_64) {
			if (pos + 8 > buf.length) throw new Error("truncated 64-bit field");
			out.push({ fieldNo, wire, bytes: buf.subarray(pos, pos + 8) });
			pos += 8;
		} else if (wire === WIRE_LEN) {
			const [lenRaw, lenEnd] = decodeVarint(buf, pos);
			const len = Number(lenRaw);
			pos = lenEnd;
			if (pos + len > buf.length) throw new Error("truncated length-delimited field");
			out.push({ fieldNo, wire, bytes: buf.subarray(pos, pos + len) });
			pos += len;
		} else if (wire === WIRE_32) {
			if (pos + 4 > buf.length) throw new Error("truncated 32-bit field");
			out.push({ fieldNo, wire, bytes: buf.subarray(pos, pos + 4) });
			pos += 4;
		} else {
			throw new Error(`unknown wire type ${wire}`);
		}
	}
	return out;
}

function fieldsOf(buf: Buffer, fieldNo: number): RawField[] {
	return decodeFields(buf).filter(f => f.fieldNo === fieldNo);
}

function getField(fields: RawField[], fieldNo: number): RawField | undefined {
	for (const f of fields) if (f.fieldNo === fieldNo) return f;
	return undefined;
}

function asString(f: RawField | undefined): string {
	return f?.bytes ? Buffer.from(f.bytes).toString("utf8") : "";
}

function asBool(f: RawField | undefined): boolean {
	return f?.wire === WIRE_VARINT ? Boolean(f.value) : false;
}

function asInt(f: RawField | undefined): number {
	return f?.wire === WIRE_VARINT ? Number(f.value ?? 0) : 0;
}

function asDouble(f: RawField | undefined): number {
	return f?.bytes && f.bytes.length >= 8 ? f.bytes.readDoubleLE(0) : 0;
}

// ---------------------------------------------------------------------------
// Response decoding
// ---------------------------------------------------------------------------

export type InferenceStreamPart =
	| { kind: "text"; text: string; isFinal: boolean }
	| { kind: "thinking"; text: string; signature?: string; isFinal: boolean }
	| {
			kind: "toolCall";
			toolCallId: string;
			toolName?: string;
			/** Raw args payload carried by this frame. */
			args?: string;
			isComplete: boolean;
			toolIndex?: number;
	  }
	| { kind: "usage"; input: number; output: number; total?: number }
	| {
			kind: "extendedUsage";
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			maxTokens?: number;
	  }
	| { kind: "responseInfo"; id?: string; messageId?: string; model?: string; errorMessage?: string }
	| { kind: "invocationId"; invocationId: string }
	| { kind: "providerMetadata"; metadata: Record<string, unknown> }
	| {
			kind: "error";
			message: string;
			code?: string;
			isInputTokenLimitError?: boolean;
			isOutputTokenLimitError?: boolean;
			errorType?: number;
	  };

/**
 * Decode one Connect payload into the stream parts it carries. A well-formed
 * InferenceStreamResponse holds exactly one oneof member; unknown/absent
 * payloads yield an empty array.
 */
export function decodeInferenceStreamResponse(buf: Buffer | Uint8Array): InferenceStreamPart[] {
	const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
	const parts: InferenceStreamPart[] = [];
	for (const f of decodeFields(bytes)) {
		const body = f.bytes ?? Buffer.alloc(0);
		const fields = decodeFields(body);
		switch (f.fieldNo) {
			case 1: {
				parts.push({ kind: "text", text: asString(getField(fields, 1)), isFinal: asBool(getField(fields, 2)) });
				break;
			}
			case 2: {
				const nameField = getField(fields, 2);
				const argsField = getField(fields, 3);
				const indexField = getField(fields, 5);
				parts.push({
					kind: "toolCall",
					toolCallId: asString(getField(fields, 1)),
					toolName: nameField?.bytes ? asString(nameField) : undefined,
					// Field 3 present = this frame carries an args payload (possibly
					// empty). Absent = no args info in this frame.
					args: argsField ? asString(argsField) : undefined,
					isComplete: asBool(getField(fields, 4)),
					toolIndex: indexField ? Number(indexField.value ?? 0) : undefined,
				});
				break;
			}
			case 3: {
				const totalField = getField(fields, 3);
				parts.push({
					kind: "usage",
					input: asInt(getField(fields, 1)),
					output: asInt(getField(fields, 2)),
					total: totalField ? asInt(totalField) : undefined,
				});
				break;
			}
			case 4: {
				const msgField = getField(fields, 4);
				parts.push({
					kind: "responseInfo",
					id: asString(getField(fields, 1)) || undefined,
					messageId: msgField?.bytes
						? asString(getField(decodeFields(msgField.bytes), 1)) || undefined
						: undefined,
					model: asString(getField(fields, 2)) || undefined,
					errorMessage: asString(getField(fields, 5)) || undefined,
				});
				break;
			}
			case 5: {
				const maxTokensField = getField(fields, 5);
				parts.push({
					kind: "extendedUsage",
					input: asInt(getField(fields, 1)),
					output: asInt(getField(fields, 2)),
					cacheRead: asInt(getField(fields, 3)),
					cacheWrite: asInt(getField(fields, 4)),
					maxTokens: maxTokensField ? asInt(maxTokensField) : undefined,
				});
				break;
			}
			case 6: {
				const meta = getField(fields, 1);
				parts.push({ kind: "providerMetadata", metadata: meta?.bytes ? decodeStruct(meta.bytes) : {} });
				break;
			}
			case 7: {
				parts.push({ kind: "invocationId", invocationId: asString(getField(fields, 1)) });
				break;
			}
			case 8: {
				const codeField = getField(fields, 2);
				const errorTypeField = getField(fields, 5);
				parts.push({
					kind: "error",
					message: asString(getField(fields, 1)),
					code: codeField?.bytes ? asString(codeField) : undefined,
					isInputTokenLimitError: asBool(getField(fields, 3)) || undefined,
					isOutputTokenLimitError: asBool(getField(fields, 4)) || undefined,
					errorType: errorTypeField ? Number(errorTypeField.value ?? 0) : undefined,
				});
				break;
			}
			case 9: {
				const signatureField = getField(fields, 2);
				parts.push({
					kind: "thinking",
					text: asString(getField(fields, 1)),
					signature: signatureField?.bytes ? asString(signatureField) : undefined,
					isFinal: asBool(getField(fields, 3)),
				});
				break;
			}
			default:
				break; // unknown oneof member — skip, never fail the stream
		}
	}
	return parts;
}
