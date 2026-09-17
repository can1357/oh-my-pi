#!/usr/bin/env bun
/**
 * Live skill-suggestion battery — TypeSafe cookbook Step 5 shape.
 *
 * Usage:
 *   source ~/.omp/.env
 *   bun evals/jev-showcase/skill-suggestion/orchestrate.ts
 *   JEV_ROSTER_PATH=data/hermes_roster.json JEV_TASKS_PATH=data/requests.json bun evals/.../orchestrate.ts
 *   JEV_LIMIT=50 JEV_CONCURRENCY=4 bun evals/.../orchestrate.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { TypeSafeJudge } from "@oh-my-pi/pi-ai";
import { appendJsonl, loadCompletedKeys } from "../../../src/jev-showcase/jsonl";
import { gradeSkillSuggestion, type SkillSuggestionTask } from "../../../src/jev-showcase/grade-skill-suggestion";
import { suggestSkill, type SkillDetail, type SuggestableSkill } from "../../../src/skills/suggest";
import defaultTasks from "./tasks.json";
import defaultRoster from "./roster.json";
import type { HermesRosterEntry } from "./build-hermes-roster";

const ROOT = import.meta.dir;
const resultsPath = process.env.JEV_SHOWCASE_RESULTS ?? path.join(ROOT, "results", "results.jsonl");
const EXCERPT_CHARS = 700;

interface CookbookRequest {
	id?: string;
	text: string;
	gold?: string | null;
}

function loadJson<T>(filePath: string): T {
	return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function taskId(task: CookbookRequest, index: number): string {
	if (task.id?.trim()) return task.id.trim();
	const slug = task.text.slice(0, 48).replace(/\W+/g, "-").replace(/^-|-$/g, "");
	return slug ? `${index}:${slug}` : String(index);
}

function loadTasks(): SkillSuggestionTask[] {
	const tasksPath = process.env.JEV_TASKS_PATH?.trim();
	const raw = tasksPath ? loadJson<CookbookRequest[]>(tasksPath) : (defaultTasks as CookbookRequest[]);
	return raw.map((task, index) => ({
		id: taskId(task, index),
		text: task.text,
		gold: task.gold ?? null,
	}));
}

function loadRoster(): { roster: SuggestableSkill[]; details: Map<string, SkillDetail> } {
	const rosterPath = process.env.JEV_ROSTER_PATH?.trim();
	const raw = rosterPath
		? loadJson<HermesRosterEntry[]>(rosterPath)
		: (defaultRoster as Array<{ name: string; description: string }>);
	const details = new Map<string, SkillDetail>();
	const roster: SuggestableSkill[] = [];
	for (const entry of raw) {
		const full = "description_full" in entry ? entry.description_full : entry.description;
		const indexDesc = "description" in entry && entry.description.length <= 64 ? entry.description : full.slice(0, 60);
		roster.push({ name: entry.name, description: indexDesc });
		if ("body" in entry && entry.body) {
			details.set(entry.name, {
				description: full,
				body: entry.body.slice(0, EXCERPT_CHARS),
			});
		}
	}
	return { roster, details };
}

async function mapPool<T, R>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	async function worker(): Promise<void> {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await fn(items[i]!, i);
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
	return out;
}

async function main(): Promise<void> {
	const apiKey = process.env.TYPESAFE_API_KEY?.trim();
	if (!apiKey) {
		console.error("TYPESAFE_API_KEY required (source ~/.omp/.env or export)");
		process.exit(1);
	}
	const judge = new TypeSafeJudge({ apiKey });
	const done = loadCompletedKeys(resultsPath, r => `${r.task}:${r.arm}`);
	const arms = (process.env.JEV_ARMS ?? "typesafe").split(",").map(s => s.trim()).filter(Boolean);
	const offset = Number.parseInt(process.env.JEV_OFFSET ?? "0", 10) || 0;
	const limit = Number.parseInt(process.env.JEV_LIMIT ?? "0", 10) || 0;
	const concurrency = Math.max(1, Number.parseInt(process.env.JEV_CONCURRENCY ?? "1", 10) || 1);

	const allTasks = loadTasks();
	const tasks = limit > 0 ? allTasks.slice(offset, offset + limit) : allTasks.slice(offset);
	const { roster, details } = loadRoster();
	const loadDetail =
		details.size > 0
			? async (name: string): Promise<SkillDetail | null> => details.get(name) ?? null
			: undefined;

	console.log(
		`skill-suggestion battery: ${tasks.length}/${allTasks.length} tasks, ${roster.length} skills, concurrency=${concurrency}`,
	);

	const cells: Array<{ task: SkillSuggestionTask; arm: string }> = [];
	for (const task of tasks) {
		for (const arm of arms) {
			const key = `${task.id}:${arm}`;
			if (!done.has(key)) cells.push({ task, arm });
		}
	}

	await mapPool(cells, concurrency, async ({ task, arm }) => {
		const started = performance.now();
		let row: Record<string, unknown>;
		try {
			let suggested: string | null = null;
			if (arm === "oracle") {
				suggested = task.gold ?? null;
			} else if (arm === "typesafe") {
				const result = await suggestSkill({
					prompt: task.text,
					skills: roster,
					judge,
					rerank: "auto",
					loadDetail,
				});
				suggested = result?.name ?? null;
			} else {
				throw new Error(`unknown arm: ${arm}`);
			}
			const grade = gradeSkillSuggestion(task, suggested);
			row = {
				task: task.id,
				arm,
				suggested,
				grade,
				gold: task.gold ?? null,
				latencyMs: Math.round(performance.now() - started),
				ok: grade === "correct",
			};
		} catch (error) {
			row = {
				task: task.id,
				arm,
				error: error instanceof Error ? error.message : String(error),
				latencyMs: Math.round(performance.now() - started),
				ok: false,
			};
		}
		appendJsonl(resultsPath, row);
		console.log(`RESULT_JSON:${JSON.stringify(row)}`);
	});
}

await main();
