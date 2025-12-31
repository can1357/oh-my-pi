#!/usr/bin/env bun
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const args = process.argv.slice(2);
const pushFlag = args.includes("--push");
const version = args.find((arg) => !arg.startsWith("--"));

if (!version) {
	console.error("Usage: bun version:bump <version> [--push]");
	console.error("Example: bun version:bump 1.0.0");
	console.error("         bun version:bump 1.0.0 --push");
	process.exit(1);
}

console.log(`📦 Bumping all packages to v${version}...`);

// Update root package.json
console.log("  Updating package.json...");
const rootPkg = JSON.parse(readFileSync("package.json", "utf-8"));
rootPkg.version = version;
writeFileSync("package.json", JSON.stringify(rootPkg, null, "\t") + "\n");

// Update all plugin package.json files
const pluginsDir = "plugins";
for (const plugin of readdirSync(pluginsDir)) {
	const pluginDir = join(pluginsDir, plugin);
	const pkgPath = join(pluginDir, "package.json");

	if (statSync(pluginDir).isDirectory()) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
			pkg.version = version;
			writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
			console.log(`  Updating ${pkgPath}...`);
		} catch {
			// No package.json in this plugin dir
		}
	}
}

// Update version in CLI
console.log("  Updating src/cli.ts version...");
const cliPath = "src/cli.ts";
const cliContent = readFileSync(cliPath, "utf-8");
const updatedCli = cliContent.replace(/\.version\("[^"]*"\)/, `.version("${version}")`);
writeFileSync(cliPath, updatedCli);

console.log("");
console.log(`✅ All packages bumped to v${version}`);

if (pushFlag) {
	console.log("");
	console.log("🚀 Committing and pushing...");
	await $`git add -A`;
	await $`git commit -m ${"chore: bump version to " + version}`;
	await $`git tag v${version}`;
	await $`git push`;
	await $`git push --tags`;
	console.log("");
	console.log(`✅ Pushed v${version}`);
} else {
	console.log("");
	console.log("Next steps:");
	console.log(`  1. git add -A && git commit -m 'chore: bump version to ${version}'`);
	console.log(`  2. git tag v${version}`);
	console.log("  3. git push && git push --tags");
	console.log("");
	console.log("Or run with --push to do this automatically.");
}
