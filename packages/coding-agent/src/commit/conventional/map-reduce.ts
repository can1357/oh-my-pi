import * as path from "node:path";
import type { ConventionalAnalysis } from "../types";
import { formatTypesDescription } from "./commit-types";
import type { ConventionalGenerationConfig } from "./config";
import { ConventionalFileDiff, condenseStat, parsePromptDiff } from "./diff";
import type { CommitInference } from "./inference";
import { parseConventionalAnalysisMarkdown, parseFileObservationsMarkdown } from "./markdown";
import { renderConventionalPrompt } from "./prompts";

const MAX_FILE_TOKENS = 50_000;
const MAP_PHASE_CONCURRENCY = 16;
const MIN_MAP_BATCH_TOKENS = 4_000;
const MAX_CONTEXT_FILES = 20;

/** Factual observations extracted for one changed file. */
export interface ConventionalFileObservation {
	file: string;
	observations: string[];
	additions: number;
	deletions: number;
	status: ConventionalFileDiff["status"];
}

/** Return whether a diff crosses llm-git's exact map-reduce threshold. */
export function shouldUseMapReduce(diff: string, config: ConventionalGenerationConfig): boolean {
	if (!config.mapReduceEnabled) return false;
	let totalTokens = 0;
	let hasIncludedFile = false;
	for (const file of includedFiles(parsePromptDiff(diff), config)) {
		hasIncludedFile = true;
		const tokens = file.tokenEstimate();
		if (tokens > MAX_FILE_TOKENS) return true;
		totalTokens += tokens;
		if (totalTokens >= config.mapReduceThreshold) return true;
	}
	return hasIncludedFile && totalTokens >= config.mapReduceThreshold;
}

/** Group all file indices into greedy token- and byte-budgeted batches. */
export function buildFileBatches(files: readonly ConventionalFileDiff[], budget: number): number[][] {
	return buildBatchesForIndices(
		files,
		files.map((_file, index) => index),
		budget,
	);
}

/** Group non-binary file indices into greedy LLM batches. */
export function buildLlmFileBatches(files: readonly ConventionalFileDiff[], budget: number): number[][] {
	const indices: number[] = [];
	for (let index = 0; index < files.length; index += 1) if (!files[index]?.isBinary) indices.push(index);
	return buildBatchesForIndices(files, indices, budget);
}

/** Run exact per-file observation mapping followed by one reduce synthesis call. */
export async function runMapReduce(input: {
	inference: CommitInference;
	config: ConventionalGenerationConfig;
	stat: string;
	diff: string;
	scopeCandidates: string;
}): Promise<ConventionalAnalysis> {
	const files = includedFiles(parsePromptDiff(input.diff), input.config);
	if (files.length === 0) throw new Error("No relevant files to summarize after filtering");
	const observations = await mapPhase(files, input.inference, input.config);
	const prompts = renderConventionalPrompt("reduce", {
		types_description: formatTypesDescription(),
		observations: renderObservationsMarkdown(observations),
		stat: condenseStat(input.stat),
		scope_candidates: input.scopeCandidates,
	});
	return input.inference.complete(
		{
			operation: "map-reduce/reduce",
			role: "analysis",
			promptFamily: "reduce",
			systemPrompt: prompts.system,
			userPrompt: prompts.user,
			toolName: "create_conventional_analysis",
			progressLabel: "Reducing file observations…",
		},
		response => parseConventionalAnalysisMarkdown(response.text),
	);
}

/** Render status and change-count annotations into reduce-phase markdown. */
export function renderObservationsMarkdown(observations: readonly ConventionalFileObservation[]): string {
	const sections: string[] = [];
	for (const item of observations) {
		const annotations: string[] = item.status === "modified" ? [] : [item.status];
		if (item.additions || item.deletions) annotations.push(`+${item.additions}/-${item.deletions}`);
		const suffix = annotations.length > 0 ? ` (${annotations.join(", ")})` : "";
		sections.push(`# ${item.file}${suffix}\n${item.observations.map(text => `- ${text}`).join("\n")}`);
	}
	return sections.join("\n\n");
}

async function mapPhase(
	files: readonly ConventionalFileDiff[],
	inference: CommitInference,
	config: ConventionalGenerationConfig,
): Promise<ConventionalFileObservation[]> {
	const headers = new ContextHeaders(files);
	const totalTokens = files.reduce((sum, file) => sum + (file.isBinary ? 0 : file.tokenEstimate()), 0);
	const budget = effectiveMapBudget(totalTokens, config.mapBatchTokenBudget);
	const batches = buildLlmFileBatches(files, budget);
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const observations: Array<ConventionalFileObservation | undefined> = new Array(files.length);
	for (let index = 0; index < files.length; index += 1) {
		const file = files[index];
		if (!file?.isBinary) continue;
		observations[index] = {
			file: file.filename,
			observations: ["Binary file changed."],
			additions: file.additions,
			deletions: file.deletions,
			status: file.status,
		};
	}
	const results = await mapWithConcurrency(batches, MAP_PHASE_CONCURRENCY, async (batch, batchIndex) => {
		const batchFiles = batch.map(index => files[index]).filter(value => value !== undefined);
		const mapped = await mapFileBatch(
			batchFiles,
			headers.headerForFiles(batchFiles.map(file => file.filename)),
			inference,
			`Mapping batch ${batchIndex + 1}/${batches.length} (${batchFiles.length} files)…`,
			budget,
		);
		return batch.map((fileIndex, index) => ({ fileIndex, observation: mapped[index] }));
	});
	for (const batch of results) {
		for (const item of batch) if (item.observation) observations[item.fileIndex] = item.observation;
	}
	return observations.map((observation, index) => {
		if (observation) return observation;
		throw new Error(`Missing map observation for ${files[index]?.filename ?? "unknown"}`);
	});
}

async function mapFileBatch(
	files: readonly ConventionalFileDiff[],
	contextHeader: string,
	inference: CommitInference,
	progressLabel: string,
	budget: number,
): Promise<ConventionalFileObservation[]> {
	const promptFiles = files.map(file => ({ path: file.filename, diff: renderFileDiffForBatch(file, budget) }));
	const prompts = renderConventionalPrompt("map", { files: promptFiles, context_header: contextHeader });
	return inference.complete(
		{
			operation: "map-reduce/map",
			role: "map",
			promptFamily: "map",
			systemPrompt: prompts.system,
			userPrompt: prompts.user,
			toolName: "create_file_observations",
			progressLabel,
		},
		response => mapResponseToObservations(files, parseFileObservationsMarkdown(response.text), response.stopReason),
	);
}

function mapResponseToObservations(
	files: readonly ConventionalFileDiff[],
	entries: Array<{ path: string; observations: string[] }>,
	stopReason: string,
): ConventionalFileObservation[] {
	if (entries.length === 0) return files.map(fallbackFileObservation);
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const used = new Array<boolean>(entries.length).fill(false);
	const stoppedAtMaxTokens = stopReason === "max_tokens" || stopReason === "length";
	return files.map(file => {
		const entryIndex = findObservationEntry(file.filename, entries, used, files);
		if (entryIndex === null) return fallbackFileObservation(file);
		used[entryIndex] = true;
		const entry = entries[entryIndex];
		const observations = entry?.observations.filter(value => value.trim()) ?? [];
		return {
			file: file.filename,
			observations:
				observations.length === 0 && stoppedAtMaxTokens ? [fallbackObservationText(file.filename)] : observations,
			additions: file.additions,
			deletions: file.deletions,
			status: file.status,
		};
	});
}

function findObservationEntry(
	filename: string,
	entries: readonly { path: string }[],
	used: readonly boolean[],
	files: readonly ConventionalFileDiff[],
): number | null {
	const basename = path.basename(filename) || filename;
	const basenameUnique =
		files.filter(file => (path.basename(file.filename) || file.filename) === basename).length === 1;
	for (let pass = 0; pass < 3; pass += 1) {
		for (let index = 0; index < entries.length; index += 1) {
			if (used[index]) continue;
			const candidate = entries[index]?.path ?? "";
			if (pass === 0 && candidate === filename) return index;
			if (pass === 1 && basenameUnique && (path.basename(candidate) || candidate) === basename) return index;
			if (pass === 2 && pathSuffixMatches(candidate, filename)) return index;
		}
	}
	return null;
}

function effectiveMapBudget(totalTokens: number, cap: number): number {
	const ideal = Math.ceil((Math.max(0, totalTokens) * 5) / (MAP_PHASE_CONCURRENCY * 4));
	return Math.min(Math.max(1, cap), Math.max(MIN_MAP_BATCH_TOKENS, ideal));
}

function buildBatchesForIndices(
	files: readonly ConventionalFileDiff[],
	indices: readonly number[],
	budget: number,
): number[][] {
	const tokenBudget = Math.max(1, Math.trunc(budget));
	const byteBudget = tokenBudget * 4;
	const batches: number[][] = [];
	let current: number[] = [];
	let currentTokens = 0;
	let currentBytes = 0;
	for (const index of indices) {
		const file = files[index];
		if (!file) continue;
		const tokens = file.tokenEstimate();
		const bytes = file.size + (file.content ? 1 : 0);
		if (tokens > tokenBudget || bytes > byteBudget) {
			if (current.length > 0) batches.push(current);
			batches.push([index]);
			current = [];
			currentTokens = 0;
			currentBytes = 0;
			continue;
		}
		if (current.length > 0 && (currentTokens + tokens > tokenBudget || currentBytes + bytes > byteBudget)) {
			batches.push(current);
			current = [];
			currentTokens = 0;
			currentBytes = 0;
		}
		current.push(index);
		currentTokens += tokens;
		currentBytes += bytes;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

function includedFiles(
	files: readonly ConventionalFileDiff[],
	config: ConventionalGenerationConfig,
): ConventionalFileDiff[] {
	return files.filter(file => !config.excludedFiles.some(pattern => file.filename.endsWith(pattern)));
}

function renderFileDiffForBatch(file: ConventionalFileDiff, budget: number): string {
	const maxBytes = Math.max(1, budget * 4);
	const renderedBytes = file.size + (file.content ? 1 : 0);
	if (file.tokenEstimate() <= budget && renderedBytes <= maxBytes) return reconstructFileDiff(file);
	const clone = new ConventionalFileDiff(
		file.filename,
		file.header,
		file.content,
		file.additions,
		file.deletions,
		file.isBinary,
		file.status,
	);
	clone.truncate(Math.max(1, maxBytes - 1));
	return reconstructFileDiff(clone);
}

function reconstructFileDiff(file: ConventionalFileDiff): string {
	return file.content ? `${file.header}\n${file.content}` : file.header;
}

function fallbackFileObservation(file: ConventionalFileDiff): ConventionalFileObservation {
	return {
		file: file.filename,
		observations: [fallbackObservationText(file.filename)],
		additions: file.additions,
		deletions: file.deletions,
		status: file.status,
	};
}

function fallbackObservationText(filename: string): string {
	return `Updated ${path.basename(filename) || filename}.`;
}

function pathSuffixMatches(left: string, right: string): boolean {
	return pathHasSuffix(left, right) || pathHasSuffix(right, left);
}

function pathHasSuffix(value: string, suffix: string): boolean {
	return value === suffix || value.endsWith(`/${suffix}`) || value.endsWith(`\\${suffix}`);
}

class ContextHeaders {
	readonly #largeCommitHeader: string | null;
	readonly #files: Array<[string, number, string]>;

	constructor(files: readonly ConventionalFileDiff[]) {
		this.#largeCommitHeader = files.length > 100 ? `(Large commit with ${files.length} total files)` : null;
		this.#files = this.#largeCommitHeader
			? []
			: files.map(file => [
					file.filename,
					file.additions + file.deletions,
					inferFileDescription(file.filename, file.content),
				]);
	}

	headerForFiles(currentFiles: readonly string[]): string {
		if (this.#largeCommitHeader) return this.#largeCommitHeader;
		const current = new Set(currentFiles);
		const others = this.#files.filter(item => !current.has(item[0]));
		if (others.length === 0) return "";
		const shown = [...others].sort((left, right) => right[1] - left[1]).slice(0, MAX_CONTEXT_FILES);
		const lines = [
			"OTHER FILES IN THIS CHANGE:",
			...shown.map(([file, size, description]) => `- ${file} (${size} lines): ${description}`),
		];
		if (shown.length < others.length) lines.push(`... and ${others.length - shown.length} more files`);
		return lines.join("\n");
	}
}

function inferFileDescription(filename: string, content: string): string {
	const lower = filename.toLowerCase();
	const suffix = path.extname(filename).toLowerCase();
	if (lower.includes("test")) return "test file";
	if (lower.includes("prompt") || lower.includes("system")) return "prompt template";
	if (suffix === ".md") return "documentation";
	if (lower.includes("config") || [".toml", ".yaml", ".yml"].includes(suffix)) return "configuration";
	if (lower.includes("error")) return "error definitions";
	if (lower.includes("type")) return "type definitions";
	if (lower.endsWith("mod.rs") || lower.endsWith("lib.rs")) return "module exports";
	if (lower.endsWith("main.rs") || lower.endsWith("main.go") || lower.endsWith("main.py")) return "entry point";
	if (content.includes("class ") || content.includes("def ") || content.includes("fn ")) return "implementation";
	if (content.includes("struct ") || content.includes("enum ")) return "type definitions";
	if (content.includes("async ") || content.includes("await")) return "async code";
	return "source code";
}

async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= items.length) return;
			const item = items[index];
			if (item !== undefined) results[index] = await worker(item, index);
		}
	});
	await Promise.all(runners);
	return results;
}
