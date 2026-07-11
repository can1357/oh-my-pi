#!/usr/bin/env bun
import * as path from "node:path";
/**
 * One-command publisher for the fork's local Hugging Face installer channel.
 * GitHub Actions separately builds all platforms and publishes GitHub Release
 * assets. This script remains useful for populating the private Hugging Face repo
 * consumed by the install endpoint, or as a local fallback after tagging.
 *
 * Pipeline:
 *   1. Bump + changelog + commit + tag + push — delegates to `release.ts`, which
 *      waits for enabled Actions. Skipped when package.json is already at
 *      <version> and the tag exists, or when `--skip-tag` is passed.
 *   2. Build the HOST platform's binary and upload it to the private Hugging Face
 *      repo behind the install endpoint — delegates to `publish-binaries-hf.ts`.
 *      The global VERSION pointer flips ONLY when every platform's binary exists
 *      for the tag; a host builds its own platform only and darwin needs a Mac,
 *      so finish the other platforms on their hosts before installs move forward.
 *   3. (--npm) Publish the npm workspaces. Opt-in: cross-platform native packages
 *      need each platform built, so a single host can ship an incomplete native
 *      set. See docs/RELEASING-FORK.md.
 *
 * Usage:
 *   bun scripts/release-local.ts 16.1.10                       # bump/tag/push + host binary -> HF
 *   bun scripts/release-local.ts 16.1.10 --npm                 # also npm publish
 *   bun scripts/release-local.ts 16.1.10 --skip-tag            # already bumped/tagged; just publish
 *   bun scripts/release-local.ts 16.1.10 --skip-tag --targets darwin-arm64,darwin-x64   # on a Mac: fill in darwin
 *   bun scripts/release-local.ts 16.1.10 --force-build          # rebuild/re-upload binaries already present on HF
 *   bun scripts/release-local.ts 16.1.10 --dry-run
 *
 * Env: HF_TOKEN (write-scoped Hugging Face token) for step 2; npm auth (see
 * `npm whoami`) for --npm.
 */
import { $ } from "bun";

const repoRoot = path.join(import.meta.dir, "..");
const version = process.argv[2];

function hasFlag(flag: string): boolean {
	return process.argv.includes(flag);
}
function flagValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
	console.error(
		"Usage: bun scripts/release-local.ts <version> [--npm] [--skip-tag] [--skip-binaries] [--targets a,b] [--force-build] [--dry-run]",
	);
	process.exit(1);
}

const tag = `v${version}`;
const isDryRun = hasFlag("--dry-run");
const doNpm = hasFlag("--npm");
const skipTag = hasFlag("--skip-tag");
const skipBinaries = hasFlag("--skip-binaries");
const forceBuild = hasFlag("--force-build");
const targets = flagValue("--targets");

async function run(cmd: string[]): Promise<void> {
	console.log(`\n$ ${cmd.join(" ")}`);
	const proc = Bun.spawn(cmd, { cwd: repoRoot, stdout: "inherit", stderr: "inherit", env: Bun.env });
	const code = await proc.exited;
	if (code !== 0) {
		console.error(`\n\u2717 Command failed (exit ${code}): ${cmd.join(" ")}`);
		process.exit(code);
	}
}

async function packageVersion(): Promise<string> {
	const pkg = await Bun.file(path.join(repoRoot, "packages/coding-agent/package.json")).json();
	return pkg.version as string;
}

async function tagExists(): Promise<boolean> {
	const out = await $`git tag --list ${tag}`.cwd(repoRoot).nothrow().text();
	return out.trim() === tag;
}

console.log(`Local release ${tag}${isDryRun ? " (dry run)" : ""}\n`);

// 1. Bump / tag / push.
if (skipTag) {
	console.log("Step 1: bump/tag/push - skipped (--skip-tag).");
} else if ((await packageVersion()) === version && (await tagExists())) {
	console.log(`Step 1: bump/tag/push - already at ${tag} with tag present; skipping.`);
} else if (isDryRun) {
	console.log(`Step 1: would run: bun scripts/release.ts ${version}`);
} else {
	console.log("Step 1: bump/tag/push (release.ts)...");
	await run(["bun", "scripts/release.ts", version]);
}

// 2. Build host binary + upload to Hugging Face (VERSION flips only when complete).
if (skipBinaries) {
	console.log("\nStep 2: binaries - skipped (--skip-binaries).");
} else {
	console.log("\nStep 2: build host binary -> Hugging Face...");
	const cmd = ["bun", "scripts/publish-binaries-hf.ts", "--tag", tag];
	if (targets) cmd.push("--targets", targets);
	if (forceBuild) cmd.push("--force-build");
	if (isDryRun) cmd.push("--dry-run");
	await run(cmd);
}

// 3. npm publish (opt-in).
if (doNpm) {
	console.log("\nStep 3: npm publish...");
	await run(["bun", "run", isDryRun ? "publish:dry" : "publish"]);
} else {
	console.log("\nStep 3: npm publish - skipped (pass --npm to include).");
}

console.log(`\n=== Local release ${tag} ${isDryRun ? "(dry run) " : ""}done ===`);
console.log("Reminder: a host builds its own platform binary only (darwin needs a Mac).");
console.log("If the HF VERSION pointer did not flip, finish the missing platforms on their hosts, e.g.:");
console.log(`  bun scripts/release-local.ts ${version} --skip-tag --targets darwin-arm64,darwin-x64`);
