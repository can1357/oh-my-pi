/**
 * `omp find`: run the semantic `find` tool's cascade from the shell. Same
 * search as the tool, printed as a ranked, colored digest (or JSON).
 */
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { formatBytes, formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { InternalUrlFilesystem, isUrlPath } from "../internal-urls/url-filesystem";
import { resolveJudge } from "../judgment";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { formatPathRelativeToCwd, resolveSearchResultPath } from "../tools/path-utils";
import { type CascadeResult, runCascade } from "../tools/jfind/cascade";
import { rankedHeat } from "../tools/jfind/passages";
import { resolveSearchRoot, type SearchRoot } from "../tools/jfind/tree";

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

function printReport(cmd: FindCommandArgs, rel: string, result: CascadeResult, elapsedMs: number): void {
	const { hits, stats, threshold } = result;
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
	const log = cmd.quiet ? () => {} : (message: string) => console.error(chalk.dim(message));
	const cwd = process.cwd();
	// Internal URLs (`omp://`, `local://`, …) are searched in place; `find` only reads.
	const filesystem = new InternalUrlFilesystem({ context: { cwd }, tier: "read" });
	let root: SearchRoot;
	try {
		root = await resolveSearchRoot(filesystem, cmd.path, cwd);
	} catch (error) {
		if (!(error instanceof ToolError)) throw error;
		console.error(chalk.red(`Error: ${error.message}`));
		process.exit(1);
	}

	// Settings and extensions belong to the searched project; a file or URL
	// scope has none of its own, so it keeps the caller's.
	const baseCwd = root.type === "directory" && !isUrlPath(root.path) ? root.path : cwd;
	log("resolving judge");
	const settings = await Settings.init({ cwd: baseCwd });
	const authStorage = await discoverAuthStorage(undefined, { settings });
	try {
		const registry = new ModelRegistry(authStorage);
		await registry.refresh();
		await loadCliExtensionProviders(registry, settings, baseCwd);
		const judge = resolveJudge({ settings, registry, sessionId: Bun.randomUUIDv7() });
		const started = performance.now();
		const raw = await runCascade({
			root,
			filesystem,
			query: cmd.query.trim(),
			extraKeywords: cmd.keywords,
			judge,
			includeHidden: cmd.hidden,
			onProgress: log,
		});
		// Hits print as paths usable from the caller's cwd: relative files or URLs.
		const result: CascadeResult = {
			...raw,
			hits: raw.hits.map(hit => ({
				...hit,
				rel: formatPathRelativeToCwd(resolveSearchResultPath(root.path, hit.rel), cwd),
			})),
		};
		const elapsedMs = performance.now() - started;
		if (cmd.json) {
			console.log(JSON.stringify({ query: cmd.query, root: root.path, elapsedMs, ...result }, null, 2));
		} else {
			printReport(cmd, formatPathRelativeToCwd(root.path, cwd), result, elapsedMs);
		}
		// `exitCode`, not `exit`: process.exit skips the finally below, and with it authStorage.close().
		if (result.stats.requests > 0 && result.stats.errors === result.stats.requests) process.exitCode = 1;
	} finally {
		authStorage.close();
	}
}
