/**
 * AI-assisted selective staging for the git TUI ("what should we stage?").
 *
 * Runs two tiny-model passes over the unstaged tree. The file pass shows the
 * model the whole changed-file list in one completion (batched for huge trees)
 * so files are picked as a coherent set; the hunk pass then judges every hunk
 * of the picked files with independent parallel yes/no completions. Matching
 * hunks are staged via `git apply --cached`; picked untracked and binary files
 * are staged whole.
 */
import {
	type Api,
	type ApiKey,
	type AssistantMessage,
	completeSimple,
	type Model,
	retryTransientCompletion,
} from "@oh-my-pi/pi-ai";
import type { VcsHunkSelection } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { parseFileDiffs, parseFileHunks } from "../../commit/git/diff";
import type { FileDiff } from "../../commit/types";
import { ModelRegistry } from "../../config/model-registry";
import { resolveRoleSelection } from "../../config/model-resolver";
import { Settings } from "../../config/settings";
import filesPromptTemplate from "../../prompts/system/git-ai-stage-files.md" with { type: "text" };
import hunkPromptTemplate from "../../prompts/system/git-ai-stage-hunk.md" with { type: "text" };
import { discoverAuthStorage, loadCliExtensionProviders } from "../../sdk";
import type { ChangedFile } from "./state";

/** Files per file-pass completion; larger trees fan out one call per batch. */
const FILE_BATCH = 80;
/** Head-truncation bound for hunk text in the hunk pass. */
const HUNK_CHARS = 2400;
/**
 * Mirrors the auto-thinking classifier budget: leaves room for thinking
 * preambles on backends that ignore `disableReasoning`, and stays above
 * Anthropic-dialect `thinking.budget_tokens` minimums (issues #4355, #8610).
 */
const SAFE_MAX_TOKENS = 4096;

/** Counts reported back to the status line after an AI staging run. */
export interface AiStageOutcome {
	/** Files accepted by the file pass. */
	matchedFiles: number;
	/** Files evaluated in the file pass. */
	totalFiles: number;
	/** Hunks staged by the hunk pass. */
	stagedHunks: number;
	/** Hunks evaluated in matched files. */
	totalHunks: number;
	/** Untracked/binary files staged whole. */
	wholeFiles: number;
}

/** Options for {@link aiStage}. */
export interface AiStageOptions {
	cwd: string;
	/** The user's natural-language description of what to stage. */
	instruction: string;
	/** Unstaged sidebar entries; conflicted files are skipped. */
	files: readonly Pick<ChangedFile, "path" | "kind">[];
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

/**
 * Filter the unstaged tree against `instruction` with the tiny/smol model and
 * stage the matching hunks. Called by the git TUI's unstaged-header wand pill.
 * @throws when no model/key resolves, git fails, or every judgement in a pass errors.
 */
export async function aiStage(options: AiStageOptions): Promise<AiStageOutcome> {
	const { cwd, instruction, signal, onProgress } = options;
	const repo = vcs.requireGit(cwd);
	const untracked = options.files.filter(file => file.kind === "untracked");
	const tracked = options.files.filter(file => file.kind !== "untracked" && file.kind !== "conflicted");
	if (tracked.length === 0 && untracked.length === 0) throw new Error("No unstaged changes to filter");

	onProgress?.("Resolving model…");
	const settings = await Settings.init({ cwd });
	const authStorage = await discoverAuthStorage();
	try {
		const registry = new ModelRegistry(authStorage);
		await registry.refresh();
		await loadCliExtensionProviders(registry, settings, cwd);
		const model = resolveRoleSelection(["tiny", "smol"], settings, registry.getAvailable())?.model;
		if (!model) throw new Error("No tiny/smol model available for AI staging");
		if (!(await registry.getApiKey(model))) throw new Error(`No API key for ${model.provider}/${model.id}`);
		const complete = createCompleter(model, registry.resolver(model), signal);

		const rawDiff = tracked.length > 0 ? await repo.diffText({ files: tracked.map(file => file.path) }, signal) : "";
		const fileDiffs = new Map(parseFileDiffs(rawDiff).map(entry => [entry.filename, entry]));

		interface Candidate {
			file: Pick<ChangedFile, "path" | "kind">;
			/** Parsed worktree diff; absent for untracked files. */
			diff?: FileDiff;
		}
		const candidates: Candidate[] = tracked.flatMap(file => {
			const diff = fileDiffs.get(file.path);
			return diff ? [{ file, diff }] : [];
		});
		candidates.push(...untracked.map(file => ({ file })));

		// File pass: one completion sees the whole (batched) list, so files are
		// picked as a coherent set instead of N independent coin flips.
		onProgress?.(`Choosing files… (${candidates.length} changed)`);
		const batches: Candidate[][] = [];
		for (let start = 0; start < candidates.length; start += FILE_BATCH) {
			batches.push(candidates.slice(start, start + FILE_BATCH));
		}
		const picked = (
			await Promise.all(
				batches.map(async batch => {
					const fileList = batch
						.map(candidate => `- ${candidate.file.path} (${describeCandidate(candidate)})`)
						.join("\n");
					const reply = await complete(prompt.render(filesPromptTemplate, { instruction, fileList }));
					const picks = parseFileSelection(
						reply,
						batch.map(candidate => candidate.file.path),
					);
					return picks.map(pick => batch[pick - 1]);
				}),
			)
		).flat();
		onProgress?.(`Picked ${picked.length}/${candidates.length} files`);
		// Zero picks usually means the request is about change content ("comment
		// edits"), which paths alone cannot answer — advance everything and let
		// the hunk pass decide. A non-authoritative file scope must never stage
		// whole files: no untracked/binary whole-stages, no whole-file fallback.
		const fileScopeAuthoritative = picked.length > 0;
		const matched = fileScopeAuthoritative ? picked : candidates;

		// Hunk pass: every hunk of every matched text file is judged independently.
		const binaryWhole: string[] = [];
		const jobs: { path: string; index: number; changed: string }[] = [];
		for (const candidate of matched) {
			if (!candidate.diff) continue;
			if (candidate.diff.isBinary) {
				if (fileScopeAuthoritative) binaryWhole.push(candidate.file.path);
				continue;
			}
			for (const hunk of parseFileHunks(candidate.diff).hunks) {
				// Small judges misread unchanged context as part of the change, so
				// only the +/− lines go to the model.
				const changed = hunk.content
					.split("\n")
					.filter(line => line.startsWith("+") || line.startsWith("-"))
					.join("\n");
				if (changed.length === 0) continue;
				// HunkSelection indices are 1-based; parsed hunk.index is 0-based.
				jobs.push({ path: candidate.file.path, index: hunk.index + 1, changed });
			}
		}
		let hunksJudged = 0;
		const hunkVerdicts = await judgeAll(jobs, async job => {
			const reply = await complete(
				prompt.render(hunkPromptTemplate, {
					instruction,
					path: job.path,
					changed: bound(job.changed, HUNK_CHARS),
				}),
			);
			onProgress?.(`Choosing hunks… ${++hunksJudged}/${jobs.length}`);
			return parseVerdict(reply);
		});

		const stagedHunks = hunkVerdicts.filter(Boolean).length;
		// The hunk judge asks whether the changed lines themselves are what the
		// user described. Topical instructions ("git stuff", "the login feature")
		// are answered by the file pick, not by line content, so the judge
		// rejects every hunk unanimously — take that as "the instruction does not
		// discriminate within files" and stage the picked files whole. Kind
		// instructions ("comment changes") accept at least one hunk somewhere,
		// which keeps the per-hunk selection authoritative.
		const wholeFileScope = fileScopeAuthoritative && jobs.length > 0 && stagedHunks === 0;
		const indicesByPath = new Map<string, number[]>();
		jobs.forEach((job, index) => {
			if (!hunkVerdicts[index]) return;
			const indices = indicesByPath.get(job.path);
			if (indices) indices.push(job.index);
			else indicesByPath.set(job.path, [job.index]);
		});
		const trackedWhole = wholeFileScope
			? matched.filter(candidate => candidate.diff && !candidate.diff.isBinary).map(candidate => candidate.file.path)
			: [];

		const selections: VcsHunkSelection[] = [
			...binaryWhole.map(filePath => ({ path: filePath, kind: "all" as const })),
			...trackedWhole.map(filePath => ({ path: filePath, kind: "all" as const })),
			...[...indicesByPath].map(([filePath, indices]) => ({
				path: filePath,
				kind: "indices" as const,
				indices,
			})),
		];
		const untrackedAccepted = fileScopeAuthoritative
			? matched.filter(candidate => !candidate.diff).map(candidate => candidate.file.path)
			: [];
		if (selections.length > 0 || untrackedAccepted.length > 0) onProgress?.("Staging…");
		if (selections.length > 0) await repo.stageHunks(selections, rawDiff || null, signal);
		if (untrackedAccepted.length > 0) await repo.stageFiles(untrackedAccepted, signal);

		return {
			matchedFiles: matched.length,
			totalFiles: candidates.length,
			stagedHunks,
			totalHunks: jobs.length,
			wholeFiles: untrackedAccepted.length + binaryWhole.length + trackedWhole.length,
		};
	} finally {
		authStorage.close();
	}
}

/** One text completion against the resolved model. */
function createCompleter(
	model: Model<Api>,
	apiKey: ApiKey,
	signal?: AbortSignal,
): (userPrompt: string) => Promise<string> {
	return async userPrompt => {
		const response = await retryTransientCompletion(
			() =>
				completeSimple(
					model,
					{ messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }] },
					{ apiKey, maxTokens: SAFE_MAX_TOKENS, temperature: 0, disableReasoning: true, signal },
				),
			{ signal },
		);
		if (response.stopReason === "error") {
			throw new Error(`AI staging request failed: ${response.errorMessage ?? "unknown error"}`);
		}
		return extractText(response.content);
	};
}

/**
 * Fan out one judgement per item. A failed judgement rejects just its item so
 * one flaky request cannot sink the run — unless every item failed, which
 * means the backend is broken and the first error surfaces.
 */
async function judgeAll<T>(items: readonly T[], run: (item: T) => Promise<boolean>): Promise<boolean[]> {
	let failures = 0;
	let firstError: unknown;
	const verdicts = await Promise.all(
		items.map(async item => {
			try {
				return await run(item);
			} catch (error) {
				failures++;
				firstError ??= error;
				logger.debug("git ai-stage: judgement failed", {
					error: error instanceof Error ? error.message : String(error),
				});
				return false;
			}
		}),
	);
	if (items.length > 0 && failures === items.length) {
		throw firstError instanceof Error ? firstError : new Error(String(firstError));
	}
	return verdicts;
}

/** File-list line detail: change kind plus +/− counts when the diff is parsed. */
function describeCandidate(candidate: { file: Pick<ChangedFile, "kind">; diff?: FileDiff }): string {
	if (!candidate.diff) return candidate.file.kind;
	return `${candidate.file.kind}, +${candidate.diff.additions} −${candidate.diff.deletions}`;
}

/**
 * Parse the file-pass reply into 1-based picks over `paths`.
 *
 * The model echoes matching paths verbatim (tiny models copy strings reliably
 * but miscount list indices, measured on lfm2-2.6b). A line-level echo match
 * runs first; a boundary-guarded substring match catches prose replies without
 * picking `a/b.ts` off a mention of `other/a/b.ts`. "none" or noise yields no
 * picks.
 */
export function parseFileSelection(text: string, paths: readonly string[]): number[] {
	const picked = new Set<number>();
	const lines = text.split("\n").map(line => line.replace(/^[\s\-*•]+/, "").trim());
	paths.forEach((filePath, index) => {
		if (lines.some(line => line === filePath || line.startsWith(`${filePath} `))) {
			picked.add(index + 1);
			return;
		}
		const at = text.indexOf(filePath);
		if (at < 0) return;
		const before = at > 0 ? text[at - 1] : "";
		const after = at + filePath.length < text.length ? text[at + filePath.length] : "";
		if (!/[\w./-]/.test(before) && !/[\w./-]/.test(after)) picked.add(index + 1);
	});
	return [...picked].sort((left, right) => left - right);
}

/** Earliest bare `yes` before any `no` accepts; anything else rejects. */
export function parseVerdict(text: string): boolean {
	const lower = text.toLowerCase();
	const yes = lower.search(/\byes\b/);
	if (yes < 0) return false;
	const no = lower.search(/\bno\b/);
	return no < 0 || yes < no;
}

function bound(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}\n…`;
}

function extractText(content: AssistantMessage["content"]): string {
	return content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map(block => block.text)
		.join(" ")
		.trim();
}
