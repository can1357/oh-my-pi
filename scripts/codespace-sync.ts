#!/usr/bin/env bun
/**
 * codespace-sync — sync a Git working tree (history + branches + dirty + untracked)
 * to a remote codespace over SSH, or pull from a remote codespace back to the local
 * checkout. Idempotent. Pure git + ssh + tar, no daemon, no agent.
 *
 * Usage:
 *   bun scripts/codespace-sync.ts push  <ssh-target> [--path <remote-dir>]
 *   bun scripts/codespace-sync.ts pull  <ssh-target> [--path <remote-dir>]
 *   bun scripts/codespace-sync.ts status <ssh-target> [--path <remote-dir>]
 *   bun scripts/codespace-sync.ts handoff <ssh-target> [--path <remote-dir>] [--launch]
 *
 * <ssh-target>  user@host form, e.g. pk@100.111.69.99
 * <remote-dir>  absolute path on remote (default: ~/codespace-<repo-basename>)
 *
 * The `handoff` action uses GitHub as the transport instead of git bundle + tar.
 * It commits everything locally, force-pushes to a persistent handoff/<target>
 * branch on origin, then SSHes to the target and clones (if missing) or pulls
 * that branch. When --launch is passed, it also spawns an ompk agent session
 * on the target inside a tmux window.
 *
 * Env vars (for tests / non-default ssh ports / custom key):
 *   CODESPACE_SYNC_KEY   absolute path to ssh private key
 *   CODESPACE_SYNC_PORT  ssh port (default 22)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

type Direction = "push" | "pull" | "status" | "handoff";

interface SyncOptions {
	direction: Direction;
	sshTarget: string;
	remoteDir: string;
	launch: boolean;
}

interface PlanResult {
	ok: true;
	direction: Direction;
	sshTarget: string;
	remoteDir: string;
	localRepo: string;
	branch: string;
	dirtyFiles: number;
	untrackedFiles: number;
	stashCount: number;
	transferBytesEstimate: number;
}

interface BundleResult {
	bundlePath: string;
	stashBundlePath: string | null;
	bytes: number;
}

interface SpawnResult {
	code: number;
	stdout: string;
	stderr: string;
}

const STASH_BUNDLE_NAME = ".codespace-sync-stash.bundle";

// Folders that should never ship over the wire. Conservative — false negatives
// (extra bytes) are cheap; false positives (missing source) cost a rebuild.
const RSYNC_EXCLUDES = [
	".git",
	"node_modules",
	"target",
	"dist",
	"build",
	".next",
	".turbo",
	".cache",
	"__pycache__",
	".venv",
	"venv",
	".pytest_cache",
	".mypy_cache",
	"coverage",
	".parcel-cache",
];

function parseArgs(argv: string[]): SyncOptions {
	const args = argv.slice(2);
	if (args.length < 2) {
		throw new Error("usage: codespace-sync <push|pull|status|handoff> <ssh-target> [--path <remote-dir>] [--launch]");
	}
	const direction = args[0] as Direction;
	if (direction !== "push" && direction !== "pull" && direction !== "status" && direction !== "handoff") {
		throw new Error(`unknown direction: ${direction}`);
	}
	const sshTarget = args[1];
	let remoteDir = "";
	let launch = false;
	for (let i = 2; i < args.length; i++) {
		if (args[i] === "--path") {
			remoteDir = args[++i] ?? "";
		} else if (args[i] === "--launch") {
			launch = true;
		}
	}
	if (!remoteDir) {
		remoteDir = `~/codespace-${path.basename(process.cwd())}`;
	}
	return { direction, sshTarget, remoteDir, launch };
}

// Direct argv spawn. Use for git / ssh / scp / tar where Windows OpenSSH or
// git get confused by paths delivered through a shell.
async function direct(argv: string[], opts: { cwd?: string } = {}): Promise<SpawnResult> {
	const proc = Bun.spawn({
		cmd: argv,
		cwd: opts.cwd ?? process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	const stdout = proc.stdout ? await new Response(proc.stdout).text() : "";
	const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
	const code = await proc.exited;
	return { code, stdout, stderr };
}

// SSH argv builder. Honors CODESPACE_SYNC_KEY (Windows-style path) and
// CODESPACE_SYNC_PORT.
function sshArgv(): string[] {
	const parts = ["ssh"];
	if (process.env.CODESPACE_SYNC_KEY) {
		parts.push("-i", toWinPath(process.env.CODESPACE_SYNC_KEY));
	}
	if (process.env.CODESPACE_SYNC_PORT) parts.push("-p", process.env.CODESPACE_SYNC_PORT);
	parts.push("-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=NUL");
	return parts;
}

// cygpath -m gives a mixed form on this box; we always normalize to forward
// slashes because Windows OpenSSH ssh/scp reject backslash paths delivered
// through shell pipelines.
function toWinPath(p: string): string {
	const r = Bun.spawnSync(["cygpath", "-m", p], { stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) return p.replace(/\\/g, "/");
	const out = r.stdout ? new TextDecoder().decode(r.stdout).trim() : "";
	return (out || p).replace(/\\/g, "/");
}

async function gitCurrentBranch(cwd: string): Promise<string> {
	const r = await direct(["git", "symbolic-ref", "--short", "HEAD"], { cwd });
	if (r.code === 0) return r.stdout.trim();
	const sha = await direct(["git", "rev-parse", "--short", "HEAD"], { cwd });
	return sha.stdout.trim() || "HEAD";
}

async function countDirty(cwd: string): Promise<number> {
	const r = await direct(["git", "diff", "--name-only"], { cwd });
	return r.stdout.split("\n").filter(Boolean).length;
}

async function countUntracked(cwd: string): Promise<number> {
	const r = await direct(["git", "ls-files", "--others", "--exclude-standard"], { cwd });
	return r.stdout.split("\n").filter(Boolean).length;
}

async function countStash(cwd: string): Promise<number> {
	const r = await direct(["git", "stash", "list"], { cwd });
	return r.stdout.split("\n").filter(Boolean).length;
}

async function estimateTransferBytes(localRepo: string): Promise<number> {
	const r = await direct(["git", "ls-files"], { cwd: localRepo });
	const files = r.stdout.split("\n").filter(Boolean);
	let total = 0;
	for (const rel of files) {
		try {
			const s = await fs.stat(`${localRepo}/${rel}`);
			total += s.size;
		} catch {
			// missing file (e.g. submodule not checked out) — skip
		}
	}
	return total;
}

async function makePlan(opts: SyncOptions): Promise<PlanResult> {
	const localRepo = process.cwd();
	const branch = await gitCurrentBranch(localRepo);
	const [dirty, untracked, stashCount, bytes] = await Promise.all([
		countDirty(localRepo),
		countUntracked(localRepo),
		countStash(localRepo),
		estimateTransferBytes(localRepo),
	]);
	return {
		ok: true,
		direction: opts.direction,
		sshTarget: opts.sshTarget,
		remoteDir: opts.remoteDir,
		localRepo,
		branch,
		dirtyFiles: dirty,
		untrackedFiles: untracked,
		stashCount,
		transferBytesEstimate: bytes,
	};
}

function formatPlan(p: PlanResult): string {
	const kb = Math.round(p.transferBytesEstimate / 1024);
	return [
		`direction:    ${p.direction}`,
		`local repo:   ${p.localRepo}`,
		`remote dir:   ${p.remoteDir} (on ${p.sshTarget})`,
		`current br:   ${p.branch}`,
		`dirty files:  ${p.dirtyFiles}`,
		`untracked:    ${p.untrackedFiles}`,
		`stash count:  ${p.stashCount}`,
		`xfer est.:    ${kb} KiB working tree (excludes .git, node_modules, target, dist, …)`,
	].join("\n");
}

async function ensureRemoteDir(sshTarget: string, remoteDir: string): Promise<void> {
	const r = await direct([...sshArgv(), sshTarget, `mkdir -p ${remoteDir} && cd ${remoteDir} && pwd`]);
	if (r.code !== 0) {
		throw new Error(`cannot access ${sshTarget}:${remoteDir}\n${r.stderr}`);
	}
}

async function buildBundle(localRepo: string, destDir: string): Promise<BundleResult> {
	const bundlePath = path.join(destDir, ".codespace-sync.bundle");
	const r = await direct(["git", "bundle", "create", bundlePath, "--all"], { cwd: localRepo });
	if (r.code !== 0) throw new Error(`git bundle failed:\n${r.stderr}`);
	const stat = await fs.stat(bundlePath);

	let stashBundlePath: string | null = null;
	const stashList = await direct(["git", "stash", "list"], { cwd: localRepo });
	if (stashList.stdout.trim().length > 0) {
		stashBundlePath = path.join(destDir, STASH_BUNDLE_NAME);
		const sr = await direct(["git", "bundle", "create", stashBundlePath, "refs/stash"], { cwd: localRepo });
		if (sr.code !== 0) throw new Error(`git stash bundle failed:\n${sr.stderr}`);
	}
	return { bundlePath, stashBundlePath, bytes: stat.size };
}

// Push the working tree as a tar over ssh. Windows OpenSSH rsync on this box
// is broken (exits 53 silently); tar-over-ssh is portable and dependency-free.
async function rsyncPush(localRepo: string, sshTarget: string, remoteDir: string): Promise<void> {
	const tarArgs = ["tar", "-cf", "-", ...RSYNC_EXCLUDES.flatMap(e => ["--exclude", e]), "-C", localRepo, "."];
	const sshArgs = [...sshArgv(), sshTarget, `tar -xf - -C ${remoteDir} --no-same-owner`];
	const tar = Bun.spawn({ cmd: tarArgs, stdout: "pipe", stderr: "pipe" });
	const ssh = Bun.spawn({ cmd: sshArgs, stdin: tar.stdout, stdout: "pipe", stderr: "pipe" });
	const [tarCode, sshCode, tarErr, sshErr] = await Promise.all([
		tar.exited,
		ssh.exited,
		tar.stderr ? new Response(tar.stderr).text() : Promise.resolve(""),
		ssh.stderr ? new Response(ssh.stderr).text() : Promise.resolve(""),
	]);
	if (tarCode !== 0) throw new Error(`tar failed (exit ${tarCode}):\n${tarErr}`);
	if (sshCode !== 0) throw new Error(`remote untar failed (exit ${sshCode}):\n${sshErr}`);
}

async function scpFile(localPath: string, sshTarget: string, remoteDir: string): Promise<void> {
	const key = process.env.CODESPACE_SYNC_KEY ? toWinPath(process.env.CODESPACE_SYNC_KEY) : null;
	const port = process.env.CODESPACE_SYNC_PORT ?? "22";
	const r = await direct([
		"scp",
		...(key ? ["-i", key] : []),
		"-P",
		port,
		"-o",
		"StrictHostKeyChecking=no",
		"-o",
		"UserKnownHostsFile=NUL",
		localPath,
		`${sshTarget}:${remoteDir}/`,
	]);
	if (r.code !== 0) throw new Error(`scp ${localPath} failed:\n${r.stderr}`);
}

async function sshRun(sshTarget: string, cmd: string): Promise<SpawnResult> {
	return direct([...sshArgv(), sshTarget, cmd]);
}

// On the remote, init a fresh git repo from the bundle we scp'd, then check
// out the branch. Use single ssh calls per step because BusyBox sh on slim
// images misbehaves with `&&` chains.
async function remoteInitRepo(sshTarget: string, remoteDir: string, branch: string): Promise<void> {
	const probe = await sshRun(sshTarget, `cd ${remoteDir} && test -d .git && echo EXISTS || echo FRESH`);
	const isFresh = probe.stdout.trim() === "FRESH";
	if (isFresh) {
		const init = await sshRun(
			sshTarget,
			`cd ${remoteDir} && git clone --bundle=.codespace-sync.bundle -l ./.codespace-sync.bundle .git-tmp && mv .git-tmp/.git .git && rm -rf .git-tmp`,
		);
		if (init.code !== 0) {
			throw new Error(`remote bundle clone failed:\n${init.stderr}\n${init.stdout}`);
		}
	}
	const co = await sshRun(sshTarget, `cd ${remoteDir} && git checkout ${branch} || git checkout -b ${branch} || true`);
	if (co.code !== 0) {
		throw new Error(`remote checkout failed:\n${co.stderr}\n${co.stdout}`);
	}
}

async function push(opts: SyncOptions, plan: PlanResult): Promise<void> {
	console.log("→ ensure remote dir exists");
	await ensureRemoteDir(opts.sshTarget, opts.remoteDir);

	console.log("→ build local bundle (all branches + tags)");
	const bundle = await buildBundle(plan.localRepo, plan.localRepo);
	console.log(`  bundle: ${bundle.bundlePath} (${Math.round(bundle.bytes / 1024)} KiB)`);
	if (bundle.stashBundlePath) {
		console.log(`  stash bundle: ${bundle.stashBundlePath}`);
	}

	console.log("→ tar working tree to remote");
	await rsyncPush(plan.localRepo, opts.sshTarget, opts.remoteDir);

	console.log("→ scp bundle(s) to remote");
	await scpFile(bundle.bundlePath, opts.sshTarget, opts.remoteDir);
	if (bundle.stashBundlePath) {
		await scpFile(bundle.stashBundlePath, opts.sshTarget, opts.remoteDir);
	}

	console.log("→ init/refresh remote repo from bundle");
	await remoteInitRepo(opts.sshTarget, opts.remoteDir, plan.branch);

	console.log("✓ push complete");
}

async function pull(opts: SyncOptions, plan: PlanResult): Promise<void> {
	console.log("→ ensure local is clean (refuses to overwrite uncommitted edits)");
	// --untracked-files=no so the check ignores newly created files; only
	// modifications / deletions to tracked files block the pull.
	const status = await direct(["git", "status", "--porcelain", "--untracked-files=no"]);
	if (status.stdout.trim().length > 0) {
		throw new Error(`local working tree is dirty — refusing to overwrite. Commit/stash first.\n${status.stdout}`);
	}

	const remoteBundle = `${opts.sshTarget}:${opts.remoteDir}/.codespace-sync.bundle`;
	const key = process.env.CODESPACE_SYNC_KEY ? toWinPath(process.env.CODESPACE_SYNC_KEY) : null;
	const port = process.env.CODESPACE_SYNC_PORT ?? "22";
	const r = await direct([
		"scp",
		...(key ? ["-i", key] : []),
		"-P",
		port,
		"-o",
		"StrictHostKeyChecking=no",
		"-o",
		"UserKnownHostsFile=NUL",
		remoteBundle,
		`${plan.localRepo}/.codespace-sync.bundle`,
	]);
	if (r.code !== 0) throw new Error(`scp remote bundle failed:\n${r.stderr}`);

	console.log("→ fetch all branches from bundle");
	const fr = await direct(["git", "fetch", "./.codespace-sync.bundle", "+refs/heads/*:refs/remotes/origin-sync/*"]);
	if (fr.code !== 0) throw new Error(`git fetch from bundle failed:\n${fr.stderr}`);

	console.log("→ tar working tree from remote to local");
	const localTmp = path.join(plan.localRepo, ".codespace-sync-incoming");
	await fs.rm(localTmp, { recursive: true, force: true });
	await fs.mkdir(localTmp, { recursive: true });
	const ssh = Bun.spawn({
		cmd: [...sshArgv(), opts.sshTarget, `tar -cf - -C ${opts.remoteDir} .`],
		stdout: "pipe",
		stderr: "pipe",
	});
	const untar = Bun.spawn({
		cmd: ["tar", "-xf", "-", "-C", localTmp],
		stdin: ssh.stdout,
		stderr: "pipe",
	});
	const [sshCode, untarCode, sshErr, untarErr] = await Promise.all([
		ssh.exited,
		untar.exited,
		ssh.stderr ? new Response(ssh.stderr).text() : Promise.resolve(""),
		untar.stderr ? new Response(untar.stderr).text() : Promise.resolve(""),
	]);
	if (sshCode !== 0) throw new Error(`remote tar failed (exit ${sshCode}):\n${sshErr}`);
	if (untarCode !== 0) throw new Error(`local untar failed (exit ${untarCode}):\n${untarErr}`);
	console.log(`  staged into ${localTmp} — review, then \`mv\` files into the working tree manually`);

	await fs.unlink(path.join(plan.localRepo, ".codespace-sync.bundle")).catch(() => {});

	console.log("✓ pull complete (working tree staged in .codespace-sync-incoming)");
}

// ── handoff action (GitHub-branch transport) ──

/** Branch name on the GitHub remote: handoff/<target-node>, derived from ssh target. */
function buildHandoffBranch(sshTarget: string): string {
	const node = sshTarget.includes("@") ? sshTarget.split("@")[1] : sshTarget;
	return `handoff/${node}`;
}

/** Convert a leading ~ to $HOME so the path is safe inside double-quoted SSH commands. */
function sshSafePath(p: string): string {
	return p.replace(/^~(?=\/|$)/, "$HOME");
}

/**
 * GitHub-branch handoff: commit everything locally, push to handoff/<node>
 * on origin, then SSH to the target and clone-or-pull that branch. When --launch
 * is passed, also spawns an ompk agent session on the target inside tmux.
 *
 * For large repos where `git push` is slow (1GB+ .git), this uses a fast-path
 * that creates a patch of just the new commits and applies it on the remote
 * via SSH, skipping the push entirely. The remote must already have the repo
 * cloned for the fast path.
 */
async function handoff(opts: SyncOptions, plan: PlanResult): Promise<void> {
	const branch = buildHandoffBranch(opts.sshTarget);
	const remoteDirSsh = sshSafePath(opts.remoteDir);
	const repoName = path.basename(plan.localRepo);

	// 1. Resolve GitHub remote URL.
	console.log("→ resolve GitHub remote URL");
	const remoteRes = await direct(["git", "remote", "get-url", "origin"], { cwd: plan.localRepo });
	if (remoteRes.code !== 0) {
		throw new Error(`cannot resolve git remote 'origin':\n${remoteRes.stderr}`);
	}
	const remoteUrl = remoteRes.stdout.trim();
	console.log(`  origin: ${remoteUrl}`);

	// 2. Stage all changes (including untracked) and commit.
	console.log("→ stage all changes (including untracked)");
	await direct(["git", "add", "-A"], { cwd: plan.localRepo });

	const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	console.log("→ commit (allow-empty)");
	const commitRes = await direct(["git", "commit", "-m", `handoff: ${ts}`, "--allow-empty"], { cwd: plan.localRepo });
	if (commitRes.code !== 0 && commitRes.code !== 1) {
		throw new Error(`git commit failed:\n${commitRes.stderr}`);
	}

	// 3. Check if the target already has the repo cloned.
	console.log(`→ SSH to ${opts.sshTarget}: check if ${opts.remoteDir} exists`);
	const probe = await sshRun(opts.sshTarget, `test -d "${remoteDirSsh}/.git" && echo EXISTS || echo FRESH`);
	if (probe.code !== 0) {
		throw new Error(`cannot reach ${opts.sshTarget}:\n${probe.stderr}`);
	}

	const remoteExists = probe.stdout.trim() === "EXISTS";

	if (remoteExists) {
		// FAST PATH: The remote already has the repo. Instead of pushing the
		// entire branch to GitHub (slow for large repos — git push negotiates
		// and re-sends objects even if the remote already has them), create a
		// patch of just the new commits and pipe it over SSH to `git am`.
		// This only transfers the diff, not the full object database.
		console.log(`→ fast-path: patch over SSH (skipping slow git push)`);

		const remoteHeadRes = await sshRun(opts.sshTarget, `cd "${remoteDirSsh}" && git rev-parse HEAD 2>/dev/null || echo NONE`);
		const remoteHead = remoteHeadRes.stdout.trim();

		if (remoteHead !== "NONE" && remoteHead.length === 40) {
			// Create a patch from the remote HEAD to our current HEAD
			const patchRes = await direct(["git", "format-patch", "--stdout", remoteHead + "..HEAD"], { cwd: plan.localRepo });
			if (patchRes.code === 0 && patchRes.stdout.length > 0) {
				const localHeadRes = await direct(["git", "rev-parse", "--short", "HEAD"], { cwd: plan.localRepo });
				console.log(`  patch: ${patchRes.stdout.length} bytes (${remoteHead.slice(0, 8)}..${localHeadRes.stdout.trim()})`);

				// Apply the patch on the remote via SSH stdin
				const applyProc = Bun.spawn({
					cmd: [...buildSshArgv(), opts.sshTarget, `cd "${remoteDirSsh}" && git am --abort 2>/dev/null; git checkout -B ${branch} 2>/dev/null; git am --3way`],
					stdin: new TextEncoder().encode(patchRes.stdout),
					stdout: "pipe",
					stderr: "pipe",
				});
				const [applyCode, applyOut, applyErr] = await Promise.all([
					applyProc.exited,
					applyProc.stdout ? new Response(applyProc.stdout).text() : "",
					applyProc.stderr ? new Response(applyProc.stderr).text() : "",
				]);
				if (applyCode !== 0) {
					console.log(`  ⚠ patch apply failed, falling back to git push`);
					await sshRun(opts.sshTarget, `cd "${remoteDirSsh}" && git am --abort 2>/dev/null`);
					await gitPushFallback(opts, plan, branch, remoteUrl, remoteDirSsh);
				} else {
					console.log(`✓ patch applied on ${opts.sshTarget}:${opts.remoteDir} (branch ${branch})`);
				}
			} else {
				console.log(`  no new commits — remote is already up to date`);
				await sshRun(opts.sshTarget, `cd "${remoteDirSsh}" && git checkout -B ${branch} 2>/dev/null`);
			}
		} else {
			console.log(`  cannot determine remote HEAD, falling back to git push`);
			await gitPushFallback(opts, plan, branch, remoteUrl, remoteDirSsh);
		}
	} else {
		// SLOW PATH: Remote doesn't have the repo yet — push to GitHub, then clone.
		await gitPushFallback(opts, plan, branch, remoteUrl, remoteDirSsh);
	}

	console.log(`✓ git handoff complete — ${opts.sshTarget}:${opts.remoteDir} on branch ${branch}`);

	// 4. Optionally launch an ompk agent session on the target inside tmux.
	if (opts.launch) {
		const sessionName = `ompk-${repoName}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 50);
		console.log(`→ launch ompk session on ${opts.sshTarget} (tmux: ${sessionName})`);

		const checkCmd = `which ompk >/dev/null 2>&1 && echo OMPK_OK || echo OMPK_MISSING; which tmux >/dev/null 2>&1 && echo TMUX_OK || echo TMUX_MISSING`;
		const check = await sshRun(opts.sshTarget, checkCmd);
		const checkOut = check.stdout.trim();
		if (!checkOut.includes("OMPK_OK")) {
			console.log(`  ⚠ ompk not found on ${opts.sshTarget} — skipping session launch.`);
			console.log(`✓ handoff complete (git only, no agent session)`);
			return;
		}
		if (!checkOut.includes("TMUX_OK")) {
			console.log(`  ⚠ tmux not found on ${opts.sshTarget} — skipping session launch.`);
			console.log(`✓ handoff complete (git only, no agent session)`);
			return;
		}

		const launchCmd = [
			`tmux kill-session -t ${sessionName} 2>/dev/null || true`,
			`tmux new-session -d -s ${sessionName} -c "${remoteDirSsh}"`,
			`tmux send-keys -t ${sessionName} 'ompk --cwd "${remoteDirSsh}"' Enter`,
		].join(" && ");
		const launch = await sshRun(opts.sshTarget, launchCmd);
		if (launch.code !== 0) {
			console.log(`  ⚠ failed to launch ompk session:\n${launch.stderr}`);
			console.log(`✓ handoff complete (git ok, agent session launch failed)`);
			return;
		}

		console.log(`✓ ompk session launched — attach on ${opts.sshTarget} with: tmux attach -t ${sessionName}`);
	}

	console.log(`✓ handoff complete`);
}

/** Fallback: push to GitHub, then fetch + checkout on the remote. */
async function gitPushFallback(opts: SyncOptions, plan: PlanResult, branch: string, remoteUrl: string, remoteDirSsh: string): Promise<void> {
	console.log(`→ push to origin/${branch} (force)`);
	const pushRes = await direct(["git", "push", "--force", "origin", `HEAD:${branch}`], { cwd: plan.localRepo });
	if (pushRes.code !== 0) {
		throw new Error(`git push failed:\n${pushRes.stderr}`);
	}

	const probe = await sshRun(opts.sshTarget, `test -d "${remoteDirSsh}/.git" && echo EXISTS || echo FRESH`);
	if (probe.stdout.trim() === "FRESH") {
		console.log(`→ clone ${remoteUrl} → ${opts.remoteDir}`);
		const cloneCmd = `mkdir -p "$(dirname "${remoteDirSsh}")" && git clone "${remoteUrl}" "${remoteDirSsh}"`;
		const clone = await sshRun(opts.sshTarget, cloneCmd);
		if (clone.code !== 0) {
			throw new Error(`remote clone failed:\n${clone.stderr}\n${clone.stdout}`);
		}
	}

	console.log(`→ fetch + checkout ${branch} on ${opts.sshTarget}`);
	const syncCmd = `cd "${remoteDirSsh}" && git fetch origin ${branch} && git checkout -B ${branch} origin/${branch} && git reset --hard origin/${branch}`;
	const sync = await sshRun(opts.sshTarget, syncCmd);
	if (sync.code !== 0) {
		throw new Error(`remote sync failed:\n${sync.stderr}\n${sync.stdout}`);
	}
}

/**
 * Check if the repo has a GitHub `origin` remote. When it does, `push` can
 * use the fast GitHub-branch handoff instead of the slow bundle+tar transport.
 */
async function hasGitHubOrigin(cwd: string): Promise<boolean> {
	const r = await direct(["git", "remote", "get-url", "origin"], { cwd });
	if (r.code !== 0) return false;
	const url = r.stdout.trim();
	return url.includes("github.com") || url.startsWith("git@") || url.startsWith("https://");
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv);
	const plan = await makePlan(opts);
	console.log(`── plan ──\n${formatPlan(plan)}\n───────────`);
	if (opts.direction === "status") {
		console.log("(status only — no transfer)");
		return;
	}
	if (opts.direction === "handoff") {
		await handoff(opts, plan);
	} else if (opts.direction === "push") {
		// Auto-redirect push → handoff when origin is a GitHub remote.
		// The GitHub-branch handoff is much faster than bundle+tar because
		// it only pushes the delta to GitHub (which already has most of the
		// history) instead of transferring the entire repo over SSH.
		if (await hasGitHubOrigin(plan.localRepo)) {
			console.log("→ push → handoff (origin is a GitHub remote, using fast GitHub-branch transport)");
			await handoff(opts, plan);
		} else {
			await push(opts, plan);
		}
	} else {
		await pull(opts, plan);
	}
}

main().catch((err: unknown) => {
	console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
