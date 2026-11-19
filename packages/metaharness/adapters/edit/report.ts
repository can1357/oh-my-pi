/**
 * Markdown report generator for edit benchmark results.
 */

import { formatDuration, formatPercent, truncate } from "@oh-my-pi/pi-utils";
import { type BenchmarkResult, EDIT_FAILURE_CATEGORIES, type TaskResult } from "./runner";

function formatBestStatus(task: TaskResult, runsPerTask: number): { status: string; label: string } {
	const completed = task.runs.filter(run => !isCompletedGhost(run)).length;
	const succeeded = task.runs.filter(run => run.success).length;
	if (task.success) {
		// best-of-N pass; flag flakiness when not every run succeeded.
		const flaky = completed > 0 && succeeded < completed;
		const status = flaky ? "⚠️" : "✅";
		const label = `PASS (${succeeded}/${completed || runsPerTask})`;
		return { status, label };
	}
	return { status: "❌", label: `FAIL (0/${completed || runsPerTask})` };
}

function isCompletedGhost(run: TaskResult["runs"][number]): boolean {
	if (run.success) return false;
	return run.tokens.total === 0 && run.toolCalls.read === 0 && run.toolCalls.edit === 0 && run.toolCalls.write === 0;
}

function formatNumber(n: number): string {
	return n.toLocaleString();
}

function formatRate(numerator: number, denominator: number): string {
	if (denominator === 0) return "—";
	const percent = (numerator / denominator) * 100;
	return `${percent.toFixed(1)}% (${numerator}/${denominator})`;
}

function escapeMarkdown(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function getStringField(value: unknown, field: string): string | null {
	if (!value || typeof value !== "object") return null;
	const fieldValue = (value as Record<string, unknown>)[field];
	return typeof fieldValue === "string" ? fieldValue : null;
}

function formatEditArgsBlock(args: unknown): string {
	if (!args || typeof args !== "object") return "—";
	const diff = getStringField(args, "diff");
	if (diff !== null) {
		return diff;
	}
	const input = getStringField(args, "input");
	if (input !== null) {
		return input;
	}
	try {
		return JSON.stringify(args, null, 2);
	} catch {
		return "—";
	}
}

function formatToolError(error: unknown): string {
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error, null, 2);
	} catch {
		return String(error);
	}
}

function formatFiles(files: string[]): string {
	const joined = files.join(", ");
	return truncate(joined, 60);
}

export function generateReport(result: BenchmarkResult): string {
	const { config, tasks, summary } = result;
	const runsPerTask = config.runsPerTask;
	const allRuns = tasks.flatMap(task => task.runs);
	const nonGhostRuns = allRuns.filter(
		run =>
			run.success ||
			run.tokens.total > 0 ||
			run.toolCalls.read > 0 ||
			run.toolCalls.edit > 0 ||
			run.toolCalls.write > 0,
	);
	const verifiedRuns = nonGhostRuns.filter(run => run.verificationPassed).length;
	const editToolRuns = nonGhostRuns.filter(run => run.patchApplied).length;
	const totalEditAttempts = nonGhostRuns.reduce((sum, run) => sum + run.toolCalls.edit, 0);
	const totalEditFailures = nonGhostRuns.reduce((sum, run) => sum + run.toolCalls.editFailures, 0);

	const lines: string[] = [];

	lines.push("# Edit Benchmark Report");
	lines.push("");
	lines.push("## Configuration");
	lines.push("");
	lines.push("| Setting | Value |");
	lines.push("|---------|-------|");
	lines.push(`| Date | ${result.startTime} |`);
	lines.push(`| Model | ${config.provider}/${config.model} |`);
	lines.push(`| Thinking Level | ${config.thinkingLevel ?? "default"} |`);
	lines.push(`| Runs per task | ${runsPerTask} |`);
	lines.push(`| Edit Variant | ${config.editVariant ?? "auto"} |`);
	lines.push(`| Edit Fuzzy | ${config.editFuzzy === undefined ? "auto" : config.editFuzzy} |`);
	lines.push(
		`| Edit Fuzzy Threshold | ${config.editFuzzyThreshold === undefined ? "auto" : config.editFuzzyThreshold} |`,
	);
	lines.push(`| Guided Mode | ${config.guided === false ? "no" : "yes"} |`);
	lines.push(`| Max Attempts | ${config.maxAttempts ?? 1} |`);
	lines.push(`| Max Turns | ${config.maxTurns ?? "unset"} |`);
	lines.push(`| No-op Retry Limit | ${config.noOpRetryLimit ?? 2} |`);
	lines.push(`| Mutation Scope Window | ${config.mutationScopeWindow ?? 20} |`);
	lines.push(`| Require Edit Tool | ${config.requireEditToolCall ? "yes" : "no"} |`);
	lines.push(`| Require Read Tool | ${config.requireReadToolCall ? "yes" : "no"} |`);
	lines.push(`| No-Edit Baseline | ${config.noEditRequired ? "yes" : "no"} |`);
	lines.push("");

	lines.push("## Summary");
	lines.push("");
	lines.push(
		"Primary metrics (tokens, duration, tool calls) are aggregated over the **best run** of each task. Diagnostic counts (ghost runs, timeouts, retries, failure categories) span every executed run.",
	);
	lines.push("");
	lines.push("| Metric | Value |");
	lines.push("|--------|-------|");
	lines.push(`| Total Tasks | ${summary.totalTasks} |`);
	lines.push(`| Total Runs | ${summary.totalRuns} |`);
	lines.push(`| Successful Runs | ${summary.successfulRuns} |`);
	lines.push(`| **Task Success Rate** | **${formatRate(summary.successfulTasks, summary.totalTasks)}** |`);
	if (config.editVariant === "hashline") {
		lines.push(
			`| **Autocorrect-Free Success Rate** | **${formatRate(summary.autocorrectFreeSuccessfulTasks, summary.totalTasks)}** |`,
		);
		lines.push(`| Autocorrected Best Runs | ${formatRate(summary.autocorrectedBestRuns, summary.totalTasks)} |`);
		lines.push(`| Edit Autocorrect Rate | ${formatPercent(summary.editAutocorrectRate)} |`);
	}
	lines.push(`| Verified Rate | ${formatRate(verifiedRuns, summary.totalRuns)} |`);
	lines.push(`| Edit Tool Usage Rate | ${formatRate(editToolRuns, summary.totalRuns)} |`);
	lines.push(`| **Edit Success Rate** | **${formatPercent(summary.editSuccessRate)}** |`);
	lines.push(`| Timeout Runs | ${summary.timeoutRuns} |`);
	if (summary.ghostRuns > 0) {
		lines.push(`| Ghost Runs (0/0/0) | ${summary.ghostRuns} |`);
	}
	if (summary.transportFailureRuns > 0) {
		lines.push(`| Transport Failures (excluded) | ${summary.transportFailureRuns} |`);
	}
	if (summary.totalTimeoutRetries > 0 || summary.totalZeroToolRetries > 0 || summary.totalProviderFailureRetries > 0) {
		lines.push(`| Timeout Retries | ${summary.totalTimeoutRetries} |`);
		lines.push(`| Zero-Tool Retries | ${summary.totalZeroToolRetries} |`);
		lines.push(`| Provider Failure Retries | ${summary.totalProviderFailureRetries} |`);
	}
	if (typeof summary.mutationIntentMatchRate === "number") {
		lines.push(`| Mutation Intent Match Rate | ${formatPercent(summary.mutationIntentMatchRate)} |`);
	}
	if (config.editVariant === "patch" || config.editVariant === "hashline") {
		lines.push(`| Patch Failure Rate | ${formatRate(totalEditFailures, totalEditAttempts)} |`);
	}
	lines.push(`| Tasks All Passing | ${summary.consistentlyPassingTasks} |`);
	lines.push(`| Tasks Flaky/Failing | ${summary.totalTasks - summary.consistentlyPassingTasks} |`);
	lines.push("");
	lines.push("### Tool Calls");
	lines.push("");
	lines.push("| Tool | Total (best) | Avg/Task |");
	lines.push("|------|--------------|----------|");
	lines.push(`| Read | ${summary.totalToolCalls.read} | ${summary.avgToolCallsPerTask.read.toFixed(1)} |`);
	lines.push(`| Edit | ${summary.totalToolCalls.edit} | ${summary.avgToolCallsPerTask.edit.toFixed(1)} |`);
	lines.push(`| Write | ${summary.totalToolCalls.write} | ${summary.avgToolCallsPerTask.write.toFixed(1)} |`);
	lines.push(
		`| **Tool Input Chars** | ${formatNumber(summary.totalToolCalls.totalInputChars)} | ${formatNumber(Math.round(summary.avgToolCallsPerTask.totalInputChars))} |`,
	);
	lines.push("");
	lines.push("### Tokens & Time (Overall)");
	lines.push("");
	lines.push("| Metric | Total (best) | Avg/Task | Median | P1 | P99 |");
	lines.push("|--------|--------------|----------|--------|----|----|");
	lines.push(
		`| Input Tokens | ${formatNumber(summary.totalTokens.input)} | ${formatNumber(summary.avgTokensPerTask.input)} | ${formatNumber(summary.medianTokensPerTask.input)} | ${formatNumber(summary.p1TokensPerTask.input)} | ${formatNumber(summary.p99TokensPerTask.input)} |`,
	);
	lines.push(
		`| Output Tokens | ${formatNumber(summary.totalTokens.output)} | ${formatNumber(summary.avgTokensPerTask.output)} | ${formatNumber(summary.medianTokensPerTask.output)} | ${formatNumber(summary.p1TokensPerTask.output)} | ${formatNumber(summary.p99TokensPerTask.output)} |`,
	);
	lines.push(
		`| Reasoning Tokens | ${formatNumber(summary.totalTokens.reasoning)} | ${formatNumber(summary.avgTokensPerTask.reasoning)} | ${formatNumber(summary.medianTokensPerTask.reasoning)} | ${formatNumber(summary.p1TokensPerTask.reasoning)} | ${formatNumber(summary.p99TokensPerTask.reasoning)} |`,
	);
	lines.push(
		`| Total Tokens | ${formatNumber(summary.totalTokens.total)} | ${formatNumber(summary.avgTokensPerTask.total)} | ${formatNumber(summary.medianTokensPerTask.total)} | ${formatNumber(summary.p1TokensPerTask.total)} | ${formatNumber(summary.p99TokensPerTask.total)} |`,
	);
	lines.push(
		`| Duration | ${formatDuration(summary.totalDuration)} | ${formatDuration(summary.avgDurationPerTask)} | — | — | — |`,
	);
	lines.push(`| **Avg Indent Score** | — | **${formatScore(summary.avgIndentScore)}** | — | — | — |`);
	lines.push("");
	lines.push("### Tokens & Time (One-shot Successes)");
	lines.push("");
	lines.push("| Metric | Total | Avg/Task | Median | P1 | P99 |");
	lines.push("|--------|-------|----------|--------|----|----|");
	lines.push(
		`| Input Tokens | ${formatNumber(summary.totalOneShotSuccessTokens.input)} | ${formatNumber(summary.avgOneShotSuccessTokensPerTask.input)} | ${formatNumber(summary.medianOneShotSuccessTokensPerTask.input)} | ${formatNumber(summary.p1OneShotSuccessTokensPerTask.input)} | ${formatNumber(summary.p99OneShotSuccessTokensPerTask.input)} |`,
	);
	lines.push(
		`| Output Tokens | ${formatNumber(summary.totalOneShotSuccessTokens.output)} | ${formatNumber(summary.avgOneShotSuccessTokensPerTask.output)} | ${formatNumber(summary.medianOneShotSuccessTokensPerTask.output)} | ${formatNumber(summary.p1OneShotSuccessTokensPerTask.output)} | ${formatNumber(summary.p99OneShotSuccessTokensPerTask.output)} |`,
	);
	lines.push(
		`| Reasoning Tokens | ${formatNumber(summary.totalOneShotSuccessTokens.reasoning)} | ${formatNumber(summary.avgOneShotSuccessTokensPerTask.reasoning)} | ${formatNumber(summary.medianOneShotSuccessTokensPerTask.reasoning)} | ${formatNumber(summary.p1OneShotSuccessTokensPerTask.reasoning)} | ${formatNumber(summary.p99OneShotSuccessTokensPerTask.reasoning)} |`,
	);
	lines.push(
		`| Total Tokens | ${formatNumber(summary.totalOneShotSuccessTokens.total)} | ${formatNumber(summary.avgOneShotSuccessTokensPerTask.total)} | ${formatNumber(summary.medianOneShotSuccessTokensPerTask.total)} | ${formatNumber(summary.p1OneShotSuccessTokensPerTask.total)} | ${formatNumber(summary.p99OneShotSuccessTokensPerTask.total)} |`,
	);
	lines.push("");

	if (summary.hashlineEditSubtypes) {
		const rows = Object.entries(summary.hashlineEditSubtypes)
			.filter(([, count]) => count > 0)
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
		const total = rows.reduce((sum, [, count]) => sum + count, 0);
		if (total > 0) {
			lines.push("### Hashline Op Breakdown");
			lines.push("");
			lines.push("All attempted edit calls across all runs (retries and failed calls included).");
			lines.push("");
			lines.push("| Operation | Count | % |");
			lines.push("|-----------|-------|---|");
			for (const [op, count] of rows) {
				lines.push(`| \`${op}\` | ${count} | ${formatPercent(count / total)} |`);
			}
			lines.push(`| **Total** | **${total}** | 100% |`);
			lines.push("");
		}
	}

	const totalCategorizedEditFailures = EDIT_FAILURE_CATEGORIES.reduce(
		(sum, category) => sum + (summary.editFailureCategories[category] ?? 0),
		0,
	);
	if (totalCategorizedEditFailures > 0) {
		lines.push("### Edit Failure Categories");
		lines.push("");
		lines.push("| Category | Count | % |");
		lines.push("|----------|-------|---|");
		for (const category of EDIT_FAILURE_CATEGORIES) {
			const count = summary.editFailureCategories[category] ?? 0;
			if (count === 0) continue;
			lines.push(`| ${category} | ${count} | ${formatPercent(count / totalCategorizedEditFailures)} |`);
		}
		lines.push(`| **Total** | **${totalCategorizedEditFailures}** | 100% |`);
		lines.push("");
	}

	lines.push("## Task Results");
	lines.push("");
	lines.push("| Task | File | Success | Edit Hit | R/E/W | Tokens (In/Out) | Time | Indent |");
	lines.push("|------|------|---------|----------|-------|-----------------|------|--------|");

	for (const task of tasks) {
		const { status, label } = formatBestStatus(task, runsPerTask);
		const editHitRate = formatPercent(task.editSuccessRate);
		const toolCalls = `${task.toolCalls.read.toFixed(0)}/${task.toolCalls.edit.toFixed(0)}/${task.toolCalls.write.toFixed(0)}`;
		lines.push(
			`| ${escapeMarkdown(task.name)} | ${escapeMarkdown(formatFiles(task.files))} | ${label} ${status} | ${editHitRate} | ${toolCalls} | ${formatNumber(task.tokens.input)}/${formatNumber(task.tokens.output)} | ${formatDuration(task.duration)} | ${formatScore(task.indentScore)} |`,
		);
	}
	lines.push("");

	appendCategorySummary(lines, tasks);
	appendMutationSummary(lines, tasks);
	appendDifficultySummary(lines, tasks);

	if (totalEditFailures > 0) {
		lines.push("## Edit Tool Errors");
		lines.push("");
		lines.push("Failures where the edit tool returned an error or failed to apply the patch.");
		lines.push("");

		for (const task of tasks) {
			const taskFailures = task.runs.filter(run => run.editFailures.length > 0);
			if (taskFailures.length === 0) continue;
			lines.push(`### ${task.name} (${formatFiles(task.files)})`);
			lines.push("");

			for (const run of taskFailures) {
				lines.push(`#### Run ${run.runIndex + 1}`);
				lines.push("");
				for (const [index, failure] of run.editFailures.entries()) {
					const args = failure.args as { path?: unknown; operation?: unknown };
					const path = typeof args?.path === "string" ? args.path : "—";
					const operation = typeof args?.operation === "string" ? args.operation : "—";
					lines.push(`##### Attempt ${index + 1}`);
					lines.push("");
					lines.push(`- Path: ${escapeMarkdown(path)}`);
					lines.push(`- Operation: ${escapeMarkdown(operation)}`);
					lines.push(`- Category: ${escapeMarkdown(failure.category ?? "other")}`);
					lines.push("");
					lines.push("**Tool error**");
					lines.push("");
					lines.push("```");
					lines.push(formatToolError(failure.error));
					lines.push("```");
					lines.push("");
					const body = formatEditArgsBlock(failure.args);
					lines.push("**Patch args**");
					lines.push("");
					lines.push("```diff");
					lines.push(body);
					lines.push("```");
					lines.push("");
				}
			}
		}
	}

	const flakyTasks = tasks.filter(task => {
		if (!task.success) return false;
		const nonGhost = task.runs.filter(run => !isCompletedGhost(run));
		return nonGhost.length > 0 && nonGhost.some(run => !run.success);
	});
	if (flakyTasks.length > 0) {
		lines.push("## Flaky Tasks (best passed; some runs failed)");
		lines.push("");

		for (const task of flakyTasks) {
			const nonGhost = task.runs.filter(run => !isCompletedGhost(run));
			const passing = nonGhost.filter(run => run.success).length;
			const denom = nonGhost.length || runsPerTask;
			const bestNote = task.bestRunIndex >= 0 ? ` (best: run ${task.bestRunIndex + 1})` : "";
			lines.push(`### ${task.name} (${formatFiles(task.files)}) — ${passing}/${denom}${bestNote}`);
			lines.push("");
			lines.push("| Run | Status | Error | Tokens (in/out) | Time |");
			lines.push("|-----|--------|-------|-----------------|------|");

			for (const run of task.runs) {
				const marker = run.runIndex === task.bestRunIndex ? " ★" : "";
				const status = run.success ? "✅" : "❌";
				const error = run.error ? truncate(escapeMarkdown(run.error), 50) : "—";
				lines.push(
					`| ${run.runIndex + 1}${marker} | ${status} | ${error} | ${formatNumber(run.tokens.input)} / ${formatNumber(run.tokens.output)} | ${formatDuration(run.duration)} |`,
				);
			}
			lines.push("");
		}
	}

	const failedTasks = tasks.filter(task => !task.success);
	if (failedTasks.length > 0) {
		lines.push("## Failed Tasks (0% passing)");
		lines.push("");

		for (const task of failedTasks) {
			lines.push(`### ${task.name} (${formatFiles(task.files)}) — 0/${runsPerTask}`);
			lines.push("");

			const errors = task.runs.map(r => r.error).filter(Boolean);
			const uniqueErrors = [...new Set(errors)];

			if (uniqueErrors.length === 1) {
				lines.push(`**All runs failed with same error:** ${escapeMarkdown(uniqueErrors[0]!)}`);
			} else {
				lines.push("| Run | Status | Error | Tokens (in/out) | Time |");
				lines.push("|-----|--------|-------|-----------------|------|");

				for (const run of task.runs) {
					const error = run.error ? truncate(escapeMarkdown(run.error), 50) : "—";
					lines.push(
						`| ${run.runIndex + 1} | ❌ | ${error} | ${formatNumber(run.tokens.input)} / ${formatNumber(run.tokens.output)} | ${formatDuration(run.duration)} |`,
					);
				}
			}
			lines.push("");

			const taskDef = findTaskPrompt(task);
			if (taskDef) {
				lines.push("**Prompt:**");
				lines.push(`> ${escapeMarkdown(taskDef.prompt).split("\n").join("\n> ")}`);
				lines.push("");
			}

			const sampleResponse = task.runs.find(r => r.agentResponse)?.agentResponse;
			if (sampleResponse) {
				lines.push("**Sample agent response (run 1):**");
				lines.push("```");
				lines.push(truncate(sampleResponse, 500));
				lines.push("```");
				lines.push("");
			}

			const sampleDiff = task.runs.find(r => r.diff)?.diff;
			if (sampleDiff) {
				lines.push("**Diff (expected vs actual):**");
				lines.push("```diff");
				lines.push(truncate(sampleDiff, 2000));
				lines.push("```");
				lines.push("");
			}
		}
	}

	return lines.join("\n");
}

function formatScore(value: number): string {
	return value.toFixed(2);
}

function findTaskPrompt(_task: TaskResult): { prompt: string } | undefined {
	// This is a placeholder - in actual use, we'd pass task definitions alongside results
	return undefined;
}

export function generateJsonReport(result: BenchmarkResult): string {
	return JSON.stringify(result, null, 2);
}

function appendCategorySummary(lines: string[], tasks: TaskResult[]): void {
	const runs = tasks.flatMap(task => task.runs);
	const categoryStats = new Map<string, { runs: number; verified: number; editUsed: number; success: number }>();
	const difficultyByCategory = new Map<string, number[]>();

	for (const task of tasks) {
		const metadata = task.runs.find(run => run.mutationCategory || run.difficultyScore !== undefined);
		const category = metadata?.mutationCategory ?? "unknown";
		if (typeof metadata?.difficultyScore === "number") {
			const scores = difficultyByCategory.get(category) ?? [];
			scores.push(metadata.difficultyScore);
			difficultyByCategory.set(category, scores);
		}
	}

	for (const run of runs) {
		const category = run.mutationCategory ?? "unknown";
		const entry = categoryStats.get(category) ?? { runs: 0, verified: 0, editUsed: 0, success: 0 };
		entry.runs += 1;
		if (run.verificationPassed) entry.verified += 1;
		if (run.patchApplied) entry.editUsed += 1;
		if (run.success) entry.success += 1;
		categoryStats.set(category, entry);
	}

	lines.push("## Category Summary");
	lines.push("");
	lines.push("| Category | Runs | Verified | Edit Used | Success | Min/Avg/Max Difficulty |");
	lines.push("|----------|------|----------|-----------|---------|------------------------|");

	const categories = [...categoryStats.keys()].sort();
	for (const category of categories) {
		const entry = categoryStats.get(category)!;
		const scores = difficultyByCategory.get(category) ?? [];
		lines.push(
			`| ${escapeMarkdown(category)} | ${entry.runs} | ${formatRate(entry.verified, entry.runs)} | ${formatRate(entry.editUsed, entry.runs)} | ${formatRate(entry.success, entry.runs)} | ${formatDifficultyStats(scores)} |`,
		);
	}
	lines.push("");
}

function appendMutationSummary(lines: string[], tasks: TaskResult[]): void {
	const runs = tasks.flatMap(task => task.runs);
	const mutationStats = new Map<
		string,
		{ category: string; runs: number; verified: number; editUsed: number; success: number }
	>();

	for (const run of runs) {
		const mutation = run.mutationType ?? "unknown";
		const category = run.mutationCategory ?? "unknown";
		const entry = mutationStats.get(mutation) ?? {
			category,
			runs: 0,
			verified: 0,
			editUsed: 0,
			success: 0,
		};
		entry.runs += 1;
		if (run.verificationPassed) entry.verified += 1;
		if (run.patchApplied) entry.editUsed += 1;
		if (run.success) entry.success += 1;
		mutationStats.set(mutation, entry);
	}

	lines.push("## Mutation Summary");
	lines.push("");
	lines.push("| Mutation | Category | Runs | Verified | Edit Used | Success |");
	lines.push("|----------|----------|------|----------|-----------|---------|");

	const mutations = [...mutationStats.keys()].sort();
	for (const mutation of mutations) {
		const entry = mutationStats.get(mutation)!;
		lines.push(
			`| ${escapeMarkdown(mutation)} | ${escapeMarkdown(entry.category)} | ${entry.runs} | ${formatRate(entry.verified, entry.runs)} | ${formatRate(entry.editUsed, entry.runs)} | ${formatRate(entry.success, entry.runs)} |`,
		);
	}
	lines.push("");
}

function appendDifficultySummary(lines: string[], tasks: TaskResult[]): void {
	const runs = tasks.flatMap(task => task.runs);
	const buckets = [
		{ label: "0-2", min: 0, max: 2 },
		{ label: "3-5", min: 3, max: 5 },
		{ label: "6-8", min: 6, max: 8 },
		{ label: "9+", min: 9, max: Number.POSITIVE_INFINITY },
	];
	const bucketStats = new Map<string, { runs: number; verified: number; editUsed: number; success: number }>();
	const unknown = { runs: 0, verified: 0, editUsed: 0, success: 0 };

	for (const run of runs) {
		const score = run.difficultyScore;
		if (typeof score !== "number") {
			unknown.runs += 1;
			if (run.verificationPassed) unknown.verified += 1;
			if (run.patchApplied) unknown.editUsed += 1;
			if (run.success) unknown.success += 1;
			continue;
		}
		const bucket = buckets.find(entry => score >= entry.min && score <= entry.max);
		const label = bucket?.label ?? "unknown";
		const entry = bucketStats.get(label) ?? { runs: 0, verified: 0, editUsed: 0, success: 0 };
		entry.runs += 1;
		if (run.verificationPassed) entry.verified += 1;
		if (run.patchApplied) entry.editUsed += 1;
		if (run.success) entry.success += 1;
		bucketStats.set(label, entry);
	}

	lines.push("## Difficulty Summary");
	lines.push("");
	lines.push("| Difficulty Score | Runs | Verified | Edit Used | Success |");
	lines.push("|------------------|------|----------|-----------|---------|");

	for (const bucket of buckets) {
		const entry = bucketStats.get(bucket.label) ?? { runs: 0, verified: 0, editUsed: 0, success: 0 };
		lines.push(
			`| ${bucket.label} | ${entry.runs} | ${formatRate(entry.verified, entry.runs)} | ${formatRate(entry.editUsed, entry.runs)} | ${formatRate(entry.success, entry.runs)} |`,
		);
	}
	if (unknown.runs > 0) {
		lines.push(
			`| unknown | ${unknown.runs} | ${formatRate(unknown.verified, unknown.runs)} | ${formatRate(unknown.editUsed, unknown.runs)} | ${formatRate(unknown.success, unknown.runs)} |`,
		);
	}
	lines.push("");
}

function formatDifficultyStats(scores: number[]): string {
	if (scores.length === 0) return "—";
	const min = Math.min(...scores);
	const max = Math.max(...scores);
	const avg = scores.reduce((sum, score) => sum + score, 0) / scores.length;
	return `${min} / ${avg.toFixed(1)} / ${max}`;
}
