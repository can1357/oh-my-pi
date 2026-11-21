/**
 * Worker-side proxies of the main thread's memory objects. A subagent alias built on a
 * worker reads its parent through these, so retains, recalls, bank confirmations, and
 * Mnemopi writes land in main's live client, bank set, and SQLite banks.
 */
import type { RecallResult } from "@oh-my-pi/pi-mnemopi";
import type { HindsightBankSet } from "../../hindsight/bank";
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
import type { HindsightSessionStateApi } from "../../hindsight/state";
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
import type { RemoteObject } from "../rpc";
import type {
	HindsightClientProtocol,
	HindsightSessionStateProtocol,
	MnemopiSessionStateProtocol,
} from "./memory-protocol";

/** Main's Hindsight client, as seen from a worker; every request runs on main. */
export class RemoteHindsightClient implements HindsightClientApi {
	readonly #remote: RemoteObject<HindsightClientProtocol>;

	constructor(remote: RemoteObject<HindsightClientProtocol>) {
		this.#remote = remote;
	}

	retain(bankId: string, content: string, options?: RetainOptions): Promise<RetainResponse> {
		return this.#remote.call("retain", bankId, content, options);
	}

	retainBatch(bankId: string, items: MemoryItemInput[], options?: RetainBatchOptions): Promise<RetainResponse> {
		return this.#remote.call("retainBatch", bankId, items, options);
	}

	recall(bankId: string, query: string, options?: RecallOptions): Promise<RecallResponse> {
		return this.#remote.call("recall", bankId, query, options);
	}

	reflect(bankId: string, query: string, options?: ReflectOptions): Promise<ReflectResponse> {
		return this.#remote.call("reflect", bankId, query, options);
	}

	createBank(bankId: string, options?: CreateBankOptions): Promise<BankProfileResponse> {
		return this.#remote.call("createBank", bankId, options);
	}

	listMemories(bankId: string, options?: ListMemoriesOptions): Promise<ListMemoriesResponse> {
		return this.#remote.call("listMemories", bankId, options);
	}

	listDocuments(bankId: string, options?: ListDocumentsOptions): Promise<ListDocumentsResponse> {
		return this.#remote.call("listDocuments", bankId, options);
	}

	getDocument(bankId: string, documentId: string): Promise<DocumentResponse | null> {
		return this.#remote.call("getDocument", bankId, documentId);
	}

	updateDocument(bankId: string, documentId: string, options: UpdateDocumentOptions): Promise<DocumentResponse> {
		return this.#remote.call("updateDocument", bankId, documentId, options);
	}

	deleteDocument(bankId: string, documentId: string): Promise<boolean> {
		return this.#remote.call("deleteDocument", bankId, documentId);
	}

	listMentalModels(bankId: string, options?: ListMentalModelsOptions): Promise<MentalModelListResponse> {
		return this.#remote.call("listMentalModels", bankId, options);
	}

	getMentalModel(
		bankId: string,
		mentalModelId: string,
		options?: GetMentalModelOptions,
	): Promise<MentalModelSummary | null> {
		return this.#remote.call("getMentalModel", bankId, mentalModelId, options);
	}

	createMentalModel(
		bankId: string,
		name: string,
		sourceQuery: string,
		options?: CreateMentalModelOptions,
	): Promise<CreateMentalModelResponse> {
		return this.#remote.call("createMentalModel", bankId, name, sourceQuery, options);
	}

	refreshMentalModel(bankId: string, mentalModelId: string): Promise<RefreshMentalModelResponse> {
		return this.#remote.call("refreshMentalModel", bankId, mentalModelId);
	}

	deleteMentalModel(bankId: string, mentalModelId: string): Promise<boolean> {
		return this.#remote.call("deleteMentalModel", bankId, mentalModelId);
	}

	getMentalModelHistory(bankId: string, mentalModelId: string): Promise<MentalModelHistoryEntry[]> {
		return this.#remote.call("getMentalModelHistory", bankId, mentalModelId);
	}
}

/** Main's confirmed-bank set of one parent state; each operation runs synchronously on main's `Set`. */
export class RemoteHindsightBankSet implements HindsightBankSet {
	readonly #remote: RemoteObject<HindsightSessionStateProtocol>;

	constructor(remote: RemoteObject<HindsightSessionStateProtocol>) {
		this.#remote = remote;
	}

	get size(): number {
		return this.#remote.callSync("banks.size");
	}

	has(bankId: string): boolean {
		return this.#remote.callSync("banks.has", bankId);
	}

	add(bankId: string): this {
		this.#remote.callSync("banks.add", bankId);
		return this;
	}

	delete(bankId: string): boolean {
		return this.#remote.callSync("banks.delete", bankId);
	}

	[Symbol.iterator](): Iterator<string> {
		return this.#remote.callSync("banks.list")[Symbol.iterator]();
	}
}

/** A main-thread parent Hindsight state, as seen from a worker; fields read main's current values. */
export class RemoteHindsightSessionState implements HindsightSessionStateApi {
	readonly #remote: RemoteObject<HindsightSessionStateProtocol>;
	readonly banksSet: RemoteHindsightBankSet;

	constructor(remote: RemoteObject<HindsightSessionStateProtocol>) {
		this.#remote = remote;
		this.banksSet = new RemoteHindsightBankSet(remote);
	}

	get client(): HindsightClientApi {
		return this.#remote.callSync("client");
	}

	get bankId(): string {
		return this.#remote.callSync("bankId");
	}

	get retainTags(): string[] | undefined {
		return this.#remote.callSync("retainTags");
	}

	get recallTags(): string[] | undefined {
		return this.#remote.callSync("recallTags");
	}

	get recallTagsMatch(): "any" | "all" | "any_strict" | "all_strict" | undefined {
		return this.#remote.callSync("recallTagsMatch");
	}

	get config(): HindsightConfig {
		return this.#remote.callSync("config");
	}

	get lastRecallSnippet(): string | undefined {
		return this.#remote.callSync("lastRecallSnippet");
	}

	get mentalModelsSnippet(): string | undefined {
		return this.#remote.callSync("mentalModelsSnippet");
	}
}

/** A main-thread parent Mnemopi state, as seen from a worker; every bank operation runs on main's banks. */
export class RemoteMnemopiSessionState implements MnemopiSessionStateApi {
	readonly #remote: RemoteObject<MnemopiSessionStateProtocol>;

	constructor(remote: RemoteObject<MnemopiSessionStateProtocol>) {
		this.#remote = remote;
	}

	get sessionId(): string {
		return this.#remote.callSync("sessionId");
	}

	get config(): MnemopiBackendConfig {
		return this.#remote.callSync("config");
	}

	get hasRecalledForFirstTurn(): boolean {
		return this.#remote.callSync("hasRecalledForFirstTurn");
	}

	get lastRecallSnippet(): string | undefined {
		return this.#remote.callSync("lastRecallSnippet");
	}

	get aliasOf(): MnemopiSessionStateApi | undefined {
		return this.#remote.callSync("aliasOf");
	}

	getScopedRetainTarget(): MnemopiBankTarget {
		return this.#remote.callSync("getScopedRetainTarget");
	}

	getScopedRecallTargets(): readonly MnemopiBankTarget[] {
		return this.#remote.callSync("getScopedRecallTargets");
	}

	getGlobalRetainTarget(): MnemopiBankTarget {
		return this.#remote.callSync("getGlobalRetainTarget");
	}

	getScopedMemory(id: string): MnemopiScopedMemoryHit | null {
		return this.#remote.callSync("getScopedMemory", id);
	}

	editScopedMemory(
		op: MnemopiMemoryEditOperation,
		id: string,
		options?: MnemopiMemoryEditOptions,
	): MnemopiMemoryEditResult {
		return this.#remote.callSync("editScopedMemory", op, id, options);
	}

	collectScopedRecallResults(query: string): Promise<RecallResult[]> {
		return this.#remote.call("collectScopedRecallResults", query);
	}

	recallResultsScoped(query: string): Promise<RecallResult[]> {
		return this.#remote.call("collectScopedRecallResults", query);
	}

	formatScopedRecallContext(results: readonly RecallResult[], format?: "bullet" | "json"): string | undefined {
		return this.#remote.callSync("formatScopedRecallContext", results, format);
	}

	rememberScoped(memory: MnemopiRememberInput, options?: MnemopiRememberOptions, target?: MnemopiBankTarget): string {
		return this.#remote.callSync("rememberScoped", memory, options, target);
	}

	getScopedStats(): MnemopiBankStats[] {
		return this.#remote.callSync("getScopedStats");
	}

	consolidate(options?: MnemopiConsolidateOptions): Promise<void> {
		return this.#remote.call("consolidate", options);
	}
}
