/** Adapter contract every engine (Mnemopi, Mnemosyne, sanity engines) implements for the protocol runner. */
import type { EvalCase, EvalQuestion } from "./types";

export type EngineName = "mnemopi" | "mnemosyne" | "oracle" | "random";
export type ProtocolName = "standard" | "fts-only" | "with-sleep" | "upstream-compat";
/** `recall`: `BeamMemory.recall`. `enhanced`: `recallEnhanced` with facts, the call omp's auto-recall makes. */
export type MnemopiRecall = "recall" | "enhanced";

export interface RememberItem {
	messageId: string;
	content: string;
	source: string;
	importance: number;
}

export interface RecallHit {
	engineId: string;
	/** `fact`: a Mnemopi fact row (`--mnemopi-recall enhanced`); it maps to messages only by content. */
	tier: "working" | "episodic" | "fact";
	content: string;
	summaryOf: string[];
}

/** A row the engine returned but the harness does not rank (a derived tier such as `memoria_source`). */
export interface DroppedRow {
	tier: string;
	engineId: string;
	/** The working row a derived row was built from, when the engine says so. */
	sourceMemoryId: string | null;
	/** 0-based position in the engine's raw result list. */
	rank: number;
}

export interface EngineOpenOptions {
	storeDir: string;
	protocol: ProtocolName;
}

export interface EngineAdapter {
	readonly name: EngineName;
	/** Whose memory `resources()` reports: a separate engine process, or the harness process itself. */
	readonly rssScope: "engine-process" | "harness-process";
	describe(): Promise<Record<string, string>>;
	open(evalCase: EvalCase, options: EngineOpenOptions): Promise<void>;
	remember(items: readonly RememberItem[]): Promise<(string | null)[]>;
	vectorCount(): Promise<number>;
	sleep(): Promise<void>;
	recall(question: EvalQuestion, k: number): Promise<RecallHit[]>;
	/** Rows the last `recall` returned but did not rank; engines that never drop rows omit this. */
	lastDropped?(): DroppedRow[];
	/** The largest `top_k` the last `recall` asked the engine for (diagnostic); engines that never widen omit this. */
	lastFetchK?(): number;
	close(): Promise<void>;
	dispose(): Promise<void>;
	/** Starts the engine and embeds the one string "warmup" (a no-op for fts-only), so the runner can time process start, import and model load. */
	warmup(protocol: ProtocolName): Promise<void>;
	/** Engine memory: peak resident set size, plus the resident set size before warmup. Both are in bytes. */
	resources(): Promise<{ peakRssBytes: number; baselineRssBytes: number }>;
}
