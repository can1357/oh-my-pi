import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { PROJECT_PI_DIR, PROJECT_PLUGINS_JSON } from "@omp/paths";
import chalk from "chalk";

export interface InitOptions {
	force?: boolean;
}

/**
 * Initialize .pi/plugins.json in current project
 */
export async function initProject(options: InitOptions = {}): Promise<void> {
	// Check if already exists
	if (existsSync(PROJECT_PLUGINS_JSON) && !options.force) {
		console.log(chalk.yellow(`${PROJECT_PLUGINS_JSON} already exists.`));
		console.log(chalk.dim("Use --force to overwrite"));
		process.exitCode = 1;
		return;
	}

	try {
		// Create .pi directory
		await mkdir(PROJECT_PI_DIR, { recursive: true });

		// Create plugins.json
		const pluginsJson = {
			plugins: {},
			disabled: [],
		};

		await writeFile(PROJECT_PLUGINS_JSON, JSON.stringify(pluginsJson, null, 2));

		console.log(chalk.green(`✓ Created ${PROJECT_PLUGINS_JSON}`));
		console.log();
		console.log(chalk.dim("Next steps:"));
		console.log(chalk.dim("  1. Add plugins: omp install <package> --save"));
		console.log(chalk.dim("  2. Or edit plugins.json directly"));
		console.log(chalk.dim("  3. Run: omp install (to install all)"));
	} catch (err) {
		console.log(chalk.red(`Error initializing project: ${(err as Error).message}`));
		process.exitCode = 1;
	}
}
