#!/usr/bin/env bun
/**
 * Release script for pi-mono
 *
 * Usage:
 *   bun scripts/release.ts <version|major|minor|patch|canary> [--skip-ci-check]
 *                                                        Full release (preflight incl. CI-green check, version,
 *                                                        changelog, commit, push, watch)
 *   bun scripts/release.ts watch                         Watch CI for current commit
 *   bun scripts/release.ts deps                          Full third-party dependency refresh (bun.lock + Cargo.lock);
 *                                                        land it via PR/main CI before the next release
 *
 * Example: bun scripts/release.ts minor
 */
import { $, Glob } from "bun";
import { compareVersions } from "../packages/utils/src/version.ts";
import { runChangelogFixer } from "./fix-changelogs";
import { generateNixBunDeps, resolveNixBunDepsGenerator } from "./gen-nix-bun";

const changelogGlob = new Glob("packages/*/CHANGELOG.md");
const packageJsonGlob = new Glob("packages/*/package.json");
const cargoTomlGlob = new Glob("crates/*/Cargo.toml");
/**
 * Strict explicit-version guard: three numeric dot-segments with an optional
 * leading `v` and NO prerelease suffix. Prereleases are rejected because the
 * downstream publish (`scripts/ci-release-publish.ts`) runs `npm publish` with
 * no `--tag`, which would promote a prerelease to the npm `latest` dist-tag —
 * hitting every unqualified install and the `/latest` endpoint `omp update`
 * reads. Bump keywords (major/minor/patch) are handled separately and must not
 * be routed through this check.
 *
 * Returns the normalized bare version (leading `v` stripped) when accepted, or
 * `null` when rejected. Callers must use the returned value for all writes so
 * no downstream manifest (package.json, Cargo.toml, tag) ever sees a `v`
 * prefix — Cargo rejects `version = "v17.2.8"`.
 */
export function validateExplicitVersion(version: string): string | null {
	const match = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(version);
	return match ? match[1] : null;
}

function git(args: readonly string[]) {
	return $`git -c core.fsmonitor=false -c core.untrackedCache=false -c fetch.pruneTags=false ${args}`;
}

// =============================================================================
// CI-green preflight
// =============================================================================

export interface CIRun {
	databaseId: number;
	status: string;
	conclusion: string | null;
	event?: string;
}

export interface CommitRuns {
	sha: string;
	runs: readonly CIRun[];
}

export type CIGateDecision =
	| { kind: "pass"; sha: string; runId: number; ancestor: boolean }
	| { kind: "fail"; sha: string; runId: number; conclusion: string; ancestor: boolean }
	| { kind: "wait"; sha: string; runId: number; ancestor: boolean }
	| { kind: "none" };

/**
 * Decide the CI gate from HEAD's first-parent chain (index 0 = HEAD). The
 * first commit that has any CI run is authoritative; its latest run (highest
 * databaseId) must have completed with `success`. Commits without runs (e.g.
 * path-filtered pushes) fall through to their first-parent ancestor.
 */
export function decideCIGate(chain: readonly CommitRuns[]): CIGateDecision {
	for (let i = 0; i < chain.length; i++) {
		const { sha, runs } = chain[i];
		if (runs.length === 0) continue;
		const latest = runs.reduce((a, b) => (b.databaseId > a.databaseId ? b : a));
		const ancestor = i > 0;
		if (latest.status !== "completed") return { kind: "wait", sha, runId: latest.databaseId, ancestor };
		if (latest.conclusion === "success") return { kind: "pass", sha, runId: latest.databaseId, ancestor };
		return { kind: "fail", sha, runId: latest.databaseId, conclusion: latest.conclusion ?? "unknown", ancestor };
	}
	return { kind: "none" };
}

const CI_ANCESTOR_LIMIT = 30;

async function listCIRuns(sha: string): Promise<CIRun[]> {
	const out = await $`gh run list --commit ${sha} --workflow CI --json databaseId,status,conclusion,event`.text();
	return JSON.parse(out) as CIRun[];
}

/** Poll a run until it completes; fail fast on the first failed job. */
async function waitForRun(runId: number): Promise<boolean> {
	while (true) {
		const out = await $`gh run view ${runId} --json status,conclusion,jobs`.quiet().text();
		const run = JSON.parse(out) as {
			status: string;
			conclusion: string | null;
			jobs: Array<{ name: string; databaseId: number; status: string; conclusion: string | null }>;
		};
		const failedJob = run.jobs.find(
			j => j.status === "completed" && j.conclusion !== "success" && j.conclusion !== "skipped",
		);
		if (failedJob) {
			console.error(`  CI job failed: ${failedJob.name} (job ${failedJob.databaseId}): ${failedJob.conclusion}`);
			return false;
		}
		if (run.status === "completed") return run.conclusion === "success";
		const done = run.jobs.filter(j => j.status === "completed").length;
		console.log(`  Waiting for CI run ${runId}... (${done}/${run.jobs.length} jobs done)`);
		await Bun.sleep(10000);
	}
}

async function checkCIGreen(): Promise<void> {
	await git(["fetch", "origin", "main"]).quiet();
	const head = (await git(["rev-parse", "HEAD"]).text()).trim();
	const remote = (await git(["rev-parse", "origin/main"]).text()).trim();
	if (head !== remote) {
		console.error(`Error: HEAD (${head.slice(0, 8)}) != origin/main (${remote.slice(0, 8)}). Pull/push first.`);
		process.exit(1);
	}
	console.log("  HEAD matches origin/main");

	const shas = (await git(["rev-list", "--first-parent", "-n", String(CI_ANCESTOR_LIMIT), "HEAD"]).text())
		.trim()
		.split("\n")
		.filter(Boolean);
	const chain: CommitRuns[] = [];
	let decision: CIGateDecision = { kind: "none" };
	for (const sha of shas) {
		chain.push({ sha, runs: await listCIRuns(sha) });
		decision = decideCIGate(chain);
		if (decision.kind !== "none") break;
	}

	if (decision.kind === "none") {
		console.error(`Error: No CI run found on HEAD or its last ${CI_ANCESTOR_LIMIT} first-parent ancestors.`);
		process.exit(1);
	}
	const label = decision.ancestor
		? `ancestor ${decision.sha.slice(0, 8)} (HEAD ${head.slice(0, 8)} has no CI run)`
		: `HEAD ${decision.sha.slice(0, 8)}`;
	if (decision.kind === "wait") {
		console.log(`  CI run ${decision.runId} for ${label} in progress; waiting...`);
		if (!(await waitForRun(decision.runId))) {
			console.error(`Error: CI run ${decision.runId} for ${label} failed. Fix main before releasing.`);
			process.exit(1);
		}
	} else if (decision.kind === "fail") {
		console.error(`Error: CI run ${decision.runId} for ${label} concluded '${decision.conclusion}'.`);
		console.error("  Fix main (or re-run CI) before releasing, or pass --skip-ci-check to override.");
		process.exit(1);
	}
	console.log(`  CI green for ${label} (run ${decision.runId})`);
}

// =============================================================================
// Shared functions
// =============================================================================

async function watchCI(): Promise<boolean> {
	const commitSha = (await git(["rev-parse", "HEAD"]).text()).trim();
	console.log(`  Commit: ${commitSha.slice(0, 8)}`);

	while (true) {
		const runsOutput = await $`gh run list --commit ${commitSha} --json databaseId,status,conclusion,name`.text();
		const runs: Array<{ databaseId: number; status: string; conclusion: string | null; name: string }> =
			JSON.parse(runsOutput);

		if (runs.length === 0) {
			console.log("  Waiting for CI to start...");
			await Bun.sleep(3000);
			continue;
		}

		// Check job-level status for in-progress runs (fail fast on first job failure)
		const failedJobs: Array<{ workflow: string; job: string; jobId: number; conclusion: string }> = [];
		const inProgressRuns = runs.filter(r => r.status === "in_progress" || r.status === "queued");

		for (const run of inProgressRuns) {
			const jobsOutput = await $`gh run view ${run.databaseId} --json jobs`.quiet().nothrow().text();
			try {
				const { jobs } = JSON.parse(jobsOutput) as {
					jobs: Array<{ name: string; databaseId: number; status: string; conclusion: string | null }>;
				};
				for (const job of jobs) {
					if (job.status === "completed" && job.conclusion !== "success" && job.conclusion !== "skipped") {
						failedJobs.push({
							workflow: run.name,
							job: job.name,
							jobId: job.databaseId,
							conclusion: job.conclusion ?? "unknown",
						});
					}
				}
			} catch {
				// Ignore parse errors
			}
		}

		if (failedJobs.length > 0) {
			console.error("\nCI job failed:");
			for (const f of failedJobs) {
				console.error(`  - ${f.workflow} / ${f.job} (job ${f.jobId}): ${f.conclusion}`);
				// Tail the failed job's log
				const log = await $`gh run view --job ${f.jobId} --log-failed`.quiet().nothrow().text();
				if (log.trim()) {
					const lines = log.trimEnd().split("\n");
					const tail = lines.slice(-20).join("\n");
					console.error(`\n--- Last 20 lines of ${f.job} ---\n${tail}\n`);
				}
			}
			return false;
		}

		// Check workflow-level status
		const pending = runs.filter(r => r.status !== "completed");
		const failed = runs.filter(r => r.status === "completed" && r.conclusion !== "success");
		const passed = runs.filter(r => r.status === "completed" && r.conclusion === "success");

		console.log(`  ${passed.length} passed, ${pending.length} pending, ${failed.length} failed`);

		if (failed.length > 0) {
			console.error("\nCI failed:");
			for (const r of failed) {
				console.error(`  - ${r.name}: ${r.conclusion}`);
				// Fetch failed jobs and tail their logs
				const jobsOutput = await $`gh run view ${r.databaseId} --json jobs`.quiet().nothrow().text();
				try {
					const { jobs } = JSON.parse(jobsOutput) as {
						jobs: Array<{ name: string; databaseId: number; status: string; conclusion: string | null }>;
					};
					for (const job of jobs) {
						if (job.conclusion !== "success" && job.conclusion !== "skipped") {
							const log = await $`gh run view --job ${job.databaseId} --log-failed`.quiet().nothrow().text();
							if (log.trim()) {
								const lines = log.trimEnd().split("\n");
								const tail = lines.slice(-20).join("\n");
								console.error(`\n--- Last 20 lines of ${job.name} (job ${job.databaseId}) ---\n${tail}\n`);
							}
						}
					}
				} catch {
					// Ignore parse errors
				}
			}
			return false;
		}

		if (pending.length === 0) {
			console.log("  All CI checks passed!\n");
			return true;
		}

		await Bun.sleep(5000);
	}
}

function hasUnreleasedContent(content: string): boolean {
	const unreleasedMatch = content.match(/## \[Unreleased\]\s*\n([\s\S]*?)(?=## \[\d|$)/);
	if (!unreleasedMatch) return false;
	const sectionContent = unreleasedMatch[1].trim();
	return sectionContent.length > 0;
}

function removeEmptyVersionEntries(content: string): string {
	// Remove version entries that have no content (just whitespace until next ## [ or EOF)
	return content.replace(/## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}\s*\n(?=## \[|\s*$)/g, "");
}

async function updateChangelogsForRelease(version: string): Promise<void> {
	const date = new Date().toISOString().split("T")[0];

	for await (const changelog of changelogGlob.scan(".")) {
		let content = await Bun.file(changelog).text();

		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		// Only create version entry if [Unreleased] has content
		if (hasUnreleasedContent(content)) {
			content = content.replace("## [Unreleased]", `## [${version}] - ${date}`);
			content = content.replace(/^(# Changelog\n\n)/, `$1## [Unreleased]\n\n`);
		}

		// Clean up any existing empty version entries
		content = removeEmptyVersionEntries(content);

		await Bun.write(changelog, content);
		console.log(`  Updated ${changelog}`);
	}
}

// =============================================================================
// Subcommands
// =============================================================================

async function cmdWatch(): Promise<void> {
	console.log("\n=== Watching CI ===\n");
	const success = await watchCI();
	process.exit(success ? 0 : 1);
}

export function parseVersion(v: string): [number, number, number] {
	const match = v.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-canary\.\d+)?$/);
	if (!match) throw new Error(`Invalid version: ${v}`);
	return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

export function bumpVersion(current: string, bump: "major" | "minor" | "patch"): string {
	const [major, minor, patch] = parseVersion(current);
	if (bump === "patch" && /-canary\.\d+$/.test(current)) {
		return `${major}.${minor}.${patch}`;
	}
	switch (bump) {
		case "major":
			return `${major + 1}.0.0`;
		case "minor":
			return `${major}.${minor + 1}.0`;
		case "patch":
			return `${major}.${minor}.${patch + 1}`;
	}
}

export function bumpCanaryVersion(current: string): string {
	const [major, minor, patch] = parseVersion(current);
	const canaryMatch = current.match(/-canary\.(\d+)$/);
	if (canaryMatch) {
		return `${major}.${minor}.${patch}-canary.${parseInt(canaryMatch[1], 10) + 1}`;
	}
	return `${major}.${minor}.${patch + 1}-canary.1`;
}

async function cmdDeps(): Promise<void> {
	console.log("\n=== Full dependency refresh ===\n");
	await $`rm -f bun.lock`;
	await $`bun install`;
	await $`cargo generate-lockfile`;
	await generateNixBunDeps(resolveNixBunDepsGenerator());
	await $`bun scripts/gen-clippy-bazelrc.ts`;
	// Cargo.lock changed, so the crate_universe entry in MODULE.bazel.lock is
	// stale; without a refresh every fresh CI bazel server re-splices (~4 min).
	await $`bun scripts/gen-bazel-lock.ts`;
	console.log("\nDependencies refreshed. Land these lockfile changes through a PR (or push to main) and");
	console.log("let CI go green BEFORE the next release; `release` no longer refreshes third-party deps.");
}

async function cmdRelease(versionOrBump: string, skipCICheck = false): Promise<void> {
	console.log("\n=== Release Script ===\n");
	// Validate explicit versions before any compare: the shared compareVersions
	// never throws, so without this guard garbage like "999.bad" would be
	// accepted and written into every package.json / Cargo.toml / tag. The
	// validator also normalizes a leading `v` to the bare version so every
	// downstream write (manifests, Cargo.toml, tag) uses `17.2.8`, not `v17.2.8`.
	if (
		versionOrBump !== "major" &&
		versionOrBump !== "minor" &&
		versionOrBump !== "patch" &&
		versionOrBump !== "canary"
	) {
		const normalized = validateExplicitVersion(versionOrBump);
		if (normalized === null) {
			console.error(
				`Error: Invalid version "${versionOrBump}". Expected a semver like 17.2.8 or v17.2.8 (prereleases such as 17.2.8-rc.1 are not supported by this release path), or a bump keyword (major/minor/patch/canary).`,
			);
			process.exit(1);
		}
		versionOrBump = normalized;
	}

	// 1. Pre-flight checks
	console.log("Pre-flight checks...");

	const branch = await git(["branch", "--show-current"]).text();
	if (branch.trim() !== "main") {
		console.error(`Error: Must be on main branch (currently on '${branch.trim()}')`);
		process.exit(1);
	}
	console.log("  On main branch");

	const status = await git(["status", "--porcelain"]).text();
	if (status.trim()) {
		console.error("Error: Uncommitted changes detected. Commit or stash first.");
		console.error(status);
		process.exit(1);
	}
	console.log("  Working directory clean");

	if (skipCICheck) {
		console.warn("\n  !!! WARNING: --skip-ci-check given: NOT verifying that CI is green on main. !!!\n");
	} else {
		await checkCIGreen();
	}

	const nixBunDepsGenerator = resolveNixBunDepsGenerator();
	console.log(`  Nix dependency generator: ${nixBunDepsGenerator.kind}`);

	// Step 4 refreshes MODULE.bazel.lock through bazel; fail before touching
	// any file rather than half-way through the version rewrite.
	const bazel = Bun.which("bazelisk") ?? Bun.which("bazel");
	if (!bazel) {
		console.error("Error: bazelisk (or bazel) not on PATH; needed to refresh MODULE.bazel.lock.");
		process.exit(1);
	}
	console.log(`  Bazel: ${bazel}`);

	const latestTag = (await git(["describe", "--tags", "--abbrev=0", "--match", "v*"]).text()).trim();
	let version = versionOrBump;
	if (version === "major" || version === "minor" || version === "patch") {
		version = bumpVersion(latestTag, version);
		console.log(`Bumping ${versionOrBump} version from ${latestTag} -> ${version}`);
	} else if (version === "canary") {
		version = bumpCanaryVersion(latestTag);
		console.log(`Bumping canary version from ${latestTag} -> ${version}`);
	}

	if (compareVersions(version, latestTag) <= 0) {
		console.error(`Error: Version ${version} must be greater than latest tag ${latestTag}`);
		process.exit(1);
	}
	console.log(`  Version ${version} > ${latestTag}\n`);

	// 2. Update package versions
	console.log(`Updating package versions to ${version}…`);
	const pkgJsonPaths = await Array.fromAsync(packageJsonGlob.scan("."));

	// Filter out private packages
	const publicPkgPaths: string[] = [];
	for (const pkgPath of pkgJsonPaths) {
		const pkgJson = await Bun.file(pkgPath).json();
		if (pkgJson.private) {
			console.log(`  Skipping ${pkgJson.name} (private)`);
			continue;
		}
		publicPkgPaths.push(pkgPath);
	}

	await $`sd '"version": "[^"]+"' ${`"version": "${version}"`} ${publicPkgPaths}`;

	// Verify
	console.log("  Verifying versions:");
	for (const pkgPath of publicPkgPaths) {
		const pkgJson = await Bun.file(pkgPath).json();
		console.log(`    ${pkgJson.name}: ${pkgJson.version}`);
	}
	console.log();

	// Update @oh-my-pi/* catalog entries in root package.json
	console.log("Updating root catalog versions...");
	let rootPkgRaw = await Bun.file("package.json").text();
	rootPkgRaw = rootPkgRaw.replace(/("@oh-my-pi\/[^"]+":\s*)"[^"]+"/g, `$1"${version}"`);
	await Bun.write("package.json", rootPkgRaw);
	console.log("  Updated root catalog @oh-my-pi/* entries");

	// 3. Update Rust workspace version
	console.log(`Updating Rust workspace version to ${version}…`);
	await $`sd '^version = "[^"]+"' ${`version = "${version}"`} Cargo.toml`;

	// Verify
	const cargoToml = await Bun.file("Cargo.toml").text();
	const versionMatch = cargoToml.match(/^\[workspace\.package\][\s\S]*?^version = "([^"]+)"/m);
	if (versionMatch) {
		console.log(`  workspace: ${versionMatch[1]}`);
	}

	// List crates using workspace version
	for await (const cargoPath of cargoTomlGlob.scan(".")) {
		const content = await Bun.file(cargoPath).text();
		if (content.includes("version.workspace = true")) {
			const nameMatch = content.match(/^name = "([^"]+)"/m);
			if (nameMatch) {
				console.log(`  ${nameMatch[1]}: ${version} (workspace)`);
			}
		}
	}
	console.log();

	// pi-natives addons carry no per-release Rust edit: every install stamps
	// `packages/natives/package.json#version` into the addon post-link
	// (scripts/stamp-native-version.ts via scripts/bazel-natives.ts), so the
	// version bump above is the only native-facing change.

	// 4. Regenerate lockfiles and generated configs
	// Only workspace member versions change here; third-party deps are refreshed
	// separately via `bun scripts/release.ts deps` so they get CI before release.
	await $`bun install`;
	await $`cargo update --workspace`;
	await generateNixBunDeps(nixBunDepsGenerator);
	// bazel/clippy.bazelrc mirrors [workspace.lints] in Cargo.toml; regenerate
	// it here (like the lockfiles) so the bazel clippy policy can never drift.
	// The release_gate CI job runs the matching `--check`.
	await $`bun scripts/gen-clippy-bazelrc.ts`;
	// MODULE.bazel.lock caches the crate_universe extension result keyed by
	// Cargo.toml/Cargo.lock hashes, which the bump just rewrote. Unrefreshed,
	// every bazel job of the release run re-splices the cargo workspace
	// (~4 min each). One local evaluation (~1-4 min) fixes all of them. The
	// bazel_lock CI job runs the matching `--check`.
	await $`bun scripts/gen-bazel-lock.ts`;
	console.log();

	// 5. Update changelogs
	if (versionOrBump === "canary") {
		console.log("Skipping CHANGELOGs for canary release.\n");
	} else {
		console.log("Updating CHANGELOGs...");
		// Omit `since` so the fixer resolves its own baseline: the `clog` tag (last
		// authoritative rewrite) when newer than `latestTag`, else `latestTag`. This
		// keeps a release run from re-promoting bullets a prior `--recover` restored.
		const fixResult = await runChangelogFixer({});
		for (const fixed of fixResult.changedFiles) {
			console.log(
				`  Fixed ${fixed.path}: ${fixed.promotedItems} promoted, ` +
					`${fixed.mergedDuplicateHeadings} duplicate heading(s) merged, ` +
					`${fixed.removedEmptyHeadings} empty heading(s) removed`,
			);
		}
		await updateChangelogsForRelease(version);
		console.log();
	}

	// 6. Run checks
	console.log("Running checks...");
	await $`bun run check`;
	console.log();

	// 7. Commit
	console.log("Committing...");
	await git(["add", "."]);
	await git(["commit", "-m", `chore: bump version to ${version}`]);
	console.log();

	// 8. Tag, then push branch + tag atomically — pushing the tag by object id.
	//
	// This repo is in the global `[maintenance] repo = …` list, so a scheduled
	// `git maintenance run` fetches origin with `fetch.pruneTags=true` (set
	// globally) and deletes any local tag not yet on the remote — i.e. the
	// brand-new release tag. The `-c fetch.pruneTags=false` on our git wrapper
	// only governs our own git calls, not the concurrent maintenance process, so
	// a local tag ref may vanish before or while the push resolves it.
	//
	// A bare push refspec (`refs/tags/v…` with no `:dst`) re-resolves the tag on
	// disk during refspec matching (git's remote.c:match_explicit); if the prune
	// lands in that window git dies with
	// "refs/tags/v… cannot be resolved to branch", and if it lands before the
	// push it dies with "src refspec … does not match any". We sidestep both by
	// pushing the HEAD commit object id straight into the remote tag ref
	// (`<sha>:refs/tags/v…`): the push has no dependency on a local tag, and the
	// commit is reachable from main so maintenance cannot prune it. The local
	// tag we still create is only for `git describe`; losing it is harmless. The
	// default Git LFS pre-push hook uploads the branch's LFS objects as part of
	// this same atomic push — no separate `git lfs push` is needed.
	console.log("Tagging and pushing to remote...");
	const tagRef = `v${version}`;
	const sha = (await git(["rev-parse", "HEAD"]).text()).trim();
	await git(["tag", "-f", tagRef]);
	await git(["push", "--atomic", "origin", "refs/heads/main:refs/heads/main", `${sha}:refs/tags/${tagRef}`]);
	console.log();

	// 9. Watch CI
	console.log("Watching CI...");
	const success = await watchCI();

	if (success) {
		console.log(`=== Released v${version} ===`);
	} else {
		// CI's `concurrency` block (.github/workflows/ci.yml) recognizes a
		// release run by its `chore: bump version to vX.Y.Z` subject (#2564),
		// so retries that keep that subject also get the per-sha, never-cancel
		// group. Reword the body, not the subject.
		console.log("\nTo retry after fixing (repeat until CI passes):");
		console.log(`  git commit -m "chore: bump version to ${version}" -m "<what was fixed>"`);
		console.log(`  git tag -f v${version}`);
		console.log(
			`  git push --atomic origin refs/heads/main:refs/heads/main "+$(git rev-parse HEAD):refs/tags/v${version}"`,
		);
		console.log("  bun scripts/release.ts watch");
		process.exit(1);
	}
}

// =============================================================================
// Main
// =============================================================================

if (import.meta.main) {
	const args = process.argv.slice(2);
	const skipCICheck = args.includes("--skip-ci-check");
	const arg = args.find(a => a !== "--skip-ci-check");
	const usage = () => {
		console.error("Usage:");
		console.error("  bun scripts/release.ts <version|major|minor|patch|canary> [--skip-ci-check]   Full release");
		console.error("  bun scripts/release.ts watch                         Watch CI for current commit");
		console.error("  bun scripts/release.ts deps                          Full third-party dependency refresh");
	};

	if (!arg) {
		usage();
		process.exit(1);
	}

	if (arg === "watch") {
		await cmdWatch();
	} else if (arg === "deps") {
		await cmdDeps();
	} else if (
		arg === "major" ||
		arg === "minor" ||
		arg === "patch" ||
		arg === "canary" ||
		validateExplicitVersion(arg) !== null
	) {
		await cmdRelease(arg, skipCICheck);
	} else {
		console.error(`Unknown command or invalid version: ${arg}`);
		usage();
		process.exit(1);
	}
}
