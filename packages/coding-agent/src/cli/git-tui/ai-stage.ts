/**
 * AI-assisted selective staging for the git TUI ("what should we stage?").
 *
 * Every unit of unstaged change — each hunk of a tracked text file, each
 * untracked file, each binary file — is one independent judgment for the
 * `judge` role (TypeSafe jev when credentialed), scored against the full list
 * of changed paths for contrast and fanned out as a single concurrency-capped
 * wave. Accepted hunks are staged via `git apply --cached`; accepted untracked
 * and binary files are staged whole.
 */
import * as path from "node:path";
import type { ChoiceQuestion, ScoreQuestion } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { VcsHunkSelection } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { parseFileDiffs, parseFileHunks } from "../../commit/git/diff";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { resolveJudge } from "../../judgment";
import { discoverAuthStorage, loadCliExtensionProviders } from "../../sdk";
import { mapWithConcurrencyLimitAllSettled } from "../../task/parallel";
import type { ChangedFile } from "@oh-my-pi/pi-tui/apps/git/state";
import type { AiStageOutcome } from "@oh-my-pi/pi-tui/apps/git/git-tui";

/** Judgments in flight at once; System One requests are stateless, so the tree is classified as one wave. */
const CONCURRENCY = 64;
/** Head-truncation bound for a unit's change text. */
const UNIT_CHARS = 2400;
/**
 * Probability of the top level ("part of it") at or above which a unit is
 * staged. Genuine matches score ≥ 0.7 (measured on a mixed tree and small
 * fixtures); same-area noise settles around 0.5–0.65 when the instruction
 * names nothing in the tree, so 0.6 trims it without costing recall.
 */
const STAGE_THRESHOLD = 0.6;

/**
 * Each unit is judged with the whole changed-path list as contrast. Without
 * it, an isolated yes/no lets anything sharing vocabulary with the instruction
 * drift to 0.55–0.8 (measured on a 278-hunk tree: 105 accepted for a
 * 23-hunk feature); with the tree and an explicit "tangential" level, the same
 * tree yields zero false positives and 16 of the feature's hunks.
 */
const UNIT_QUESTION: ScoreQuestion = {
	type: "score",
	instructions:
		"The user is staging a git commit out of a working tree with many unrelated changes and described which changes they want. `all_changed_files` lists every changed path for contrast; the state then shows one unit of change: its `path`, its `kind` (`hunk`: the added + and removed − lines of one hunk of a modified file; `deleted file`: the head of the removed − lines of a file being deleted; `new file`: the head of an untracked file; `binary`: path only), and `change`. How much does this unit belong to what the user described?",
	criteria: [
		"Unrelated: different work that happens to be in the same tree.",
		"Tangential: same file, area, or vocabulary, but the user's words do not actually describe this particular change.",
		"Part of it: the user's words describe this particular change (its content, its kind of edit, or this file by name).",
	],
};
/** Index of the "part of it" level in {@link UNIT_QUESTION}. */
const PART_OF_IT = "2";

/** Highest-scoring accepted units shown together in the verification pick. */
const VERIFY_CANDIDATES = 8;
/** Per-candidate change text bound in the verification pick. */
const VERIFY_CHARS = 600;
/**
 * Probability of `none` at or above which the run stages nothing. When the
 * instruction names work that is not in the tree, per-unit scores of the
 * nearest same-area changes still drift to 0.6–0.85; only a question with an
 * explicit "none of these" alternative separates that (0.55–0.7) from a real
 * match (0.03–0.37, measured across feature, kind-of-edit, and by-name asks).
 */
const NONE_THRESHOLD = 0.5;
/** Choice key for "the instruction describes none of the candidates". */
const NONE = "none";
const VERIFY_INSTRUCTIONS =
	"The user is staging a git commit and described which changes they want. `candidates` are the changed units in the tree that scored highest for that description, each with its path, kind, and changed lines. Which candidate is most clearly the change the user described — or is none of them actually it?";
const VERIFY_NONE_CRITERION =
	"None of the candidates is the change the user described; they only share an area or vocabulary with it.";

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

/** One independently judged piece of the working tree. */
interface Unit {
	path: string;
	/** 1-based hunk index for `stageHunks`; absent for units staged whole. */
	hunk?: number;
	/** Whole-file units: `git add` for untracked paths, `apply --cached` for tracked binaries. */
	untracked: boolean;
	kind: "hunk" | "deleted file" | "new file" | "binary";
	/** Head-bounded +/− lines or untracked-file head; absent for binaries. */
	change?: string;
}

/**
 * Filter the unstaged tree against `instruction` with the resolved judge and
 * stage the matching units. Called by the git TUI's unstaged-header wand pill.
 * @throws when no judge resolves, git fails, the run is aborted, or every judgment errors.
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
			sessionId: Bun.randomUUIDv7(),
		});

		onProgress?.("Reading changes…");
		const rawDiff = tracked.length > 0 ? await repo.diffText({ files: tracked.map(file => file.path) }, signal) : "";
		const deleted = new Set(tracked.flatMap(file => (file.kind === "deleted" ? [file.path] : [])));
		const units: Unit[] = [];
		const filePaths = new Set<string>();
		for (const diff of parseFileDiffs(rawDiff)) {
			filePaths.add(diff.filename);
			if (diff.isBinary) {
				units.push({ path: diff.filename, untracked: false, kind: "binary" });
				continue;
			}
			for (const hunk of parseFileHunks(diff).hunks) {
				// Prompted fallbacks misread unchanged context as part of the
				// change, so only the +/− lines go to the model.
				const changed = hunk.content
					.split("\n")
					.filter(line => line.startsWith("+") || line.startsWith("-"))
					.join("\n");
				if (changed.length === 0) continue;
				// HunkSelection indices are 1-based; parsed hunk.index is 0-based.
				units.push({
					path: diff.filename,
					hunk: hunk.index + 1,
					untracked: false,
					kind: deleted.has(diff.filename) ? "deleted file" : "hunk",
					change: bound(changed, UNIT_CHARS),
				});
			}
		}
		for (const file of untracked) {
			filePaths.add(file.path);
			const head = await readHead(path.join(cwd, file.path), signal);
			units.push(
				head === null
					? { path: file.path, untracked: true, kind: "binary" }
					: { path: file.path, untracked: true, kind: "new file", change: head },
			);
		}
		const totalHunks = units.reduce((count, unit) => count + (unit.hunk === undefined ? 0 : 1), 0);
		const allChangedFiles = [...filePaths];

		let settled = 0;
		onProgress?.(`Judging 0/${units.length} changes…`);
		const { results, aborted } = await mapWithConcurrencyLimitAllSettled(
			units,
			CONCURRENCY,
			async (unit, _index, workerSignal) => {
				const { answers } = await judge.judge(
					{
						state: {
							instruction,
							all_changed_files: allChangedFiles,
							path: unit.path,
							kind: unit.kind,
							...(unit.change === undefined ? {} : { change: unit.change }),
						},
						questions: { belongs: UNIT_QUESTION },
					},
					{ signal: workerSignal },
				);
				onProgress?.(`Judging ${++settled}/${units.length} changes…`);
				return answers.belongs.probabilities[PART_OF_IT];
			},
			signal,
		);
		if (aborted) throw signal?.reason instanceof Error ? signal.reason : new AIError.AbortError("staging aborted");
		const scores = verdicts(results);
		const accepted = scores.map(score => score >= STAGE_THRESHOLD);

		// Per-unit scores rank well but have no null hypothesis: when the
		// instruction describes nothing in the tree, the nearest same-area
		// changes still clear the threshold. One pick over the strongest
		// candidates with an explicit `none` option supplies it.
		const ranked = units
			.map((unit, index) => ({ unit, score: scores[index] }))
			.filter(entry => entry.score >= STAGE_THRESHOLD)
			.sort((a, b) => b.score - a.score)
			.slice(0, VERIFY_CANDIDATES);
		if (ranked.length > 0) {
			onProgress?.("Verifying…");
			const criteria: Record<string, string | null> = { [NONE]: VERIFY_NONE_CRITERION };
			const candidates = ranked.map(({ unit }, index) => {
				criteria[`c${index}`] = null;
				return {
					key: `c${index}`,
					path: unit.path,
					kind: unit.kind,
					...(unit.change === undefined ? {} : { change: bound(unit.change, VERIFY_CHARS) }),
				};
			});
			const question: ChoiceQuestion = { type: "choice", instructions: VERIFY_INSTRUCTIONS, criteria };
			const { answers } = await judge.judge(
				{ state: { instruction, candidates }, questions: { pick: question } },
				{ signal },
			);
			if (answers.pick.probabilities[NONE] >= NONE_THRESHOLD) {
				logger.debug("git ai-stage: verification rejected every candidate", {
					instruction,
					none: answers.pick.probabilities[NONE],
					candidates: candidates.map(candidate => candidate.path),
				});
				accepted.fill(false);
			}
		}

		const indicesByPath = new Map<string, number[]>();
		const binaryAccepted: string[] = [];
		const untrackedAccepted: string[] = [];
		const matchedPaths = new Set<string>();
		let stagedHunks = 0;
		units.forEach((unit, index) => {
			if (!accepted[index]) return;
			matchedPaths.add(unit.path);
			if (unit.hunk === undefined) {
				(unit.untracked ? untrackedAccepted : binaryAccepted).push(unit.path);
				return;
			}
			stagedHunks++;
			const indices = indicesByPath.get(unit.path);
			if (indices) indices.push(unit.hunk);
			else indicesByPath.set(unit.path, [unit.hunk]);
		});

		const selections: VcsHunkSelection[] = [
			...binaryAccepted.map(filePath => ({
				path: filePath,
				kind: "all" as const,
			})),
			...[...indicesByPath].map(([filePath, indices]) => ({
				path: filePath,
				kind: "indices" as const,
				indices,
			})),
		];
		if (selections.length > 0 || untrackedAccepted.length > 0) onProgress?.("Staging…");
		if (selections.length > 0) await repo.stageHunks(selections, rawDiff || null, signal);
		if (untrackedAccepted.length > 0) await repo.stageFiles(untrackedAccepted, signal);

		return {
			matchedFiles: matchedPaths.size,
			totalFiles: filePaths.size,
			stagedHunks,
			totalHunks,
			wholeFiles: binaryAccepted.length + untrackedAccepted.length,
		};
	} finally {
		authStorage.close();
	}
}

/**
 * Collapse settled judgments to per-unit scores. A failed judgment scores its
 * unit 0 so one flaky request cannot sink the run — unless every unit failed,
 * which means the backend is broken and the first error surfaces.
 */
function verdicts(results: readonly (PromiseSettledResult<number> | undefined)[]): number[] {
	let failures = 0;
	let firstError: unknown;
	const out = results.map(result => {
		if (result?.status === "fulfilled") return result.value;
		failures++;
		firstError ??= result?.reason;
		if (result) {
			logger.debug("git ai-stage: judgment failed", {
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
		}
		return 0;
	});
	if (results.length > 0 && failures === results.length) {
		throw firstError instanceof Error ? firstError : new Error(String(firstError));
	}
	return out;
}

/** Head of an untracked file as text; `null` when the file is binary or unreadable. */
async function readHead(filePath: string, signal: AbortSignal | undefined): Promise<string | null> {
	signal?.throwIfAborted();
	try {
		const file = Bun.file(filePath);
		const text = await file.slice(0, UNIT_CHARS).text();
		if (text.includes("\0")) return null;
		return file.size > UNIT_CHARS ? `${text}\n…` : text;
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

/** Head-truncate `text` to `limit` characters with an ellipsis marker. */
function bound(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}\n…`;
}
