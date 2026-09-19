import {
	buildQueryWorkerContext,
	executeLeasedCompletion,
	workerContextContains,
	type RlmBrokerResult,
	type RlmWorkerMessage,
} from "./broker";
import { RlmRuntime } from "./runtime";
import type { RlmStore } from "./store";
import { resolveRlmView } from "./view";

export interface RlmCompleterOptions {
	/** Abort in-flight provider work (lease / store cancel / wall-clock / session dispose). */
	signal?: AbortSignal;
	deadlineAt?: number;
	/** RLM purpose tag for host routing / telemetry. */
	purpose?: "rlm-query" | "rlm-subcall" | string;
	/** Inspectable worker messages (context firewall). */
	workerMessages?: readonly RlmWorkerMessage[];
}

/**
 * Host-injected isolated completion. Must NOT inherit root transcript history.
 * Prefer `session.runIsolatedCompletion` / `runEphemeralTurn({ isolated: true })`.
 */
export interface RlmCompleter {
	(
		prompt: string,
		options?: RlmCompleterOptions,
	): Promise<
		| string
		| {
				text: string;
				tokens?: number;
				cost?: number;
				inputTokens?: number;
				outputTokens?: number;
		  }
	>;
}

export interface RlmQueryResult {
	text: string;
	citation: string;
	failOpen?: boolean;
	tokens?: number;
	cost?: number;
	overBudget?: boolean;
	context?: RlmBrokerResult["context"];
	leaseId?: string;
	aborted?: boolean;
}

const QUERY_SLICE = 8_192;

/**
 * Depth-0 query over a capped grant via the v3 membrane (view + lease + ledger).
 * Accepts {@link RlmRuntime} or legacy {@link RlmStore}.
 */
export async function rlmQuery(
	storeOrRuntime: RlmStore | RlmRuntime,
	handle: string,
	question: string,
	complete?: RlmCompleter,
	start = 0,
	end?: number,
): Promise<RlmQueryResult> {
	const runtime =
		storeOrRuntime instanceof RlmRuntime ? storeOrRuntime : RlmRuntime.fromStore(storeOrRuntime);
	const store = runtime.store;

	let view;
	try {
		view = resolveRlmView(store, [{ handle, start, end }], { perGrantSlice: QUERY_SLICE });
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		store.note("query", msg, true);
		return { text: `${msg} (fail-open)`, citation: handle, failOpen: true };
	}

	const worker = buildQueryWorkerContext(view, question);
	const result = await executeLeasedCompletion(runtime, worker, complete, "query");
	return {
		text: result.text,
		citation: result.citation,
		failOpen: result.failOpen,
		tokens: result.tokens,
		cost: result.cost,
		overBudget: result.overBudget,
		context: result.context,
		leaseId: result.lease?.id,
		aborted: result.aborted,
	};
}

export function promptContainsCorpus(prompt: string, corpus: string): boolean {
	if (corpus.length <= QUERY_SLICE) return prompt.includes(corpus);
	const mid = Math.floor(corpus.length / 2);
	const window = corpus.slice(Math.max(0, mid - 64), mid + 64);
	return prompt.includes(window);
}

export { QUERY_SLICE, workerContextContains };
export type { RlmBrokerResult, RlmWorkerMessage };
