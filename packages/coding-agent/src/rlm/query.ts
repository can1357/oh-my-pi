import { RlmBudgetError, type RlmStore } from "./store";

export interface RlmCompleter {
	(prompt: string): Promise<string>;
}

export interface RlmQueryResult {
	text: string;
	citation: string;
	failOpen?: boolean;
}

const QUERY_SLICE = 8_192;

/**
 * Depth-0 subcall: ask a question over a capped slice. The completer sees only
 * the slice + question, never the full record. Missing completer / budget miss
 * fail open (honest error text, no throw into the agent loop).
 */
export async function rlmQuery(
	store: RlmStore,
	handle: string,
	question: string,
	complete?: RlmCompleter,
	start = 0,
	end?: number,
): Promise<RlmQueryResult> {
	const peek = store.peek(handle, start, end);
	const slice = peek.text.length > QUERY_SLICE ? peek.text.slice(0, QUERY_SLICE) : peek.text;
	const prompt = `Answer from this excerpt only. Cite ${peek.citation} if you use it.\n\nExcerpt:\n${slice}\n\nQuestion:\n${question}`;
	const approxTokens = Math.ceil(prompt.length / 4);
	try {
		store.charge(approxTokens);
	} catch (error) {
		if (error instanceof RlmBudgetError) {
			return { text: `${error.message} (fail-open)`, citation: peek.citation, failOpen: true };
		}
		throw error;
	}
	if (!complete) {
		return {
			text: "rlm query unavailable: no completer configured (fail-open)",
			citation: peek.citation,
			failOpen: true,
		};
	}
	const text = await complete(prompt);
	return { text, citation: peek.citation };
}

export function promptContainsCorpus(prompt: string, corpus: string): boolean {
	if (corpus.length <= QUERY_SLICE) return prompt.includes(corpus);
	const mid = corpus.slice(Math.floor(corpus.length / 2) - 32, Math.floor(corpus.length / 2) + 32);
	return prompt.includes(mid);
}
