#!/usr/bin/env bun

import { program } from "commander";
import { createPlugin } from "./commands/create.js";
import { runDoctor } from "./commands/doctor.js";
import { disablePlugin, enablePlugin } from "./commands/enable.js";
import { showInfo } from "./commands/info.js";
import { initProject } from "./commands/init.js";
import { installPlugin } from "./commands/install.js";
import { linkPlugin } from "./commands/link.js";
import { listPlugins } from "./commands/list.js";
import { showOutdated } from "./commands/outdated.js";
import { searchPlugins } from "./commands/search.js";
import { uninstallPlugin } from "./commands/uninstall.js";
import { updatePlugin } from "./commands/update.js";
import { whyFile } from "./commands/why.js";
import { checkMigration, migrateToNpm } from "./migrate.js";

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
	.option("-g, --global", "Install globally to ~/.pi (default)")
	.option("-S, --save", "Add to plugins.json")
	.option("-D, --save-dev", "Add as dev dependency")
	.option("--force", "Overwrite conflicts without prompting")
	.option("--json", "Output as JSON")
	.action(installPlugin);

program
	.command("uninstall <name>")
	.alias("rm")
	.description("Remove plugin and its symlinks")
	.option("-g, --global", "Uninstall from ~/.pi (default)")
	.option("--json", "Output as JSON")
	.action(uninstallPlugin);

program
	.command("update [name]")
	.alias("up")
	.description("Update to latest within semver range")
	.option("-g, --global", "Update global plugins (default)")
	.option("--json", "Output as JSON")
	.action(updatePlugin);

program
	.command("list")
	.alias("ls")
	.description("Show installed plugins")
	.option("-g, --global", "List global plugins (default)")
	.option("--json", "Output as JSON")
	.action(listPlugins);

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
	.option("-g, --global", "Link globally (default)")
	.action(linkPlugin);

// ============================================================================
// New Commands
// ============================================================================

program
	.command("init")
	.description("Create .pi/plugins.json in current project")
	.option("--force", "Overwrite existing plugins.json")
	.action(initProject);

program
	.command("search <query>")
	.description("Search npm for omp-plugin keyword")
	.option("--json", "Output as JSON")
	.option("--limit <n>", "Maximum results to show", "20")
	.action((query, options) => searchPlugins(query, { ...options, limit: parseInt(options.limit, 10) }));

program
	.command("info <package>")
	.description("Show plugin details before install")
	.option("--json", "Output as JSON")
	.option("--versions", "Show available versions")
	.action(showInfo);

program
	.command("outdated")
	.description("List plugins with newer versions")
	.option("-g, --global", "Check global plugins (default)")
	.option("--json", "Output as JSON")
	.action(showOutdated);

program
	.command("doctor")
	.description("Check for broken symlinks, conflicts")
	.option("-g, --global", "Check global plugins (default)")
	.option("--fix", "Attempt to fix issues")
	.option("--json", "Output as JSON")
	.action(runDoctor);

program
	.command("create <name>")
	.description("Scaffold new plugin from template")
	.option("-d, --description <desc>", "Plugin description")
	.option("-a, --author <author>", "Plugin author")
	.action(createPlugin);

program
	.command("why <file>")
	.description("Show which plugin installed a file")
	.option("-g, --global", "Check global plugins (default)")
	.option("--json", "Output as JSON")
	.action(whyFile);

program
	.command("enable <name>")
	.description("Enable a disabled plugin")
	.option("-g, --global", "Target global plugins (default)")
	.option("--json", "Output as JSON")
	.action(enablePlugin);

program
	.command("disable <name>")
	.description("Disable plugin without uninstalling")
	.option("-g, --global", "Target global plugins (default)")
	.option("--json", "Output as JSON")
	.action(disablePlugin);

program
	.command("migrate")
	.description("Migrate from legacy manifest.json to npm-native format")
	.action(async () => {
		await migrateToNpm();
	});

program.parse();
