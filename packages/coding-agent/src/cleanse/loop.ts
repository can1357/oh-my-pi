import { groupDiagnosticsByFile } from "./balance";
import { diagnosticKey } from "./checkers";
import type {
	CleanseAgentOutcome,
	CleanseAssignment,
	CleanseDiagnostic,
	CleanseDiagnosticReport,
	CleanseFileIssues,
	CleanseLoopResult,
} from "./types";

/** Runtime seams for one streaming diagnose-while-dispatching pass plus verification. */
export interface CleanseLoopDependencies {
	/**
	 * Streaming diagnostic pass. Implementations invoke `onDiagnostics` as
	 * checkers emit output and resolve with the final aggregate report once
	 * every checker has exited.
	 */
	collect(
		onDiagnostics: (diagnostics: readonly CleanseDiagnostic[]) => void,
		signal?: AbortSignal,
	): Promise<CleanseDiagnosticReport>;
	/** Post-repair verification pass; never dispatches. */
	verify(signal?: AbortSignal): Promise<CleanseDiagnosticReport>;
	/** Run one repair subagent to completion. `peers` are the other in-flight assignments. */
	dispatch(
		assignment: CleanseAssignment,
		worker: number,
		peers: readonly CleanseAssignment[],
		signal?: AbortSignal,
	): Promise<CleanseAgentOutcome>;
	/**
	 * Deliver late diagnostics for files owned by a running worker into that
	 * worker's chat. Resolve false (or reject) when undeliverable; the loop
	 * requeues them for a fresh worker instead.
	 */
	followUp?(worker: number, diagnostics: readonly CleanseDiagnostic[]): Promise<boolean>;
	/** Final streaming report, before verification. */
	onCollected?(report: CleanseDiagnosticReport): void;
	/** Verification finished with `report` remaining. */
	onVerified?(report: CleanseDiagnosticReport): void;
}

/** Inputs controlling one complete cleanse loop. */
export interface CleanseLoopOptions {
	maxAgents: number;
	signal?: AbortSignal;
}

/** One in-flight worker's ownership record shared by every file it holds. */
interface OwnerEntry {
	worker: number;
	/** Late diagnostics not yet delivered as a follow-up message. */
	held: CleanseDiagnostic[];
	sending: boolean;
	released: boolean;
}

/**
 * Stream diagnostics into a bounded worker pool, then verify the combined edits.
 *
 * Diagnostics are grouped per file and dispatched as they arrive: a new file
 * group goes to a fresh worker while fewer than `maxAgents` run; otherwise it
 * queues until a slot frees. Files stay sticky — two workers never edit the
 * same file concurrently. Late diagnostics for an owned file are steered into
 * the owning worker's chat via `followUp`; when that fails (worker not yet
 * registered or already finishing) they are requeued for a fresh worker once
 * the owner releases the file. Each diagnostic is dispatched at most once;
 * the final verification pass decides `clean`.
 */
export async function runCleanseLoop(
	options: CleanseLoopOptions,
	dependencies: CleanseLoopDependencies,
): Promise<CleanseLoopResult> {
	const { maxAgents, signal } = options;
	if (!Number.isInteger(maxAgents) || maxAgents <= 0) {
		throw new Error("maxAgents must be a positive integer");
	}

	const seen = new Set<string>();
	/** File key (`""` = project-level) → queued diagnostics not yet assigned. */
	const pending = new Map<string, CleanseDiagnostic[]>();
	/** File keys owned by an in-flight worker. */
	const owned = new Map<string, OwnerEntry>();
	const inFlight = new Map<number, { assignment: CleanseAssignment; done: Promise<void> }>();
	const followUps = new Set<Promise<void>>();
	const outcomes: CleanseAgentOutcome[] = [];
	let dispatched = 0;
	/** Infrastructure failure from the dispatch seam (subagent errors settle as outcomes instead). */
	let dispatchFailure: unknown;

	/** Queue one deduplicated diagnostic: held for its owner or pending for a fresh worker. */
	const route = (diagnostic: CleanseDiagnostic, touched: Set<OwnerEntry>): void => {
		const fileKey = diagnostic.file ?? "";
		const entry = owned.get(fileKey);
		if (entry) {
			entry.held.push(diagnostic);
			touched.add(entry);
			return;
		}
		const queued = pending.get(fileKey);
		if (queued) queued.push(diagnostic);
		else pending.set(fileKey, [diagnostic]);
	};

	const enqueue = (diagnostics: readonly CleanseDiagnostic[]): void => {
		const touched = new Set<OwnerEntry>();
		for (const diagnostic of diagnostics) {
			const key = diagnosticKey(diagnostic);
			if (seen.has(key)) continue;
			seen.add(key);
			route(diagnostic, touched);
		}
		for (const entry of touched) trySend(entry);
	};

	/** Steer held diagnostics into the owning worker's chat, one batch in flight per worker. */
	const trySend = (entry: OwnerEntry): void => {
		if (!dependencies.followUp || entry.sending || entry.released || entry.held.length === 0) return;
		const batch = entry.held.splice(0);
		entry.sending = true;
		const send = dependencies
			.followUp(entry.worker, batch)
			.catch(() => false)
			.then(delivered => {
				entry.sending = false;
				followUps.delete(send);
				if (delivered) {
					trySend(entry);
					return;
				}
				if (entry.released) {
					// Owner finished while the send was in flight; requeue for a fresh worker.
					const touched = new Set<OwnerEntry>();
					for (const diagnostic of batch) route(diagnostic, touched);
					for (const late of touched) trySend(late);
					pump();
				} else {
					// Retried at the next enqueue touch or requeued when the owner releases.
					entry.held.unshift(...batch);
				}
			});
		followUps.add(send);
	};

	const takeBatch = (): CleanseFileIssues[] => {
		const groups = groupDiagnosticsByFile([...pending.values()].flat());
		// Aim for roughly maxAgents-sized shares of the currently queued weight,
		// so a lone free slot never swallows the whole backlog in one worker.
		const totalWeight = groups.reduce((sum, group) => sum + group.weight, 0);
		const budget = totalWeight / maxAgents;
		const batch: CleanseFileIssues[] = [];
		let weight = 0;
		for (const group of groups) {
			if (batch.length > 0 && weight >= budget) break;
			batch.push(group);
			weight += group.weight;
			pending.delete(group.file ?? "");
		}
		return batch;
	};

	const launch = (groups: CleanseFileIssues[]): void => {
		dispatched += 1;
		const worker = dispatched;
		const assignment: CleanseAssignment = {
			index: worker - 1,
			groups,
			weight: groups.reduce((sum, group) => sum + group.weight, 0),
		};
		const entry: OwnerEntry = { worker, held: [], sending: false, released: false };
		for (const group of groups) owned.set(group.file ?? "", entry);
		const peers = [...inFlight.values()].map(flight => flight.assignment);
		const done = dependencies
			.dispatch(assignment, worker, peers, signal)
			.then(
				outcome => outcomes.push(outcome),
				error => {
					dispatchFailure ??= error;
					outcomes.push({
						name: `CleanseA${worker}`,
						success: false,
						output: "",
						error: error instanceof Error ? error.message : String(error),
					});
				},
			)
			.then(() => {
				inFlight.delete(worker);
				entry.released = true;
				for (const group of groups) owned.delete(group.file ?? "");
				// Undelivered late diagnostics may already be fixed; a follow-up
				// worker verifies and no-ops if so.
				const leftovers = entry.held.splice(0);
				const touched = new Set<OwnerEntry>();
				for (const diagnostic of leftovers) route(diagnostic, touched);
				for (const late of touched) trySend(late);
				pump();
			});
		inFlight.set(worker, { assignment, done });
	};

	const pump = (): void => {
		if (signal?.aborted || dispatchFailure) return;
		while (pending.size > 0 && inFlight.size < maxAgents) {
			launch(takeBatch());
		}
	};

	let collectFailure: unknown;
	let report: CleanseDiagnosticReport;
	try {
		report = await dependencies.collect(diagnostics => {
			enqueue(diagnostics);
			pump();
		}, signal);
	} catch (error) {
		// Drain in-flight workers before surfacing the failure.
		collectFailure = error;
		report = { checks: [], diagnostics: [], skipped: [] };
	}
	if (!collectFailure) {
		// Safety net for non-streaming collect implementations.
		enqueue(report.diagnostics);
		pump();
		dependencies.onCollected?.(report);
	}

	// Drain: every completion and settled follow-up pumps, so the queue
	// empties unless cancelled or failed.
	const draining = (): boolean =>
		inFlight.size > 0 ||
		followUps.size > 0 ||
		(pending.size > 0 && !signal?.aborted && !collectFailure && !dispatchFailure);
	while (draining()) {
		if (inFlight.size === 0 && followUps.size === 0) {
			pump();
			if (inFlight.size === 0) break;
		}
		await Promise.race([...followUps, ...[...inFlight.values()].map(flight => flight.done)]);
	}
	if (collectFailure) throw collectFailure;
	if (dispatchFailure && !signal?.aborted) throw dispatchFailure;

	if (signal?.aborted) {
		return { status: "cancelled", workers: dispatched, report, outcomes };
	}
	if (dispatched === 0) {
		const status = report.diagnostics.length === 0 ? "clean" : "stalled";
		return { status, workers: 0, report, outcomes };
	}
	const verified = await dependencies.verify(signal);
	dependencies.onVerified?.(verified);
	if (signal?.aborted) {
		return { status: "cancelled", workers: dispatched, report: verified, outcomes };
	}
	return {
		status: verified.diagnostics.length === 0 ? "clean" : "stalled",
		workers: dispatched,
		report: verified,
		outcomes,
	};
}
