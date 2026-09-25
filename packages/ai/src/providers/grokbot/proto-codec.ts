/**
 * Hand-rolled protobuf codec for Grok Bot InferenceService Stream.
 * Request fields sent: 1 messages, 2 tools, 3 provider_defined_tools (optional),
 * 4 model_config, 6 invocation_id, 7 requested_model, 8 conversation_id,
 * 9 accepted_unadvertised_tool_names (optional), 16 subagent_type (optional).
 * Fields 5/10–15 are decode-only (legacy model_id, automation, lineage).
 *
 * Typed exports also re-exported from `./proto.ts`. Prefer importing via
 * `./proto.ts` from outside this folder.
 */

export const CONNECT_END_STREAM_FLAG = 0b00000010;

type BytesLike = Buffer | Uint8Array;
/** Loose protobuf JSON-shaped records used at the encode/decode boundary. */
type ProtoRecord = Record<string, unknown>;
type EncodeOpts = { force?: boolean };
type MessageOpts = { omitEmpty?: boolean };
type DecodedField = {
	fieldNo: number;
	wire: number;
	value?: number | bigint;
	bytes?: Buffer;
};

export function frameConnectProto(protoBytes: BytesLike, flags = 0): Buffer {
	const payload = Buffer.isBuffer(protoBytes) ? protoBytes : Buffer.from(protoBytes);
	const frame = Buffer.alloc(5 + payload.length);
	frame[0] = flags;
	frame.writeUInt32BE(payload.length, 1);
	payload.copy(frame, 5);
	return frame;
}

const WIRE_VARINT = 0;
const WIRE_64 = 1;
const WIRE_LEN = 2;
const WIRE_32 = 5;

function concat(chunks: Array<Buffer | undefined | null>): Buffer {
	return Buffer.concat(chunks.filter((c): c is Buffer => Boolean(c?.length)));
}

function encodeVarint(value: number | bigint): Buffer {
	let n = typeof value === "bigint" ? value : BigInt(value >>> 0);
	if (typeof value === "number" && value < 0) {
		n = BigInt(value) & 0xffffffffn;
	}
	const out = [];
	while (n > 0x7fn) {
		out.push(Number((n & 0x7fn) | 0x80n));
		n >>= 7n;
	}
	out.push(Number(n));
	return Buffer.from(out);
}

function encodeTag(fieldNo: number, wire: number): Buffer {
	return encodeVarint((fieldNo << 3) | wire);
}

function encodeString(fieldNo: number, s: unknown, { force = false }: EncodeOpts = {}): Buffer {
	if (s == null) return Buffer.alloc(0);
	if (!force && s === "") return Buffer.alloc(0);
	const payload = Buffer.from(String(s), "utf8");
	return concat([encodeTag(fieldNo, WIRE_LEN), encodeVarint(payload.length), payload]);
}

function encodeBool(fieldNo: number, v: unknown, { force = false }: EncodeOpts = {}): Buffer {
	if (v == null) return Buffer.alloc(0);
	if (!force && v === false) return Buffer.alloc(0);
	return concat([encodeTag(fieldNo, WIRE_VARINT), encodeVarint(v ? 1 : 0)]);
}

function encodeInt32(fieldNo: number, n: unknown, { force = false }: EncodeOpts = {}): Buffer {
	if (typeof n !== "number" || !Number.isFinite(n)) return Buffer.alloc(0);
	const v = n | 0;
	if (!force && v === 0) return Buffer.alloc(0);
	if (v < 0) {
		// proto3 int32 negatives: 10-byte two's complement varint
		let x = BigInt(v) & 0xffffffffffffffffn;
		const out = [];
		for (let i = 0; i < 10; i++) {
			const more = i < 9;
			out.push(Number((x & 0x7fn) | (more ? 0x80n : 0n)));
			x >>= 7n;
		}
		return concat([encodeTag(fieldNo, WIRE_VARINT), Buffer.from(out)]);
	}
	return concat([encodeTag(fieldNo, WIRE_VARINT), encodeVarint(v)]);
}

function encodeEnum(fieldNo: number, n: unknown, { force = false }: EncodeOpts = {}): Buffer {
	return encodeInt32(fieldNo, n, { force });
}

function encodeFloat(fieldNo: number, n: unknown): Buffer {
	if (typeof n !== "number" || !Number.isFinite(n)) return Buffer.alloc(0);
	const buf = Buffer.alloc(4);
	buf.writeFloatLE(n, 0);
	return concat([encodeTag(fieldNo, WIRE_32), buf]);
}

function encodeDouble(fieldNo: number, n: unknown, { force = false }: EncodeOpts = {}): Buffer {
	if (typeof n !== "number" || !Number.isFinite(n)) return Buffer.alloc(0);
	if (!force && n === 0) return Buffer.alloc(0);
	const buf = Buffer.alloc(8);
	buf.writeDoubleLE(n, 0);
	return concat([encodeTag(fieldNo, WIRE_64), buf]);
}

function encodeMessage(
	fieldNo: number,
	bytes: BytesLike | undefined | null,
	{ omitEmpty = true }: MessageOpts = {},
): Buffer {
	if (!bytes) return Buffer.alloc(0);
	const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
	if (omitEmpty && buf.length === 0) return Buffer.alloc(0);
	return concat([encodeTag(fieldNo, WIRE_LEN), encodeVarint(buf.length), buf]);
}

function encodeValue(js: unknown): Buffer {
	if (js === null || js === undefined) {
		return encodeEnum(1, 0, { force: true });
	}
	if (typeof js === "number") {
		if (!Number.isFinite(js)) return encodeEnum(1, 0, { force: true });
		return encodeDouble(2, js, { force: true });
	}
	if (typeof js === "string") {
		return encodeString(3, js, { force: true });
	}
	if (typeof js === "boolean") {
		return encodeBool(4, js, { force: true });
	}
	if (Array.isArray(js)) {
		return encodeMessage(6, encodeListValue(js), { omitEmpty: false });
	}
	if (typeof js === "object") {
		return encodeMessage(5, encodeStruct(js), { omitEmpty: false });
	}
	return encodeString(3, String(js), { force: true });
}

function encodeListValue(arr: readonly unknown[]): Buffer {
	const chunks: Buffer[] = [];
	for (const item of arr) {
		chunks.push(encodeMessage(1, encodeValue(item), { omitEmpty: false }));
	}
	return concat(chunks);
}

function encodeStruct(obj: unknown): Buffer {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return Buffer.alloc(0);
	const chunks: Buffer[] = [];
	for (const [key, val] of Object.entries(obj)) {
		const entry = concat([
			encodeString(1, key, { force: true }),
			encodeMessage(2, encodeValue(val), { omitEmpty: false }),
		]);
		chunks.push(encodeMessage(1, entry, { omitEmpty: false }));
	}
	return concat(chunks);
}

function encodeParameter(p: ProtoRecord): Buffer {
	return concat([encodeString(1, p.id || ""), encodeString(2, p.value == null ? "" : String(p.value))]);
}

function encodeRequestedModel(rm: unknown): Buffer {
	if (!rm || typeof rm !== "object") return Buffer.alloc(0);
	const rec = rm as ProtoRecord;
	const chunks = [
		encodeString(1, rec.modelId || rec.model_id || ""),
		encodeBool(2, Boolean(rec.maxMode ?? rec.max_mode)),
	];
	const params = Array.isArray(rec.parameters) ? rec.parameters : [];
	for (const p of params) chunks.push(encodeMessage(3, encodeParameter(p as ProtoRecord)));
	if (rec.builtInModel || rec.built_in_model) chunks.push(encodeBool(4, true));
	if (rec.isVariantStringRepresentation || rec.is_variant_string_representation) {
		chunks.push(encodeBool(5, true));
	}
	return concat(chunks);
}

function encodeModelConfig(cfg: unknown): Buffer {
	if (!cfg || typeof cfg !== "object") return Buffer.alloc(0);
	const rec = cfg as ProtoRecord;
	const chunks: Buffer[] = [];
	if (typeof rec.maxTokens === "number") chunks.push(encodeInt32(1, rec.maxTokens, { force: true }));
	else if (typeof rec.max_tokens === "number") chunks.push(encodeInt32(1, rec.max_tokens, { force: true }));
	if (typeof rec.temperature === "number") chunks.push(encodeFloat(2, rec.temperature));
	if (typeof rec.topP === "number") chunks.push(encodeFloat(3, rec.topP));
	else if (typeof rec.top_p === "number") chunks.push(encodeFloat(3, rec.top_p));
	const stops = rec.stopSequences || rec.stop_sequences || [];
	if (Array.isArray(stops)) {
		for (const s of stops) {
			if (typeof s === "string") chunks.push(encodeString(4, s));
		}
	}
	return concat(chunks);
}

function encodeCustomToolFormat(fmt: unknown): Buffer {
	if (!fmt || typeof fmt !== "object") return Buffer.alloc(0);
	const rec = fmt as ProtoRecord;
	return concat([
		encodeString(1, rec.type || ""),
		encodeString(2, rec.definition || ""),
		encodeString(3, rec.syntax || ""),
	]);
}

function encodeTool(tool: ProtoRecord): Buffer {
	const chunks = [
		encodeString(1, tool.name || ""),
		encodeString(2, tool.description || ""),
		encodeMessage(3, encodeStruct(tool.parameters || { type: "object", properties: {} })),
	];
	const custom = tool.customToolFormat || tool.custom_tool_format;
	if (custom) chunks.push(encodeMessage(4, encodeCustomToolFormat(custom)));
	return concat(chunks);
}

/** InferenceNamedProviderDefinedTool — field 3 (distinct from field 2 agent tools). */
function encodeNamedProviderDefinedTool(tool: ProtoRecord): Buffer {
	const chunks = [
		encodeString(1, tool.name || "", { force: true }),
		encodeString(2, tool.id || "", { force: true }),
		encodeString(3, tool.type || "", { force: true }),
	];
	const options = tool.options ?? tool.parameters;
	if (options && typeof options === "object" && !Array.isArray(options)) {
		chunks.push(encodeMessage(4, encodeStruct(options), { omitEmpty: false }));
	}
	return concat(chunks);
}

function encodeToolCall(tc: ProtoRecord): Buffer {
	const chunks = [
		encodeString(1, tc.toolCallId || tc.tool_call_id || ""),
		encodeString(2, tc.toolName || tc.tool_name || ""),
	];
	if (tc.args && typeof tc.args === "object") {
		// Preserve empty Struct args (`{}`) so the protobuf args/raw oneof
		// discriminator survives history replay — same contract as empty-string raw.
		chunks.push(encodeMessage(3, encodeStruct(tc.args), { omitEmpty: false }));
	}
	const raw = Object.hasOwn(tc, "rawToolCallArgs")
		? tc.rawToolCallArgs
		: Object.hasOwn(tc, "raw_tool_call_args")
			? tc.raw_tool_call_args
			: undefined;
	// Preserve empty-string raw grammar args (oneof discriminator); `||` would drop "".
	if (typeof raw === "string") chunks.push(encodeString(4, raw, { force: true }));
	return concat(chunks);
}

function encodeReasoningPart(p: ProtoRecord): Buffer {
	return concat([
		encodeBool(1, Boolean(p.isRedacted || p.is_redacted)),
		encodeString(2, p.text || ""),
		p.signature ? encodeString(3, p.signature, { force: true }) : Buffer.alloc(0),
		p.redactedData || p.redacted_data
			? encodeString(4, p.redactedData || p.redacted_data, { force: true })
			: Buffer.alloc(0),
		p.modelName || p.model_name ? encodeString(5, p.modelName || p.model_name, { force: true }) : Buffer.alloc(0),
	]);
}

function encodeTextContentPart(p: ProtoRecord): Buffer {
	return encodeString(1, p.text || "", { force: true });
}

function encodeImageContentPart(p: ProtoRecord): Buffer {
	return concat([
		encodeString(1, p.data || "", { force: true }),
		p.mimeType || p.mime_type ? encodeString(2, p.mimeType || p.mime_type) : Buffer.alloc(0),
	]);
}

function encodeContentPart(p: unknown): Buffer {
	if (!p || typeof p !== "object") return Buffer.alloc(0);
	const rec = p as ProtoRecord;
	if (rec.type === "image" || rec.image) {
		const image = rec.image && typeof rec.image === "object" ? (rec.image as ProtoRecord) : rec;
		return encodeMessage(2, encodeImageContentPart(image));
	}
	const text = rec.text && typeof rec.text === "object" ? (rec.text as ProtoRecord) : rec;
	return encodeMessage(1, encodeTextContentPart(text));
}

function encodeContentParts(partsMsg: unknown): Buffer {
	const parts = Array.isArray(partsMsg)
		? partsMsg
		: partsMsg && typeof partsMsg === "object" && Array.isArray((partsMsg as ProtoRecord).parts)
			? ((partsMsg as ProtoRecord).parts as unknown[])
			: [];
	const chunks: Buffer[] = [];
	for (const p of parts) chunks.push(encodeMessage(1, encodeContentPart(p as ProtoRecord)));
	return concat(chunks);
}

function encodeToolResultPart(p: ProtoRecord): Buffer {
	const chunks = [
		encodeString(1, p.toolCallId || p.tool_call_id || ""),
		encodeString(2, p.toolName || p.tool_name || ""),
	];
	if (p.result !== undefined) {
		chunks.push(encodeMessage(3, encodeValue(p.result), { omitEmpty: false }));
	}
	if (p.isError || p.is_error) chunks.push(encodeBool(4, true));
	const experimental = p.experimentalContent || p.experimental_content;
	if (Array.isArray(experimental)) {
		for (const item of experimental) {
			chunks.push(encodeMessage(5, encodeContentPart(item)));
		}
	}
	return concat(chunks);
}

function encodeToolContent(tc: ProtoRecord | undefined | null): Buffer {
	const parts = Array.isArray(tc?.parts) ? (tc.parts as unknown[]) : [];
	const chunks: Buffer[] = [];
	for (const p of parts) chunks.push(encodeMessage(1, encodeToolResultPart(p as ProtoRecord)));
	return concat(chunks);
}

function encodeCoreMessage(msg: ProtoRecord): Buffer {
	const role = typeof msg.role === "number" ? msg.role : 0;
	const chunks = [encodeEnum(1, role)];
	if (msg.toolContent || msg.tool_content) {
		chunks.push(
			encodeMessage(6, encodeToolContent((msg.toolContent || msg.tool_content) as ProtoRecord), {
				omitEmpty: false,
			}),
		);
	} else if (msg.parts) {
		chunks.push(encodeMessage(3, encodeContentParts(msg.parts), { omitEmpty: false }));
	} else if (typeof msg.text === "string") {
		chunks.push(encodeString(2, msg.text, { force: true }));
	}
	const toolCalls = Array.isArray(msg.toolCalls) ? msg.toolCalls : Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
	for (const tc of toolCalls) chunks.push(encodeMessage(4, encodeToolCall(tc as ProtoRecord)));
	const reasoning = Array.isArray(msg.reasoningParts)
		? msg.reasoningParts
		: Array.isArray(msg.reasoning_parts)
			? msg.reasoning_parts
			: [];
	for (const rp of reasoning) chunks.push(encodeMessage(7, encodeReasoningPart(rp as ProtoRecord)));
	return concat(chunks);
}

export function encodeInferenceStreamRequest(req: ProtoRecord): Buffer {
	const chunks: Buffer[] = [];
	const messages = Array.isArray(req.messages) ? req.messages : [];
	for (const m of messages) chunks.push(encodeMessage(1, encodeCoreMessage(m as ProtoRecord)));
	const tools = Array.isArray(req.tools) ? req.tools : [];
	for (const t of tools) chunks.push(encodeMessage(2, encodeTool(t as ProtoRecord)));
	const providerTools = Array.isArray(req.providerDefinedTools)
		? req.providerDefinedTools
		: Array.isArray(req.provider_defined_tools)
			? req.provider_defined_tools
			: [];
	for (const t of providerTools) chunks.push(encodeMessage(3, encodeNamedProviderDefinedTool(t as ProtoRecord)));
	const modelConfig = req.modelConfig || req.model_config;
	if (modelConfig) chunks.push(encodeMessage(4, encodeModelConfig(modelConfig)));
	const invocationId = req.invocationId || req.invocation_id;
	if (invocationId) chunks.push(encodeString(6, invocationId));
	const requested = req.requestedModel || req.requested_model;
	if (requested) chunks.push(encodeMessage(7, encodeRequestedModel(requested)));
	const conversationId = req.conversationId || req.conversation_id;
	if (conversationId) chunks.push(encodeString(8, conversationId));
	const acceptedNames =
		req.acceptedUnadvertisedToolNames ||
		req.accepted_unadvertised_tool_names ||
		req.acceptedUnadvertisedToolName ||
		[];
	if (Array.isArray(acceptedNames)) {
		for (const name of acceptedNames) {
			if (typeof name === "string" && name.trim()) chunks.push(encodeString(9, name.trim()));
		}
	}
	const automationId = req.automationId || req.automation_id;
	if (typeof automationId === "string" && automationId.trim()) {
		chunks.push(encodeString(10, automationId.trim()));
	}
	const conversationGroupId = req.conversationGroupId || req.conversation_group_id;
	if (typeof conversationGroupId === "string" && conversationGroupId.trim()) {
		chunks.push(encodeString(12, conversationGroupId.trim()));
	}
	const parentRequestId = req.parentRequestId || req.parent_request_id;
	if (typeof parentRequestId === "string" && parentRequestId.trim()) {
		chunks.push(encodeString(13, parentRequestId.trim()));
	}
	const rootParentRequestId = req.rootParentRequestId || req.root_parent_request_id;
	if (typeof rootParentRequestId === "string" && rootParentRequestId.trim()) {
		chunks.push(encodeString(14, rootParentRequestId.trim()));
	}
	const parentAgentToolCallId = req.parentAgentToolCallId || req.parent_agent_tool_call_id;
	if (typeof parentAgentToolCallId === "string" && parentAgentToolCallId.trim()) {
		chunks.push(encodeString(15, parentAgentToolCallId.trim()));
	}
	const subagentType = req.subagentType || req.subagent_type;
	if (typeof subagentType === "string" && subagentType.trim()) {
		chunks.push(encodeString(16, subagentType.trim()));
	}
	return concat(chunks);
}

function decodeVarint(buf: Buffer, pos: number): [number | bigint, number] {
	let n = 0n;
	let shift = 0n;
	while (pos < buf.length) {
		const b = BigInt(buf[pos++]);
		n |= (b & 0x7fn) << shift;
		if ((b & 0x80n) === 0n) {
			const asNum = n <= 0xffffffffn ? Number(n) : n;
			return [asNum, pos];
		}
		shift += 7n;
		if (shift > 70n) throw new Error("varint too long");
	}
	throw new Error("truncated varint");
}

function decodeFields(buf: BytesLike | undefined | null): DecodedField[] {
	const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
	const fields: DecodedField[] = [];
	let pos = 0;
	while (pos < bytes.length) {
		const [tag, p1] = decodeVarint(bytes, pos);
		const tagNum = typeof tag === "bigint" ? Number(tag) : tag;
		const fieldNo = tagNum >>> 3;
		const wire = tagNum & 7;
		pos = p1;
		// Protobuf field numbers are 1..536870911; zero is illegal and would
		// otherwise decode as a no-op field, turning malformed frames into {}.
		if (fieldNo === 0) throw new Error("protobuf field number must be non-zero");
		if (wire === WIRE_VARINT) {
			const [v, p2] = decodeVarint(bytes, pos);
			fields.push({ fieldNo, wire, value: v });
			pos = p2;
		} else if (wire === WIRE_64) {
			if (pos + 8 > bytes.length) throw new Error("truncated 64-bit");
			fields.push({ fieldNo, wire, bytes: bytes.subarray(pos, pos + 8) });
			pos += 8;
		} else if (wire === WIRE_LEN) {
			const [lenRaw, p2] = decodeVarint(bytes, pos);
			const len = typeof lenRaw === "bigint" ? Number(lenRaw) : lenRaw;
			pos = p2;
			if (pos + len > bytes.length) throw new Error("truncated len");
			fields.push({ fieldNo, wire, bytes: bytes.subarray(pos, pos + len) });
			pos += len;
		} else if (wire === WIRE_32) {
			if (pos + 4 > bytes.length) throw new Error("truncated 32-bit");
			fields.push({ fieldNo, wire, bytes: bytes.subarray(pos, pos + 4) });
			pos += 4;
		} else {
			throw new Error(`unknown wire type ${wire}`);
		}
	}
	return fields;
}

export function fieldNumbers(buf: BytesLike): number[] {
	return decodeFields(buf).map(f => f.fieldNo);
}

function asString(f: DecodedField | undefined): string {
	return f?.bytes ? Buffer.from(f.bytes).toString("utf8") : "";
}

function asBool(f: DecodedField | undefined): boolean {
	if (!f) return false;
	if (f.wire === WIRE_VARINT) return Boolean(f.value);
	return false;
}

function asInt(f: DecodedField | undefined): number {
	if (!f) return 0;
	if (f.wire === WIRE_VARINT) {
		const v = f.value;
		if (typeof v === "bigint") return Number(v);
		return typeof v === "number" ? v : 0;
	}
	return 0;
}

/** Require a present field to be length-delimited string; missing → "". */
function requireStringField(f: DecodedField | undefined, label: string): string {
	if (!f) return "";
	if (f.wire !== WIRE_LEN || !f.bytes) {
		throw new Error(`protobuf ${label} must be length-delimited string`);
	}
	return Buffer.from(f.bytes).toString("utf8");
}

/** Require a present field to be varint bool; missing → false. */
function requireBoolField(f: DecodedField | undefined, label: string): boolean {
	if (!f) return false;
	if (f.wire !== WIRE_VARINT) {
		throw new Error(`protobuf ${label} must be varint`);
	}
	return Boolean(f.value);
}

/** Require a present field to be varint int; missing → 0. */
function requireIntField(f: DecodedField | undefined, label: string): number {
	if (!f) return 0;
	if (f.wire !== WIRE_VARINT) {
		throw new Error(`protobuf ${label} must be varint`);
	}
	const v = f.value;
	if (typeof v === "bigint") return Number(v);
	return typeof v === "number" ? v : 0;
}

function asFloat(f: DecodedField | undefined): number {
	if (!f?.bytes || f.bytes.length < 4) return 0;
	return Buffer.from(f.bytes).readFloatLE(0);
}

function asDouble(f: DecodedField | undefined): number {
	if (!f?.bytes || f.bytes.length < 8) return 0;
	return Buffer.from(f.bytes).readDoubleLE(0);
}

function first(fields: readonly DecodedField[], n: number): DecodedField | undefined {
	return fields.find(f => f.fieldNo === n);
}

function all(fields: readonly DecodedField[], n: number): DecodedField[] {
	return fields.filter(f => f.fieldNo === n);
}

function fieldBytes(f: DecodedField | undefined): Buffer {
	if (!f?.bytes) throw new Error("protobuf length-delimited field missing bytes");
	return f.bytes;
}

function decodeValue(buf: BytesLike | undefined): unknown {
	const fields = decodeFields(buf);
	for (const f of fields) {
		if (f.fieldNo === 1) return null;
		if (f.fieldNo === 2) return asDouble(f);
		if (f.fieldNo === 3) return asString(f);
		if (f.fieldNo === 4) return asBool(f);
		if (f.fieldNo === 5) return decodeStruct(fieldBytes(f));
		if (f.fieldNo === 6) return decodeListValue(fieldBytes(f));
	}
	return undefined;
}

function decodeListValue(buf: BytesLike | undefined): unknown[] {
	return all(decodeFields(buf), 1).map(f => decodeValue(fieldBytes(f)));
}

function decodeStruct(buf: BytesLike | undefined): ProtoRecord {
	const out: ProtoRecord = {};
	for (const entry of all(decodeFields(buf), 1)) {
		const ef = decodeFields(fieldBytes(entry));
		const key = asString(first(ef, 1));
		const valField = first(ef, 2);
		out[key] = valField ? decodeValue(fieldBytes(valField)) : undefined;
	}
	return out;
}

function decodeRequestedModel(buf: BytesLike): ProtoRecord {
	const fields = decodeFields(buf);
	const parameters = all(fields, 3).map(f => {
		const pf = decodeFields(fieldBytes(f));
		return { id: asString(first(pf, 1)), value: asString(first(pf, 2)) };
	});
	return {
		modelId: asString(first(fields, 1)),
		maxMode: asBool(first(fields, 2)),
		parameters,
		builtInModel: asBool(first(fields, 4)),
		isVariantStringRepresentation: asBool(first(fields, 5)),
	};
}

function decodeModelConfig(buf: BytesLike): ProtoRecord {
	const fields = decodeFields(buf);
	const out: ProtoRecord = {};
	const max = first(fields, 1);
	if (max) out.maxTokens = asInt(max);
	const temp = first(fields, 2);
	if (temp) out.temperature = asFloat(temp);
	const topP = first(fields, 3);
	if (topP) out.topP = asFloat(topP);
	const stops = all(fields, 4).map(asString);
	if (stops.length) out.stopSequences = stops;
	return out;
}

function decodeTool(buf: BytesLike): ProtoRecord {
	const fields = decodeFields(buf);
	const out: ProtoRecord = {
		name: asString(first(fields, 1)),
		description: asString(first(fields, 2)),
		parameters: first(fields, 3) ? decodeStruct(fieldBytes(first(fields, 3))) : {},
	};
	const custom = first(fields, 4);
	if (custom) {
		const cf = decodeFields(fieldBytes(custom));
		out.customToolFormat = {
			type: asString(first(cf, 1)),
			definition: asString(first(cf, 2)),
			syntax: asString(first(cf, 3)),
		};
	}
	return out;
}

function decodeNamedProviderDefinedTool(buf: BytesLike): ProtoRecord {
	const fields = decodeFields(buf);
	const out: ProtoRecord = {
		name: asString(first(fields, 1)),
		id: asString(first(fields, 2)),
		type: asString(first(fields, 3)),
	};
	if (first(fields, 4)) out.options = decodeStruct(fieldBytes(first(fields, 4)));
	return out;
}

function decodeToolCall(buf: BytesLike): ProtoRecord {
	const fields = decodeFields(buf);
	const out: ProtoRecord = {
		toolCallId: asString(first(fields, 1)),
		toolName: asString(first(fields, 2)),
	};
	if (first(fields, 3)) out.args = decodeStruct(fieldBytes(first(fields, 3)));
	if (first(fields, 4)) out.rawToolCallArgs = asString(first(fields, 4));
	return out;
}

function decodeReasoningPart(buf: BytesLike): ProtoRecord {
	const fields = decodeFields(buf);
	const out: ProtoRecord = {
		isRedacted: asBool(first(fields, 1)),
		text: asString(first(fields, 2)),
	};
	if (first(fields, 3)) out.signature = asString(first(fields, 3));
	if (first(fields, 4)) out.redactedData = asString(first(fields, 4));
	if (first(fields, 5)) out.modelName = asString(first(fields, 5));
	return out;
}

function decodeContentPart(buf: BytesLike): ProtoRecord | undefined {
	const fields = decodeFields(buf);
	const text = first(fields, 1);
	if (text) {
		const tf = decodeFields(fieldBytes(text));
		return { type: "text", text: asString(first(tf, 1)) };
	}
	const image = first(fields, 2);
	if (image) {
		const imgf = decodeFields(fieldBytes(image));
		const out: ProtoRecord = { type: "image", data: asString(first(imgf, 1)) };
		if (first(imgf, 2)) out.mimeType = asString(first(imgf, 2));
		return out;
	}
	return undefined;
}

function decodeContentParts(buf: BytesLike): { parts: ProtoRecord[] } {
	return {
		parts: all(decodeFields(buf), 1)
			.map(f => decodeContentPart(fieldBytes(f)))
			.filter((part): part is ProtoRecord => part !== undefined),
	};
}

function decodeToolResultPart(buf: BytesLike): ProtoRecord {
	const fields = decodeFields(buf);
	const out: ProtoRecord = {
		toolCallId: asString(first(fields, 1)),
		toolName: asString(first(fields, 2)),
	};
	if (first(fields, 3)) out.result = decodeValue(fieldBytes(first(fields, 3)));
	if (asBool(first(fields, 4))) out.isError = true;
	const experimental = all(fields, 5)
		.map(f => decodeContentPart(fieldBytes(f)))
		.filter((part): part is ProtoRecord => part !== undefined);
	if (experimental.length) out.experimentalContent = experimental;
	return out;
}

function decodeToolContent(buf: BytesLike): { parts: ProtoRecord[] } {
	return { parts: all(decodeFields(buf), 1).map(f => decodeToolResultPart(fieldBytes(f))) };
}

function decodeCoreMessage(buf: BytesLike): ProtoRecord {
	const fields = decodeFields(buf);
	const msg: ProtoRecord = { role: asInt(first(fields, 1)) };
	if (first(fields, 2)) msg.text = asString(first(fields, 2));
	if (first(fields, 3)) msg.parts = decodeContentParts(fieldBytes(first(fields, 3)));
	if (first(fields, 6)) msg.toolContent = decodeToolContent(fieldBytes(first(fields, 6)));
	const tcs = all(fields, 4).map(f => decodeToolCall(fieldBytes(f)));
	if (tcs.length) msg.toolCalls = tcs;
	const rps = all(fields, 7).map(f => decodeReasoningPart(fieldBytes(f)));
	if (rps.length) msg.reasoningParts = rps;
	return msg;
}

export function decodeInferenceStreamRequest(buf: BytesLike): ProtoRecord {
	const fields = decodeFields(buf);
	const out: ProtoRecord = {
		messages: all(fields, 1).map(f => decodeCoreMessage(fieldBytes(f))),
		tools: all(fields, 2).map(f => decodeTool(fieldBytes(f))),
		_fieldNumbers: fields.map(f => f.fieldNo),
	};
	const providerDefined = all(fields, 3).map(f => decodeNamedProviderDefinedTool(fieldBytes(f)));
	if (providerDefined.length > 0) out.providerDefinedTools = providerDefined;
	if (first(fields, 4)) out.modelConfig = decodeModelConfig(fieldBytes(first(fields, 4)));
	if (first(fields, 5)) out.modelId = asString(first(fields, 5));
	if (first(fields, 6)) out.invocationId = asString(first(fields, 6));
	if (first(fields, 7)) out.requestedModel = decodeRequestedModel(fieldBytes(first(fields, 7)));
	if (first(fields, 8)) out.conversationId = asString(first(fields, 8));
	if (first(fields, 9)) {
		const names = all(fields, 9)
			.map(f => asString(f))
			.filter(name => typeof name === "string" && name.length > 0);
		if (names.length > 0) out.acceptedUnadvertisedToolNames = names;
		else out.acceptedUnadvertised = true;
	}
	if (first(fields, 10)) out.automationId = asString(first(fields, 10));
	if (first(fields, 11)) out.inferenceReason = asInt(first(fields, 11));
	if (first(fields, 12)) out.conversationGroupId = asString(first(fields, 12));
	if (first(fields, 13)) out.parentRequestId = asString(first(fields, 13));
	if (first(fields, 14)) out.rootParentRequestId = asString(first(fields, 14));
	if (first(fields, 15)) out.parentAgentToolCallId = asString(first(fields, 15));
	if (first(fields, 16)) out.subagentType = asString(first(fields, 16));
	return out;
}

function encodeTextStreamPart(p: ProtoRecord): Buffer {
	return concat([
		encodeString(1, p.text || "", { force: Boolean(p.text === "") }),
		encodeBool(2, Boolean(p.isFinal || p.is_final)),
	]);
}

function encodeThinkingStreamPart(p: ProtoRecord): Buffer {
	return concat([
		encodeString(1, p.text || ""),
		p.signature ? encodeString(2, p.signature, { force: true }) : Buffer.alloc(0),
		encodeBool(3, Boolean(p.isFinal || p.is_final)),
	]);
}

function encodeToolCallStreamPart(p: ProtoRecord): Buffer {
	const chunks = [
		encodeString(1, p.toolCallId || p.tool_call_id || ""),
		encodeString(2, p.toolName || p.tool_name || ""),
		encodeString(3, p.args == null ? "" : typeof p.args === "string" ? p.args : JSON.stringify(p.args)),
		encodeBool(4, Boolean(p.isComplete || p.is_complete)),
	];
	const idx = p.toolIndex ?? p.tool_index;
	if (typeof idx === "number") chunks.push(encodeInt32(5, idx, { force: true }));
	return concat(chunks);
}

function encodeUsage(u: ProtoRecord): Buffer {
	return concat([
		encodeInt32(1, u.promptTokens ?? u.prompt_tokens ?? 0),
		encodeInt32(2, u.completionTokens ?? u.completion_tokens ?? 0),
		u.totalTokens != null || u.total_tokens != null
			? encodeInt32(3, u.totalTokens ?? u.total_tokens, { force: true })
			: Buffer.alloc(0),
	]);
}

function encodeExtendedUsage(u: ProtoRecord): Buffer {
	return concat([
		encodeInt32(1, u.inputTokens ?? u.input_tokens ?? 0),
		encodeInt32(2, u.outputTokens ?? u.output_tokens ?? 0),
		encodeInt32(3, u.cacheReadTokens ?? u.cache_read_tokens ?? 0),
		encodeInt32(4, u.cacheWriteTokens ?? u.cache_write_tokens ?? 0),
		encodeInt32(5, u.maxTokens ?? u.max_tokens ?? 0),
	]);
}

function encodeResponseInfo(info: ProtoRecord): Buffer {
	const chunks = [encodeString(1, info.id || ""), encodeString(2, info.model || "")];
	const errMsg = info.errorMessage || info.error_message;
	if (typeof errMsg === "string" && errMsg) chunks.push(encodeString(5, errMsg, { force: true }));
	return concat(chunks);
}

function encodeInvocationIdInfo(info: unknown): Buffer {
	const id =
		typeof info === "string"
			? info
			: info && typeof info === "object"
				? String((info as ProtoRecord).invocationId || (info as ProtoRecord).invocation_id || "")
				: "";
	return encodeString(1, id);
}

function encodeStreamError(err: ProtoRecord): Buffer {
	return concat([
		encodeString(1, err.message || ""),
		encodeString(2, err.code || ""),
		encodeBool(3, Boolean(err.isInputTokenLimitError || err.is_input_token_limit_error)),
		encodeBool(4, Boolean(err.isOutputTokenLimitError || err.is_output_token_limit_error)),
		encodeEnum(5, err.errorType || err.error_type || 0),
	]);
}

export function encodeInferenceStreamResponse(resp: ProtoRecord): Buffer {
	if (resp.textPart || resp.text_part) {
		return encodeMessage(1, encodeTextStreamPart((resp.textPart || resp.text_part) as ProtoRecord));
	}
	if (resp.toolCallPart || resp.tool_call_part) {
		return encodeMessage(2, encodeToolCallStreamPart((resp.toolCallPart || resp.tool_call_part) as ProtoRecord));
	}
	if (resp.usage) return encodeMessage(3, encodeUsage(resp.usage as ProtoRecord));
	if (resp.responseInfo || resp.response_info) {
		return encodeMessage(4, encodeResponseInfo((resp.responseInfo || resp.response_info) as ProtoRecord));
	}
	if (resp.extendedUsage || resp.extended_usage) {
		return encodeMessage(5, encodeExtendedUsage((resp.extendedUsage || resp.extended_usage) as ProtoRecord));
	}
	if (resp.invocationId || resp.invocation_id) {
		return encodeMessage(7, encodeInvocationIdInfo(resp.invocationId || resp.invocation_id));
	}
	if (resp.error) return encodeMessage(8, encodeStreamError(resp.error as ProtoRecord));
	if (resp.thinkingPart || resp.thinking_part) {
		return encodeMessage(9, encodeThinkingStreamPart((resp.thinkingPart || resp.thinking_part) as ProtoRecord));
	}
	return Buffer.alloc(0);
}

function decodeTextPart(buf: BytesLike): ProtoRecord {
	const fields = decodeFields(buf);
	return {
		text: requireStringField(first(fields, 1), "textPart.text"),
		isFinal: requireBoolField(first(fields, 2), "textPart.isFinal"),
	};
}

function decodeThinkingPart(buf: BytesLike): ProtoRecord {
	const fields = decodeFields(buf);
	const out: ProtoRecord = {
		text: requireStringField(first(fields, 1), "thinkingPart.text"),
		isFinal: requireBoolField(first(fields, 3), "thinkingPart.isFinal"),
	};
	if (first(fields, 2)) out.signature = requireStringField(first(fields, 2), "thinkingPart.signature");
	return out;
}

function decodeToolCallPart(buf: BytesLike): ProtoRecord {
	const fields = decodeFields(buf);
	const out: ProtoRecord = {
		toolCallId: requireStringField(first(fields, 1), "toolCallPart.toolCallId"),
		toolName: requireStringField(first(fields, 2), "toolCallPart.toolName"),
		args: requireStringField(first(fields, 3), "toolCallPart.args"),
		isComplete: requireBoolField(first(fields, 4), "toolCallPart.isComplete"),
	};
	if (first(fields, 5)) out.toolIndex = requireIntField(first(fields, 5), "toolCallPart.toolIndex");
	return out;
}

function decodeUsage(buf: BytesLike): ProtoRecord {
	const fields = decodeFields(buf);
	return {
		promptTokens: requireIntField(first(fields, 1), "usage.promptTokens"),
		completionTokens: requireIntField(first(fields, 2), "usage.completionTokens"),
		totalTokens: first(fields, 3) ? requireIntField(first(fields, 3), "usage.totalTokens") : undefined,
	};
}

function decodeExtendedUsage(buf: BytesLike): ProtoRecord {
	const fields = decodeFields(buf);
	return {
		inputTokens: requireIntField(first(fields, 1), "extendedUsage.inputTokens"),
		outputTokens: requireIntField(first(fields, 2), "extendedUsage.outputTokens"),
		cacheReadTokens: requireIntField(first(fields, 3), "extendedUsage.cacheReadTokens"),
		cacheWriteTokens: requireIntField(first(fields, 4), "extendedUsage.cacheWriteTokens"),
		maxTokens: requireIntField(first(fields, 5), "extendedUsage.maxTokens"),
	};
}

function decodeResponseInfo(buf: BytesLike): ProtoRecord {
	const fields = decodeFields(buf);
	const out: ProtoRecord = {
		id: requireStringField(first(fields, 1), "responseInfo.id"),
		model: requireStringField(first(fields, 2), "responseInfo.model"),
	};
	if (first(fields, 5)) out.errorMessage = requireStringField(first(fields, 5), "responseInfo.errorMessage");
	return out;
}

function decodeInvocationId(buf: BytesLike): ProtoRecord {
	const fields = decodeFields(buf);
	return { invocationId: requireStringField(first(fields, 1), "invocationId.invocationId") };
}

function decodeError(buf: BytesLike): ProtoRecord {
	const fields = decodeFields(buf);
	return {
		message: requireStringField(first(fields, 1), "error.message"),
		code: requireStringField(first(fields, 2), "error.code"),
		isInputTokenLimitError: requireBoolField(first(fields, 3), "error.isInputTokenLimitError"),
		isOutputTokenLimitError: requireBoolField(first(fields, 4), "error.isOutputTokenLimitError"),
		errorType: requireIntField(first(fields, 5), "error.errorType"),
	};
}

/** Known InferenceStreamResponse oneofs are length-delimited messages. */
function requireLenBytes(f: DecodedField, label: string): Buffer {
	if (f.wire !== WIRE_LEN || !f.bytes) {
		throw new Error(`protobuf field ${f.fieldNo} (${label}) must be length-delimited`);
	}
	return f.bytes;
}

export function decodeInferenceStreamResponse(buf: BytesLike): ProtoRecord {
	const fields = decodeFields(buf);
	const out: ProtoRecord = {};
	for (const f of fields) {
		if (f.fieldNo === 1) out.textPart = decodeTextPart(requireLenBytes(f, "textPart"));
		else if (f.fieldNo === 2) out.toolCallPart = decodeToolCallPart(requireLenBytes(f, "toolCallPart"));
		else if (f.fieldNo === 3) out.usage = decodeUsage(requireLenBytes(f, "usage"));
		else if (f.fieldNo === 4) out.responseInfo = decodeResponseInfo(requireLenBytes(f, "responseInfo"));
		else if (f.fieldNo === 5) out.extendedUsage = decodeExtendedUsage(requireLenBytes(f, "extendedUsage"));
		else if (f.fieldNo === 6) {
			const mf = decodeFields(requireLenBytes(f, "providerMetadata"));
			const meta = first(mf, 1);
			out.providerMetadata = { metadata: meta ? decodeStruct(fieldBytes(meta)) : {} };
		} else if (f.fieldNo === 7) out.invocationId = decodeInvocationId(requireLenBytes(f, "invocationId"));
		else if (f.fieldNo === 8) out.error = decodeError(requireLenBytes(f, "error"));
		else if (f.fieldNo === 9) out.thinkingPart = decodeThinkingPart(requireLenBytes(f, "thinkingPart"));
	}
	return out;
}
