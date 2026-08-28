/**
 * Working state store — the live, mutable picture of the task.
 *
 * One SQLite row per {@link PersistenceScope}, keyed on {@link scopeKey} and
 * upserted in place. Two deliberate departures from the obvious design:
 *
 * ## One row per scope, not one row per update
 *
 * Appending a row per update and reading `ORDER BY updated_at DESC LIMIT 1`
 * has two failure modes this store refuses to inherit: two writes inside the
 * same millisecond make "latest" a coin toss, and any other row that lands in
 * the table (a snapshot, a migration artefact) silently becomes the current
 * state. History belongs to the checkpoint store and the event journal; the
 * working state is a register, not a log.
 *
 * ## Synchronous API
 *
 * `bun:sqlite` is synchronous. Wrapping every method in `async` would promise
 * concurrency the store cannot deliver and invite `await`-free call sites that
 * still compile. Callers that need a promise can wrap the call; the type
 * system should not claim I/O that never yields.
 *
 * Mutations run through {@link WorkingStateStore.update}, which performs its
 * read-merge-write inside a SQLite transaction so two writers cannot
 * interleave a lost update.
 */

import { Database } from "bun:sqlite";
import type { PersistenceScope, WorkingState } from "./types";
import { asString, asStringArray, createEmptyWorkingState, hashContent, scopeKey } from "./types";

export interface WorkingStateStoreOptions {
	dbPath: string;
	scope: PersistenceScope;
}

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS working_state (
		state_key TEXT PRIMARY KEY,
		project_id TEXT NOT NULL,
		objective TEXT NOT NULL DEFAULT '',
		constraints TEXT NOT NULL DEFAULT '[]',
		active_plan TEXT NOT NULL DEFAULT '',
		current_step TEXT NOT NULL DEFAULT '',
		files_touched TEXT NOT NULL DEFAULT '[]',
		pending_operations TEXT NOT NULL DEFAULT '[]',
		unresolved_errors TEXT NOT NULL DEFAULT '[]',
		last_verified_test_state TEXT NOT NULL DEFAULT '',
		content_hash TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		created_at TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_working_state_project ON working_state(project_id);
`;

export class WorkingStateStore {
	readonly #db: Database;
	readonly #scope: PersistenceScope;
	readonly #stateKey: string;

	constructor(options: WorkingStateStoreOptions) {
		this.#scope = options.scope;
		this.#stateKey = scopeKey(options.scope);
		this.#db = new Database(options.dbPath, { create: true });
		this.#db.exec("PRAGMA journal_mode = WAL;");
		this.#db.exec("PRAGMA busy_timeout = 5000;");
		this.#db.exec(SCHEMA);
	}

	/** The current state for this scope, or a fresh empty state if none exists. */
	getCurrent(): WorkingState {
		const row = this.#db.query("SELECT * FROM working_state WHERE state_key = ?").get(this.#stateKey) as Record<
			string,
			unknown
		> | null;

		if (!row) return createEmptyWorkingState();

		return {
			objective: asString(row.objective),
			constraints: asStringArray(row.constraints),
			activePlan: asString(row.active_plan),
			currentStep: asString(row.current_step),
			filesTouched: asStringArray(row.files_touched),
			pendingOperations: asStringArray(row.pending_operations),
			unresolvedErrors: asStringArray(row.unresolved_errors),
			lastVerifiedTestState: asString(row.last_verified_test_state),
			updatedAt: asString(row.updated_at),
		};
	}

	/**
	 * Merge `updates` into the current state and persist the result.
	 *
	 * Read-merge-write runs inside a transaction: without it, two concurrent
	 * updates each read the same base state and the second write silently
	 * discards the first.
	 */
	update(updates: Partial<Omit<WorkingState, "updatedAt">>): WorkingState {
		return this.#merge(() => updates);
	}

	setObjective(objective: string): WorkingState {
		return this.update({ objective });
	}

	/** Committing to a new plan resets the step: the old step described the old plan. */
	setActivePlan(activePlan: string): WorkingState {
		return this.update({ activePlan, currentStep: "" });
	}

	setCurrentStep(currentStep: string): WorkingState {
		return this.update({ currentStep });
	}

	setTestState(lastVerifiedTestState: string): WorkingState {
		return this.update({ lastVerifiedTestState });
	}

	addFileTouched(file: string): WorkingState {
		return this.#addUnique("filesTouched", file);
	}

	addConstraint(constraint: string): WorkingState {
		return this.#addUnique("constraints", constraint);
	}

	addUnresolvedError(error: string): WorkingState {
		return this.#addUnique("unresolvedErrors", error);
	}

	resolveError(error: string): WorkingState {
		return this.#removeAll("unresolvedErrors", error);
	}

	/** Pending operations are a multiset on purpose: the same command can be queued twice. */
	addPendingOperation(operation: string): WorkingState {
		return this.#merge(current => ({ pendingOperations: [...current.pendingOperations, operation] }));
	}

	completeOperation(operation: string): WorkingState {
		return this.#removeAll("pendingOperations", operation);
	}

	/** Replace the whole state, e.g. when restoring from a checkpoint. */
	replace(state: Omit<WorkingState, "updatedAt">): WorkingState {
		const next: WorkingState = { ...state, updatedAt: new Date().toISOString() };
		const apply = this.#db.transaction((): void => {
			this.#write(next);
		});
		apply();
		return next;
	}

	close(): void {
		this.#db.close();
	}

	#addUnique(field: "filesTouched" | "constraints" | "unresolvedErrors", value: string): WorkingState {
		return this.#merge(current => (current[field].includes(value) ? {} : { [field]: [...current[field], value] }));
	}

	#removeAll(field: "pendingOperations" | "unresolvedErrors", value: string): WorkingState {
		return this.#merge(current => ({ [field]: current[field].filter(item => item !== value) }));
	}

	/**
	 * The single mutation path: read, derive, write — inside one transaction.
	 *
	 * Every public mutator funnels through here, which is what makes lost
	 * updates impossible without each method reimplementing the locking.
	 */
	#merge(derive: (current: WorkingState) => Partial<Omit<WorkingState, "updatedAt">>): WorkingState {
		const apply = this.#db.transaction((): WorkingState => {
			const current = this.getCurrent();
			const next: WorkingState = { ...current, ...derive(current), updatedAt: new Date().toISOString() };
			this.#write(next);
			return next;
		});
		return apply();
	}

	#write(state: WorkingState): void {
		this.#db
			.query(`
			INSERT INTO working_state (state_key, project_id, objective, constraints, active_plan, current_step,
				files_touched, pending_operations, unresolved_errors, last_verified_test_state,
				content_hash, updated_at, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(state_key) DO UPDATE SET
				objective = excluded.objective,
				constraints = excluded.constraints,
				active_plan = excluded.active_plan,
				current_step = excluded.current_step,
				files_touched = excluded.files_touched,
				pending_operations = excluded.pending_operations,
				unresolved_errors = excluded.unresolved_errors,
				last_verified_test_state = excluded.last_verified_test_state,
				content_hash = excluded.content_hash,
				updated_at = excluded.updated_at
		`)
			.run(
				this.#stateKey,
				this.#scope.projectId,
				state.objective,
				JSON.stringify(state.constraints),
				state.activePlan,
				state.currentStep,
				JSON.stringify(state.filesTouched),
				JSON.stringify(state.pendingOperations),
				JSON.stringify(state.unresolvedErrors),
				state.lastVerifiedTestState,
				hashContent(state),
				state.updatedAt,
				state.updatedAt,
			);
	}
}
