// Run: bun packages/coding-agent/bench/memory-eval/run.ts <subcommand>
//   run  --dataset <name> --engine <name> --protocol <name> [--embedder js|python] [--cases N] [--out file]
//        --embedder applies to mnemopi only: `python` swaps its slow JS fastembed for the same model in Python fastembed.
//   diff <a.json> <b.json>
//   calibration-check <a.json> <b.json>   (a: py/upstream_run_a.py dump, b: run --protocol upstream-compat result)
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { type CalibrationDump, compareCalibration, runUpstreamCompat } from "./compat";
import { loadBeamUpstreamCompat, loadDataset } from "./datasets";
import type { EngineAdapter, ProtocolName } from "./engine";
import { type MnemopiEmbedder, mnemopiEngine } from "./engines/mnemopi";
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

function createEngine(name: string, embedder: MnemopiEmbedder): EngineAdapter {
	if (embedder !== "js" && name !== "mnemopi") throw new Error("--embedder applies to the mnemopi engine only");
	if (name === "mnemopi") {
		// Mnemopi runs in this process and reads these itself, so they cannot be scrubbed: refuse instead.
		// OPENROUTER_BASE_URL is the one non-MNEMOPI_ variable that can route its embeddings to an API.
		const set = Object.keys(Bun.env).filter(
			key => (key.startsWith("MNEMOPI_") || key === "OPENROUTER_BASE_URL") && Bun.env[key],
		);
		if (set.length > 0) {
			throw new Error(`refusing to run mnemopi with MNEMOPI_* or OPENROUTER_BASE_URL set: ${set.join(", ")}`);
		}
		return mnemopiEngine({ embedder });
	}
	if (name === "mnemosyne") return mnemosyneEngine();
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
		},
	});
	const dataset = pick(values.dataset, DATASETS, "dataset");
	const protocol = pick(values.protocol, PROTOCOLS, "protocol");
	const cases = caseLimit(values.cases);
	const engine = createEngine(values.engine ?? "", pick(values.embedder, ["js", "python"] as const, "embedder"));
	const k = dataset.startsWith("beam") ? 10 : 50;

	const startedAt = new Date().toISOString();
	const dataDir = path.join(CACHE_ROOT, "data");
	const storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-eval-"));
	let result: ResultFile;
	try {
		let run: RunOutput;
		let excluded: ExcludedQuestion[] = [];
		if (protocol === "upstream-compat") {
			if (dataset !== "beam-100k" || !hasCompatOps(engine)) {
				throw new Error("upstream-compat runs only with --engine mnemosyne --dataset beam-100k");
			}
			const count = cases ?? UPSTREAM_COMPAT_CONVERSATIONS;
			const questions = await runUpstreamCompat(engine, await loadBeamUpstreamCompat(dataDir, count));
			// No warmup runs here; the store is a temp dir, not measured.
			run = {
				questions,
				resources: { warmupMs: 0, ...(await engine.resources()), rssScope: engine.rssScope },
				storeBytesMean: 0,
			};
		} else {
			const loaded = await loadDataset(dataset, dataDir);
			excluded = loaded.excluded;
			const selected = cases === undefined ? loaded.cases : loaded.cases.slice(0, cases);
			run = await runCases(engine, selected, protocol, k, storeRoot);
		}
		result = buildResultFile(
			{
				dataset,
				datasetRevision: dataset.startsWith("beam") ? REVISIONS.beam : REVISIONS.lme,
				engine: engine.name,
				engineInfo: await engine.describe(),
				protocol,
				k,
				gitCommit: (await vcs.requireGit(REPO_ROOT).headSha()) ?? "unknown",
				startedAt,
			},
			run,
			excluded,
		);
	} finally {
		await engine.dispose();
		await fs.rm(storeRoot, { recursive: true, force: true });
	}

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

const fmt = (b: BootstrapResult): string =>
	`meanDiff ${b.meanDiff.toFixed(4)} CI [${b.ciLow.toFixed(4)}, ${b.ciHigh.toFixed(4)}] wins ${b.wins} ties ${b.ties} losses ${b.losses}`;

const describeConfig = (label: string, c: RunConfig): string =>
	`${label}: engine ${c.engine} protocol ${c.protocol} k ${c.k} gitCommit ${c.gitCommit}`;

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
	if (a.config.protocol !== b.config.protocol) {
		throw new Error(`protocol differs: ${a.config.protocol} vs ${b.config.protocol}`);
	}
	if (a.config.k !== b.config.k) throw new Error(`k differs: ${a.config.k} vs ${b.config.k}`);
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

	const identical = pairs.filter(
		p => JSON.stringify(p.a.ranked.map(r => r.messageIds)) === JSON.stringify(p.b.ranked.map(r => r.messageIds)),
	).length;
	console.log(`identical rankings: ${identical} / ${pairs.length}`);

	const overall = pairedBootstrap(
		pairs.map(p => p.a.metrics[metric]),
		pairs.map(p => p.b.metrics[metric]),
	);
	console.log(`${metric} overall (b - a): ${fmt(overall)}`);
	const perCategory: Record<string, BootstrapResult> = {};
	for (const category of new Set(pairs.map(p => p.a.category))) {
		const rows = pairs.filter(p => p.a.category === category);
		perCategory[category] = pairedBootstrap(
			rows.map(p => p.a.metrics[metric]),
			rows.map(p => p.b.metrics[metric]),
		);
		console.log(`  ${category} (n=${rows.length}): ${fmt(perCategory[category])}`);
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
