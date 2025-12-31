import { npmSearch } from "@omp/npm";
import { log, outputJson, setJsonMode } from "@omp/output";
import chalk from "chalk";

function truncate(str: string, maxLen: number): string {
	if (!str || str.length <= maxLen) return str;
	return `${str.slice(0, maxLen - 3)}...`;
}

export interface SearchOptions {
	json?: boolean;
	limit?: number;
}

/**
 * Search npm for plugins with omp-plugin keyword
 */
export async function searchPlugins(query: string, options: SearchOptions = {}): Promise<void> {
	if (options.json) {
		setJsonMode(true);
	}

	log(chalk.blue(`Searching npm for "${query}" with omp-plugin keyword...`));

	try {
		const results = await npmSearch(query, "omp-plugin");

		if (results.length === 0) {
			log(chalk.yellow("\nNo plugins found."));
			log(chalk.dim("Try a different search term, or search without keyword:"));
			log(chalk.dim("  npm search omp-plugin"));
			process.exitCode = 1;
			return;
		}

		const limit = options.limit || 20;
		const displayResults = results.slice(0, limit);

		if (options.json) {
			outputJson({ results: displayResults });
			return;
		}

		log(chalk.bold(`\nFound ${results.length} plugin(s):\n`));

		for (const result of displayResults) {
			log(chalk.green("◆ ") + chalk.bold(result.name) + chalk.dim(` v${result.version}`));

			if (result.description) {
				log(chalk.dim(`    ${truncate(result.description, 100)}`));
			}

			if (result.keywords?.length) {
				const otherKeywords = result.keywords.filter((k) => k !== "omp-plugin");
				if (otherKeywords.length > 0) {
					log(chalk.dim(`    tags: ${otherKeywords.join(", ")}`));
				}
			}

			log();
		}

		if (results.length > limit) {
			log(chalk.dim(`... and ${results.length - limit} more. Use --limit to see more.`));
		}

		log(chalk.dim("Install with: omp install <package-name>"));
	} catch (err) {
		const error = err as Error;
		if (
			error.message.includes("ENOTFOUND") ||
			error.message.includes("ETIMEDOUT") ||
			error.message.includes("EAI_AGAIN")
		) {
			log(chalk.red("\nNetwork error: Unable to reach npm registry."));
			log(chalk.dim("  Check your internet connection and try again."));
		} else {
			log(chalk.red(`\nSearch failed: ${error.message}`));
		}
		process.exitCode = 1;
	}
}
