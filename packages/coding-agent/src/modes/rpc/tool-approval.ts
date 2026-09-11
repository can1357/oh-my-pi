import { type } from "@oh-my-pi/omptype";
import { isRecord, sanitizeText, Snowflake } from "@oh-my-pi/pi-utils";
import type { ToolApprovalDialogOptions, ToolApprovalRequest } from "../../tools/approval";
import type {
	RpcToolApprovalCancelRequest,
	RpcToolApprovalRequest,
	RpcToolApprovalResponse,
	RpcToolApprovalValue,
} from "./rpc-types";

export const RPC_TOOL_APPROVAL_MAX_FRAME_BYTES = 64 * 1024;
export const RPC_TOOL_APPROVAL_MAX_STRING_BYTES = 8 * 1024;
export const RPC_TOOL_APPROVAL_MAX_COLLECTION_ITEMS = 32;
export const RPC_TOOL_APPROVAL_MAX_DEPTH = 4;

const RPC_TOOL_APPROVAL_INPUT_BUDGET_BYTES = 24 * 1024;
const RPC_TOOL_APPROVAL_MAX_ID_BYTES = 512;
const RPC_TOOL_APPROVAL_MAX_TOOL_NAME_BYTES = 256;
const RPC_TOOL_APPROVAL_MAX_DETAIL_LINES = 16;
const RPC_TOOL_APPROVAL_MAX_DETAIL_BYTES = 2 * 1024;
const RPC_TOOL_APPROVAL_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const REDACTED_VALUE = "[redacted]";
const TRUNCATED_VALUE = "[truncated]";
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
	input: { "[string]": "unknown" },
	detail: {
		lines: "string[]",
		truncated: "boolean",
		redacted: "boolean",
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

interface SanitizeState {
	remainingBytes: number;
	truncated: boolean;
	redacted: boolean;
	seen: Set<object>;
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

function truncateUtf8(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.byteLength <= maxBytes) return value;
	let end = Math.max(0, maxBytes);
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

function takeString(value: string, state: SanitizeState, maxBytes = RPC_TOOL_APPROVAL_MAX_STRING_BYTES): string {
	const sanitized = sanitizeText(value);
	const available = Math.max(0, Math.min(maxBytes, state.remainingBytes));
	const size = byteLength(sanitized);
	if (size <= available) {
		state.remainingBytes -= size;
		return sanitized;
	}
	state.truncated = true;
	const suffix = "…";
	const suffixBytes = byteLength(suffix);
	const result = available <= suffixBytes ? "" : `${truncateUtf8(sanitized, available - suffixBytes)}${suffix}`;
	state.remainingBytes -= byteLength(result);
	return result;
}

function sanitizeValue(value: unknown, state: SanitizeState, depth: number): RpcToolApprovalValue {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") return takeString(value, state);
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "object") {
		state.truncated = true;
		return TRUNCATED_VALUE;
	}
	if (depth >= RPC_TOOL_APPROVAL_MAX_DEPTH || state.seen.has(value)) {
		state.truncated = true;
		return TRUNCATED_VALUE;
	}

	state.seen.add(value);
	try {
		if (Array.isArray(value)) {
			const limit = Math.min(value.length, RPC_TOOL_APPROVAL_MAX_COLLECTION_ITEMS);
			// oxlint-disable-next-line unicorn/no-new-array -- bounded length preallocation
			const result = new Array<RpcToolApprovalValue>(limit);
			for (let index = 0; index < limit; index++) result[index] = sanitizeValue(value[index], state, depth + 1);
			if (limit < value.length) state.truncated = true;
			return result;
		}

		const entries: Array<[string, RpcToolApprovalValue]> = [];
		let count = 0;
		for (const [rawKey, child] of Object.entries(value)) {
			if (count >= RPC_TOOL_APPROVAL_MAX_COLLECTION_ITEMS) {
				state.truncated = true;
				break;
			}
			const key = takeString(rawKey, state, 128);
			if (!key) continue;
			const sensitiveKey = rawKey.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
			const sensitive =
				SENSITIVE_INPUT_KEYS[sensitiveKey] === true ||
				sensitiveKey.endsWith("token") ||
				sensitiveKey.endsWith("secret") ||
				sensitiveKey.endsWith("password") ||
				sensitiveKey.endsWith("credential") ||
				sensitiveKey.endsWith("apikey") ||
				sensitiveKey.endsWith("privatekey") ||
				sensitiveKey.endsWith("accesskey");
			if (sensitive) {
				state.redacted = true;
				state.remainingBytes = Math.max(0, state.remainingBytes - byteLength(REDACTED_VALUE));
				entries.push([key, REDACTED_VALUE]);
			} else if (rawKey === "env" && isRecord(child)) {
				const envEntries = Object.keys(child)
					.slice(0, RPC_TOOL_APPROVAL_MAX_COLLECTION_ITEMS)
					.map(envKey => [takeString(envKey, state, 128), REDACTED_VALUE] as const)
					.filter(([envKey]) => envKey.length > 0);
				if (envEntries.length < Object.keys(child).length) state.truncated = true;
				state.redacted = true;
				entries.push([key, Object.fromEntries(envEntries)]);
			} else {
				entries.push([key, sanitizeValue(child, state, depth + 1)]);
			}
			count++;
		}
		return Object.fromEntries(entries);
	} finally {
		state.seen.delete(value);
	}
}

function sanitizeInput(value: unknown, state: SanitizeState): { [key: string]: RpcToolApprovalValue } {
	const sanitized = sanitizeValue(value, state, 0);
	return isRecord(sanitized) ? sanitized : { value: sanitized };
}

function boundedStandaloneString(value: string, maxBytes: number): { value: string; truncated: boolean } {
	const state: SanitizeState = { remainingBytes: maxBytes, truncated: false, redacted: false, seen: new Set() };
	return { value: takeString(value, state, maxBytes), truncated: state.truncated };
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

/** Validate an untrusted native approval request before exposing it to an RPC client consumer. */
export function isRpcToolApprovalRequest(value: unknown): value is RpcToolApprovalRequest {
	const parsed = requestSchema(value);
	if (parsed instanceof type.errors) return false;
	if (!validBoundedString(parsed.id, RPC_TOOL_APPROVAL_MAX_ID_BYTES)) return false;
	if (!validBoundedString(parsed.toolCallId, RPC_TOOL_APPROVAL_MAX_ID_BYTES)) return false;
	if (!validBoundedString(parsed.toolName, RPC_TOOL_APPROVAL_MAX_TOOL_NAME_BYTES)) return false;
	if (!validApprovalValue(parsed.input)) return false;
	if (typeof parsed.detail.redacted !== "boolean") return false;
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
	try {
		return byteLength(JSON.stringify(parsed)) <= RPC_TOOL_APPROVAL_MAX_FRAME_BYTES;
	} catch {
		return false;
	}
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

	const state: SanitizeState = {
		remainingBytes: RPC_TOOL_APPROVAL_INPUT_BUDGET_BYTES,
		truncated: false,
		redacted: false,
		seen: new Set(),
	};
	const input = sanitizeInput(request.input, state);
	const lines = request.details.slice(0, RPC_TOOL_APPROVAL_MAX_DETAIL_LINES).map(line => {
		const bounded = boundedStandaloneString(line, RPC_TOOL_APPROVAL_MAX_DETAIL_BYTES);
		if (bounded.truncated) state.truncated = true;
		return bounded.value;
	});
	if (lines.length < request.details.length) state.truncated = true;
	const reason = request.reason
		? boundedStandaloneString(request.reason, RPC_TOOL_APPROVAL_MAX_DETAIL_BYTES)
		: undefined;
	if (reason?.truncated) state.truncated = true;
	const providerSafetyChecks = request.providerSafetyChecks
		?.slice(0, RPC_TOOL_APPROVAL_MAX_DETAIL_LINES)
		.map(check => {
			const bounded = boundedStandaloneString(check, RPC_TOOL_APPROVAL_MAX_DETAIL_BYTES);
			if (bounded.truncated) state.truncated = true;
			return bounded.value;
		});
	if (providerSafetyChecks && providerSafetyChecks.length < (request.providerSafetyChecks?.length ?? 0))
		state.truncated = true;

	const frame: RpcToolApprovalRequest = {
		type: "tool_approval_request",
		id,
		toolCallId: request.toolCallId,
		toolKind: request.toolKind,
		toolName: request.toolName,
		tier: request.tier,
		input,
		detail: {
			lines,
			truncated: state.truncated,
			redacted: state.redacted,
			...(reason ? { reason: reason.value } : {}),
			...(providerSafetyChecks ? { providerSafetyChecks } : {}),
		},
		...(timeout === undefined ? {} : { timeout }),
	};
	if (!isRpcToolApprovalRequest(frame)) throw new Error("Tool approval request exceeds RPC protocol bounds");
	return frame;
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
		if (dialogOptions?.signal?.aborted) return Promise.resolve(false);
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
		const cancel = (timedOut: boolean) => {
			if (settled) return;
			this.#output({
				type: "tool_approval_cancel",
				id: Snowflake.next() as string,
				targetId: id,
				toolCallId: request.toolCallId,
			});
			if (timedOut) dialogOptions?.onTimeout?.();
			finish(false);
		};
		const onAbort = () => cancel(false);

		dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });
		if (dialogOptions?.timeout !== undefined) {
			timeoutId = setTimeout(() => cancel(true), dialogOptions.timeout);
		}
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
