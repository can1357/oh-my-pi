import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";

export interface CreateOptions {
	description?: string;
	author?: string;
}

/**
 * Scaffold a new plugin from template
 */
export async function createPlugin(name: string, options: CreateOptions = {}): Promise<void> {
	// Ensure name follows conventions
	const pluginName = name.startsWith("omp-") ? name : `omp-${name}`;
	const pluginDir = pluginName;

	if (existsSync(pluginDir)) {
		console.log(chalk.red(`Error: Directory ${pluginDir} already exists`));
		process.exitCode = 1;
		return;
	}

	console.log(chalk.blue(`Creating plugin: ${pluginName}...`));

	try {
		// Create directory structure
		await mkdir(pluginDir, { recursive: true });
		await mkdir(join(pluginDir, "agents"), { recursive: true });
		await mkdir(join(pluginDir, "tools"), { recursive: true });
		await mkdir(join(pluginDir, "themes"), { recursive: true });
		await mkdir(join(pluginDir, "commands"), { recursive: true });

		// Create package.json
		const packageJson = {
			name: pluginName,
			version: "0.1.0",
			description: options.description || `A pi plugin`,
			keywords: ["omp-plugin"],
			author: options.author || "",
			license: "MIT",
			omp: {
				install: [],
			},
			files: ["agents", "tools", "themes", "commands"],
		};

		await writeFile(join(pluginDir, "package.json"), JSON.stringify(packageJson, null, 2));

		// Create README.md
		const readme = `# ${pluginName}

${options.description || "A pi plugin."}

## Installation

\`\`\`bash
omp install ${pluginName}
\`\`\`

## Contents

### Agents

Add agent markdown files to \`agents/\` directory.

### Tools

Add tool implementations to \`tools/\` directory.

### Themes

Add theme JSON files to \`themes/\` directory.

### Commands

Add command markdown files to \`commands/\` directory.

## Configuration

Edit \`package.json\` to configure which files are installed:

\`\`\`json
{
  "omp": {
    "install": [
      { "src": "agents/my-agent.md", "dest": "agent/agents/my-agent.md" },
      { "src": "tools/my-tool/", "dest": "agent/tools/my-tool/" }
    ]
  }
}
\`\`\`

## Publishing

1. Update version in package.json
2. Run \`npm publish\`

Users can then install with: \`omp install ${pluginName}\`

## License

MIT
`;

		await writeFile(join(pluginDir, "README.md"), readme);

		// Create example agent
		const exampleAgent = `# Example Agent

This is an example agent for ${pluginName}.

## Description

Describe what this agent does.

## Instructions

Provide instructions for the agent here.
`;

		await writeFile(join(pluginDir, "agents", "example.md"), exampleAgent);

		// Create .gitignore
		const gitignore = `node_modules/
.DS_Store
*.log
`;
		await writeFile(join(pluginDir, ".gitignore"), gitignore);

		console.log(chalk.green(`\n✓ Created plugin at ${pluginDir}/`));
		console.log();
		console.log(chalk.dim("Directory structure:"));
		console.log(chalk.dim(`  ${pluginDir}/`));
		console.log(chalk.dim("  ├── package.json"));
		console.log(chalk.dim("  ├── README.md"));
		console.log(chalk.dim("  ├── .gitignore"));
		console.log(chalk.dim("  ├── agents/"));
		console.log(chalk.dim("  │   └── example.md"));
		console.log(chalk.dim("  ├── tools/"));
		console.log(chalk.dim("  ├── themes/"));
		console.log(chalk.dim("  └── commands/"));
		console.log();
		console.log(chalk.dim("Next steps:"));
		console.log(chalk.dim(`  1. cd ${pluginDir}`));
		console.log(chalk.dim("  2. Add your agents, tools, themes, or commands"));
		console.log(chalk.dim("  3. Update omp.install in package.json"));
		console.log(chalk.dim("  4. Test locally: omp link ."));
		console.log(chalk.dim("  5. Publish: npm publish"));
	} catch (err) {
		console.log(chalk.red(`Error creating plugin: ${(err as Error).message}`));
		process.exitCode = 1;
	}
}
