import { npmInfo } from "@omp/npm";
import chalk from "chalk";

export interface InfoOptions {
	json?: boolean;
	versions?: boolean;
}

/**
 * Show detailed info about a package before install
 */
export async function showInfo(packageName: string, options: InfoOptions = {}): Promise<void> {
	console.log(chalk.blue(`Fetching info for ${packageName}...`));

	try {
		const info = await npmInfo(packageName);

		if (!info) {
			console.log(chalk.red(`Package not found: ${packageName}`));
			process.exitCode = 1;
			return;
		}

		if (options.json) {
			console.log(JSON.stringify(info, null, 2));
			return;
		}

		console.log();
		console.log(chalk.bold.green(info.name) + chalk.dim(` v${info.version}`));
		console.log();

		if (info.description) {
			console.log(chalk.white(info.description));
			console.log();
		}

		// Author
		if (info.author) {
			const authorStr =
				typeof info.author === "string"
					? info.author
					: `${info.author.name}${info.author.email ? ` <${info.author.email}>` : ""}`;
			console.log(chalk.dim("author: ") + authorStr);
		}

		// Homepage
		if (info.homepage) {
			console.log(chalk.dim("homepage: ") + info.homepage);
		}

		// Repository
		if (info.repository) {
			const repoUrl = typeof info.repository === "string" ? info.repository : info.repository.url;
			console.log(chalk.dim("repo: ") + repoUrl);
		}

		// Keywords
		if (info.keywords?.length) {
			console.log(chalk.dim("keywords: ") + info.keywords.join(", "));
		}

		// Is it an omp plugin?
		const isOmpPlugin = info.keywords?.includes("omp-plugin");
		if (isOmpPlugin) {
			console.log(chalk.green("\n✓ This is an omp plugin"));
		} else {
			console.log(chalk.yellow("\n⚠ This package does not have the omp-plugin keyword"));
			console.log(chalk.dim("  It may work, but might not have omp.install configuration"));
		}

		// Versions
		if (options.versions && info["dist-tags"]) {
			console.log(chalk.dim("\ndist-tags:"));
			for (const [tag, version] of Object.entries(info["dist-tags"])) {
				console.log(chalk.dim(`  ${tag}: `) + version);
			}
		}

		console.log();
		console.log(chalk.dim(`Install with: omp install ${packageName}`));
	} catch (err) {
		console.log(chalk.red(`Error fetching info: ${(err as Error).message}`));
		process.exitCode = 1;
	}
}
