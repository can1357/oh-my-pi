/**
 * Web search CLI command handlers.
 *
 * Handles `omp q`/`omp web-search` subcommands for testing web search models.
 */

import { getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Settings } from "../config/settings";
import { runSearchQuery, type SearchQueryParams } from "../web/search/index";
import { initTheme } from "../ui/theme/service";
import { printRows } from "../ui/print-rows";
import "../ui/styles/tools";
import "../ui/tools";
import { ToolBlock, ToolCall } from "../ui/transcript/tool-block";

export interface SearchCommandArgs {
	query: string;
	model?: string;
	recency?: "day" | "week" | "month" | "year";
	limit?: number;
	expanded: boolean;
}

const RECENCY_OPTIONS: SearchCommandArgs["recency"][] = ["day", "week", "month", "year"];

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

	initTheme();

	const params: SearchQueryParams = {
		query: cmd.query,
		model: cmd.model,
		recency: cmd.recency,
		limit: cmd.limit,
	};

	const result = await runSearchQuery(params);
	const call = new ToolCall({ id: "web-search", name: "web_search", args: params });
	call.setExpanded(cmd.expanded);
	call.setExecutionStarted();
	call.updateResult(result, false);
	call.seal();

	const width = Math.max(60, process.stdout.columns ?? 100);
	process.stdout.write(`${printRows(() => ToolBlock({ call }), width).join("\n")}\n`);

	if (result.details?.error) {
		process.exitCode = 1;
	}
}
