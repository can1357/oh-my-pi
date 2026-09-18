import { RlmBudgetError, type RlmStore } from "./store";
import { QUERY_SLICE, type RlmCompleter, type RlmQueryResult } from "./query";

/** One granted slice into a spilled handle for a depth-1 worker. */
export interface RlmGrant {
	handle: string;
	start?: number;
	end?: number;
}

const MAX_GRANTS = 8;
const PER_GRANT_SLICE = QUERY_SLICE;

/**
 * RFC v2 depth-1 subcall (implementation pick **A2**: single nested ephemeral
 * completion over granted slices — not a third agent runtime, not recursive).
 *
 * - `maxDepth < 1` → fail-open (v1 preserved).
 * - `depth > maxDepth` → fail-open (blocks depth ≥ 2 when maxDepth is 1).
 * - Completer sees only granted peeks (capped), never full ungranted records.
 * - Worker has no tool loop here, so it cannot spawn depth-2 via `rlm subcall`.
 */
export async function rlmSubcall(
	store: RlmStore,
	grants: RlmGrant[],
	task: string,
	complete?: RlmCompleter,
	depth = 1,
): Promise<RlmQueryResult> {
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

	const limited = grants.slice(0, MAX_GRANTS);
	const excerpts: string[] = [];
	const citations: string[] = [];

	for (const grant of limited) {
		try {
			const peek = store.peek(grant.handle, grant.start ?? 0, grant.end);
			const text =
				peek.text.length > PER_GRANT_SLICE ? peek.text.slice(0, PER_GRANT_SLICE) : peek.text;
			excerpts.push(`### ${peek.citation}\n${text}`);
			citations.push(peek.citation);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			store.note("subcall", msg, true);
			return {
				text: `${msg} (fail-open)`,
				citation: "",
				failOpen: true,
			};
		}
	}

	const citation = citations.join("; ");
	const prompt =
		`You are a depth-${depth} RLM worker. Answer ONLY from the granted excerpts. ` +
		`Cite the handle ranges you use. You cannot call tools or spawn further subcalls.\n\n` +
		`Granted excerpts:\n${excerpts.join("\n\n")}\n\nTask:\n${trimmedTask}`;

	const approxTokens = Math.ceil(prompt.length / 4);
	try {
		store.beginCall(approxTokens);
	} catch (error) {
		const msg = error instanceof RlmBudgetError ? error.message : String(error);
		store.note("subcall", msg, true);
		return { text: `${msg} (fail-open)`, citation, failOpen: true };
	}

	if (!complete) {
		store.note("subcall", "no completer", true);
		return {
			text: "rlm subcall: no completer bound (fail-open)",
			citation,
			failOpen: true,
		};
	}

	const signal = store.createCallSignal();
	try {
		store.note("subcall", `depth=${depth} grants=${limited.length} task_bytes=${trimmedTask.length}`);
		const raw = await complete(prompt, { signal });
		const text = typeof raw === "string" ? raw : raw.text;
		const actualTokens = typeof raw === "string" ? approxTokens : (raw.tokens ?? approxTokens);
		const actualCost = typeof raw === "string" ? 0 : (raw.cost ?? 0);
		const reconciled = store.reconcileUsage({
			estimatedTokens: approxTokens,
			actualTokens,
			actualCost,
		});
		if (reconciled.overBudget) {
			store.note("subcall", "overBudget after completion", true);
			return {
				text: `${text}\n\n(rlm over-budget after completion; fail-open)`,
				citation,
				failOpen: true,
				tokens: reconciled.tokens,
				cost: reconciled.cost,
				overBudget: true,
			};
		}
		return { text, citation, tokens: reconciled.tokens, cost: reconciled.cost };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		store.note("subcall", msg, true);
		return { text: `${msg} (fail-open)`, citation, failOpen: true };
	}
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
