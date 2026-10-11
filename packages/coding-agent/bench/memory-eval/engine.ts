/** Adapter contract every engine (Mnemopi, Mnemosyne, sanity engines) implements for the protocol runner. */
import type { EvalCase, EvalQuestion } from "./types";

export type EngineName = "mnemopi" | "mnemosyne" | "oracle" | "random";
export type ProtocolName = "standard" | "fts-only" | "with-sleep" | "upstream-compat";

export interface RememberItem {
	messageId: string;
	content: string;
	source: string;
	importance: number;
}

export interface RecallHit {
	engineId: string;
	tier: "working" | "episodic";
	content: string;
	summaryOf: string[];
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
	close(): Promise<void>;
	dispose(): Promise<void>;
	/** Starts the engine and embeds the one string "warmup" (a no-op for fts-only), so the runner can time process start, import and model load. */
	warmup(protocol: ProtocolName): Promise<void>;
	/** Engine memory: peak resident set size, plus the resident set size before warmup. Both are in bytes. */
	resources(): Promise<{ peakRssBytes: number; baselineRssBytes: number }>;
}
