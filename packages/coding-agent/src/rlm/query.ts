import { RlmBudgetError, type RlmStore } from "./store";

export interface RlmCompleterOptions {
	/** Abort in-flight provider work (store cancel / wall-clock / session dispose). */
	signal?: AbortSignal;
}

/**
 * Host-injected isolated completion. Must NOT inherit root transcript history.
 * Prefer `runEphemeralTurn({ isolated: true, history: [], signal })`.
 */
export interface RlmCompleter {
	(
		prompt: string,
		options?: RlmCompleterOptions,
	): Promise<{ text: string; tokens?: number; cost?: number } | string>;
}

export interface RlmQueryResult {
	text: string;
	citation: string;
	failOpen?: boolean;
	/** Tokens charged for this call (estimate or provider). */
	tokens?: number;
	cost?: number;
	overBudget?: boolean;
}

const QUERY_SLICE = 8_192;

/**
 * Depth-0 subcall: ask a question over a capped slice. The completer sees only
 * the slice + question, never the full record. Missing completer / budget miss /
 * cancel / wall-clock fail open (honest error text, no throw into the agent loop).
 *
 * Hosts must inject an **isolated** completer (`ToolSession.rlmComplete`) so the
 * provider request cannot inherit the root conversation history.
 */
export async function rlmQuery(
	store: RlmStore,
	handle: string,
	question: string,
	complete?: RlmCompleter,
	start = 0,
	end?: number,
): Promise<RlmQueryResult> {
	let peek;
	try {
		peek = store.peek(handle, start, end);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		store.note("query", msg, true);
		return { text: `${msg} (fail-open)`, citation: handle, failOpen: true };
	}
	const slice = peek.text.length > QUERY_SLICE ? peek.text.slice(0, QUERY_SLICE) : peek.text;
	const prompt = `Answer from this excerpt only. Cite ${peek.citation} if you use it.\n\nExcerpt:\n${slice}\n\nQuestion:\n${question}`;
	const approxTokens = Math.ceil(prompt.length / 4);

	try {
		store.beginCall(approxTokens);
	} catch (error) {
		if (error instanceof RlmBudgetError) {
			store.note("query", error.message, true);
			return { text: `${error.message} (fail-open)`, citation: peek.citation, failOpen: true };
		}
		throw error;
	}

	if (!complete) {
		store.note("query", "no completer", true);
		return {
			text: "rlm query unavailable: no completer configured (fail-open)",
			citation: peek.citation,
			failOpen: true,
		};
	}

	const signal = store.createCallSignal();
	try {
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
			store.note("query", "overBudget after completion", true);
			return {
				text: `${text}\n\n(rlm over-budget after completion; fail-open)`,
				citation: peek.citation,
				failOpen: true,
				tokens: reconciled.tokens,
				cost: reconciled.cost,
				overBudget: true,
			};
		}
		store.note("query", `ok tokens=${reconciled.tokens} cost=${reconciled.cost}`);
		return { text, citation: peek.citation, tokens: reconciled.tokens, cost: reconciled.cost };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		store.note("query", msg, true);
		return { text: `${msg} (fail-open)`, citation: peek.citation, failOpen: true };
	}
}

export function promptContainsCorpus(prompt: string, corpus: string): boolean {
	if (corpus.length <= QUERY_SLICE) return prompt.includes(corpus);
	// Large corpus: check midpoint window presence as a strong signal.
	const mid = Math.floor(corpus.length / 2);
	const window = corpus.slice(Math.max(0, mid - 64), mid + 64);
	return prompt.includes(window);
}

export { QUERY_SLICE };
