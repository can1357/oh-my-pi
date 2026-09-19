#!/usr/bin/env bun
// run.mjs — score a judgment-model verifier against labeled IX Bridge snapshots.
//
// Decides whether a judgment gate belongs behind the browser lane by
// measuring, on real captured state:
//   accuracy  — does the predicted probability >= threshold match the human label?
//   baseline  — how often was the browser subagent's own claim (agentClaim) right?
//   latency   — mean judge call time vs. a reasoning-model verification turn
//   cost      — usage-cost where the judge reports it
//   brier     — calibration of the raw probability (lower is better)
//
// Judges:
//   openrouter (default) — chat-completions via OPENROUTER_API_KEY (.env is
//     auto-loaded by Bun). Jev is NOT on OpenRouter; this is the preferred path.
//   typesafe — POST /v1/systemone via TYPESAFE_API_KEY, for direct comparison
//     if a TypeSafe key ever exists.
//
// Usage:
//   bun evals/typesafe-jev/run.mjs --selftest                 # verify scoring, no API needed
//   bun evals/typesafe-jev/run.mjs --dry-run                  # validate corpus coverage, no API
//   bun evals/typesafe-jev/run.mjs \
//     [--judge openrouter|typesafe] [--model google/gemini-3.5-flash-lite] \
//     [--corpus path] [--thresholds 0.5,0.7,0.9]
//
// Wire the gate only if some threshold beats the baseline on accuracy without
// adding more latency than the verification turn it replaces.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { judgeState, parseJudgeJson } from "../../packages/coding-agent/src/lib/openrouter-judge.ts";

const DEFAULT_CORPUS = join(dirname(fileURLToPath(import.meta.url)), "corpus.jsonl");
const COST_PER_INPUT_TOKEN = 42 / 1e9;

function parseArgs(argv) {
	const out = { corpus: DEFAULT_CORPUS, thresholds: [0.5, 0.7, 0.9], model: undefined, judge: "openrouter" };
	for (let i = 0; i < argv.length; i++) {
		const [flag, inline] = argv[i].split("=", 2);
		const value = inline ?? argv[++i];
		switch (flag) {
			case "--selftest": out.selftest = true; break;
			case "--dry-run": out.dryRun = true; break;
			case "--corpus": out.corpus = value; break;
			case "--model": out.model = value; break;
			case "--thresholds": out.thresholds = value.split(",").map(Number); break;
			case "--judge": out.judge = value; break;
			default: throw new Error(`unknown flag: ${flag}`);
		}
	}
	return out;
}

function loadCorpus(path) {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line, i) => {
			try {
				return JSON.parse(line);
			} catch {
				throw new Error(`corpus line ${i + 1} is not valid JSON`);
			}
		});
}


async function judge(row, opts) {
	if (opts.judge === "typesafe") {
		const { systemOne } = await import("../../packages/coding-agent/src/lib/typesafe-http.ts");
		const res = await systemOne(row.state, row.questions, { model: opts.model });
		return { answers: res.answers, inputTokens: res.usage.input_tokens, costUsd: res.usage.input_tokens * COST_PER_INPUT_TOKEN };
	}
	return judgeState({ goal: row.goal, state: row.state, questions: row.questions, model: opts.model });
}

/** Score judged rows: per-question accuracy at each threshold, brier, baseline, latency. */
function scoreRows(rows, thresholds) {
	const qids = [...new Set(rows.flatMap((r) => Object.keys(r.labels ?? {})))];
	const report = {};
	for (const qid of qids) {
		const scored = rows.filter(
			(r) => typeof r.labels?.[qid] === "boolean" && typeof r.answers?.[qid]?.noul === "number",
		);
		const n = scored.length;
		const accuracy = {};
		for (const t of thresholds) {
			accuracy[t] = n
				? scored.filter((r) => r.answers[qid].noul >= t === r.labels[qid]).length / n
				: null;
		}
		const withClaim = scored.filter((r) => typeof r.agentClaim === "boolean");
		report[qid] = {
			n,
			accuracy,
			brier: n
				? scored.reduce((s, r) => s + (r.answers[qid].noul - (r.labels[qid] ? 1 : 0)) ** 2, 0) / n
				: null,
			baselineAccuracy: withClaim.length
				? withClaim.filter((r) => r.agentClaim === r.labels[qid]).length / withClaim.length
				: null,
			meanLatencyMs: n ? scored.reduce((s, r) => s + r.latencyMs, 0) / n : null,
			inputTokens: scored.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
			costUsd: scored.reduce((s, r) => s + (r.costUsd ?? 0), 0),
		};
	}
	return report;
}

function printReport(report, thresholds, judgeName = "judge") {
	for (const [qid, r] of Object.entries(report)) {
		console.log(`\nquestion: ${qid}  (n=${r.n})`);
		if (r.n === 0) {
			console.log("  no labeled rows with answers — nothing to score");
			continue;
		}
		for (const t of thresholds) {
			const acc = r.accuracy[t];
			console.log(`  accuracy @ ${t}: ${acc === null ? "n/a" : acc.toFixed(3)}`);
		}
		console.log(`  brier:            ${r.brier === null ? "n/a" : r.brier.toFixed(3)}`);
		console.log(
			`  baseline (agentClaim): ${r.baselineAccuracy === null ? "n/a" : r.baselineAccuracy.toFixed(3)}`,
		);
		console.log(`  mean latency:     ${r.meanLatencyMs?.toFixed(0)}ms`);
		const cost = r.costUsd > 0 ? `~$${r.costUsd.toFixed(6)}` : "n/a";
		console.log(`  input tokens:     ${r.inputTokens} (${cost})`);
		const best = thresholds
			.filter((t) => r.accuracy[t] !== null)
			.sort((a, b) => r.accuracy[b] - r.accuracy[a])[0];
		if (best !== undefined && r.baselineAccuracy !== null) {
			const delta = r.accuracy[best] - r.baselineAccuracy;
			console.log(
				`  verdict: ${judgeName}@${best} ${r.accuracy[best].toFixed(3)} vs baseline ${r.baselineAccuracy.toFixed(3)} → ${delta >= 0 ? "+" : ""}${delta.toFixed(3)}`,
			);
		}
	}
}

// --selftest: deterministic fake judge over synthetic rows; asserts the scoring
// math so a broken metric can't silently bless or condemn the gate.
function selftest(thresholds) {
	const rows = [
		{ labels: { q: true }, agentClaim: true, answers: { q: { noul: 0.9 } }, latencyMs: 100, inputTokens: 10 },
		{ labels: { q: true }, agentClaim: false, answers: { q: { noul: 0.8 } }, latencyMs: 100, inputTokens: 10 },
		{ labels: { q: false }, agentClaim: false, answers: { q: { noul: 0.1 } }, latencyMs: 100, inputTokens: 10 },
		{ labels: { q: false }, agentClaim: true, answers: { q: { noul: 0.6 } }, latencyMs: 100, inputTokens: 10 },
	];
	const report = scoreRows(rows, thresholds);
	const q = report.q;
	const checks = [
		["n", q.n === 4],
		["accuracy@0.5", q.accuracy[0.5] === 0.75],
		["accuracy@0.7", q.accuracy[0.7] === 1.0],
		["accuracy@0.9", q.accuracy[0.9] === 0.75],
		["brier", Math.abs(q.brier - (0.01 + 0.04 + 0.01 + 0.36) / 4) < 1e-9],
		["baseline", q.baselineAccuracy === 0.5],
		["latency", q.meanLatencyMs === 100],
		["tokens", q.inputTokens === 40],
		["parseJudgeJson", parseJudgeJson('{"q":0.9}').q.noul === 0.9],
		["parseJudgeJson-prose", parseJudgeJson('answer: {"q": 0.4} done').q.noul === 0.4],
		["parseJudgeJson-throws", (() => { try { parseJudgeJson("no json"); return false; } catch { return true; } })()],
	];
	const failed = checks.filter(([, ok]) => !ok);
	for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
	if (failed.length) process.exit(1);
	console.log("selftest: scoring logic verified");
}

const opts = parseArgs(process.argv.slice(2));
if (opts.selftest) {
	selftest(opts.thresholds);
	process.exit(0);
}

const rows = loadCorpus(opts.corpus);
const labeled = rows.filter((r) => Object.keys(r.labels ?? {}).length > 0);
console.log(`corpus: ${rows.length} rows, ${labeled.length} labeled`);
if (opts.dryRun) {
	for (const r of rows) {
		const missing = Object.keys(r.questions ?? {}).filter((q) => typeof r.labels?.[q] !== "boolean");
		console.log(
			`  ${r.id}: ${Object.keys(r.questions ?? {}).length} questions, ` +
			(missing.length ? `missing labels: ${missing.join(", ")}` : "fully labeled"),
		);
	}
	process.exit(0);
}
if (labeled.length === 0) {
	console.error("no labeled rows — capture with capture.mjs and fill labels first");
	process.exit(2);
}

for (const row of labeled) {
	const start = performance.now();
	try {
		const res = await judge(row, opts);
		row.answers = res.answers;
		row.inputTokens = res.inputTokens;
		row.costUsd = res.costUsd;
	} catch (error) {
		row.error = error instanceof Error ? error.message : String(error);
	}
	row.latencyMs = performance.now() - start;
	if (row.error) console.log(`  ${row.id}: ERROR ${row.error}`);
}

printReport(scoreRows(labeled, opts.thresholds), opts.thresholds, opts.judge);
