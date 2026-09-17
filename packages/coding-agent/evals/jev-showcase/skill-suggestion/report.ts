#!/usr/bin/env bun
/** Aggregate skill-suggestion results.jsonl into cookbook-style scorecard. */
import * as fs from "node:fs";
import * as path from "node:path";
import { readJsonl } from "../../../src/jev-showcase/jsonl";
import { summarizeSkillSuggestion, type SkillSuggestionTask } from "../../../src/jev-showcase/grade-skill-suggestion";
import defaultTasks from "./tasks.json";

const ROOT = import.meta.dir;
const resultsPath = process.argv[2] ?? path.join(ROOT, "results", "results.jsonl");
const rows = readJsonl([resultsPath]);

function loadTasks(): SkillSuggestionTask[] {
	const tasksPath = process.env.JEV_TASKS_PATH?.trim();
	if (!tasksPath) return defaultTasks as SkillSuggestionTask[];
	const raw = JSON.parse(fs.readFileSync(tasksPath, "utf8")) as Array<{
		id?: string;
		text: string;
		gold?: string | null;
	}>;
	return raw.map((task, index) => ({
		id: task.id?.trim() || `${index}:${task.text.slice(0, 32)}`,
		text: task.text,
		gold: task.gold ?? null,
	}));
}

const battery = loadTasks();
const byArm = new Map<string, Map<string, string | null>>();
for (const row of rows) {
	const arm = String(row.arm ?? "?");
	const task = String(row.task ?? "");
	if (!byArm.has(arm)) byArm.set(arm, new Map());
	byArm.get(arm)!.set(task, (row.suggested as string | null | undefined) ?? null);
}

console.log(`skill-suggestion scorecard (${battery.length} tasks in battery file)`);
console.log(`${"arm".padEnd(12)} wrong_load  needless_load  ok/total  mean_ms  fixed  broke`);
console.log("-".repeat(72));

for (const [arm, results] of [...byArm.entries()].sort()) {
	const armRows = rows.filter(r => r.arm === arm);
	const oks = armRows.filter(r => r.ok).length;
	const latencies = armRows.map(r => Number(r.latencyMs ?? 0)).filter(n => n > 0);
	const meanMs = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
	const score = summarizeSkillSuggestion(battery, results);
	console.log(
		`${arm.padEnd(12)} ${(score.wrongLoad * 100).toFixed(1).padStart(9)}% ${(score.needlessLoad * 100).toFixed(1).padStart(12)}% ${String(oks + "/" + armRows.length).padStart(8)} ${meanMs.toFixed(0).padStart(7)} ${String(score.fixed).padStart(5)} ${String(score.broke).padStart(5)}`,
	);
}

const cookbookRef = { wrong: 0.073, needless: 0.04 };
const ts = byArm.get("typesafe");
if (ts) {
	const score = summarizeSkillSuggestion(battery, ts);
	console.log(`\ncookbook reference (488×182): wrong 7.3%  needless 4.0%`);
	console.log(
		`this run delta: wrong ${((score.wrongLoad - cookbookRef.wrong) * 100).toFixed(1)}pp  needless ${((score.needlessLoad - cookbookRef.needless) * 100).toFixed(1)}pp`,
	);
}
