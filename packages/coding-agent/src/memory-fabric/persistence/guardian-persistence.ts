/**
 * Guardian persistence bridge — durable backing for the guardian's port.
 *
 * The guardian participant talks to memory through `GuardianRetrievalPort`,
 * whose working-state and checkpoint methods are optional precisely so the
 * fabric works with no store at all. This module supplies the durable
 * implementation: it wires the SQLite stores in this directory under an
 * existing port via {@link GuardianPersistence.extendPort}, overriding only
 * the persistence-shaped methods and delegating retrieval and context
 * composition untouched.
 *
 * Working state is scoped per session: each session id gets its own
 * {@link WorkingStateStore} over the same database file, so two concurrent
 * sessions in one project cannot read each other's objectives. Stores are
 * created lazily and cached; {@link GuardianPersistence.dispose} closes all
 * of them.
 *
 * Guardian types are imported from the guardian modules and deliberately not
 * re-exported — the guardian owns its contract, this module merely satisfies
 * it.
 */

import * as path from "node:path";
import type { GuardianWorkingState } from "../guardian/decision-engine";
import type { GuardianRetrievalPort } from "../guardian/integration";
import { CheckpointStore } from "./checkpoint-store";
import { EventJournal } from "./event-journal";
import type { PersistenceScope, WorkingState } from "./types";
import { WorkingStateStore } from "./working-state-store";

export interface GuardianPersistenceOptions {
	/** Directory that receives every store's files. */
	directory: string;
	/** Scope shared by all sessions; `sessionId` is supplied per call. */
	scope: Omit<PersistenceScope, "sessionId">;
	/** Checkpoints kept per project when the checkpoint store prunes. */
	keepCheckpoints?: number;
}

export interface GuardianPersistence {
	/** Per-session working state store, created on first use. */
	workingStateFor(sessionId: string): WorkingStateStore;
	readonly checkpointStore: CheckpointStore;
	readonly journal: EventJournal;
	/** A copy of `base` whose persistence methods hit the durable stores. */
	extendPort(base: GuardianRetrievalPort): GuardianRetrievalPort;
	/** Close every underlying database. Idempotent. */
	dispose(): void;
}

export function createGuardianPersistence(options: GuardianPersistenceOptions): GuardianPersistence {
	const stores = new Map<string, WorkingStateStore>();
	const workingStateDbPath = path.join(options.directory, `${options.scope.projectId}_working_state.sqlite`);
	const checkpointStore = new CheckpointStore({
		directory: options.directory,
		scope: options.scope,
		keepLatest: options.keepCheckpoints,
	});
	const journal = new EventJournal({ directory: options.directory, scope: options.scope });
	let disposed = false;

	const workingStateFor = (sessionId: string): WorkingStateStore => {
		let store = stores.get(sessionId);
		if (!store) {
			store = new WorkingStateStore({ dbPath: workingStateDbPath, scope: { ...options.scope, sessionId } });
			stores.set(sessionId, store);
		}
		return store;
	};

	const extendPort = (base: GuardianRetrievalPort): GuardianRetrievalPort => ({
		...base,
		getWorkingState: async (sessionId: string): Promise<GuardianWorkingState | null> => {
			const state = workingStateFor(sessionId).getCurrent();
			return toGuardianWorkingState(state);
		},
		createCheckpoint: async (sessionId: string, label: string): Promise<string> => {
			const state = workingStateFor(sessionId).getCurrent();
			const snapshot = checkpointStore.create(state, sessionId, label);
			journal.append({
				type: "checkpoint-created",
				recordId: snapshot.checkpointId,
				payload: { sessionId, label },
			});
			return snapshot.checkpointId;
		},
		queueMaintenance: async (sessionId: string, reason: string): Promise<void> => {
			journal.append({ type: "maintenance-queued", payload: { sessionId, reason } });
		},
	});

	return {
		workingStateFor,
		checkpointStore,
		journal,
		extendPort,
		dispose: (): void => {
			if (disposed) return;
			disposed = true;
			for (const store of stores.values()) store.close();
			stores.clear();
			checkpointStore.close();
			journal.close();
		},
	};
}

/**
 * Project a persisted {@link WorkingState} onto the guardian's shape.
 *
 * A state with no objective and no constraints is reported as `null` — the
 * guardian treats "no working state" and "empty working state" identically,
 * and `null` is the honest one.
 */
function toGuardianWorkingState(state: WorkingState): GuardianWorkingState | null {
	if (state.objective === "" && state.constraints.length === 0) return null;
	const guardianState: GuardianWorkingState = {};
	if (state.objective !== "") guardianState.objective = state.objective;
	if (state.constraints.length > 0) guardianState.constraints = [...state.constraints];
	return guardianState;
}
