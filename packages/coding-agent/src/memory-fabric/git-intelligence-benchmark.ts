/**
 * Held-out co-change benchmark — honest, deterministic, self-labeling.
 *
 * Measures how well `analyzeCoChange` predicts which files change together,
 * using the repository's own history as ground truth: hold out the most
 * recent commits, train only on strictly earlier commits, query one file
 * from each held-out commit, and check the predictions against the files
 * that actually changed with it. No leakage: the evaluated commit is never
 * in its own training set, and the decay clock is the held-out commit's own
 * timestamp.
 *
 * Discipline, identical to every additive module in this fabric:
 *   - PURE: a function of (commits, options); no git access, no wall clock,
 *     no I/O, no randomness. Callers obtain commits via `readHistory` (or a
 *     fixture) and own all I/O.
 *   - Observe-only: the output is a report (`mode: "observe"`) carrying no
 *     authority.
 *   - Fail-open: unusable commits are skipped and counted; the function
 *     never throws and degrades to an empty summary.
 *
 * Honest math, stated plainly:
 *   - precision = true positives / predictions made (per sample);
 *   - recall    = true positives / files that actually co-changed (per sample);
 *   - the summary reports the MEAN of per-sample precision/recall and the
 *     exact skip count. Nothing is extrapolated, no median or percentile is
 *     claimed, and samples with nothing to predict or nothing to recall are
 *     skipped rather than padded with zeros.
 */

import type { CoChangePolicy, GitCommitRecord } from "./git-intelligence";
import { analyzeCoChange, buildPathIdentities, DEFAULT_GIT_INTELLIGENCE_CONFIG } from "./git-intelligence";

export interface BenchmarkOptions {
	/** How many of the most recent commits to evaluate. Default: 20. */
	holdOut?: number;
	/** Predictions per query (top-K partners). Default: 5. */
	topK?: number;
	/** Minimum training commits required before a sample counts. Default: 5. */
	minTraining?: number;
	/** Co-change policy overrides (defaults to the module default, minShared 1). */
	policy?: Partial<CoChangePolicy>;
}

/** One evaluated held-out commit. */
export interface HeldOutSample {
	sha: string;
	queryPath: string;
	/** Identity ids predicted by the trained index (top-K). */
	predicted: string[];
	/** Identity ids of files that actually co-changed in the commit. */
	actual: string[];
	truePositives: number;
	precision: number;
	recall: number;
}

export interface BenchmarkSummary {
	mode: "observe";
	sampleCount: number;
	/** Held-out commits that could not be evaluated (and why they are not zeros). */
	skipped: number;
	topK: number;
	/** Mean per-sample precision (0 when there are no samples). */
	meanPrecision: number;
	/** Mean per-sample recall (0 when there are no samples). */
	meanRecall: number;
	samples: HeldOutSample[];
}

const EMPTY_SUMMARY: BenchmarkSummary = {
	mode: "observe",
	sampleCount: 0,
	skipped: 0,
	topK: 0,
	meanPrecision: 0,
	meanRecall: 0,
	samples: [],
};

function commitEpoch(commit: GitCommitRecord): number {
	const ms = Date.parse(commit.committedAt);
	return Number.isFinite(ms) ? ms : 0;
}

function positiveInt(value: number | undefined, fallback: number): number {
	return typeof value === "number" && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Run the held-out benchmark over a commit history. Pure and fail-open; the
 * input array is never mutated. Returns an empty summary when there is
 * nothing to evaluate.
 */
export function runHeldOutBenchmark(
	commits: readonly GitCommitRecord[],
	options: BenchmarkOptions = {},
): BenchmarkSummary {
	try {
		const topK = positiveInt(options.topK, 5);
		const holdOut = positiveInt(options.holdOut, 20);
		const minTraining = positiveInt(options.minTraining, 5);
		const policy: CoChangePolicy = {
			...DEFAULT_GIT_INTELLIGENCE_CONFIG.coChange,
			minShared: 1,
			topK,
			...options.policy,
		};

		// Annotated: `Array.isArray` narrows the readonly parameter to `any[]`,
		// which would strip contextual typing from every callback downstream.
		const source: readonly GitCommitRecord[] = Array.isArray(commits)
			? commits.filter(c => c && typeof c === "object")
			: [];
		const sorted = [...source].sort((a, b) => commitEpoch(a) - commitEpoch(b));

		const samples: HeldOutSample[] = [];
		let skipped = 0;
		const firstIndex = Math.max(0, sorted.length - holdOut);

		for (let i = firstIndex; i < sorted.length; i++) {
			const heldOut = sorted[i];
			if (!heldOut) continue;

			const eligible = heldOut.files.filter(f => !f.binary);
			if (heldOut.isMerge || eligible.length < 2 || i < minTraining) {
				skipped += 1;
				continue;
			}

			// Train ONLY on strictly earlier commits; clock = held-out commit time.
			const training = sorted.slice(0, i);
			const index = buildPathIdentities(training);
			const coChange = analyzeCoChange(training, index, policy, commitEpoch(heldOut));

			// Query the first held-out file the training history knows about.
			const query = eligible.find(f => index.resolve(f.path) !== undefined);
			const queryIdentity = query ? index.resolve(query.path) : undefined;
			if (!query || !queryIdentity) {
				skipped += 1;
				continue;
			}

			// Ground truth: the OTHER files of the commit, as training identities.
			const actual = new Set<string>();
			for (const file of eligible) {
				if (file.path === query.path) continue;
				const identity = index.resolve(file.path);
				if (identity && identity.id !== queryIdentity.id) actual.add(identity.id);
			}

			const predicted = (coChange.partners.get(queryIdentity.id) ?? []).slice(0, topK).map(p => p.id);
			if (predicted.length === 0 || actual.size === 0) {
				skipped += 1;
				continue;
			}

			let truePositives = 0;
			for (const id of predicted) {
				if (actual.has(id)) truePositives += 1;
			}

			samples.push({
				sha: heldOut.sha,
				queryPath: query.path,
				predicted,
				actual: [...actual].sort(),
				truePositives,
				precision: truePositives / predicted.length,
				recall: truePositives / actual.size,
			});
		}

		let precisionSum = 0;
		let recallSum = 0;
		for (const sample of samples) {
			precisionSum += sample.precision;
			recallSum += sample.recall;
		}

		return {
			mode: "observe",
			sampleCount: samples.length,
			skipped,
			topK,
			meanPrecision: samples.length === 0 ? 0 : precisionSum / samples.length,
			meanRecall: samples.length === 0 ? 0 : recallSum / samples.length,
			samples,
		};
	} catch {
		return EMPTY_SUMMARY;
	}
}

/** Render a summary as plain text. Pure; never throws. */
export function formatBenchmarkSummary(summary: BenchmarkSummary): string {
	try {
		const p = (summary.meanPrecision * 100).toFixed(1);
		const r = (summary.meanRecall * 100).toFixed(1);
		return (
			`co-change held-out benchmark (observe): ${summary.sampleCount} samples, ` +
			`${summary.skipped} skipped, top-${summary.topK}, ` +
			`mean precision ${p}%, mean recall ${r}%`
		);
	} catch {
		return "co-change held-out benchmark (observe): unavailable";
	}
}
