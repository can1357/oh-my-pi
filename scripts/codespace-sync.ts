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
import * as os from "node:os";
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
		`xfer est.:    ${kb} KiB working tree (tracked + non-ignored untracked files)`,
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
//
// The file list comes from git, not from walking `.` with --exclude patterns.
// With `-C <repo> .` every member is prefixed `./`, so bare patterns like
// `node_modules` never matched and the stream silently carried the whole
// checkout (measured: 532 MiB / 323 s on a repo whose real payload is ~1 MB).
// `git ls-files` also honours .gitignore, so bulky ignored state is skipped
// without maintaining a hand-written exclude list.
async function workingTreeFileList(localRepo: string): Promise<string[]> {
	// -s exposes the mode so gitlinks (160000) can be dropped: tar would
	// recursively archive an initialized submodule directory, dragging in its
	// .git file and ignored state that `git ls-files` never selected.
	const r = await direct(["git", "ls-files", "-z", "-s", "--cached", "--others", "--exclude-standard"], {
		cwd: localRepo,
	});
	if (r.code !== 0) throw new Error(`git ls-files failed:\n${r.stderr}`);
	const files: string[] = [];
	for (const entry of r.stdout.split("\0").filter(Boolean)) {
		// Staged form: "<mode> <sha> <stage>\t<path>". Untracked (--others)
		// entries have no metadata prefix and arrive as a bare path.
		const tab = entry.indexOf("\t");
		if (tab === -1) {
			files.push(entry);
			continue;
		}
		const mode = entry.slice(0, entry.indexOf(" "));
		if (mode === "160000") continue; // submodule gitlink
		files.push(entry.slice(tab + 1));
	}
	// Drop cached entries whose file is gone from the worktree, or tar would
	// abort on a path it cannot stat. `git ls-files --deleted` is the right
	// question: it reports exactly "in the index, missing on disk", which also
	// covers a file staged and then removed (`git add f && rm f`) — a case
	// `git diff --diff-filter=D HEAD` misses entirely because HEAD never had
	// it. A staged rename needs no special handling here: `git mv` removes the
	// old path from the index, so it never enters `files` in the first place.
	const gone = await direct(["git", "ls-files", "-z", "--deleted"], { cwd: localRepo });
	if (gone.code !== 0) throw new Error(`git ls-files --deleted failed:\n${gone.stderr}`);
	const deleted = new Set(gone.stdout.split("\0").filter(Boolean));
	return files.filter(f => !deleted.has(f));
}

async function rsyncPush(localRepo: string, sshTarget: string, remoteDir: string): Promise<void> {
	const files = await workingTreeFileList(localRepo);
	// An empty list is legitimate (empty-tree commit, or every tracked file
	// deleted locally). The bundle already established HEAD and the caller's
	// sweep removes deleted paths, so there is simply nothing to overlay.
	if (files.length === 0) return;
	const listPath = path.join(os.tmpdir(), `codespace-sync-files-${process.pid}.lst`);
	await Bun.write(listPath, files.join("\0"));
	// --no-recursion: every path is already enumerated by git, so a listed
	// directory must never be expanded by tar itself.
	const tarArgs = [
		"tar",
		"-cf",
		"-",
		"-C",
		localRepo,
		"--null",
		"--no-recursion",
		"--files-from",
		toWinPath(listPath),
	];
	const sshArgs = [...sshArgv(), sshTarget, `tar -xf - -C ${remoteDir} --no-same-owner`];
	try {
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
	} finally {
		await Bun.file(listPath)
			.delete()
			.catch(() => {});
	}
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
	// Tailscale SSH (check-mode sessions) does not propagate the remote
	// command's exit status — every failure looks like exit 0. Remote stdout
	// IS reliable, so smuggle the real status through it and parse it back.
	const res = await direct([...sshArgv(), sshTarget, `${cmd}\n__sc_rc=$?; echo "__SSH_RC=$__sc_rc"`]);
	const m = res.stdout.match(/__SSH_RC=(\d+)\s*$/);
	if (m) {
		return {
			code: res.code !== 0 ? res.code : Number(m[1]),
			stdout: res.stdout.replace(/__SSH_RC=\d+\s*$/, ""),
			stderr: res.stderr,
		};
	}
	// Missing sentinel = the remote shell never reached our echo (dead session,
	// unreachable host). Fail closed — returning res.code would recreate the
	// exact false-success condition this wrapper exists to prevent.
	return {
		code: res.code !== 0 ? res.code : 255,
		stdout: res.stdout,
		stderr: `${res.stderr}\n[sshRun] remote exit marker missing — treating as failure`.trim(),
	};
}

// On the remote, init a fresh git repo from the bundle we scp'd, then check
// out the branch. Use single ssh calls per step because BusyBox sh on slim
// images misbehaves with `&&` chains.
async function remoteInitRepo(sshTarget: string, remoteDir: string, branch: string, localHead: string): Promise<void> {
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

	const fetch = await sshRun(
		sshTarget,
		`cd ${remoteDir} && git fetch --force ./.codespace-sync.bundle "+refs/heads/*:refs/remotes/codespace-sync/*" "+refs/tags/*:refs/tags/*"`,
	);
	if (fetch.code !== 0) {
		throw new Error(`remote bundle fetch failed:\n${fetch.stderr}\n${fetch.stdout}`);
	}

	const co = await sshRun(sshTarget, `cd ${remoteDir} && git reset --hard && git checkout -B ${branch} ${localHead}`);
	if (co.code !== 0) {
		throw new Error(`remote checkout failed:\n${co.stderr}\n${co.stdout}`);
	}
}

async function push(opts: SyncOptions, plan: PlanResult): Promise<void> {
	console.log("→ ensure remote dir exists");
	await ensureRemoteDir(opts.sshTarget, opts.remoteDir);

	const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "codespace-sync-push-"));
	try {
		console.log("→ build local bundle (all branches + tags)");
		const bundle = await buildBundle(plan.localRepo, bundleDir);
		console.log(`  bundle: ${bundle.bundlePath} (${Math.round(bundle.bytes / 1024)} KiB)`);
		if (bundle.stashBundlePath) {
			console.log(`  stash bundle: ${bundle.stashBundlePath}`);
		}

		console.log("→ scp bundle(s) to remote");
		await scpFile(bundle.bundlePath, opts.sshTarget, opts.remoteDir);
		if (bundle.stashBundlePath) {
			await scpFile(bundle.stashBundlePath, opts.sshTarget, opts.remoteDir);
		}

		const localHead = (await direct(["git", "rev-parse", "HEAD"], { cwd: plan.localRepo })).stdout.trim();
		if (!/^[0-9a-f]{40}$/.test(localHead)) {
			throw new Error(`cannot resolve local HEAD: ${localHead || "(empty)"}`);
		}

		console.log("→ init/refresh remote repo from bundle");
		await remoteInitRepo(opts.sshTarget, opts.remoteDir, plan.branch, localHead);

		console.log("→ tar working tree to remote");
		await rsyncPush(plan.localRepo, opts.sshTarget, opts.remoteDir);

		console.log("✓ push complete");
	} finally {
		await fs.rm(bundleDir, { recursive: true, force: true });
	}
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
export async function handoff(opts: SyncOptions, plan: PlanResult): Promise<void> {
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
	// Never ship transport artifacts: a prior bundle/tar run can leave
	// .codespace-sync.* files in the tree, and `git add -A` would commit them
	// (a stale 337 MB bundle once ballooned every handoff patch and broke the
	// GitHub fallback with GH001 file-size rejections).
	await direct(
		[
			"git",
			"rm",
			"-r",
			"-q",
			"--cached",
			"--ignore-unmatch",
			"--",
			".codespace-sync.bundle",
			".codespace-sync.stash.bundle",
			".codespace-sync-incoming",
		],
		{ cwd: plan.localRepo },
	);

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
		// and re-sends objects even if the remote already has them), ship an
		// incremental git bundle over the SSH channel and fetch it remotely.
		// This only transfers the missing objects, not the full database.
		console.log(`→ fast-path: bundle over SSH (skipping slow git push)`);

		// Ship real git objects as a bundle over the SSH channel — no GitHub
		// round-trip (some targets have no GitHub egress at all), and unlike
		// `git am` this preserves commit shas, so the next handoff stays
		// incremental instead of replaying ever-growing history. Find the
		// newest remote commit the local repo also has (legacy am-based
		// handoffs left rewritten shas); the remote is a disposable mirror,
		// so rewinding to it is safe.
		const remoteListRes = await sshRun(
			opts.sshTarget,
			`cd "${remoteDirSsh}" && git rev-list --max-count=100 HEAD 2>/dev/null || echo NONE`,
		);
		const remoteShas = remoteListRes.stdout
			.split("\n")
			.map(s => s.trim())
			.filter(s => /^[0-9a-f]{40}$/.test(s));
		let base = "";
		for (const sha of remoteShas) {
			const known = await direct(["git", "cat-file", "-e", `${sha}^{commit}`], { cwd: plan.localRepo });
			if (known.code === 0) {
				base = sha;
				break;
			}
		}
		const localHead = (await direct(["git", "rev-parse", "HEAD"], { cwd: plan.localRepo })).stdout.trim();

		if (base && localHead.length === 40) {
			let fastPathOk = false;
			if (base === localHead) {
				// Remote already has every object — just align branch + worktree.
				console.log(`  remote already at local HEAD — aligning branch`);
				const align = await sshRun(
					opts.sshTarget,
					`cd "${remoteDirSsh}" && git reset --hard && git clean -fd && git checkout -B "${branch}" ${localHead}`,
				);
				fastPathOk = align.code === 0;
				if (!fastPathOk) console.log(`  ⚠ branch align failed (rc ${align.code})`);
			} else {
				const bundlePath = path.join(os.tmpdir(), `codespace-handoff-${Date.now()}.bundle`);
				try {
					const bundleRes = await direct(["git", "bundle", "create", bundlePath, `${base}..HEAD`], {
						cwd: plan.localRepo,
					});
					if (bundleRes.code !== 0) {
						console.log(`  ⚠ bundle create failed:\n${bundleRes.stderr.trim()}`);
					} else {
						const bundleBytes = (await fs.stat(bundlePath)).size;
						console.log(`  bundle: ${bundleBytes} bytes (${base.slice(0, 8)}..${localHead.slice(0, 8)})`);
						// Pipe the bundle to the remote, fetch its objects, then
						// point the branch at the exact local HEAD sha. Exit
						// status is smuggled via stdout because Tailscale SSH
						// check-mode sessions always report exit 0.
						const applyProc = Bun.spawn({
							cmd: [
								...sshArgv(),
								opts.sshTarget,
								`cd "${remoteDirSsh}" && cat > .git/codespace-handoff.bundle && git reset --hard && git clean -fd && git fetch .git/codespace-handoff.bundle HEAD && git checkout -B "${branch}" ${localHead} && rm -f .git/codespace-handoff.bundle\n__sc_rc=$?; echo "__SSH_RC=$__sc_rc"`,
							],
							stdin: Bun.file(bundlePath),
							stdout: "pipe",
							stderr: "pipe",
						});
						const [applyExit, applyOut, applyErr] = await Promise.all([
							applyProc.exited,
							applyProc.stdout ? new Response(applyProc.stdout).text() : "",
							applyProc.stderr ? new Response(applyProc.stderr).text() : "",
						]);
						const applyRc = applyOut.match(/__SSH_RC=(\d+)\s*$/);
						// Missing sentinel = remote shell never reached our echo — fail closed.
						const applyCode = applyExit !== 0 ? applyExit : applyRc ? Number(applyRc[1]) : 255;
						if (applyCode !== 0) {
							console.log(`  ⚠ bundle apply failed (rc ${applyCode})`);
							console.log(`  ${applyErr.trim().split("\n").slice(-3).join("\n  ")}`);
						} else {
							fastPathOk = true;
						}
					}
				} finally {
					await fs.rm(bundlePath, { force: true });
				}
			}
			if (fastPathOk) {
				// The mirror contract is tree equality — verify it directly.
				const localTree = (
					await direct(["git", "rev-parse", "HEAD^{tree}"], { cwd: plan.localRepo })
				).stdout.trim();
				const remoteTree = (
					await sshRun(
						opts.sshTarget,
						`cd "${remoteDirSsh}" && git rev-parse "HEAD^{tree}" 2>/dev/null || echo NONE`,
					)
				).stdout.trim();
				if (localTree.length !== 40 || localTree !== remoteTree) {
					console.log(
						`  ⚠ apply reported success but remote tree does not match local tree — falling back to git push`,
					);
					await gitPushFallback(opts, plan, branch, remoteUrl, remoteDirSsh);
				} else {
					console.log(`✓ bundle applied on ${opts.sshTarget}:${opts.remoteDir} (branch ${branch})`);
				}
			} else {
				console.log(`  falling back to git push`);
				await gitPushFallback(opts, plan, branch, remoteUrl, remoteDirSsh);
			}
		} else {
			console.log(`  no shared commit with the remote, falling back to git push`);
			await gitPushFallback(opts, plan, branch, remoteUrl, remoteDirSsh);
		}
	} else {
		// SLOW PATH: Remote doesn't have the repo yet — push to GitHub, then clone.
		await gitPushFallback(opts, plan, branch, remoteUrl, remoteDirSsh);
	}

	console.log(`✓ git handoff complete — ${opts.sshTarget}:${opts.remoteDir} on branch ${branch}`);

	// 4. Auto-launch an ompk session via the target's handoff-bot (if running).
	if (opts.launch) {
		await autoLaunchHandoffBotSession(opts.sshTarget, remoteDirSsh, repoName);
	}

	// 5. Clean up the handoff branch on GitHub.
	console.log(`→ cleanup handoff branch origin/${branch}`);
	const deleteRes = await direct(["git", "push", "origin", "--delete", branch], { cwd: plan.localRepo });
	if (deleteRes.code === 0) {
		console.log(`✓ deleted origin/${branch}`);
	} else {
		console.log(`  (branch cleanup skipped: ${deleteRes.stderr.trim() || "unknown"})`);
	}

	console.log(`✓ handoff complete`);
}

/**
 * Auto-launch an ompk session on the target via its handoff-bot.
 * Reads the bot token from the target's config over SSH, then sends a
 * /new <repo> message via the Telegram Bot API. The handoff-bot on the
 * target picks up the message and creates the session automatically.
 */
async function autoLaunchHandoffBotSession(sshTarget: string, remoteDirSsh: string, repoName: string): Promise<void> {
	console.log(`→ auto-launch handoff-bot session on ${sshTarget}`);

	// Read the bot config from the target
	const configCmd = `cat ~/.handoff-bot/config.json 2>/dev/null || cat /data/.handoff-bot/config.json 2>/dev/null || echo NONE`;
	const configRes = await sshRun(sshTarget, configCmd);
	if (configRes.stdout.trim() === "NONE") {
		console.log(`  ⚠ no handoff-bot config found on ${sshTarget} — skipping auto-launch`);
		console.log(`  (install handoff-bot on the target: run handoff-bot/install.sh)`);
		return;
	}

	let botConfig: { botToken?: string; allowedChatIds?: string[] };
	try {
		botConfig = JSON.parse(configRes.stdout);
	} catch {
		console.log(`  ⚠ cannot parse handoff-bot config on ${sshTarget} — skipping auto-launch`);
		return;
	}

	if (!botConfig.botToken) {
		console.log(`  ⚠ no botToken in handoff-bot config on ${sshTarget} — skipping auto-launch`);
		return;
	}

	// Determine the chat ID
	let chatId = (botConfig.allowedChatIds || [])[0];
	if (!chatId) {
		// Use the most recent chat from getUpdates
		const updatesUrl = `https://api.telegram.org/bot${botConfig.botToken}/getUpdates?limit=1`;
		const updatesRes = await direct(["curl", "-s", updatesUrl]);
		try {
			const updates = JSON.parse(updatesRes.stdout);
			if (updates.ok && updates.result && updates.result.length > 0) {
				chatId = updates.result[0].message?.chat?.id?.toString();
			}
		} catch {}
	}

	if (!chatId) {
		console.log(`  ⚠ cannot determine chat ID — send a message to the bot on Telegram first, then retry`);
		return;
	}

	// Send /new <repo> to the bot via Telegram API
	const sendUrl = `https://api.telegram.org/bot${botConfig.botToken}/sendMessage`;
	const sendRes = await direct([
		"curl",
		"-s",
		"-X",
		"POST",
		sendUrl,
		"-d",
		`chat_id=${chatId}`,
		"-d",
		`text=/new ${repoName}`,
	]);
	try {
		const resp = JSON.parse(sendRes.stdout);
		if (resp.ok) {
			console.log(`✓ handoff-bot session auto-launched — check Telegram, the session is ready`);
		} else {
			console.log(`  ⚠ Telegram sendMessage failed: ${resp.description || "unknown"}`);
		}
	} catch {
		console.log(`  ⚠ cannot parse Telegram API response — skipping auto-launch`);
	}
}

/** Fallback: push to GitHub, then fetch + checkout on the remote. */
async function gitPushFallback(
	opts: SyncOptions,
	plan: PlanResult,
	branch: string,
	remoteUrl: string,
	remoteDirSsh: string,
): Promise<void> {
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
	// Fetch from the resolved GitHub URL, not the remote's `origin`: legacy
	// bundle-clones have origin pointing at a local .codespace-sync.bundle
	// path, which silently can never contain the new commits. FETCH_HEAD
	// pins the sync to exactly what was just pushed.
	const syncCmd = `cd "${remoteDirSsh}" && git fetch "${remoteUrl}" "${branch}" && git checkout -B "${branch}" FETCH_HEAD && git reset --hard FETCH_HEAD`;
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

if (import.meta.main) {
	main().catch((err: unknown) => {
		console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	});
}
