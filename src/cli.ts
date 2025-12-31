#!/usr/bin/env bun

import { createPlugin } from "@omp/commands/create";
import { runDoctor } from "@omp/commands/doctor";
import { disablePlugin, enablePlugin } from "@omp/commands/enable";
import { showInfo } from "@omp/commands/info";
import { initProject } from "@omp/commands/init";
import { installPlugin } from "@omp/commands/install";
import { linkPlugin } from "@omp/commands/link";
import { listPlugins } from "@omp/commands/list";
import { showOutdated } from "@omp/commands/outdated";
import { searchPlugins } from "@omp/commands/search";
import { uninstallPlugin } from "@omp/commands/uninstall";
import { updatePlugin } from "@omp/commands/update";
import { whyFile } from "@omp/commands/why";
import { withErrorHandling } from "@omp/errors";
import { checkMigration, migrateToNpm } from "@omp/migrate";
import { checkNpmAvailable } from "@omp/npm";
import chalk from "chalk";
import { program } from "commander";

// Check npm availability at startup
const npmCheck = checkNpmAvailable();
if (!npmCheck.available) {
	console.log(chalk.red(npmCheck.error));
	process.exit(1);
}

program.name("omp").description("Oh My Pi - Plugin manager for pi configuration").version("0.1.0");

// Check for migration on startup (only for commands that need it)
program.hook("preAction", async (thisCommand) => {
	const migratingCommands = ["install", "uninstall", "update", "list", "link"];
	if (migratingCommands.includes(thisCommand.name())) {
		await checkMigration();
	}
});

// ============================================================================
// Core Commands
// ============================================================================

program
	.command("install [packages...]")
	.alias("i")
	.description("Install plugin(s). No args = install from plugins.json")
	.addHelpText(
		"after",
		`
Examples:
  $ omp install @oh-my-pi/subagents         # Install from npm
  $ omp install @oh-my-pi/subagents@^2.0.0  # Specific version range
  $ omp install @myorg/cool-theme           # Scoped package
  $ omp install ./local/path            # Local directory (copies)
  $ omp install                         # Install all from plugins.json
`,
	)
	.option("-g, --global", "Install globally to ~/.pi")
	.option("-l, --local", "Install to project-local .pi/")
	.option("-S, --save", "Add to plugins.json")
	.option("-D, --save-dev", "Add as dev dependency")
	.option("--force", "Overwrite conflicts without prompting")
	.option("--json", "Output as JSON")
	.action(withErrorHandling(installPlugin));

program
	.command("uninstall <name>")
	.alias("rm")
	.description("Remove plugin and its symlinks")
	.option("-g, --global", "Uninstall from ~/.pi")
	.option("-l, --local", "Uninstall from project-local .pi/")
	.option("--json", "Output as JSON")
	.action(withErrorHandling(uninstallPlugin));

program
	.command("update [name]")
	.alias("up")
	.description("Update to latest within semver range")
	.option("-g, --global", "Update global plugins")
	.option("-l, --local", "Update project-local plugins")
	.option("--json", "Output as JSON")
	.action(withErrorHandling(updatePlugin));

program
	.command("list")
	.alias("ls")
	.description("Show installed plugins")
	.option("-g, --global", "List global plugins")
	.option("-l, --local", "List project-local plugins")
	.option("--json", "Output as JSON")
	.action(withErrorHandling(listPlugins));

program
	.command("link <path>")
	.description("Symlink local plugin (dev mode)")
	.addHelpText(
		"after",
		`
Unlike install, link creates a symlink to the original directory,
so changes are reflected immediately without reinstalling.
`,
	)
	.option("-n, --name <name>", "Custom name for the plugin")
	.option("-g, --global", "Link globally")
	.option("-l, --local", "Link to project-local .pi/")
	.option("--force", "Overwrite existing npm-installed plugin")
	.action(withErrorHandling(linkPlugin));

// ============================================================================
// New Commands
// ============================================================================

program
	.command("init")
	.description("Create .pi/plugins.json in current project")
	.option("--force", "Overwrite existing plugins.json")
	.action(withErrorHandling(initProject));

program
	.command("search <query>")
	.description("Search npm for omp-plugin keyword")
	.option("--json", "Output as JSON")
	.option("--limit <n>", "Maximum results to show", "20")
	.action(withErrorHandling((query, options) => searchPlugins(query, { ...options, limit: parseInt(options.limit, 10) })));

program
	.command("info <package>")
	.description("Show plugin details before install")
	.option("--json", "Output as JSON")
	.option("--versions", "Show available versions")
	.action(withErrorHandling(showInfo));

program
	.command("outdated")
	.description("List plugins with newer versions")
	.option("-g, --global", "Check global plugins")
	.option("-l, --local", "Check project-local plugins")
	.option("--json", "Output as JSON")
	.action(withErrorHandling(showOutdated));

program
	.command("doctor")
	.description("Check for broken symlinks, conflicts")
	.option("-g, --global", "Check global plugins")
	.option("-l, --local", "Check project-local plugins")
	.option("--fix", "Attempt to fix issues")
	.option("--json", "Output as JSON")
	.action(withErrorHandling(runDoctor));

program
	.command("create <name>")
	.description("Scaffold new plugin from template")
	.option("-d, --description <desc>", "Plugin description")
	.option("-a, --author <author>", "Plugin author")
	.action(withErrorHandling(createPlugin));

program
	.command("why <file>")
	.description("Show which plugin installed a file")
	.option("-g, --global", "Check global plugins")
	.option("-l, --local", "Check project-local plugins")
	.option("--json", "Output as JSON")
	.action(withErrorHandling(whyFile));

program
	.command("enable <name>")
	.description("Enable a disabled plugin")
	.option("-g, --global", "Target global plugins")
	.option("-l, --local", "Target project-local plugins")
	.option("--json", "Output as JSON")
	.action(withErrorHandling(enablePlugin));

program
	.command("disable <name>")
	.description("Disable plugin without uninstalling")
	.option("-g, --global", "Target global plugins")
	.option("-l, --local", "Target project-local plugins")
	.option("--json", "Output as JSON")
	.action(withErrorHandling(disablePlugin));

program
	.command("migrate")
	.description("Migrate from legacy manifest.json to npm-native format")
	.action(
		withErrorHandling(async () => {
			await migrateToNpm();
		}),
	);

program.parse();
