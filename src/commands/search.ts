import { npmSearch } from "@omp/npm";
import chalk from "chalk";

export interface SearchOptions {
	json?: boolean;
	limit?: number;
}

/**
 * Search npm for plugins with omp-plugin keyword
 */
export async function searchPlugins(query: string, options: SearchOptions = {}): Promise<void> {
	console.log(chalk.blue(`Searching npm for "${query}" with omp-plugin keyword...`));

	try {
		const results = await npmSearch(query, "omp-plugin");

		if (results.length === 0) {
			console.log(chalk.yellow("\nNo plugins found."));
			console.log(chalk.dim("Try a different search term, or search without keyword:"));
			console.log(chalk.dim("  npm search omp-plugin"));
			process.exitCode = 1;
			return;
		}

		const limit = options.limit || 20;
		const displayResults = results.slice(0, limit);

		if (options.json) {
			console.log(JSON.stringify({ results: displayResults }, null, 2));
			return;
		}

		console.log(chalk.bold(`\nFound ${results.length} plugin(s):\n`));

		for (const result of displayResults) {
			console.log(chalk.green("◆ ") + chalk.bold(result.name) + chalk.dim(` v${result.version}`));

			if (result.description) {
				console.log(chalk.dim(`    ${result.description}`));
			}

			if (result.keywords?.length) {
				const otherKeywords = result.keywords.filter((k) => k !== "omp-plugin");
				if (otherKeywords.length > 0) {
					console.log(chalk.dim(`    tags: ${otherKeywords.join(", ")}`));
				}
			}

			console.log();
		}

		if (results.length > limit) {
			console.log(chalk.dim(`... and ${results.length - limit} more. Use --limit to see more.`));
		}

		console.log(chalk.dim("Install with: omp install <package-name>"));
	} catch (err) {
		console.log(chalk.red(`Error searching: ${(err as Error).message}`));
		process.exitCode = 1;
	}
}
