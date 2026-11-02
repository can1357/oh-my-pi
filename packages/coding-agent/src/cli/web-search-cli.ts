/**
 * Web search CLI command handlers.
 *
 * Handles `omp q`/`omp web-search` subcommands for testing web search models.
 */

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
		process.stderr.write(`${chalk.red("Error: Query is required")}\n`);
		process.exit(1);
	}

	if (cmd.recency && !RECENCY_OPTIONS.includes(cmd.recency)) {
		process.stderr.write(`${chalk.red(`Error: Invalid recency "${cmd.recency}"`)}\n`);
		process.stderr.write(`${chalk.dim(`Valid recency values: ${RECENCY_OPTIONS.join(", ")}`)}\n`);
		process.exit(1);
	}

	if (cmd.limit !== undefined && Number.isNaN(cmd.limit)) {
		process.stderr.write(`${chalk.red("Error: --limit must be a number")}\n`);
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
	process.stdout.write(`${chalk.bold(`${APP_NAME} q`)} - Test web search models

${chalk.bold("Usage:")}
  ${APP_NAME} q [options] <query>
  ${APP_NAME} web-search [options] <query>

${chalk.bold("Arguments:")}
  query      Search query text

${chalk.bold("Options:")}
  --model <selector>  Catalog model selector (for example, web/duckduckgo)
  --recency <value>   Recency filter (when supported): ${RECENCY_OPTIONS.join(", ")}
  -l, --limit <n>     Max results to return
  --compact           Render condensed output
  -h, --help          Show this help

${chalk.bold("Query directives:")}
  site:/-site:  after:/before: (YYYY-MM-DD)  inurl:  intitle:  filetype:
  "exact phrase"  -term  OR
  Mapped to native provider filters where available, otherwise applied as a
  lenient post-filter (a constraint matching nothing is relaxed, not fatal).

${chalk.bold("Examples:")}
  ${APP_NAME} q --model=web/duckduckgo "what's the color of the sky"
  ${APP_NAME} q --model=openrouter/google/gemini-2.5-flash --recency=week "latest TypeScript changes"
  ${APP_NAME} q 'transformer scaling site:arxiv.org after:2024 -site:reddit.com'
`);
}
