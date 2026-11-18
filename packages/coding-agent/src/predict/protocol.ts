/**
 * Contract between omp processes and the daemon's `predict` module
 * (`daemon/modules/predict.ts`).
 *
 * One `predict` unit (global scope) per agent directory serves ghost-text word
 * completion to every omp process through `call("predict", method, params, { unit })`.
 */
import * as path from "node:path";
import type { PredictedWord } from "@oh-my-pi/pi-natives";

/** Daemon module kind and `call` module name. */
export const TEXT_PREDICT_KIND = "predict";

/** Engines the module can open (`TextPredictor` methods); clients resolve `auto` before asking. */
export type TextPredictMethod = "ngram" | "smollm" | "apple";

/** Every engine, for per-method parameters. */
export const TEXT_PREDICT_METHODS: readonly TextPredictMethod[] = ["ngram", "smollm", "apple"];

/**
 * Unit key for one agent directory. Different agent directories (profiles,
 * tests) get separate units because history and learned state are per agent dir.
 */
export function textPredictKey(agentDir: string): string {
	return Bun.hash.wyhash(path.resolve(agentDir)).toString(16).padStart(16, "0").slice(0, 12);
}

/**
 * `open` params. Paths are resolved by the opening client: the daemon's own
 * environment belongs to whichever client started it.
 */
export interface TextPredictOpenParams {
	agentDir: string;
	/** `history.db` whose prompts the learning engines ingest. */
	historyDbPath: string;
	/** SmolLM weights directory. */
	modelDir: string;
	/** Persisted learned state per engine. */
	stateDirs: Record<TextPredictMethod, string>;
}

/** `call` methods and their params/results. */
export interface TextPredictCalls {
	complete: {
		params: { method: TextPredictMethod; before: string; prefix: string };
		result: PredictedWord | null;
	};
	feedback: {
		params: { method: TextPredictMethod; before: string; prefix: string; suggestion: string; accepted: boolean };
		result: null;
	};
	/** Ingest history rows newer than each open engine's cursor. */
	sync: { params: Record<string, never>; result: { ingested: number } };
}

export type TextPredictCallMethod = keyof TextPredictCalls;
