import {
	contextFlowRlmGrants,
	contextFlowRlmWorkerSkipped,
	FLOW_KEYS,
	resolveRlmFlowOwner,
} from "../context-flow/rlm-flow";
import {
	buildQueryWorkerContext,
	buildQueryWorkerRequest,
	executeLeasedCompletion,
	workerContextContains,
	type RlmBrokerResult,
	type RlmWorkerMessage,
} from "./broker";
import { RlmRuntime } from "./runtime";
import {
	selectGrantsFromSearch,
	type RlmGrantSelectPolicy,
	type RlmGrantSelectResult,
} from "./select-grants";
import type { RlmStore } from "./store";
import { brokerResultUsageFields, type RlmWorkerUsageSource } from "./worker-usage";
import { resolveRlmView, type RlmGrant } from "./view";


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
		| {
				text: string;
				tokens?: number;
				cost?: number;
				inputTokens?: number;
				outputTokens?: number;
				cacheReadTokens?: number;
				provider?: string;
				model?: string;
				structured?: unknown;
		  }
		| string
	>;
}

export interface RlmQueryResult {
	text: string;
	citation: string;
	failOpen?: boolean;
	tokens?: number;
	cost?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	provider?: string;
	model?: string;
	workerUsageKnown?: boolean;
	workerUsageSource?: RlmWorkerUsageSource;
	overBudget?: boolean;
	context?: RlmBrokerResult["context"];
	leaseId?: string;
	aborted?: boolean;
	/** Present when grants came from search selection. */
	selection?: RlmGrantSelectResult;
	/** Granted UTF-8 bytes actually sent to the worker. */
	grantedBytes?: number;
}

const QUERY_SLICE = 8_192;

export interface RlmQueryArgs {
	handle: string;
	question: string;
	complete?: RlmCompleter;
	/** Default fixed-grant start (ignored when grants or patterns set). */
	start?: number;
	end?: number;
	/** Explicit multi-range grants. */
	grants?: readonly RlmGrant[];
	/**
	 * Search patterns driving grant selection on `handle`.
	 * When set (and grants omitted), query does **not** default to the first 8 KiB.
	 */
	patterns?: string | readonly string[];
	selectPolicy?: RlmGrantSelectPolicy;
}

/**
 * Depth-0 query over a capped grant via the v3 membrane (view + lease + ledger).
 * Accepts {@link RlmRuntime} or legacy {@link RlmStore}.
 *
 * Grant sources (first match wins):
 * 1. explicit `grants`
 * 2. search-driven `patterns` on `handle`
 * 3. legacy fixed slice `handle` + start/end (default start=0, capped to QUERY_SLICE)
 */
export async function rlmQuery(
	storeOrRuntime: RlmStore | RlmRuntime,
	handleOrArgs: string | RlmQueryArgs,
	question?: string,
	complete?: RlmCompleter,
	start = 0,
	end?: number,
): Promise<RlmQueryResult> {
	const args: RlmQueryArgs =
		typeof handleOrArgs === "string"
			? { handle: handleOrArgs, question: question ?? "", complete, start, end }
			: handleOrArgs;

	const runtime =
		storeOrRuntime instanceof RlmRuntime ? storeOrRuntime : RlmRuntime.fromStore(storeOrRuntime);
	const store = runtime.store;
	const handle = args.handle;
	const q = (args.question ?? "").trim();
	if (!q) {
		store.note("query", "empty question", true);
		return { text: "question is required (fail-open)", citation: handle, failOpen: true };
	}

	let grants: RlmGrant[];
	let selection: RlmGrantSelectResult | undefined;

	if (args.grants && args.grants.length > 0) {
		grants = [...args.grants];
	} else if (args.patterns !== undefined) {
		try {
			selection = selectGrantsFromSearch(store, handle, args.patterns, args.selectPolicy);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			store.note("query", msg, true);
			return { text: `${msg} (fail-open)`, citation: handle, failOpen: true, selection };
		}
		if (selection.empty || selection.grants.length === 0) {
			store.metrics.queries += 1;
			store.metrics.workerCallsAvoided += 1;
			store.note("query", `no search hits for patterns on ${handle}`, true);
			const owner = resolveRlmFlowOwner(runtime);
			if (owner) contextFlowRlmWorkerSkipped(owner, FLOW_KEYS.RLM_WORKER, "no search hits", store);
			return {
				text: "no matching evidence in spilled corpus — abstain rather than guess (fail-open)",
				citation: handle,
				failOpen: true,
				selection,
				grantedBytes: 0,
			};
		}
		store.metrics.grantsSelected += selection.grants.length;
		grants = selection.grants;
		const owner = resolveRlmFlowOwner(runtime);
		if (owner) {
			contextFlowRlmGrants(
				owner,
				{
					grantedBytes: selection.grantedBytes,
					grantCount: selection.grants.length,
					grantedTokens: Math.round(selection.grantedBytes / 4),
				},
				store,
			);
		}
	} else {
		grants = [{ handle, start: args.start ?? 0, end: args.end }];
	}

	store.metrics.queries += 1;

	let view;
	try {
		view = resolveRlmView(store, grants, { perGrantSlice: QUERY_SLICE });
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		store.note("query", msg, true);
		return { text: `${msg} (fail-open)`, citation: handle, failOpen: true, selection };
	}

	const worker = buildQueryWorkerRequest({ question: q, view });
	const result = await executeLeasedCompletion(runtime, worker, args.complete, "query");
	return {
		text: result.text,
		citation: result.citation,
		failOpen: result.failOpen,
		...brokerResultUsageFields(result),
		overBudget: result.overBudget,
		context: result.context,
		leaseId: result.lease?.id,
		aborted: result.aborted,
		selection,
		grantedBytes: view.grantedBytes,
	};
}

export function promptContainsCorpus(prompt: string, corpus: string): boolean {
	if (corpus.length <= QUERY_SLICE) return prompt.includes(corpus);
	const mid = Math.floor(corpus.length / 2);
	return prompt.includes(corpus.slice(Math.max(0, mid - 40), mid + 40));
}

export { QUERY_SLICE, workerContextContains };
export type { RlmBrokerResult, RlmWorkerMessage };
