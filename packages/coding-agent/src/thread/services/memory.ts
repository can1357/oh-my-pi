/**
 * Memory-backend bridge between the main thread and subagent workers.
 *
 * A subagent aliases its parent's memory state (`ExecutorOptions.parentHindsightSessionState`
 * / `parentMnemopiSessionState` / `parentSupermemorySessionState`). When the child runs on a
 * worker, those parents stay on main and cross by reference:
 *
 * - `HindsightSessionState` → {@link RemoteHindsightSessionState}: the worker alias copies
 *   the parent's routing and config as an in-process alias does, but its client is main's
 *   client ({@link RemoteHindsightClient}) and its bank set is main's live set
 *   ({@link RemoteHindsightBankSet}), so tool retains/recalls/reflects and bank
 *   confirmations land on main.
 * - `MnemopiSessionState` → {@link RemoteMnemopiSessionState}: an alias whose parent is
 *   remote holds no banks; it routes every scoped-bank read and write to the parent, so
 *   saves land in main's live SQLite banks.
 * - `SupermemorySessionState` → {@link RemoteSupermemorySessionState}: the worker alias
 *   routes every tool search, retain, save and edit to the parent, so writes land in main's
 *   outbox and container; `SupermemoryHttpError` keeps its `status` across the hop.
 *
 * Nothing is held per worker: the link releases exported objects when it closes.
 */
import { HindsightApi, HindsightError } from "../../hindsight/client";
import { HindsightSessionState } from "../../hindsight/state";
import { MnemopiSessionState } from "../../mnemopi/state";
import { SupermemoryHttpError } from "../../supermemory/client";
import { SupermemorySessionState } from "../../supermemory/state";
import type { WorkerThreadLink } from "../protocol";
import { registerRpcError, type RpcServe } from "../rpc";
import type { ThreadService, WorkerPeer } from "../services";
import {
	HINDSIGHT_CLIENT_KIND,
	HINDSIGHT_SESSION_STATE_KIND,
	type HindsightClientProtocol,
	type HindsightSessionStateProtocol,
	MNEMOPI_SESSION_STATE_KIND,
	type MnemopiSessionStateProtocol,
	SUPERMEMORY_SESSION_STATE_KIND,
	type SupermemorySessionStateProtocol,
} from "./memory-protocol";
import {
	RemoteHindsightClient,
	RemoteHindsightSessionState,
	RemoteMnemopiSessionState,
	RemoteSupermemorySessionState,
} from "./memory-remote";

const serveHindsightClient: RpcServe<HindsightApi, HindsightClientProtocol> = {
	retain: (client, bankId, content, options) => client.retain(bankId, content, options),
	retainBatch: (client, bankId, items, options) => client.retainBatch(bankId, items, options),
	recall: (client, bankId, query, options) => client.recall(bankId, query, options),
	reflect: (client, bankId, query, options) => client.reflect(bankId, query, options),
	createBank: (client, bankId, options) => client.createBank(bankId, options),
	listMemories: (client, bankId, options) => client.listMemories(bankId, options),
	listDocuments: (client, bankId, options) => client.listDocuments(bankId, options),
	getDocument: (client, bankId, documentId) => client.getDocument(bankId, documentId),
	updateDocument: (client, bankId, documentId, options) => client.updateDocument(bankId, documentId, options),
	deleteDocument: (client, bankId, documentId) => client.deleteDocument(bankId, documentId),
	listMentalModels: (client, bankId, options) => client.listMentalModels(bankId, options),
	getMentalModel: (client, bankId, mentalModelId, options) => client.getMentalModel(bankId, mentalModelId, options),
	createMentalModel: (client, bankId, name, sourceQuery, options) =>
		client.createMentalModel(bankId, name, sourceQuery, options),
	refreshMentalModel: (client, bankId, mentalModelId) => client.refreshMentalModel(bankId, mentalModelId),
	deleteMentalModel: (client, bankId, mentalModelId) => client.deleteMentalModel(bankId, mentalModelId),
	getMentalModelHistory: (client, bankId, mentalModelId) => client.getMentalModelHistory(bankId, mentalModelId),
};

const serveHindsightState: RpcServe<HindsightSessionState, HindsightSessionStateProtocol> = {
	client: state => state.client,
	bankId: state => state.bankId,
	retainTags: state => state.retainTags,
	recallTags: state => state.recallTags,
	recallTagsMatch: state => state.recallTagsMatch,
	config: state => state.config,
	lastRecallSnippet: state => state.lastRecallSnippet,
	mentalModelsSnippet: state => state.mentalModelsSnippet,
	"banks.size": state => state.banksSet.size,
	"banks.has": (state, bankId) => state.banksSet.has(bankId),
	"banks.add": (state, bankId) => {
		state.banksSet.add(bankId);
	},
	"banks.delete": (state, bankId) => state.banksSet.delete(bankId),
	"banks.list": state => [...state.banksSet],
};

const serveMnemopiState: RpcServe<MnemopiSessionState, MnemopiSessionStateProtocol> = {
	sessionId: state => state.sessionId,
	config: state => state.config,
	hasRecalledForFirstTurn: state => state.hasRecalledForFirstTurn,
	lastRecallSnippet: state => state.lastRecallSnippet,
	aliasOf: state => state.aliasOf,
	getScopedRetainTarget: state => ({ bank: state.getScopedRetainTarget().bank }),
	getScopedRecallTargets: state => state.getScopedRecallTargets().map(target => ({ bank: target.bank })),
	getGlobalRetainTarget: state => ({ bank: state.getGlobalRetainTarget().bank }),
	getScopedMemory: (state, id) => state.getScopedMemory(id),
	editScopedMemory: (state, op, id, options) => state.editScopedMemory(op, id, options),
	collectScopedRecallResults: (state, query) => state.collectScopedRecallResults(query),
	formatScopedRecallContext: (state, results, format) => state.formatScopedRecallContext(results, format),
	rememberScoped: (state, memory, options, target) => state.rememberScoped(memory, options, target),
	getScopedStats: state => state.getScopedStats(),
	consolidate: (state, options) => state.consolidate(options),
};

const serveSupermemoryState: RpcServe<SupermemorySessionState, SupermemorySessionStateProtocol> = {
	containerTag: state => state.containerTag,
	config: state => state.config,
	aliasOf: state => state.aliasOf,
	lastRecallSnippet: state => state.lastRecallSnippet,
	search: (state, query, limit, signal) => state.search(query, limit, signal),
	enqueueRetain: (state, toolCallId, items) => state.enqueueRetain(toolCallId, items),
	save: (state, content, metadata, customId) => state.save(content, metadata, customId),
	updateMemory: (state, id, content, signal) => state.updateMemory(id, content, signal),
	forgetMemory: (state, id, reason, signal) => state.forgetMemory(id, reason, signal),
};

let memoryErrorsRegistered = false;

/** Rebuild Hindsight and Supermemory request errors by class on the receiving thread. */
function registerMemoryErrors(): void {
	if (memoryErrorsRegistered) return;
	memoryErrorsRegistered = true;
	registerRpcError("HindsightError", message => new HindsightError(message));
	// `status` is an own field: the link copies it onto the rebuilt error.
	registerRpcError("SupermemoryHttpError", message => Object.assign(new SupermemoryHttpError(0), { message }));
}

/** Hindsight, Mnemopi and Supermemory parent-state bridging for subagent workers. */
export const memoryThreadService: ThreadService = {
	name: "memory",

	installMain(peer: WorkerPeer): void {
		registerMemoryErrors();
		const link = peer.link;
		link.exportClass<HindsightApi, HindsightClientProtocol>(
			HINDSIGHT_CLIENT_KIND,
			(value): value is HindsightApi => value instanceof HindsightApi,
			serveHindsightClient,
		);
		link.exportClass<HindsightSessionState, HindsightSessionStateProtocol>(
			HINDSIGHT_SESSION_STATE_KIND,
			(value): value is HindsightSessionState => value instanceof HindsightSessionState,
			serveHindsightState,
		);
		link.exportClass<MnemopiSessionState, MnemopiSessionStateProtocol>(
			MNEMOPI_SESSION_STATE_KIND,
			(value): value is MnemopiSessionState => value instanceof MnemopiSessionState,
			serveMnemopiState,
		);
		link.exportClass<SupermemorySessionState, SupermemorySessionStateProtocol>(
			SUPERMEMORY_SESSION_STATE_KIND,
			(value): value is SupermemorySessionState => value instanceof SupermemorySessionState,
			serveSupermemoryState,
		);
	},

	installWorker(link: WorkerThreadLink): void {
		registerMemoryErrors();
		link.importClass<RemoteHindsightClient, HindsightClientProtocol>(
			HINDSIGHT_CLIENT_KIND,
			remote => new RemoteHindsightClient(remote),
		);
		link.importClass<RemoteHindsightSessionState, HindsightSessionStateProtocol>(
			HINDSIGHT_SESSION_STATE_KIND,
			remote => new RemoteHindsightSessionState(remote),
		);
		link.importClass<RemoteMnemopiSessionState, MnemopiSessionStateProtocol>(
			MNEMOPI_SESSION_STATE_KIND,
			remote => new RemoteMnemopiSessionState(remote),
		);
		link.importClass<RemoteSupermemorySessionState, SupermemorySessionStateProtocol>(
			SUPERMEMORY_SESSION_STATE_KIND,
			remote => new RemoteSupermemorySessionState(remote),
		);
	},
};
