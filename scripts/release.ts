#!/usr/bin/env bun
/**
 * Release script for pi-mono
 *
 * Usage: bun scripts/release.ts <version>
 *
 * Example: bun scripts/release.ts 3.10.0
 *
 * Steps:
 * 1. Pre-flight checks (clean working dir, on main branch)
 * 2. Update package.json versions
 * 3. Regenerate lockfile
 * 4. Update CHANGELOGs ([Unreleased] -> [version] - date, add new [Unreleased])
 * 5. Commit and tag
 * 6. Push
 * 7. Watch CI
 */

import type { Subprocess } from "bun";
import { Glob } from "bun";

const VERSION = process.argv[2];

if (!VERSION || !/^\d+\.\d+\.\d+/.test(VERSION)) {
	console.error("Usage: bun scripts/release.ts <version>");
	console.error("Example: bun scripts/release.ts 3.10.0");
	process.exit(1);
}

interface RunOptions {
	silent?: boolean;
	capture?: boolean;
	ignoreError?: boolean;
}

function run(cmd: string[], options: RunOptions = {}): string {
	const cmdStr = cmd.join(" ");
	if (!options.silent) console.log(`$ ${cmdStr}`);

	const result = Bun.spawnSync(cmd, {
		stdout: options.capture ? "pipe" : "inherit",
		stderr: "inherit",
	});

	if (result.exitCode !== 0 && !options.ignoreError) {
		console.error(`Command failed: ${cmdStr}`);
		process.exit(1);
	}

	return result.stdout?.toString().trim() ?? "";
}

async function getChangelogs(): Promise<string[]> {
	const glob = new Glob("packages/*/CHANGELOG.md");
	const paths: string[] = [];
	for await (const path of glob.scan(".")) {
		paths.push(path);
	}
	return paths;
}

async function getPackageJsonPaths(): Promise<string[]> {
	const glob = new Glob("packages/*/package.json");
	const paths: string[] = [];
	for await (const path of glob.scan(".")) {
		paths.push(path);
	}
	return paths;
}

async function updateChangelogsForRelease(version: string): Promise<void> {
	const date = new Date().toISOString().split("T")[0];
	const changelogs = await getChangelogs();

	for (const changelog of changelogs) {
		let content = await Bun.file(changelog).text();

		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		// Replace [Unreleased] with version and date
		content = content.replace("## [Unreleased]", `## [${version}] - ${date}`);

		// Add new [Unreleased] section after # Changelog header
		content = content.replace(/^(# Changelog\n\n)/, `$1## [Unreleased]\n\n`);

		await Bun.write(changelog, content);
		console.log(`  Updated ${changelog}`);
	}
}

// === Main Flow ===

console.log("\n=== Release Script ===\n");

// 1. Pre-flight checks
console.log("Pre-flight checks...");

const branch = run(["git", "branch", "--show-current"], { capture: true, silent: true });
if (branch !== "main") {
	console.error(`Error: Must be on main branch (currently on '${branch}')`);
	process.exit(1);
}
console.log("  On main branch");

const status = run(["git", "status", "--porcelain"], { capture: true, silent: true });
if (status) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

// 2. Update package versions
console.log(`Updating package versions to ${VERSION}...`);
const pkgJsonPaths = await getPackageJsonPaths();
run(["sd", '"version": "[^"]+"', `"version": "${VERSION}"`, ...pkgJsonPaths]);

// Verify
console.log("  Verifying versions:");
for (const pkgPath of pkgJsonPaths) {
	const pkgJson = await Bun.file(pkgPath).json();
	console.log(`    ${pkgJson.name}: ${pkgJson.version}`);
}
console.log();

// 3. Regenerate lockfile
console.log("Regenerating lockfile...");
run(["rm", "-f", "bun.lock"]);
run(["bun", "install"]);
console.log();

// 4. Update changelogs
console.log("Updating CHANGELOGs...");
await updateChangelogsForRelease(VERSION);
console.log();

// 5. Commit and tag
console.log("Committing and tagging...");
run(["git", "add", "."]);
run(["git", "commit", "-m", `chore: bump version to ${VERSION}`]);
run(["git", "tag", `v${VERSION}`]);
console.log();

// 6. Push
console.log("Pushing to remote...");
run(["git", "push", "origin", "main"]);
run(["git", "push", "origin", `v${VERSION}`]);
console.log();

// 7. Watch CI
console.log("Watching CI...");
const runListOutput = run(["gh", "run", "list", "--limit", "1", "--json", "databaseId"], { capture: true, silent: true });
const runs = JSON.parse(runListOutput);
if (runs.length > 0) {
	const runId = runs[0].databaseId;
	console.log(`  Watching run ${runId}...`);
	run(["gh", "run", "watch", String(runId), "--exit-status"], { ignoreError: true });
}
console.log();

console.log(`=== Released v${VERSION} ===`);
console.log();
console.log("If CI failed, fix the issue and run:");
console.log("  git commit --amend --no-edit");
console.log("  git push origin main --force");
console.log(`  git tag -f v${VERSION} && git push origin v${VERSION} --force`);
console.log();
console.log("To publish to npm:");
console.log("  npm run publish");
