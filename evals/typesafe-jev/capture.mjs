#!/usr/bin/env bun
// capture.mjs — append one corpus row to corpus.jsonl from the live IX Bridge daemon.
//
// Corpus rows are the ground truth for the Jev-verifier eval (see run.mjs).
// A row pairs a real browser `state` (usually a snapshot) with the judgment
// questions a verifier would answer and — once a human fills `labels` — the
// correct answers. `agentClaim` records what the browser subagent reported so
// the runner can score Jev against the existing baseline.
//
// Usage:
//   bun evals/typesafe-jev/capture.mjs \
//     --goal "Complete the checkout" \
//     --question goal_met="Did the checkout complete successfully?" \
//     [--command snapshot] [--args '{"format":"aria"}'] \
//     [--label goal_met=true] [--agent-claim true] [--id my-row] \
//     [--lane agent-a] [--base http://127.0.0.1:18086]
//
// Repeat --question/--label for multiple questions per row. Omit --label to
// capture unlabeled rows for a human to fill in later (run.mjs skips them).
// corpus.jsonl is gitignored: snapshots contain real page content.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CORPUS_PATH = join(dirname(fileURLToPath(import.meta.url)), "corpus.jsonl");

function parseArgs(argv) {
	const out = { questions: {}, labels: {}, args: {} };
	for (let i = 0; i < argv.length; i++) {
		const [flag, inline] = argv[i].split("=", 2);
		const value = inline ?? argv[++i];
		switch (flag) {
			case "--goal": out.goal = value; break;
			case "--id": out.id = value; break;
			case "--command": out.command = value; break;
			case "--args": out.args = JSON.parse(value); break;
			case "--lane": out.lane = value; break;
			case "--base": out.base = value; break;
			case "--agent-claim": out.agentClaim = value === "true"; break;
			case "--question": {
				const [qid, instructions] = value.split("=", 2);
				out.questions[qid] = { type: "noul", instructions };
				break;
			}
			case "--label": {
				const [qid, v] = value.split("=", 2);
				out.labels[qid] = v === "true";
				break;
			}
			default:
				throw new Error(`unknown flag: ${flag}`);
		}
	}
	return out;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.goal || Object.keys(opts.questions).length === 0) {
	console.error("required: --goal and at least one --question qid=\"instructions\"");
	process.exit(2);
}

const base = (opts.base ?? "http://127.0.0.1:18086").replace(/\/+$/, "");
const command = opts.command ?? "snapshot";
const lane = opts.lane ?? "agent-a";

const res = await fetch(`${base}/ix-bridge/command`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ lane, action: command, args: opts.args }),
	signal: AbortSignal.timeout(30_000),
});
if (!res.ok) {
	console.error(`daemon returned ${res.status}: ${await res.text()}`);
	process.exit(1);
}
const raw = await res.text();
let state;
try {
	state = JSON.stringify(JSON.parse(raw));
} catch {
	state = raw;
}

const row = {
	id: opts.id ?? `${command}-${Date.now()}`,
	capturedAt: new Date().toISOString(),
	lane,
	command,
	goal: opts.goal,
	agentClaim: opts.agentClaim,
	state,
	questions: opts.questions,
	labels: opts.labels,
};

mkdirSync(dirname(CORPUS_PATH), { recursive: true });
appendFileSync(CORPUS_PATH, JSON.stringify(row) + "\n");
console.log(`captured ${row.id} (${state.length} chars state, ${Object.keys(row.labels).length} labels)`);
if (Object.keys(row.labels).length === 0) {
	console.log("unlabeled — edit corpus.jsonl and set labels.<qid> to true/false before running the eval");
}
