#!/usr/bin/env bun
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const dryRun = process.argv.includes("--dry-run");
const dryRunFlag = dryRun ? "--dry-run" : "";

if (dryRun) {
	console.log("🔍 Dry run mode - no packages will be published");
}

console.log("📦 Publishing @oh-my-pi packages...");
console.log("");

// Build first
console.log("🔨 Building CLI...");
await $`bun run build`;

// Publish CLI
console.log("");
console.log("📤 Publishing @oh-my-pi/cli...");
await $`npm publish --access public ${dryRunFlag}`.nothrow();

// Publish plugins
const pluginsDir = "plugins";
for (const plugin of readdirSync(pluginsDir)) {
	const pluginDir = join(pluginsDir, plugin);
	const pkgPath = join(pluginDir, "package.json");

	if (statSync(pluginDir).isDirectory() && existsSync(pkgPath)) {
		console.log("");
		console.log(`📤 Publishing @oh-my-pi/${plugin}...`);
		await $`npm publish --access public ${dryRunFlag}`.cwd(pluginDir).nothrow();
	}
}

console.log("");
console.log("✅ All packages published!");
