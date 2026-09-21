/**
 * `omp find`: run the semantic `find` tool's cascade from the shell. Same
 * search as the tool, printed as a ranked, colored digest (or JSON).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { formatBytes, formatDuration, formatNumber, isEnoent } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { resolveJudge } from "../judgment";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { expandPath } from "../tools/path-utils";
import { type CascadeResult, runCascade } from "../tools/jfind/cascade";
import { rankedHeat } from "../tools/jfind/passages";

export interface FindCommandArgs {
	query: string;
	path: string;
	keywords: string[];
	hidden: boolean;
	json: boolean;
	quiet: boolean;
}

/** Ranges printed per hit. */
const RANGES_SHOWN = 3;
/** Cells in the score gauge. */
const GAUGE_WIDTH = 6;

function scoreStyle(p: number): (text: string) => string {
	return p >= 0.7 ? chalk.green : p >= 0.4 ? chalk.yellow : chalk.dim;
}

function gauge(p: number): string {
	const filled = Math.round(p * GAUGE_WIDTH);
	return scoreStyle(p)("━".repeat(filled)) + chalk.dim("─".repeat(GAUGE_WIDTH - filled));
}

function printReport(cmd: FindCommandArgs, root: string, result: CascadeResult, elapsedMs: number): void {
	const { hits, stats, threshold } = result;
	const rel = path.relative(process.cwd(), root) || ".";
	console.log("");
	if (hits.length === 0) {
		console.log(
			`${chalk.yellow("no hits")} ${chalk.dim(`for "${cmd.query}" in ${rel} · τ ${threshold.toFixed(2)}`)}`,
		);
	} else {
		console.log(
			`${chalk.bold(`${hits.length} hit(s)`)} ${chalk.dim(`for "${cmd.query}" in ${rel} · τ ${threshold.toFixed(2)} · strongest first`)}`,
		);
		console.log("");
		for (const hit of hits) {
			const coverage = hit.truncated ? `${hit.linesSeen} lines judged, partial` : `${hit.linesSeen} lines judged`;
			console.log(
				`${gauge(hit.contentScore)} ${scoreStyle(hit.contentScore)(hit.contentScore.toFixed(2))} ${chalk.cyan(hit.rel)} ${chalk.dim(coverage)}`,
			);
			for (const range of rankedHeat(hit.ranges, RANGES_SHOWN)) {
				const span = range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
				console.log(
					`  ${chalk.dim("└─")} ${chalk.cyan(`${hit.rel}:${span}`)} ${chalk.dim(range.p.toFixed(2))} ${range.snippet.trim()}`,
				);
			}
		}
	}
	console.log("");
	console.log(
		chalk.dim(
			`listed ${stats.listed} · judged ${stats.judged} · read ${stats.filesRead} files (${formatBytes(stats.fileBytes)}) · ${stats.requests} requests · ${formatNumber(stats.inputTokens)} tokens · $${stats.cost.toFixed(4)} · ${formatDuration(elapsedMs)} wall / ${formatDuration(stats.apiMs)} api`,
		),
	);
	for (const failure of stats.failures) console.log(chalk.yellow(failure));
}

/** Run one search and print it. Exits non-zero on a bad root or when every judgment failed. */
export async function runFindCommand(cmd: FindCommandArgs): Promise<void> {
	if (!cmd.query.trim()) {
		console.error(chalk.red("Error: query is required"));
		process.exit(1);
	}
	const root = path.resolve(expandPath(cmd.path));
	try {
		if (!(await fs.stat(root)).isDirectory()) {
			console.error(chalk.red(`Error: not a directory: ${cmd.path}`));
			process.exit(1);
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
		console.error(chalk.red(`Error: path not found: ${cmd.path}`));
		process.exit(1);
	}

	const log = cmd.quiet ? () => {} : (message: string) => console.error(chalk.dim(message));
	log("resolving judge");
	const settings = await Settings.init({ cwd: root });
	const authStorage = await discoverAuthStorage();
	try {
		const registry = new ModelRegistry(authStorage);
		await registry.refresh();
		await loadCliExtensionProviders(registry, settings, root);
		const judge = resolveJudge({ settings, registry, sessionId: Bun.randomUUIDv7() });
		const started = performance.now();
		const result = await runCascade({
			root,
			query: cmd.query.trim(),
			extraKeywords: cmd.keywords,
			judge,
			includeHidden: cmd.hidden,
			onProgress: log,
		});
		const elapsedMs = performance.now() - started;
		if (cmd.json) {
			console.log(JSON.stringify({ query: cmd.query, root, elapsedMs, ...result }, null, 2));
		} else {
			printReport(cmd, root, result, elapsedMs);
		}
		if (result.stats.requests > 0 && result.stats.errors === result.stats.requests) process.exit(1);
	} finally {
		authStorage.close();
	}
}
