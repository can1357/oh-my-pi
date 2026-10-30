/**
 * Web search CLI command handlers.
 *
 * Handles `omp q`/`omp web-search` subcommands for testing web search models.
 */

import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { APP_NAME, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Settings } from "../config/settings";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { renderSearchResult } from "@oh-my-pi/pi-tui/tools/web-search";
import { runSearchQuery, type SearchQueryParams } from "../web/search/index";

export interface SearchCommandArgs {
	query: string;
	model?: string;
	recency?: "day" | "week" | "month" | "year";
	limit?: number;
	expanded: boolean;
}

const RECENCY_OPTIONS: SearchCommandArgs["recency"][] = ["day", "week", "month", "year"];

/**
 * Parse web search subcommand arguments.
 * Returns undefined if not a web search command.
 */
export function parseSearchArgs(args: string[]): SearchCommandArgs | undefined {
	if (args.length === 0 || (args[0] !== "q" && args[0] !== "web-search")) {
		return undefined;
	}

	const result: SearchCommandArgs = {
		query: "",
		expanded: true,
	};

	const positional: string[] = [];

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--model") {
			result.model = args[++i];
		} else if (arg.startsWith("--model=")) {
			result.model = arg.slice("--model=".length);
		} else if (arg === "--recency") {
			result.recency = args[++i] as SearchCommandArgs["recency"];
		} else if (arg === "--limit" || arg === "-l") {
			result.limit = Number.parseInt(args[++i], 10);
		} else if (arg === "--compact") {
			result.expanded = false;
		} else if (!arg.startsWith("-")) {
			positional.push(arg);
		}
	}

	if (positional.length > 0) {
		result.query = positional.join(" ");
	}

	return result;
}

export async function runSearchCommand(cmd: SearchCommandArgs): Promise<void> {
	if (!cmd.query) {
		process.stderr.write(`${chalk.red(__ompTranslate("Error: Query is required"))}\n`);
		process.exit(1);
	}

	if (cmd.recency && !RECENCY_OPTIONS.includes(cmd.recency)) {
		process.stderr.write(`${chalk.red(__ompTranslate('Error: Invalid recency "{0}"', `${cmd.recency}`))}\n`);
		process.stderr.write(
			`${chalk.dim(__ompTranslate("Valid recency values: {0}", `${RECENCY_OPTIONS.join(", ")}`))}\n`,
		);
		process.exit(1);
	}

	if (cmd.limit !== undefined && Number.isNaN(cmd.limit)) {
		process.stderr.write(`${chalk.red(__ompTranslate("Error: --limit must be a number"))}\n`);
		process.exit(1);
	}

	await Settings.init({ cwd: getProjectDir() });

	await initTheme();

	const params: SearchQueryParams = {
		query: cmd.query,
		model: cmd.model,
		recency: cmd.recency,
		limit: cmd.limit,
	};

	const result = await runSearchQuery(params);
	const component = renderSearchResult(result, { expanded: cmd.expanded, isPartial: false }, theme, {
		query: cmd.query,
		maxAnswerLines: cmd.expanded ? undefined : 6,
	});

	const width = Math.max(60, process.stdout.columns ?? 100);
	process.stdout.write(`${component.render(width).join("\n")}\n`);

	if (result.details?.error) {
		process.exitCode = 1;
	}
}

export function printSearchHelp(): void {
	process.stdout.write(
		__ompTranslate(
			'{0} - Test web search models\n\n{1}\n  {2} q [options] <query>\n  {3} web-search [options] <query>\n\n{4}\n  query      Search query text\n\n{5}\n  --model <selector>  Catalog model selector (for example, web/duckduckgo)\n  --recency <value>   Recency filter (when supported): {6}\n  -l, --limit <n>     Max results to return\n  --compact           Render condensed output\n  -h, --help          Show this help\n\n{7}\n  site:/-site:  after:/before: (YYYY-MM-DD)  inurl:  intitle:  filetype:\n  "exact phrase"  -term  OR\n  Mapped to native provider filters where available, otherwise applied as a\n  lenient post-filter (a constraint matching nothing is relaxed, not fatal).\n\n{8}\n  {9} q --model=web/duckduckgo "what\'s the color of the sky"\n  {10} q --model=openrouter/google/gemini-2.5-flash --recency=week "latest TypeScript changes"\n  {11} q \'transformer scaling site:arxiv.org after:2024 -site:reddit.com\'\n',
			`${chalk.bold(`${APP_NAME} q`)}`,
			`${chalk.bold(__ompTranslate("Usage:"))}`,
			`${APP_NAME}`,
			`${APP_NAME}`,
			`${chalk.bold(__ompTranslate("Arguments:"))}`,
			`${chalk.bold(__ompTranslate("Options:"))}`,
			`${RECENCY_OPTIONS.join(", ")}`,
			`${chalk.bold(__ompTranslate("Query directives:"))}`,
			`${chalk.bold(__ompTranslate("Examples:\u0004help.command.examples"))}`,
			`${APP_NAME}`,
			`${APP_NAME}`,
			`${APP_NAME}`,
		),
	);
}
