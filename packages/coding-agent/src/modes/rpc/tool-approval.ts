import { type } from "@oh-my-pi/omptype";
import { SENSITIVE_TOKEN_RE } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { isRecord, sanitizeText, Snowflake } from "@oh-my-pi/pi-utils";
import type { ToolApprovalDialogOptions, ToolApprovalRequest } from "../../tools/approval";
import type {
	RpcToolApprovalCancelRequest,
	RpcToolApprovalIdentity,
	RpcToolApprovalRequest,
	RpcToolApprovalResponse,
	RpcToolApprovalValue,
} from "./rpc-types";

export const RPC_TOOL_APPROVAL_MAX_FRAME_BYTES = 64 * 1024;
export const RPC_TOOL_APPROVAL_MAX_STRING_BYTES = 8 * 1024;
export const RPC_TOOL_APPROVAL_MAX_COLLECTION_ITEMS = 32;
export const RPC_TOOL_APPROVAL_MAX_DEPTH = 4;

const RPC_TOOL_APPROVAL_INPUT_BUDGET_BYTES = 20 * 1024;
const RPC_TOOL_APPROVAL_MAX_INPUT_NODES = 256;
const RPC_TOOL_APPROVAL_MAX_ID_BYTES = 512;
const RPC_TOOL_APPROVAL_MAX_TOOL_NAME_BYTES = 256;
const RPC_TOOL_APPROVAL_MAX_DETAIL_LINES = 16;
const RPC_TOOL_APPROVAL_MAX_DETAIL_BYTES = 2 * 1024;
const RPC_TOOL_APPROVAL_MAX_METADATA_FIELDS = 32;
const RPC_TOOL_APPROVAL_MAX_METADATA_FIELD_BYTES = 64;
const RPC_TOOL_APPROVAL_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const RPC_TOOL_APPROVAL_SHELL_COMMAND_BYTES = 24 * 1024;
const RPC_TOOL_APPROVAL_PATH_BYTES = 4 * 1024;
const RPC_TOOL_APPROVAL_EDIT_PATHS_BYTES = 8 * 1024;
const RPC_TOOL_APPROVAL_CONTENT_BYTES = 20 * 1024;
const REDACTED_VALUE = "[redacted]";
const TRUNCATED_VALUE = "[truncated]";
const VALUE_SECRET_RE = new RegExp(SENSITIVE_TOKEN_RE.source, SENSITIVE_TOKEN_RE.flags);
const INLINE_SECRET_RE =
	/(\b(?:token|secret|password|api[_-]?key|authorization)[\w-]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const SENSITIVE_INPUT_KEYS: Record<string, true> = {
	authorization: true,
	cookie: true,
	credential: true,
	credentials: true,
	password: true,
	passwd: true,
	secret: true,
	token: true,
	apikey: true,
	privatekey: true,
	accesskey: true,
};

const requestSchema = type({
	type: "'tool_approval_request'",
	id: "string > 0",
	toolCallId: "string > 0",
	toolKind: "'shell' | 'edit' | 'write' | 'other'",
	toolName: "string > 0",
	tier: "'read' | 'write' | 'exec'",
	identity: { "[string]": "unknown" },
	input: { "[string]": "unknown" },
	detail: {
		lines: "string[]",
		truncated: "boolean",
		truncatedFields: "string[]",
		redacted: "boolean",
		redactedFields: "string[]",
		"reason?": "string",
		"providerSafetyChecks?": "string[]",
		"+": "reject",
	},
	"timeout?": "number",
	"+": "reject",
});
const cancelRequestSchema = type({
	type: "'tool_approval_cancel'",
	id: "string > 0",
	targetId: "string > 0",
	toolCallId: "string > 0",
	"+": "reject",
});
const approvedResponseSchema = type({
	type: "'tool_approval_response'",
	id: "string > 0",
	toolCallId: "string > 0",
	approved: "boolean",
	"+": "reject",
});
const cancelledResponseSchema = type({
	type: "'tool_approval_response'",
	id: "string > 0",
	toolCallId: "string > 0",
	cancelled: "true",
	"timedOut?": "boolean",
	"+": "reject",
});
const responseSchema = approvedResponseSchema.or(cancelledResponseSchema);

interface ApprovalMetadata {
	truncatedFields: Set<string>;
	redactedFields: Set<string>;
}

interface SanitizeState extends ApprovalMetadata {
	remainingBytes: number;
	remainingNodes: number;
	seen: Set<object>;
}

interface MutableToolApprovalFrame {
	type: "tool_approval_request";
	id: string;
	toolCallId: string;
	toolKind: ToolApprovalRequest["toolKind"];
	toolName: string;
	tier: ToolApprovalRequest["tier"];
	identity: RpcToolApprovalIdentity;
	input: { [key: string]: RpcToolApprovalValue };
	detail: {
		lines: string[];
		truncated: boolean;
		truncatedFields: string[];
		redacted: boolean;
		redactedFields: string[];
		reason?: string;
		providerSafetyChecks?: string[];
	};
	timeout?: number;
}

type RpcToolApprovalOutput = (frame: RpcToolApprovalRequest | RpcToolApprovalCancelRequest) => void;

type PendingToolApproval = {
	toolCallId: string;
	resolve: (approved: boolean) => void;
	reject: (error: Error) => void;
	onTimeout?: () => void;
};

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function jsonStringBytes(value: string): number {
	return byteLength(JSON.stringify(value)) - 2;
}

function frameBytes(frame: object): number {
	return byteLength(JSON.stringify(frame)) + 1;
}

function truncateUtf8(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.byteLength <= maxBytes) return value;
	let end = Math.max(0, maxBytes);
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

function metadataField(field: string): string {
	return truncateUtf8(field, RPC_TOOL_APPROVAL_MAX_METADATA_FIELD_BYTES);
}

function markField(fields: Set<string>, field: string): void {
	if (fields.size >= RPC_TOOL_APPROVAL_MAX_METADATA_FIELDS) {
		fields.add("additional");
		return;
	}
	fields.add(metadataField(field));
}

function redactApprovalText(value: string): { value: string; redacted: boolean } {
	const sanitized = sanitizeText(value);
	const credentialRedacted = sanitized.replace(VALUE_SECRET_RE, REDACTED_VALUE);
	const redacted = credentialRedacted.replace(INLINE_SECRET_RE, `$1${REDACTED_VALUE}`);
	return { value: redacted, redacted: redacted !== sanitized };
}

function boundedJsonString(value: string, maxBytes: number, metadata: ApprovalMetadata, field: string): string {
	const safe = redactApprovalText(value);
	if (safe.redacted) markField(metadata.redactedFields, field);
	if (jsonStringBytes(safe.value) <= maxBytes) return safe.value;

	markField(metadata.truncatedFields, field);
	const chars = Array.from(safe.value);
	let low = 0;
	let high = chars.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const candidate = `${chars.slice(0, mid).join("")}…`;
		if (jsonStringBytes(candidate) <= maxBytes) low = mid;
		else high = mid - 1;
	}
	return low === 0 ? "" : `${chars.slice(0, low).join("")}…`;
}

function takeInputString(
	value: string,
	state: SanitizeState,
	field: string,
	maxBytes = RPC_TOOL_APPROVAL_MAX_STRING_BYTES,
): string {
	const safe = redactApprovalText(value);
	if (safe.redacted) markField(state.redactedFields, field);
	const available = Math.max(0, Math.min(maxBytes, state.remainingBytes));
	const size = byteLength(safe.value);
	if (size <= available) {
		state.remainingBytes -= size;
		return safe.value;
	}
	markField(state.truncatedFields, field);
	const suffix = "…";
	const suffixBytes = byteLength(suffix);
	const result = available <= suffixBytes ? "" : `${truncateUtf8(safe.value, available - suffixBytes)}${suffix}`;
	state.remainingBytes -= byteLength(result);
	return result;
}

function isSensitiveInputKey(rawKey: string): boolean {
	const key = rawKey.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
	return (
		SENSITIVE_INPUT_KEYS[key] === true ||
		key.includes("token") ||
		key.includes("secret") ||
		key.includes("password") ||
		key.includes("credential") ||
		key.includes("authorization") ||
		key.includes("apikey") ||
		key.includes("privatekey") ||
		key.includes("accesskey")
	);
}

function sanitizeEnvironment(
	value: Record<string, unknown>,
	state: SanitizeState,
	field: string,
	depth: number,
): RpcToolApprovalValue {
	if (depth >= RPC_TOOL_APPROVAL_MAX_DEPTH || state.remainingNodes <= 0) {
		markField(state.truncatedFields, field);
		return TRUNCATED_VALUE;
	}
	state.remainingNodes--;
	const entries = Object.keys(value)
		.slice(0, RPC_TOOL_APPROVAL_MAX_COLLECTION_ITEMS)
		.map(envKey => [takeInputString(envKey, state, field, 128), REDACTED_VALUE] as const)
		.filter(([envKey]) => envKey.length > 0);
	if (entries.length < Object.keys(value).length) markField(state.truncatedFields, field);
	markField(state.redactedFields, field);
	return Object.fromEntries(entries);
}

function sanitizeValue(value: unknown, state: SanitizeState, depth: number, field: string): RpcToolApprovalValue {
	if (state.remainingNodes <= 0) {
		markField(state.truncatedFields, field);
		return TRUNCATED_VALUE;
	}
	state.remainingNodes--;
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") return takeInputString(value, state, field);
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "object") {
		markField(state.truncatedFields, field);
		return TRUNCATED_VALUE;
	}
	if (depth >= RPC_TOOL_APPROVAL_MAX_DEPTH || state.seen.has(value)) {
		markField(state.truncatedFields, field);
		return TRUNCATED_VALUE;
	}

	state.seen.add(value);
	try {
		if (Array.isArray(value)) {
			const limit = Math.min(value.length, RPC_TOOL_APPROVAL_MAX_COLLECTION_ITEMS);
			// oxlint-disable-next-line unicorn/no-new-array -- bounded length preallocation
			const result = new Array<RpcToolApprovalValue>(limit);
			for (let index = 0; index < limit; index++)
				result[index] = sanitizeValue(value[index], state, depth + 1, field);
			if (limit < value.length) markField(state.truncatedFields, field);
			return result;
		}

		const entries: Array<[string, RpcToolApprovalValue]> = [];
		let count = 0;
		for (const [rawKey, child] of Object.entries(value)) {
			if (count >= RPC_TOOL_APPROVAL_MAX_COLLECTION_ITEMS) {
				markField(state.truncatedFields, field);
				break;
			}
			const key = takeInputString(rawKey, state, field, 128);
			if (!key) continue;
			const sensitive = isSensitiveInputKey(rawKey);
			if (sensitive) {
				markField(state.redactedFields, field);
				state.remainingBytes = Math.max(0, state.remainingBytes - byteLength(REDACTED_VALUE));
				entries.push([key, REDACTED_VALUE]);
			} else if (rawKey.toLowerCase() === "env" && isRecord(child)) {
				entries.push([key, sanitizeEnvironment(child, state, field, depth + 1)]);
			} else {
				entries.push([key, sanitizeValue(child, state, depth + 1, field)]);
			}
			count++;
		}
		return Object.fromEntries(entries);
	} finally {
		state.seen.delete(value);
	}
}

function sanitizeInput(value: unknown, state: SanitizeState): { [key: string]: RpcToolApprovalValue } {
	if (!isRecord(value)) return { value: sanitizeValue(value, state, 1, "input") };
	const entries: Array<[string, RpcToolApprovalValue]> = [];
	for (const [rawKey, child] of Object.entries(value)) {
		if (entries.length >= RPC_TOOL_APPROVAL_MAX_COLLECTION_ITEMS) {
			markField(state.truncatedFields, "input");
			break;
		}
		const field = `input.${rawKey}`;
		const key = takeInputString(rawKey, state, "input", 128);
		if (!key) continue;
		if (isSensitiveInputKey(rawKey)) {
			markField(state.redactedFields, field);
			entries.push([key, REDACTED_VALUE]);
			continue;
		}
		if (rawKey.toLowerCase() === "env" && isRecord(child)) {
			entries.push([key, sanitizeEnvironment(child, state, field, 1)]);
			continue;
		}
		entries.push([key, sanitizeValue(child, state, 1, field)]);
	}
	return Object.fromEntries(entries);
}

function buildIdentity(request: ToolApprovalRequest, metadata: ApprovalMetadata): RpcToolApprovalIdentity {
	const identity = request.identity;
	if (identity.kind !== request.toolKind) throw new Error("Tool approval identity kind does not match its tool kind");
	switch (identity.kind) {
		case "shell": {
			if (identity.command.length === 0)
				throw new Error("Shell approval cannot represent its required command identity");
			const command = boundedJsonString(
				identity.command,
				RPC_TOOL_APPROVAL_SHELL_COMMAND_BYTES,
				metadata,
				"identity.command",
			);
			if (!command) throw new Error("Shell approval cannot represent its required command identity");
			return { kind: "shell", command };
		}
		case "edit": {
			if (identity.paths.length === 0)
				throw new Error("Edit approval cannot represent its required paths and content identity");
			const paths: string[] = [];
			let remaining = RPC_TOOL_APPROVAL_EDIT_PATHS_BYTES;
			for (const rawPath of identity.paths.slice(0, RPC_TOOL_APPROVAL_MAX_DETAIL_LINES)) {
				const path = boundedJsonString(
					rawPath,
					Math.min(remaining, RPC_TOOL_APPROVAL_PATH_BYTES),
					metadata,
					"identity.paths",
				);
				if (!path) break;
				paths.push(path);
				remaining -= jsonStringBytes(path);
			}
			if (paths.length < identity.paths.length) markField(metadata.truncatedFields, "identity.paths");
			const content = boundedJsonString(
				identity.content,
				RPC_TOOL_APPROVAL_CONTENT_BYTES,
				metadata,
				"identity.content",
			);
			if (paths.length === 0 || (identity.content.length > 0 && content.length === 0))
				throw new Error("Edit approval cannot represent its required paths and content identity");
			return { kind: "edit", paths, content };
		}
		case "write": {
			if (identity.path.length === 0)
				throw new Error("Write approval cannot represent its required path and content identity");
			const path = boundedJsonString(identity.path, RPC_TOOL_APPROVAL_PATH_BYTES, metadata, "identity.path");
			const content = boundedJsonString(
				identity.content,
				RPC_TOOL_APPROVAL_CONTENT_BYTES,
				metadata,
				"identity.content",
			);
			if (!path || (identity.content.length > 0 && !content))
				throw new Error("Write approval cannot represent its required path and content identity");
			return { kind: "write", path, content };
		}
		case "other":
			return { kind: "other" };
	}
}

function validBoundedString(value: unknown, maxBytes: number, allowEmpty = false): value is string {
	return typeof value === "string" && (allowEmpty || value.length > 0) && byteLength(value) <= maxBytes;
}

function validApprovalValue(value: unknown, depth = 0): value is RpcToolApprovalValue {
	if (typeof value === "string") return byteLength(value) <= RPC_TOOL_APPROVAL_MAX_STRING_BYTES;
	if (value === null || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (depth >= RPC_TOOL_APPROVAL_MAX_DEPTH || typeof value !== "object") return false;
	if (Array.isArray(value)) {
		return (
			value.length <= RPC_TOOL_APPROVAL_MAX_COLLECTION_ITEMS &&
			value.every(item => validApprovalValue(item, depth + 1))
		);
	}
	if (!isRecord(value) || Object.keys(value).length > RPC_TOOL_APPROVAL_MAX_COLLECTION_ITEMS) return false;
	return Object.entries(value).every(([key, child]) => byteLength(key) <= 128 && validApprovalValue(child, depth + 1));
}

function validIdentity(value: unknown, toolKind: ToolApprovalRequest["toolKind"]): value is RpcToolApprovalIdentity {
	if (!isRecord(value) || value.kind !== toolKind) return false;
	switch (toolKind) {
		case "shell":
			return (
				Object.keys(value).length === 2 &&
				typeof value.command === "string" &&
				value.command.length > 0 &&
				jsonStringBytes(value.command) <= RPC_TOOL_APPROVAL_SHELL_COMMAND_BYTES
			);
		case "edit":
			return (
				Object.keys(value).length === 3 &&
				Array.isArray(value.paths) &&
				value.paths.length > 0 &&
				value.paths.length <= RPC_TOOL_APPROVAL_MAX_DETAIL_LINES &&
				value.paths.every(
					path =>
						typeof path === "string" && path.length > 0 && jsonStringBytes(path) <= RPC_TOOL_APPROVAL_PATH_BYTES,
				) &&
				typeof value.content === "string" &&
				jsonStringBytes(value.content) <= RPC_TOOL_APPROVAL_CONTENT_BYTES
			);
		case "write":
			return (
				Object.keys(value).length === 3 &&
				typeof value.path === "string" &&
				value.path.length > 0 &&
				jsonStringBytes(value.path) <= RPC_TOOL_APPROVAL_PATH_BYTES &&
				typeof value.content === "string" &&
				jsonStringBytes(value.content) <= RPC_TOOL_APPROVAL_CONTENT_BYTES
			);
		case "other":
			return Object.keys(value).length === 1;
	}
}

function validMetadataFields(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= RPC_TOOL_APPROVAL_MAX_METADATA_FIELDS + 1 &&
		value.every(field => validBoundedString(field, RPC_TOOL_APPROVAL_MAX_METADATA_FIELD_BYTES))
	);
}

/** Validate an untrusted native approval request before exposing it to an RPC client consumer. */
export function isRpcToolApprovalRequest(value: unknown): value is RpcToolApprovalRequest {
	const parsed = requestSchema(value);
	if (parsed instanceof type.errors) return false;
	if (!validBoundedString(parsed.id, RPC_TOOL_APPROVAL_MAX_ID_BYTES)) return false;
	if (!validBoundedString(parsed.toolCallId, RPC_TOOL_APPROVAL_MAX_ID_BYTES)) return false;
	if (!validBoundedString(parsed.toolName, RPC_TOOL_APPROVAL_MAX_TOOL_NAME_BYTES)) return false;
	if (!validIdentity(parsed.identity, parsed.toolKind)) return false;
	if (!validApprovalValue(parsed.input)) return false;
	if (!validMetadataFields(parsed.detail.truncatedFields) || !validMetadataFields(parsed.detail.redactedFields))
		return false;
	if (
		parsed.detail.lines.length > RPC_TOOL_APPROVAL_MAX_DETAIL_LINES ||
		!parsed.detail.lines.every(line => validBoundedString(line, RPC_TOOL_APPROVAL_MAX_DETAIL_BYTES, true))
	)
		return false;
	if (
		parsed.detail.reason !== undefined &&
		!validBoundedString(parsed.detail.reason, RPC_TOOL_APPROVAL_MAX_DETAIL_BYTES, true)
	)
		return false;
	if (
		parsed.detail.providerSafetyChecks !== undefined &&
		(parsed.detail.providerSafetyChecks.length > RPC_TOOL_APPROVAL_MAX_DETAIL_LINES ||
			!parsed.detail.providerSafetyChecks.every(check =>
				validBoundedString(check, RPC_TOOL_APPROVAL_MAX_DETAIL_BYTES, true),
			))
	)
		return false;
	if (
		parsed.timeout !== undefined &&
		(!Number.isFinite(parsed.timeout) || parsed.timeout < 0 || parsed.timeout > RPC_TOOL_APPROVAL_MAX_TIMEOUT_MS)
	)
		return false;
	return frameBytes(parsed) <= RPC_TOOL_APPROVAL_MAX_FRAME_BYTES;
}

/** Validate an untrusted cancellation before asking a host to dismiss an approval. */
export function isRpcToolApprovalCancelRequest(value: unknown): value is RpcToolApprovalCancelRequest {
	const parsed = cancelRequestSchema(value);
	if (parsed instanceof type.errors) return false;
	return (
		validBoundedString(parsed.id, RPC_TOOL_APPROVAL_MAX_ID_BYTES) &&
		validBoundedString(parsed.targetId, RPC_TOOL_APPROVAL_MAX_ID_BYTES) &&
		validBoundedString(parsed.toolCallId, RPC_TOOL_APPROVAL_MAX_ID_BYTES)
	);
}

/** Validate the host response variant and reject extra or conflicting decision fields. */
export function isRpcToolApprovalResponse(value: unknown): value is RpcToolApprovalResponse {
	const parsed = responseSchema(value);
	if (parsed instanceof type.errors) return false;
	return (
		validBoundedString(parsed.id, RPC_TOOL_APPROVAL_MAX_ID_BYTES) &&
		validBoundedString(parsed.toolCallId, RPC_TOOL_APPROVAL_MAX_ID_BYTES)
	);
}

function syncMetadata(frame: MutableToolApprovalFrame, metadata: ApprovalMetadata): void {
	frame.detail.truncatedFields = Array.from(metadata.truncatedFields);
	frame.detail.redactedFields = Array.from(metadata.redactedFields);
	frame.detail.truncated = frame.detail.truncatedFields.length > 0;
	frame.detail.redacted = frame.detail.redactedFields.length > 0;
}

function trimStringToFit(
	frame: MutableToolApprovalFrame,
	value: string,
	setValue: (value: string) => void,
	metadata: ApprovalMetadata,
	field: string,
): boolean {
	markField(metadata.truncatedFields, field);
	syncMetadata(frame, metadata);
	setValue("");
	if (frameBytes(frame) > RPC_TOOL_APPROVAL_MAX_FRAME_BYTES) return false;
	const chars = Array.from(value);
	let low = 0;
	let high = chars.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const candidate = mid === chars.length ? value : `${chars.slice(0, mid).join("")}…`;
		setValue(candidate);
		if (frameBytes(frame) <= RPC_TOOL_APPROVAL_MAX_FRAME_BYTES) low = mid;
		else high = mid - 1;
	}
	setValue(low === chars.length ? value : low === 0 ? "" : `${chars.slice(0, low).join("")}…`);
	return true;
}

function trimArrayToFit(
	frame: MutableToolApprovalFrame,
	values: string[],
	metadata: ApprovalMetadata,
	field: string,
): boolean {
	while (values.length > 0 && frameBytes(frame) > RPC_TOOL_APPROVAL_MAX_FRAME_BYTES) {
		const index = values.length - 1;
		const value = values[index]!;
		if (trimStringToFit(frame, value, next => (values[index] = next), metadata, field)) return true;
		values.pop();
		syncMetadata(frame, metadata);
	}
	return frameBytes(frame) <= RPC_TOOL_APPROVAL_MAX_FRAME_BYTES;
}

/** Deterministically shed optional presentation data before touching required identity. */
function fitFrame(frame: MutableToolApprovalFrame, metadata: ApprovalMetadata): void {
	syncMetadata(frame, metadata);
	if (frameBytes(frame) <= RPC_TOOL_APPROVAL_MAX_FRAME_BYTES) return;
	if (trimArrayToFit(frame, frame.detail.lines, metadata, "detail.lines")) return;
	if (frame.detail.reason !== undefined) {
		const reason = frame.detail.reason;
		if (trimStringToFit(frame, reason, value => (frame.detail.reason = value), metadata, "detail.reason")) return;
		delete frame.detail.reason;
		syncMetadata(frame, metadata);
	}
	if (
		frame.detail.providerSafetyChecks &&
		trimArrayToFit(frame, frame.detail.providerSafetyChecks, metadata, "detail.providerSafetyChecks")
	)
		return;

	let entries = Object.entries(frame.input);
	while (entries.length > 0 && frameBytes(frame) > RPC_TOOL_APPROVAL_MAX_FRAME_BYTES) {
		const [key, value] = entries.at(-1)!;
		const field = `input.${key}`;
		if (
			typeof value === "string" &&
			trimStringToFit(
				frame,
				value,
				next => {
					entries[entries.length - 1] = [key, next];
					frame.input = Object.fromEntries(entries);
				},
				metadata,
				field,
			)
		)
			return;
		markField(metadata.truncatedFields, field);
		entries = entries.slice(0, -1);
		frame.input = Object.fromEntries(entries);
		syncMetadata(frame, metadata);
	}
	if (frameBytes(frame) <= RPC_TOOL_APPROVAL_MAX_FRAME_BYTES) return;

	frame.detail.truncatedFields = ["multiple"];
	frame.detail.redactedFields = frame.detail.redacted ? ["multiple"] : [];
	if (frameBytes(frame) <= RPC_TOOL_APPROVAL_MAX_FRAME_BYTES) return;
	throw new Error("Tool approval required identity cannot fit the RPC frame budget");
}

/** Build a bounded, JSON-safe request from trusted in-process tool input. */
export function buildRpcToolApprovalRequest(
	id: string,
	request: ToolApprovalRequest,
	timeout?: number,
): RpcToolApprovalRequest {
	if (!validBoundedString(id, RPC_TOOL_APPROVAL_MAX_ID_BYTES)) throw new Error("Invalid tool approval request id");
	if (!validBoundedString(request.toolCallId, RPC_TOOL_APPROVAL_MAX_ID_BYTES))
		throw new Error("Invalid tool approval toolCallId");
	if (!validBoundedString(request.toolName, RPC_TOOL_APPROVAL_MAX_TOOL_NAME_BYTES))
		throw new Error("Invalid tool approval tool name");
	if (
		timeout !== undefined &&
		(!Number.isFinite(timeout) || timeout < 0 || timeout > RPC_TOOL_APPROVAL_MAX_TIMEOUT_MS)
	)
		throw new Error("Invalid tool approval timeout");

	const metadata: ApprovalMetadata = { truncatedFields: new Set(), redactedFields: new Set() };
	const identity = buildIdentity(request, metadata);
	const state: SanitizeState = {
		...metadata,
		remainingBytes: RPC_TOOL_APPROVAL_INPUT_BUDGET_BYTES,
		remainingNodes: RPC_TOOL_APPROVAL_MAX_INPUT_NODES,
		seen: new Set(),
	};
	const input = sanitizeInput(request.input, state);
	const lines = request.details
		.slice(0, RPC_TOOL_APPROVAL_MAX_DETAIL_LINES)
		.map(line => boundedJsonString(line, RPC_TOOL_APPROVAL_MAX_DETAIL_BYTES, metadata, "detail.lines"));
	if (lines.length < request.details.length) markField(metadata.truncatedFields, "detail.lines");
	const reason = request.reason
		? boundedJsonString(request.reason, RPC_TOOL_APPROVAL_MAX_DETAIL_BYTES, metadata, "detail.reason")
		: undefined;
	const providerSafetyChecks = request.providerSafetyChecks
		?.slice(0, RPC_TOOL_APPROVAL_MAX_DETAIL_LINES)
		.map(check =>
			boundedJsonString(check, RPC_TOOL_APPROVAL_MAX_DETAIL_BYTES, metadata, "detail.providerSafetyChecks"),
		);
	if (providerSafetyChecks && providerSafetyChecks.length < (request.providerSafetyChecks?.length ?? 0))
		markField(metadata.truncatedFields, "detail.providerSafetyChecks");

	const frame: MutableToolApprovalFrame = {
		type: "tool_approval_request",
		id,
		toolCallId: request.toolCallId,
		toolKind: request.toolKind,
		toolName: request.toolName,
		tier: request.tier,
		identity,
		input,
		detail: {
			lines,
			truncated: false,
			truncatedFields: [],
			redacted: false,
			redactedFields: [],
			...(reason === undefined ? {} : { reason }),
			...(providerSafetyChecks ? { providerSafetyChecks } : {}),
		},
		...(timeout === undefined ? {} : { timeout }),
	};
	fitFrame(frame, metadata);
	if (!isRpcToolApprovalRequest(frame)) throw new Error("Tool approval request failed protocol validation");
	return frame;
}

function approvalAbortError(signal: AbortSignal | undefined): DOMException {
	const reason = signal?.reason;
	const message =
		reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Tool approval aborted";
	return new DOMException(message, "AbortError");
}

/** Owns native approval correlation and consumes each matching response exactly once. */
export class RpcToolApprovalBridge {
	#closedError: Error | undefined;
	#pending = new Map<string, PendingToolApproval>();
	readonly #output: RpcToolApprovalOutput;

	constructor(output: RpcToolApprovalOutput) {
		this.#output = output;
	}

	request(request: ToolApprovalRequest, dialogOptions?: ToolApprovalDialogOptions): Promise<boolean> {
		if (dialogOptions?.signal?.aborted) return Promise.reject(approvalAbortError(dialogOptions.signal));
		if (this.#closedError) return Promise.reject(this.#closedError);

		const id = Snowflake.next() as string;
		const frame = buildRpcToolApprovalRequest(id, request, dialogOptions?.timeout);
		const { promise, resolve, reject } = Promise.withResolvers<boolean>();
		let settled = false;
		let timeoutId: NodeJS.Timeout | undefined;
		const cleanup = () => {
			clearTimeout(timeoutId);
			dialogOptions?.signal?.removeEventListener("abort", onAbort);
			this.#pending.delete(id);
		};
		const finish = (approved: boolean) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(approved);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const emitCancel = () => {
			this.#output({
				type: "tool_approval_cancel",
				id: Snowflake.next() as string,
				targetId: id,
				toolCallId: request.toolCallId,
			});
		};
		const onAbort = () => {
			if (settled) return;
			emitCancel();
			fail(approvalAbortError(dialogOptions?.signal));
		};
		const onTimeout = () => {
			if (settled) return;
			emitCancel();
			dialogOptions?.onTimeout?.();
			finish(false);
		};

		dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });
		if (dialogOptions?.timeout !== undefined) timeoutId = setTimeout(onTimeout, dialogOptions.timeout);
		this.#pending.set(id, {
			toolCallId: request.toolCallId,
			resolve: finish,
			reject: fail,
			onTimeout: dialogOptions?.onTimeout,
		});
		this.#output(frame);
		return promise;
	}

	/** Consume a response frame; malformed matching responses fail the gate closed. */
	handleResponse(value: unknown): boolean {
		if (!isRecord(value) || value.type !== "tool_approval_response") return false;
		const id = typeof value.id === "string" ? value.id : undefined;
		if (!id) return true;
		const pending = this.#pending.get(id);
		if (!pending) return true;
		if (!isRpcToolApprovalResponse(value)) {
			pending.reject(new Error("Malformed tool approval response"));
			return true;
		}
		if (value.toolCallId !== pending.toolCallId) {
			pending.reject(new Error("Tool approval response did not match the pending tool call"));
			return true;
		}
		if ("cancelled" in value && value.timedOut) pending.onTimeout?.();
		pending.resolve("approved" in value ? value.approved : false);
		return true;
	}

	/** Reject active and future approval requests after the RPC client disconnects. */
	close(message: string): void {
		if (!this.#closedError) this.#closedError = new Error(message);
		const pending = Array.from(this.#pending.values());
		this.#pending.clear();
		for (const request of pending) request.reject(this.#closedError);
	}
}
