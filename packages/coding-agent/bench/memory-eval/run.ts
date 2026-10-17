// Run: bun packages/coding-agent/bench/memory-eval/run.ts <subcommand>
//   run  --dataset <name> --engine <name> --protocol <name> [--embedder js|python] [--mnemopi-recall recall|enhanced]
//        [--polyphonic] [--cases N] [--out file]
//        --embedder applies to mnemopi only: `python` swaps its slow JS fastembed for the same model in Python fastembed.
//        --mnemopi-recall applies to mnemopi only: `enhanced` recalls through `recallEnhanced` with facts, as omp does.
//        --polyphonic turns on polyphonic recall (mnemopi needs `--mnemopi-recall enhanced`, mnemosyne).
//   diff <a.json> <b.json>
//   calibration-check <a.json> <b.json>   (a: py/upstream_run_a.py dump, b: run --protocol upstream-compat result)
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { type CalibrationDump, compareCalibration, runUpstreamCompat } from "./compat";
import { loadBeamUpstreamCompat, loadDataset } from "./datasets";
import type { EngineAdapter, MnemopiRecall, ProtocolName } from "./engine";
import { assertMnemopiEnvClean, type MnemopiEmbedder, mnemopiEngine } from "./engines/mnemopi";
import { mnemosyneEngine, type UpstreamCompatOps } from "./engines/mnemosyne";
import { oracleEngine, randomEngine } from "./engines/sanity";
import { buildResultFile, primaryMetric, type ResultFile, type RunConfig, type RunOutput, runCases } from "./runner";
import { type BootstrapResult, pairedBootstrap, verdict } from "./stats";
import type { DatasetName, ExcludedQuestion } from "./types";

const CACHE_ROOT = path.join(os.homedir(), ".cache", "omp-memory-eval");
const DATASETS: DatasetName[] = ["beam-100k", "beam-500k", "lme-s", "lme-s-dev"];
const PROTOCOLS: ProtocolName[] = ["standard", "fts-only", "with-sleep", "upstream-compat"];
const REVISIONS = {
	beam: "3205395e897e7318c7b094ef4e6047b9b82dbb03",
	lme: "98d7416c24c778c2fee6e6f3006e7a073259d48f",
};
const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");
const UPSTREAM_COMPAT_CONVERSATIONS = 3;

/** The revision `py/prepare_datasets.py` recorded next to the cached file; anything but the pinned one is refused. */
async function cachedRevision(dataset: DatasetName, dataDir: string): Promise<string> {
	const beam = dataset.startsWith("beam");
	const marker = path.join(dataDir, `${beam ? dataset : "lme-s"}.json.revision`);
	const pinned = beam ? REVISIONS.beam : REVISIONS.lme;
	const file = Bun.file(marker);
	const revision = (await file.exists()) ? (await file.text()).trim() : undefined;
	if (revision !== pinned) {
		throw new Error(
			`${marker}: ${revision === undefined ? "missing" : `revision ${revision}`}, expected ${pinned}; re-run py/prepare_datasets.py`,
		);
	}
	return revision;
}

interface EngineOptions {
	embedder: MnemopiEmbedder;
	mnemopiRecall: MnemopiRecall;
	polyphonic: boolean;
}

function createEngine(name: string, { embedder, mnemopiRecall, polyphonic }: EngineOptions): EngineAdapter {
	if (embedder !== "js" && name !== "mnemopi") throw new Error("--embedder applies to the mnemopi engine only");
	if (mnemopiRecall !== "recall" && name !== "mnemopi") {
		throw new Error("--mnemopi-recall applies to the mnemopi engine only");
	}
	if (polyphonic && name !== "mnemopi" && name !== "mnemosyne") {
		throw new Error("--polyphonic applies to the mnemopi and mnemosyne engines only");
	}
	if (name === "mnemopi") {
		// Only `recallEnhanced` routes through polyphonic recall; the flag would label an unchanged ranking.
		if (polyphonic && mnemopiRecall !== "enhanced") {
			throw new Error("--polyphonic with --engine mnemopi needs --mnemopi-recall enhanced");
		}
		assertMnemopiEnvClean();
		return mnemopiEngine({ embedder, recall: mnemopiRecall, polyphonic });
	}
	if (name === "mnemosyne") return mnemosyneEngine({ polyphonic });
	if (name === "oracle") return oracleEngine();
	if (name === "random") return randomEngine();
	throw new Error(`engine "${name}" is not available in this build (known: mnemopi, mnemosyne, oracle, random)`);
}

function pick<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T {
	const found = allowed.find(a => a === value);
	if (!found) throw new Error(`--${flag} must be one of ${allowed.join(", ")}`);
	return found;
}

function caseLimit(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const limit = Number(value);
	if (!Number.isInteger(limit) || limit <= 0) throw new Error(`--cases must be a positive integer, got "${value}"`);
	return limit;
}

const hasCompatOps = (engine: EngineAdapter): engine is EngineAdapter & UpstreamCompatOps => "recallRaw" in engine;

/**
 * Runs `fn` with the checkout's HEAD and dirty state read before it starts, and refuses its result if HEAD moved
 * meanwhile: the code that produced it is then unknown.
 */
export async function pinnedCheckout<T>(
	repoRoot: string,
	fn: (state: { commit: string; dirty: boolean }) => Promise<T>,
): Promise<T> {
	const git = vcs.requireGit(repoRoot);
	const commit = (await git.headSha()) ?? "unknown";
	const result = await fn({ commit, dirty: await git.isDirty() });
	const after = (await git.headSha()) ?? "unknown";
	if (after !== commit) throw new Error(`HEAD moved from ${commit} to ${after} during the run; result not written`);
	return result;
}

async function runCommand(argv: string[]): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			dataset: { type: "string" },
			engine: { type: "string" },
			protocol: { type: "string" },
			cases: { type: "string" },
			out: { type: "string" },
			embedder: { type: "string", default: "js" },
			"mnemopi-recall": { type: "string", default: "recall" },
			polyphonic: { type: "boolean", default: false },
		},
	});
	const dataset = pick(values.dataset, DATASETS, "dataset");
	const protocol = pick(values.protocol, PROTOCOLS, "protocol");
	const cases = caseLimit(values.cases);
	const engineOptions: EngineOptions = {
		embedder: pick(values.embedder, ["js", "python"] as const, "embedder"),
		mnemopiRecall: pick(values["mnemopi-recall"], ["recall", "enhanced"] as const, "mnemopi-recall"),
		polyphonic: values.polyphonic,
	};
	const engine = createEngine(values.engine ?? "", engineOptions);
	const k = dataset.startsWith("beam") ? 10 : 50;

	const startedAt = new Date().toISOString();
	const dataDir = path.join(CACHE_ROOT, "data");
	const result = await pinnedCheckout(REPO_ROOT, async git => {
		const storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-eval-"));
		try {
			let run: RunOutput;
			let excluded: ExcludedQuestion[] = [];
			const datasetRevision = await cachedRevision(dataset, dataDir);
			if (protocol === "upstream-compat") {
				if (dataset !== "beam-100k" || !hasCompatOps(engine)) {
					throw new Error("upstream-compat runs only with --engine mnemosyne --dataset beam-100k");
				}
				const count = cases ?? UPSTREAM_COMPAT_CONVERSATIONS;
				const questions = await runUpstreamCompat(engine, await loadBeamUpstreamCompat(dataDir, count));
				// No warmup runs here.
				run = { questions, warmupMs: 0 };
			} else {
				const loaded = await loadDataset(dataset, dataDir);
				excluded = loaded.excluded;
				const selected = cases === undefined ? loaded.cases : loaded.cases.slice(0, cases);
				run = await runCases(engine, selected, protocol, k, storeRoot);
			}
			return buildResultFile(
				{
					dataset,
					datasetRevision,
					engine: engine.name,
					engineInfo: await engine.describe(),
					protocol,
					k,
					mnemopiRecall: engineOptions.mnemopiRecall,
					polyphonic: engineOptions.polyphonic,
					gitCommit: git.commit,
					gitDirty: git.dirty,
					startedAt,
				},
				run,
				excluded,
			);
		} finally {
			await engine.dispose();
			// A just-closed SQLite file can block deletion for a while (Windows); a leftover scratch store must
			// never cost a finished run its result file.
			await removeWithRetries(storeRoot).catch(err => console.warn(`could not remove ${storeRoot}: ${err}`));
		}
	});

	const out =
		values.out ??
		path.join(CACHE_ROOT, "results", `${dataset}.${engine.name}.${protocol}.${startedAt.replace(/[:.]/g, "-")}.json`);
	await Bun.write(out, JSON.stringify(result));
	console.log(`aggregate: ${JSON.stringify(result.aggregate, null, 2)}`);
	console.log(`perCategory: ${JSON.stringify(result.perCategory, null, 2)}`);
	console.log(`fallbackRate: ${result.fallbackRate}`);
	console.log(`droppedRows: ${result.droppedRows}`);
	console.log(`droppedGoldRows: ${result.droppedGoldRows}`);
	console.log(`wrote ${out}`);
}

const fmt = (b: BootstrapResult): string => {
	const ci = Number.isNaN(b.ciLow) ? "n/a (fewer than 2 cases)" : `[${b.ciLow.toFixed(4)}, ${b.ciHigh.toFixed(4)}]`;
	return `meanDiff ${b.meanDiff.toFixed(4)} CI ${ci} wins ${b.wins} ties ${b.ties} losses ${b.losses}`;
};

const describeConfig = (label: string, c: RunConfig): string => {
	const embedder = c.engineInfo.embedder ? ` embedder ${c.engineInfo.embedder}` : "";
	return `${label}: engine ${c.engine}${embedder} protocol ${c.protocol} k ${c.k} mnemopiRecall ${c.mnemopiRecall} polyphonic ${c.polyphonic} gitCommit ${c.gitCommit}`;
};

function uniqueQuestionIds(label: string, file: ResultFile): Set<string> {
	const ids = new Set<string>();
	for (const q of file.questions) {
		if (ids.has(q.questionId)) throw new Error(`${label}: duplicate question id ${q.questionId}`);
		ids.add(q.questionId);
	}
	return ids;
}

function assertFiniteMetric(label: string, file: ResultFile, metric: string): void {
	const bad = file.questions.find(q => !Number.isFinite(q.metrics[metric]));
	if (bad)
		throw new Error(`${label}: question ${bad.questionId} has no finite ${metric} (got ${bad.metrics[metric]})`);
}

async function diffCommand(argv: string[]): Promise<void> {
	const [fileA, fileB] = argv;
	if (!fileA || !fileB) throw new Error("usage: diff <a.json> <b.json>");
	const a: ResultFile = await Bun.file(fileA).json();
	const b: ResultFile = await Bun.file(fileB).json();
	console.log(describeConfig("a", a.config));
	console.log(describeConfig("b", b.config));
	if (a.config.protocol === "upstream-compat" || b.config.protocol === "upstream-compat") {
		throw new Error("upstream-compat results have no primary metric to diff");
	}
	if (a.config.dataset !== b.config.dataset) {
		throw new Error(`dataset differs: ${a.config.dataset} vs ${b.config.dataset}`);
	}
	if (a.config.datasetRevision !== b.config.datasetRevision) {
		throw new Error(`datasetRevision differs: ${a.config.datasetRevision} vs ${b.config.datasetRevision}`);
	}
	if (a.config.protocol !== b.config.protocol) {
		throw new Error(`protocol differs: ${a.config.protocol} vs ${b.config.protocol}`);
	}
	if (a.config.k !== b.config.k) throw new Error(`k differs: ${a.config.k} vs ${b.config.k}`);
	// Engine options are what an ablation compares; the config lines above name both sides.
	if (a.config.engine !== b.config.engine && a.config.protocol === "with-sleep") {
		console.warn(
			"warning: with-sleep credits a summary hit with every message it covers, so recall@k depends on how many messages each engine's summaries cover; it is not comparable across engines",
		);
	}
	const idsA = uniqueQuestionIds("a", a);
	const idsB = uniqueQuestionIds("b", b);
	if (idsA.size !== idsB.size || [...idsA].some(id => !idsB.has(id))) {
		throw new Error("question sets differ between the two result files");
	}
	const metric = primaryMetric(a.config.dataset);
	assertFiniteMetric("a", a, metric);
	assertFiniteMetric("b", b, metric);
	const bById = new Map(b.questions.map(q => [q.questionId, q]));
	const pairs = a.questions.map(qa => ({ a: qa, b: bById.get(qa.questionId)! }));
	// The bootstrap clusters by a's case and splits by a's category: both files must agree on them.
	for (const { a: qa, b: qb } of pairs) {
		if (qa.caseId !== qb.caseId) {
			throw new Error(`question ${qa.questionId} is in case ${qa.caseId} in a but ${qb.caseId} in b`);
		}
		if (qa.category !== qb.category) {
			throw new Error(`question ${qa.questionId} has category ${qa.category} in a but ${qb.category} in b`);
		}
	}

	const identical = pairs.filter(
		p => JSON.stringify(p.a.ranked.map(r => r.messageIds)) === JSON.stringify(p.b.ranked.map(r => r.messageIds)),
	).length;
	console.log(`identical rankings: ${identical} / ${pairs.length}`);

	// Questions of one case were asked against one memory store, so the bootstrap resamples cases, not questions.
	const overall = pairedBootstrap(
		pairs.map(p => p.a.metrics[metric]),
		pairs.map(p => p.b.metrics[metric]),
		pairs.map(p => p.a.caseId),
	);
	const sizes = (rows: typeof pairs): string => `n=${rows.length}, cases=${new Set(rows.map(p => p.a.caseId)).size}`;
	console.log(`${metric} overall (b - a, ${sizes(pairs)}): ${fmt(overall)}`);
	const perCategory: Record<string, BootstrapResult> = {};
	for (const category of new Set(pairs.map(p => p.a.category))) {
		const rows = pairs.filter(p => p.a.category === category);
		perCategory[category] = pairedBootstrap(
			rows.map(p => p.a.metrics[metric]),
			rows.map(p => p.b.metrics[metric]),
			rows.map(p => p.a.caseId),
		);
		console.log(`  ${category} (${sizes(rows)}): ${fmt(perCategory[category])}`);
	}
	console.log(`verdict: ${verdict(overall, perCategory)}`);
}

async function calibrationCheckCommand(argv: string[]): Promise<void> {
	const [fileA, fileB] = argv;
	if (!fileA || !fileB) throw new Error("usage: calibration-check <a.json> <b.json>");
	const a: CalibrationDump = await Bun.file(fileA).json();
	const b: ResultFile = await Bun.file(fileB).json();
	const mismatches = compareCalibration(a, b);
	for (const mismatch of mismatches) console.log(mismatch);
	if (mismatches.length > 0) throw new Error(`calibration failed: ${mismatches.length} mismatches`);
	console.log(`calibration ok: ${a.questions.length} questions identical, meanRecall ${a.meanRecall}`);
}

if (import.meta.main) {
	const [subcommand, ...rest] = Bun.argv.slice(2);
	try {
		if (subcommand === "run") await runCommand(rest);
		else if (subcommand === "diff") await diffCommand(rest);
		else if (subcommand === "calibration-check") await calibrationCheckCommand(rest);
		else throw new Error("usage: run.ts <run|diff|calibration-check> ...");
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
