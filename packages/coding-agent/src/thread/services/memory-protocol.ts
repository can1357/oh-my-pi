/**
 * Wire protocols of the main-thread memory objects a subagent worker reaches by
 * reference: the Hindsight client, a parent `HindsightSessionState` (routing,
 * config, snippets, and its confirmed-bank set), a parent `MnemopiSessionState`
 * (identity, config, and every scoped-bank operation), and a parent
 * `SupermemorySessionState` (container, recall snippet, and tool operations).
 *
 * Bank targets cross as `{ bank }`; main resolves the name to its live store.
 */
import type { RecallResult } from "@oh-my-pi/pi-mnemopi";
import type {
	BankProfileResponse,
	CreateBankOptions,
	CreateMentalModelOptions,
	CreateMentalModelResponse,
	DocumentResponse,
	GetMentalModelOptions,
	HindsightClientApi,
	ListDocumentsOptions,
	ListDocumentsResponse,
	ListMemoriesOptions,
	ListMemoriesResponse,
	ListMentalModelsOptions,
	MemoryItemInput,
	MentalModelHistoryEntry,
	MentalModelListResponse,
	MentalModelSummary,
	RecallOptions,
	RecallResponse,
	ReflectOptions,
	ReflectResponse,
	RefreshMentalModelResponse,
	RetainBatchOptions,
	RetainOptions,
	RetainResponse,
	UpdateDocumentOptions,
} from "../../hindsight/client";
import type { HindsightConfig } from "../../hindsight/config";
import type { MnemopiBackendConfig } from "../../mnemopi/config";
import type {
	MnemopiBankStats,
	MnemopiBankTarget,
	MnemopiConsolidateOptions,
	MnemopiMemoryEditOperation,
	MnemopiMemoryEditOptions,
	MnemopiMemoryEditResult,
	MnemopiRememberInput,
	MnemopiRememberOptions,
	MnemopiScopedMemoryHit,
	MnemopiSessionStateApi,
} from "../../mnemopi/state";
import type {
	SupermemoryDocument,
	SupermemoryDocumentInput,
	SupermemoryForgetResult,
	SupermemoryMemory,
	SupermemoryMemoryMatch,
	SupermemorySearchItem,
} from "../../supermemory/client";
import type { SupermemoryRetainInput, SupermemorySessionStateApi } from "../../supermemory/state";
import type { RpcMethod } from "../rpc";

/** Exported-class kind of `HindsightApi`. */
export const HINDSIGHT_CLIENT_KIND = "hindsight-client";
/** Exported-class kind of `HindsightSessionState`. */
export const HINDSIGHT_SESSION_STATE_KIND = "hindsight-session-state";
/** Exported-class kind of `MnemopiSessionState`. */
export const MNEMOPI_SESSION_STATE_KIND = "mnemopi-session-state";
/** Exported-class kind of `SupermemorySessionState`. */
export const SUPERMEMORY_SESSION_STATE_KIND = "supermemory-session-state";

/** Every `HindsightApi` request, one method each. */
export type HindsightClientProtocol = {
	retain: RpcMethod<[bankId: string, content: string, options?: RetainOptions], RetainResponse>;
	retainBatch: RpcMethod<[bankId: string, items: MemoryItemInput[], options?: RetainBatchOptions], RetainResponse>;
	recall: RpcMethod<[bankId: string, query: string, options?: RecallOptions], RecallResponse>;
	reflect: RpcMethod<[bankId: string, query: string, options?: ReflectOptions], ReflectResponse>;
	createBank: RpcMethod<[bankId: string, options?: CreateBankOptions], BankProfileResponse>;
	listMemories: RpcMethod<[bankId: string, options?: ListMemoriesOptions], ListMemoriesResponse>;
	listDocuments: RpcMethod<[bankId: string, options?: ListDocumentsOptions], ListDocumentsResponse>;
	getDocument: RpcMethod<[bankId: string, documentId: string], DocumentResponse | null>;
	updateDocument: RpcMethod<[bankId: string, documentId: string, options: UpdateDocumentOptions], DocumentResponse>;
	deleteDocument: RpcMethod<[bankId: string, documentId: string], boolean>;
	listMentalModels: RpcMethod<[bankId: string, options?: ListMentalModelsOptions], MentalModelListResponse>;
	getMentalModel: RpcMethod<
		[bankId: string, mentalModelId: string, options?: GetMentalModelOptions],
		MentalModelSummary | null
	>;
	createMentalModel: RpcMethod<
		[bankId: string, name: string, sourceQuery: string, options?: CreateMentalModelOptions],
		CreateMentalModelResponse
	>;
	refreshMentalModel: RpcMethod<[bankId: string, mentalModelId: string], RefreshMentalModelResponse>;
	deleteMentalModel: RpcMethod<[bankId: string, mentalModelId: string], boolean>;
	getMentalModelHistory: RpcMethod<[bankId: string, mentalModelId: string], MentalModelHistoryEntry[]>;
};

/** A parent Hindsight state's fields (read live, synchronously) and its confirmed-bank set (`banks.*`). */
export type HindsightSessionStateProtocol = {
	client: RpcMethod<[], HindsightClientApi>;
	bankId: RpcMethod<[], string>;
	retainTags: RpcMethod<[], string[] | undefined>;
	recallTags: RpcMethod<[], string[] | undefined>;
	recallTagsMatch: RpcMethod<[], "any" | "all" | "any_strict" | "all_strict" | undefined>;
	config: RpcMethod<[], HindsightConfig>;
	lastRecallSnippet: RpcMethod<[], string | undefined>;
	mentalModelsSnippet: RpcMethod<[], string | undefined>;
	"banks.size": RpcMethod<[], number>;
	"banks.has": RpcMethod<[bankId: string], boolean>;
	"banks.add": RpcMethod<[bankId: string], void>;
	"banks.delete": RpcMethod<[bankId: string], boolean>;
	"banks.list": RpcMethod<[], string[]>;
};

/** A parent Mnemopi state's fields (read live) and its scoped-bank operations; sync ones are `callSync`. */
export type MnemopiSessionStateProtocol = {
	sessionId: RpcMethod<[], string>;
	config: RpcMethod<[], MnemopiBackendConfig>;
	hasRecalledForFirstTurn: RpcMethod<[], boolean>;
	lastRecallSnippet: RpcMethod<[], string | undefined>;
	aliasOf: RpcMethod<[], MnemopiSessionStateApi | undefined>;
	getScopedRetainTarget: RpcMethod<[], MnemopiBankTarget>;
	getScopedRecallTargets: RpcMethod<[], MnemopiBankTarget[]>;
	getGlobalRetainTarget: RpcMethod<[], MnemopiBankTarget>;
	getScopedMemory: RpcMethod<[id: string], MnemopiScopedMemoryHit | null>;
	editScopedMemory: RpcMethod<
		[op: MnemopiMemoryEditOperation, id: string, options?: MnemopiMemoryEditOptions],
		MnemopiMemoryEditResult
	>;
	collectScopedRecallResults: RpcMethod<[query: string], RecallResult[]>;
	formatScopedRecallContext: RpcMethod<
		[results: readonly RecallResult[], format?: "bullet" | "json"],
		string | undefined
	>;
	rememberScoped: RpcMethod<
		[memory: MnemopiRememberInput, options?: MnemopiRememberOptions, target?: MnemopiBankTarget],
		string
	>;
	getScopedStats: RpcMethod<[], MnemopiBankStats[]>;
	consolidate: RpcMethod<[options?: MnemopiConsolidateOptions], void>;
};

/** A parent Supermemory state's fields (read live) and the tool reads, writes and edits it runs. */
export type SupermemorySessionStateProtocol = {
	namespace: RpcMethod<[], string>;
	aliasOf: RpcMethod<[], SupermemorySessionStateApi | undefined>;
	lastRecallSnippet: RpcMethod<[], string | undefined>;
	search: RpcMethod<[query: string, limit: number | undefined, signal?: AbortSignal], SupermemorySearchItem[]>;
	enqueueRetain: RpcMethod<[toolCallId: string, items: SupermemoryRetainInput[]], void>;
	save: RpcMethod<
		[
			content: string,
			metadata: Record<string, string | number | boolean>,
			id?: string,
			dreaming?: SupermemoryDocumentInput["dreaming"],
		],
		SupermemoryDocument
	>;
	forgetMemory: RpcMethod<[id: string, signal?: AbortSignal], SupermemoryForgetResult>;
	previewForget: RpcMethod<[query: string, signal?: AbortSignal], SupermemoryMemoryMatch[]>;
	getMemory: RpcMethod<[id: string, signal?: AbortSignal], SupermemoryMemory>;
};
