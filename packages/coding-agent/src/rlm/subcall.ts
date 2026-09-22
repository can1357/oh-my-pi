import {
	buildSubcallWorkerContext,
	executeLeasedCompletion,
} from "./broker";
import type { RlmCompleter, RlmQueryResult } from "./query";
import { QUERY_SLICE } from "./query";
import { RlmRuntime } from "./runtime";
import type { RlmStore } from "./store";
import { resolveRlmView, type RlmGrant } from "./view";

export type { RlmGrant };

const MAX_GRANTS = 8;
const PER_GRANT_SLICE = QUERY_SLICE;

/**
 * RFC v2 depth-1 subcall, provisioned through the v3 membrane:
 * resolve RlmView → lease → isolated completion → reconcile.
 */
export async function rlmSubcall(
	storeOrRuntime: RlmStore | RlmRuntime,
	grants: RlmGrant[],
	task: string,
	complete?: RlmCompleter,
	depth = 1,
): Promise<RlmQueryResult> {
	const runtime =
		storeOrRuntime instanceof RlmRuntime ? storeOrRuntime : RlmRuntime.fromStore(storeOrRuntime);
	const store = runtime.store;
	const trimmedTask = task.trim();

	if (!trimmedTask) {
		store.note("subcall", "empty task", true);
		return {
			text: "rlm subcall: task is required (fail-open)",
			citation: "",
			failOpen: true,
		};
	}

	if (store.budget.maxDepth < 1) {
		store.note("subcall", "maxDepth=0 rejects depth-1 subcall", true);
		return {
			text: "rlm subcall rejected: maxDepth=0 (depth-0 only; set rlm.maxDepth≥1) (fail-open)",
			citation: "",
			failOpen: true,
		};
	}

	if (depth < 1) {
		store.note("subcall", `invalid depth=${depth}`, true);
		return {
			text: `rlm subcall rejected: depth must be ≥1 (got ${depth}) (fail-open)`,
			citation: "",
			failOpen: true,
		};
	}

	if (depth > store.budget.maxDepth) {
		store.note("subcall", `depth ${depth} > maxDepth ${store.budget.maxDepth}`, true);
		return {
			text: `rlm subcall rejected: depth ${depth} exceeds maxDepth ${store.budget.maxDepth} (fail-open)`,
			citation: "",
			failOpen: true,
		};
	}

	if (!grants.length) {
		store.note("subcall", "no grants", true);
		return {
			text: "rlm subcall: at least one handle grant is required (fail-open)",
			citation: "",
			failOpen: true,
		};
	}

	let view;
	try {
		view = resolveRlmView(store, grants, { maxGrants: MAX_GRANTS, perGrantSlice: PER_GRANT_SLICE });
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		store.note("subcall", msg, true);
		return { text: `${msg} (fail-open)`, citation: "", failOpen: true };
	}

	if (!view.grants.length) {
		store.note("subcall", "empty view", true);
		return { text: "rlm subcall: empty view (fail-open)", citation: "", failOpen: true };
	}

	store.note("subcall", `depth=${depth} grants=${view.grants.length} task_bytes=${trimmedTask.length}`);
	const worker = buildSubcallWorkerContext(view, trimmedTask, depth);
	const result = await executeLeasedCompletion(runtime, worker, complete, "subcall");
	if (!result.failOpen) {
		store.note("subcall", `ok lease=${result.lease?.id ?? "?"} tokens=${result.tokens ?? 0}`);
	}
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

/** Parse `handle` and optional comma-separated `handles` into grants. */
export function parseRlmGrants(
	handle?: string,
	handles?: string,
	start?: number,
	end?: number,
): RlmGrant[] {
	const ids: string[] = [];
	if (handles?.trim()) {
		for (const part of handles.split(/[\s,]+/)) {
			const h = part.trim();
			if (h) ids.push(h);
		}
	}
	const primary = handle?.trim() || "";
	if (primary) ids.push(primary);

	const seen = new Set<string>();
	const grants: RlmGrant[] = [];
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		const isPrimary = primary !== "" && id === primary;
		if (isPrimary && (start !== undefined || end !== undefined)) {
			grants.push({ handle: id, start, end });
		} else {
			grants.push({ handle: id });
		}
	}
	// handles-only single grant may take the range.
	if (!primary && grants.length === 1 && (start !== undefined || end !== undefined)) {
		grants[0] = { handle: grants[0]!.handle, start, end };
	}
	return grants;
}
