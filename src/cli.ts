#!/usr/bin/env bun

import { configCommand, validateConfig } from "@omp/commands/config";
import { createPlugin } from "@omp/commands/create";
import { runDoctor } from "@omp/commands/doctor";
import { disablePlugin, enablePlugin } from "@omp/commands/enable";
import { envCommand } from "@omp/commands/env";
import { featuresCommand } from "@omp/commands/features";
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
import { program } from "commander";

program.name("omp").description("Oh My Pi - Plugin manager for pi configuration").version("0.4.0");

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
  $ omp install @oh-my-pi/subagents             # Install from npm (all features)
  $ omp install @oh-my-pi/exa[search]           # Install with specific features
  $ omp install @oh-my-pi/exa[search,websets]   # Multiple features
  $ omp install @oh-my-pi/exa[*]                # Explicitly all features
  $ omp install @oh-my-pi/exa[]                 # No optional features (core only)
  $ omp install @oh-my-pi/subagents@^2.0.0      # Specific version range
  $ omp install ./local/path                    # Local directory (copies)
  $ omp install                                 # Install all from plugins.json
  $ omp install --conflict-resolution=skip      # CI: skip conflicting files
  $ omp install --conflict-resolution=overwrite # CI: overwrite conflicts
  $ omp install --dry-run                       # Preview changes without installing
`,
	)
	.option("-g, --global", "Install globally to ~/.pi")
	.option("-l, --local", "Install to project-local .pi/")
	.option("-S, --save", "Add to plugins.json")
	.option("-D, --save-dev", "Add as dev dependency")
	.option("--force", "Overwrite conflicts without prompting")
	.option(
		"--conflict-resolution <strategy>",
		"Conflict resolution strategy for CI: abort, overwrite, skip, prompt",
		(value: string) => {
			const valid = ["abort", "overwrite", "skip", "prompt"];
			if (!valid.includes(value)) {
				throw new Error(`Invalid conflict resolution strategy: ${value}. Valid options: ${valid.join(", ")}`);
			}
			return value;
		},
	)
	.option("--json", "Output as JSON")
	.option("--dry-run", "Show what would be done without making changes")
	.action(withErrorHandling(installPlugin));

program
	.command("uninstall <name>")
	.alias("rm")
	.description("Remove plugin and its symlinks")
	.option("-g, --global", "Uninstall from ~/.pi")
	.option("-l, --local", "Uninstall from project-local .pi/")
	.option("--dry-run", "Show what would be deleted without making changes")
	.option("--json", "Output as JSON")
	.action(withErrorHandling(uninstallPlugin));

program
	.command("update [name]")
	.alias("up")
	.description("Update to latest within semver range")
	.option("-g, --global", "Update global plugins")
	.option("-l, --local", "Update project-local plugins")
	.option("--dry-run", "Show what would be updated without making changes")
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
	.action(
		withErrorHandling((query, options) => searchPlugins(query, { ...options, limit: parseInt(options.limit, 10) })),
	);

program
	.command("info <package>")
	.description("Show plugin details before install")
	.option("--json", "Output as JSON")
	.option("--versions", "Show available versions")
	.option("--all-versions", "Show all published versions")
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
	.command("features <name>")
	.description("List or configure plugin features")
	.addHelpText(
		"after",
		`
Examples:
  $ omp features @oh-my-pi/exa                     # List available features
  $ omp features @oh-my-pi/exa --enable websets    # Enable a feature
  $ omp features @oh-my-pi/exa --disable search    # Disable a feature
  $ omp features @oh-my-pi/exa --set search,websets # Set exact features
  $ omp features @oh-my-pi/exa --set '*'           # Enable all features
  $ omp features @oh-my-pi/exa --set ''            # Disable all optional features
`,
	)
	.option("-g, --global", "Target global plugins")
	.option("-l, --local", "Target project-local plugins")
	.option("--enable <features...>", "Enable specific features")
	.option("--disable <features...>", "Disable specific features")
	.option("--set <features>", "Set exact feature list (comma-separated, '*' for all, '' for none)")
	.option("--json", "Output as JSON")
	.action(withErrorHandling(featuresCommand));

program
	.command("config:validate")
	.description("Validate all required config variables are set with correct types")
	.addHelpText(
		"after",
		`
Examples:
  $ omp config:validate           # Validate all enabled plugins
  $ omp config:validate --global  # Validate global plugins only
  $ omp config:validate --json    # JSON output for CI

Validates that:
  - All required variables for enabled features are set
  - Variable types match expected types (string, number, boolean, string[])

Returns exit code 1 if validation fails.
`,
	)
	.option("-g, --global", "Target global plugins")
	.option("-l, --local", "Target project-local plugins")
	.option("--json", "Output as JSON")
	.action(withErrorHandling(validateConfig));

program
	.command("config <name> [key] [value]")
	.description("Get or set plugin configuration variables")
	.addHelpText(
		"after",
		`
Examples:
  $ omp config @oh-my-pi/exa                 # List all variables
  $ omp config @oh-my-pi/exa apiKey          # Get value of apiKey
  $ omp config @oh-my-pi/exa apiKey sk-xxx   # Set apiKey to sk-xxx
  $ omp config @oh-my-pi/exa apiKey --delete # Reset apiKey to default

See also:
  $ omp config:validate                      # Validate all config
`,
	)
	.option("-g, --global", "Target global plugins")
	.option("-l, --local", "Target project-local plugins")
	.option("--delete", "Delete/reset the variable to its default")
	.option("--json", "Output as JSON")
	.action(withErrorHandling(configCommand));

program
	.command("env")
	.description("Print plugin environment variables for shell eval")
	.addHelpText(
		"after",
		`
Examples:
  $ eval "$(omp env)"              # Load env vars in current shell
  $ omp env >> ~/.bashrc           # Persist to shell config
  $ omp env --fish | source        # Fish shell syntax
  $ omp env --json                 # JSON format for scripts
`,
	)
	.option("-g, --global", "Target global plugins")
	.option("-l, --local", "Target project-local plugins")
	.option("--fish", "Output fish shell syntax instead of POSIX")
	.option("--json", "Output as JSON")
	.action(withErrorHandling(envCommand));

program.parse();
