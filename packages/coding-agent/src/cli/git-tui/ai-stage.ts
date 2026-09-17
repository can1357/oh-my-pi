/**
 * AI-assisted selective staging for the git TUI ("what should we stage?").
 *
 * Runs two judgment passes over the unstaged tree. The file pass asks one
 * yes/no question per changed file over the whole (batched) file list, so
 * files are picked as a coherent set; the hunk pass then judges every hunk of
 * the picked files with independent parallel yes/no questions. Matching hunks
 * are staged via `git apply --cached`; picked untracked and binary files are
 * staged whole.
 */
import type { NoulQuestion } from "@oh-my-pi/pi-ai";
import type { VcsHunkSelection } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { parseFileDiffs, parseFileHunks } from "../../commit/git/diff";
import type { FileDiff } from "../../commit/types";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { resolveJudge } from "../../judgment";
import fileQuestionTemplate from "../../prompts/system/git-ai-stage-file.md" with { type: "text" };
import { discoverAuthStorage, loadCliExtensionProviders } from "../../sdk";
import { ONLINE_MEMORY_MODEL_KEY } from "../../tiny/models";
import type { ChangedFile } from "@oh-my-pi/pi-tui/apps/git/state";
import type { AiStageOutcome } from "@oh-my-pi/pi-tui/apps/git/git-tui";

/** Files per file-pass judgment; larger trees fan out one call per batch. */
const FILE_BATCH = 80;
/** Head-truncation bound for hunk text in the hunk pass. */
const HUNK_CHARS = 2400;
/** Yes-probability at or above which a file or hunk is staged. */
const STAGE_THRESHOLD = 0.5;

const HUNK_QUESTION: NoulQuestion = {
	type: "noul",
	instructions:
		"The state holds the user's staging instruction and the added (+) and removed (−) lines of one git hunk in `path`. Is this change what the user asked to stage?",
};

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
 * Filter the unstaged tree against `instruction` with the resolved judge and
 * stage the matching hunks. Called by the git TUI's unstaged-header wand pill.
 * @throws when no judge resolves, git fails, or every judgement in a pass errors.
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
		const judge = resolveJudge({
			settings,
			registry,
			backend: ONLINE_MEMORY_MODEL_KEY,
			sessionId: Bun.randomUUIDv7(),
		});

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

		// File pass: one judgment sees the whole (batched) list with a question
		// per file, so files are picked as a coherent set instead of N
		// independent coin flips.
		onProgress?.(`Choosing files… (${candidates.length} changed)`);
		const batches: Candidate[][] = [];
		for (let start = 0; start < candidates.length; start += FILE_BATCH) {
			batches.push(candidates.slice(start, start + FILE_BATCH));
		}
		const picked = (
			await Promise.all(
				batches.map(async batch => {
					const questions: Record<string, NoulQuestion> = {};
					const files = batch.map((candidate, index) => {
						questions[`file${index}`] = {
							type: "noul",
							instructions: prompt.render(fileQuestionTemplate, { index, path: candidate.file.path }),
						};
						return { path: candidate.file.path, change: describeCandidate(candidate) };
					});
					const { answers } = await judge.judge({ state: { instruction, files }, questions }, { signal });
					return batch.filter((_, index) => answers[`file${index}`].noul >= STAGE_THRESHOLD);
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
			const { answers } = await judge.judge(
				{
					state: { instruction, path: job.path, changed_lines: bound(job.changed, HUNK_CHARS) },
					questions: { matches: HUNK_QUESTION },
				},
				{ signal },
			);
			onProgress?.(`Choosing hunks… ${++hunksJudged}/${jobs.length}`);
			return answers.matches.noul >= STAGE_THRESHOLD;
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

/** File-list detail: change kind plus +/− counts when the diff is parsed. */
function describeCandidate(candidate: { file: Pick<ChangedFile, "kind">; diff?: FileDiff }): string {
	if (!candidate.diff) return candidate.file.kind;
	return `${candidate.file.kind}, +${candidate.diff.additions} −${candidate.diff.deletions}`;
}

function bound(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}\n…`;
}
