import { RlmBudgetError, type RlmStore } from "./store";

export interface RlmCompleter {
	(prompt: string): Promise<{ text: string; tokens?: number; cost?: number } | string>;
}

export interface RlmQueryResult {
	text: string;
	citation: string;
	failOpen?: boolean;
	/** Tokens charged for this call (estimate or provider). */
	tokens?: number;
	cost?: number;
}

const QUERY_SLICE = 8_192;

/**
 * Depth-0 subcall: ask a question over a capped slice. The completer sees only
 * the slice + question, never the full record. Missing completer / budget miss /
 * cancel / wall-clock fail open (honest error text, no throw into the agent loop).
 *
 * Hosts should inject `ToolSession.rlmComplete` from the model registry so usage
 * accounting flows through the same stack as the root model (or `rlm.subModel`).
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
		store.charge(approxTokens, 0);
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

	try {
		const raw = await complete(prompt);
		const text = typeof raw === "string" ? raw : raw.text;
		const tokens = typeof raw === "string" ? approxTokens : (raw.tokens ?? approxTokens);
		const cost = typeof raw === "string" ? 0 : (raw.cost ?? 0);
		if (cost > 0) {
			// Second charge leg for provider-reported cost only (tokens already charged).
			try {
				if (store.budget.maxCost > 0 && store.budget.cost + cost > store.budget.maxCost) {
					store.note("query", `maxCost would exceed after completion`, true);
					return {
						text: `rlm maxCost ${store.budget.maxCost} exhausted after completion (fail-open)`,
						citation: peek.citation,
						failOpen: true,
						tokens,
						cost,
					};
				}
				store.budget.cost += cost;
			} catch {
				/* ignore */
			}
		}
		store.note("query", `ok tokens~${tokens} cost=${cost}`);
		return { text, citation: peek.citation, tokens, cost };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		store.note("query", msg, true);
		return { text: `${msg} (fail-open)`, citation: peek.citation, failOpen: true };
	}
}

export function promptContainsCorpus(prompt: string, corpus: string): boolean {
	if (corpus.length <= QUERY_SLICE) return prompt.includes(corpus);
	const mid = corpus.slice(Math.floor(corpus.length / 2) - 32, Math.floor(corpus.length / 2) + 32);
	return prompt.includes(mid);
}

export { QUERY_SLICE };
