import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";

export interface CreateOptions {
	description?: string;
	author?: string;
}

const VALID_NPM_CHARS = new Set("abcdefghijklmnopqrstuvwxyz0123456789-_.");

/**
 * Parse a scoped package name into its components.
 * Returns { scope, name } where scope includes the @ prefix, or { scope: null, name } for unscoped.
 */
function parseScopedName(fullName: string): { scope: string | null; name: string } {
	if (fullName.startsWith("@")) {
		const slashIndex = fullName.indexOf("/");
		if (slashIndex > 1) {
			return {
				scope: fullName.slice(0, slashIndex),
				name: fullName.slice(slashIndex + 1),
			};
		}
	}
	return { scope: null, name: fullName };
}

/**
 * Validate that a name conforms to npm naming rules.
 * Supports both scoped (@scope/name) and unscoped names.
 */
function isValidNpmName(name: string): boolean {
	if (!name || name.length === 0) return false;

	const { scope, name: packageName } = parseScopedName(name);

	// Validate scope if present
	if (scope !== null) {
		const scopeName = scope.slice(1); // Remove @
		if (!scopeName || scopeName.length === 0) return false;
		for (const char of scopeName) {
			if (!VALID_NPM_CHARS.has(char)) return false;
		}
	}

	// Validate package name
	if (!packageName || packageName.length === 0) return false;
	if (packageName.startsWith(".") || packageName.startsWith("_")) return false;
	if (packageName.includes(" ")) return false;
	for (const char of packageName) {
		if (!VALID_NPM_CHARS.has(char)) return false;
	}
	return true;
}

/**
 * Normalize a string to be a valid npm package name component (not including scope).
 */
function normalizeNameComponent(name: string): string {
	let normalized = name.toLowerCase().split(" ").join("-");

	// Remove invalid characters (keep alphanumeric, -, _, .)
	normalized = Array.from(normalized)
		.filter((char) => VALID_NPM_CHARS.has(char))
		.join("");

	// Can't start with . or _ or -
	while (normalized.startsWith(".") || normalized.startsWith("_") || normalized.startsWith("-")) {
		normalized = normalized.slice(1);
	}

	return normalized;
}

/**
 * Normalize a plugin name, preserving scope for scoped packages.
 * Returns the normalized name with omp- prefix applied to the package name portion.
 */
function normalizePluginName(name: string): string {
	const { scope, name: packageName } = parseScopedName(name);
	const normalizedName = normalizeNameComponent(packageName);

	if (scope !== null) {
		// For scoped packages, normalize the scope too
		const normalizedScope = normalizeNameComponent(scope.slice(1));
		if (!normalizedScope) return normalizedName;
		return `@${normalizedScope}/${normalizedName}`;
	}

	return normalizedName;
}

/**
 * Apply omp- prefix to a package name, handling scoped packages correctly.
 * For unscoped: name -> omp-name
 * For scoped: @scope/name -> @scope/omp-name
 */
function applyOmpPrefix(name: string): string {
	const { scope, name: packageName } = parseScopedName(name);

	// Check if package name already has omp- prefix
	const prefixedName = packageName.startsWith("omp-") ? packageName : `omp-${packageName}`;

	if (scope !== null) {
		return `${scope}/${prefixedName}`;
	}
	return prefixedName;
}

/**
 * Get the directory name for a plugin (strips scope for scoped packages).
 */
function getPluginDirectory(pluginName: string): string {
	const { scope, name: packageName } = parseScopedName(pluginName);
	if (scope !== null) {
		// For scoped packages, use scope-name as directory (e.g., @foo/omp-bar -> foo-omp-bar)
		return `${scope.slice(1)}-${packageName}`;
	}
	return packageName;
}

/**
 * Scaffold a new plugin from template
 */
export async function createPlugin(name: string, options: CreateOptions = {}): Promise<void> {
	// Apply omp- prefix correctly (handles scoped names)
	let pluginName = applyOmpPrefix(name);

	// Validate and normalize the plugin name
	if (!isValidNpmName(pluginName)) {
		const normalized = normalizePluginName(pluginName);
		const { name: normalizedPackageName } = parseScopedName(normalized);
		if (!normalizedPackageName || normalizedPackageName === "omp-" || normalizedPackageName === "omp") {
			console.log(chalk.red(`Error: Invalid plugin name "${name}" cannot be normalized to a valid npm name`));
			process.exitCode = 1;
			return;
		}
		// Ensure omp- prefix after normalization
		const finalName = applyOmpPrefix(normalized);
		console.log(chalk.yellow(`Invalid plugin name. Normalized to: ${finalName}`));
		pluginName = finalName;
	}
	const pluginDir = getPluginDirectory(pluginName);

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
			type: "module",
			omp: {
				install: [],
				// Uncomment to add tools:
				// tools: "tools",
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

Add tool implementations to \`tools/\` directory. Set \`"tools": "tools"\` in package.json omp field to enable.

### Themes

Add theme JSON files to \`themes/\` directory.

### Commands

Add command markdown files to \`commands/\` directory.

## Configuration

Edit \`package.json\` to configure your plugin:

\`\`\`json
{
  "omp": {
    "install": [
      { "src": "agents/my-agent.md", "dest": "agent/agents/my-agent.md" }
    ],
    "tools": "tools"
  }
}
\`\`\`

- \`install\`: Symlinks files (agents, commands, themes) into ~/.pi/agent/
- \`tools\`: Points to tool factory directory (loaded from node_modules)

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

		// Create example tool
		const exampleTool = `import type { CustomToolFactory } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const factory: CustomToolFactory = (pi) => {
  return {
    name: "example_tool",
    label: "Example Tool",
    description: "An example tool for ${pluginName}",
    parameters: Type.Object({
      message: Type.String({ description: "A message to echo" }),
    }),
    async execute({ message }) {
      return {
        content: [{ type: "text", text: \`Echo: \${message}\` }],
      };
    },
  };
};

export default factory;
`;
		await writeFile(join(pluginDir, "tools", "index.ts"), exampleTool);

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
		console.log(chalk.dim("  │   └── index.ts"));
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
		// Clean up partially created directory
		try {
			await rm(pluginDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		console.log(chalk.red(`Error creating plugin: ${(err as Error).message}`));
		process.exitCode = 1;
	}
}
