import { resolveScope } from "@omp/paths";
import { generateEnvScript, getEnvJson } from "@omp/runtime";
import chalk from "chalk";

export interface EnvOptions {
	global?: boolean;
	local?: boolean;
	json?: boolean;
	fish?: boolean;
}

/**
 * Output environment variables for plugins
 * omp env                     # Print shell exports (sh/bash/zsh)
 * omp env --fish              # Print fish shell syntax
 * omp env --json              # Print as JSON
 */
export async function envCommand(options: EnvOptions = {}): Promise<void> {
	const isGlobal = resolveScope(options);

	if (options.json) {
		const vars = await getEnvJson(isGlobal);
		console.log(JSON.stringify(vars, null, 2));
		return;
	}

	const shell = options.fish ? "fish" : "sh";
	const script = await generateEnvScript(isGlobal, shell);

	if (script.length === 0) {
		console.error(chalk.yellow("No environment variables configured."));
		console.error(chalk.dim("Set variables with: omp config <plugin> <variable> <value>"));
		process.exitCode = 1;
		return;
	}

	// Output script directly (for eval or sourcing)
	console.log(script);
}
