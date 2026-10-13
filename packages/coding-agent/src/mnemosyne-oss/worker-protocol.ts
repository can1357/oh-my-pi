export const MNEMOSYNE_OSS_PROTOCOL_VERSION = 1;

export type MnemosyneOssWorkerMethod =
	| "initialize"
	| "capabilities"
	| "status"
	| "remember"
	| "recall"
	| "get"
	| "update"
	| "forget"
	| "invalidate"
	| "stats"
	| "sleep"
	| "clear"
	| "shutdown";

export interface MnemosyneOssWorkerContext {
	session_id: string;
	cwd: string;
	store_data_dir: string;
	retain_bank: string;
	recall_banks: readonly string[];
	shared_banks: readonly string[];
	ownership: "shared" | "omp";
	author_id: "omp";
	author_type: "agent";
	channel_id: string;
	embedding_mode: "local" | "lexical";
	embedding_model?: string;
	consolidation_mode: "local" | "heuristic";
	local_llm_repo?: string;
	local_llm_file?: string;
	auto_migrate: boolean;
}
export interface MnemosyneOssWorkerInitializeResult {
	protocol: typeof MNEMOSYNE_OSS_PROTOCOL_VERSION;
}

export interface MnemosyneOssWorkerCapabilitiesParams {
	readonly [key: string]: never;
}

export interface MnemosyneOssWorkerRecallResult {
	items: readonly MnemosyneOssWorkerRecallItem[];
}

export interface MnemosyneOssWorkerGetResult {
	status: "found" | "not_found";
	id: string;
	record?: MnemosyneOssWorkerRecord;
}

export const MNEMOSYNE_OSS_ERROR_CODES = {
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	SDK_FAILURE: -32000,
	IMMUTABLE_CONTEXT_MISMATCH: -32010,
	SHARED_CLEAR_REFUSED: -32020,
	UNSUPPORTED_CLEAR: -32021,
} as const;

export interface MnemosyneOssWorkerRequest {
	jsonrpc: "2.0";
	id: string;
	method: MnemosyneOssWorkerMethod;
	params?: Record<string, unknown>;
}

/** JSON-RPC cancellation is a notification and is never a worker operation. */
export interface MnemosyneOssWorkerCancelRequest {
	jsonrpc: "2.0";
	method: "$/cancelRequest";
	params: { id: string };
}

export type MnemosyneOssWorkerMessage = MnemosyneOssWorkerRequest | MnemosyneOssWorkerCancelRequest;

export type MnemosyneOssWorkerErrorCode = -32600 | -32601 | -32602 | -32000 | -32010 | -32020 | -32021;

export interface MnemosyneOssWorkerSuccess<T = unknown> {
	jsonrpc: "2.0";
	id: string;
	result: T;
}

export interface MnemosyneOssWorkerError {
	jsonrpc: "2.0";
	id: string;
	error: {
		code: MnemosyneOssWorkerErrorCode | number;
		message: string;
		data?: unknown;
	};
}

export type MnemosyneOssWorkerResponse<T = unknown> = MnemosyneOssWorkerSuccess<T> | MnemosyneOssWorkerError;

export interface MnemosyneOssWorkerCapabilities {
	protocol: number;
	sdk_version: string;
	python_version: string;
	operations: readonly MnemosyneOssWorkerMethod[];
	embedding_mode: "local" | "lexical";
	consolidation_mode: "local" | "heuristic";
	clear_mode: "bank-manager" | "unsupported";
}

export interface MnemosyneOssWorkerRecallItem {
	id: string;
	content: string;
	source?: string;
	timestamp?: string;
	score?: number;
	bank: string;
}

export interface MnemosyneOssWorkerRecord {
	id: string;
	content: string;
	source?: string;
	timestamp?: string;
	importance?: number;
	metadata?: unknown;
	bank: string;
	store?: string;
	editable: boolean;
}

export interface MnemosyneOssWorkerMutation {
	status: "updated" | "deleted" | "invalidated" | "not_found" | "not_editable";
	id: string;
	bank?: string;
	store?: string;
	message?: string;
}

export interface MnemosyneOssWorkerStatus {
	banks: Array<{
		bank: string;
		database: string;
		health: "ok" | "error";
		working_count?: number;
		episodic_count?: number;
		triple_count?: number;
	}>;
	sdk_version: string;
	python_version: string;
	embedding_mode: "local" | "lexical";
	consolidation_mode: "local" | "heuristic";
}

export const MNEMOSYNE_OSS_REQUIRED_METHODS: readonly MnemosyneOssWorkerMethod[] = [
	"initialize",
	"capabilities",
	"status",
	"remember",
	"recall",
	"get",
	"update",
	"forget",
	"invalidate",
	"stats",
	"sleep",
	"clear",
	"shutdown",
];
