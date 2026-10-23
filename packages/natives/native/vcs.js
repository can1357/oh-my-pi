import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadNative } from "./loader-state.js";

let native;
function api() {
	native ??= loadNative();
	return native;
}
function vcsError(code, message) {
	const error = new Error(message);
	error.name = "VcsError";
	error.code = code;
	error.exitCode = 1;
	error.stdout = "";
	error.stderr = message;
	return error;
}

/**
 * True when `error` is a native VCS failure. The native layer constructs these
 * on the JS thread as real `Error` objects with `name: "VcsError"`, a
 * machine-readable `code`, and `exitCode`/`stdout`/`stderr` properties — an
 * `instanceof` check is impossible for foreign-constructed errors, so identity
 * rides on `name`.
 */
export function isVcsError(error) {
	return error instanceof Error && error.name === "VcsError";
}

/** True when a cherry-pick failed because the commit is already applied. */
export function isEmptyCherryPick(error) {
	return isVcsError(error) && error.code === "EmptyCherryPick";
}

/** Discover the git repository containing `dir`; `null` outside any checkout. */
export function git(dir) {
	return api().vcsGitDiscover(dir);
}
/** Discover the repository owning `dir`; `null` outside any repository. */
export function repo(dir) {
	return api().vcsDiscover(dir);
}
/**
 * {@link git} off the JS thread: rejects with the abort reason as soon as `signal` aborts, also
 * while a stalled checkout holds the lookup up.
 */
export async function discoverGit(dir, signal) {
	return (await untilAborted(api().vcsGitDiscoverAsync(dir, signal), signal)) ?? null;
}
/** {@link repo} off the JS thread, like {@link discoverGit}. */
export async function discoverRepo(dir, signal) {
	return (await untilAborted(api().vcsDiscoverAsync(dir, signal), signal)) ?? null;
}

/** Like {@link repo}, but equal-root jj+git ties prefer Jujutsu for display. Git-safe automation must keep using {@link repo}. */
export function repoForDisplay(dir) {
	return api().vcsDiscoverForDisplay(dir);
}

/** Like {@link repo}, asserting any requested backend capabilities. */
export function require(dir, ...features) {
	const discovered = repo(dir);
	if (!discovered) throw vcsError("NotARepository", `not a repository: ${dir}`);
	for (const feature of features) {
		if (!discovered.supports(feature)) {
			throw vcsError(
				"Unsupported",
				`\`${feature}\` is not supported on a ${discovered.kind()} repository`,
			);
		}
	}
	return discovered;
}

/** Like {@link git}, but throws a `NotARepository` VcsError. */
export function requireGit(dir) {
	const repo = git(dir);
	if (!repo) {
		throw vcsError("NotARepository", `not a repository: ${dir}`);
	}
	return repo;
}

/** Repository metadata only (cheap fs walk) — for synchronous render paths. */
export function gitInfo(dir) {
	return api().vcsGitRepoInfo(dir);
}

/** Discover the Jujutsu workspace containing `dir`; `null` when absent. */
export function jj(dir) {
	return api().vcsJjDiscover(dir);
}

/** Whether jj is the nearest VCS ancestor, making git automation unsafe. */
export function isPureJj(dir) {
	return api().vcsIsPureJj(dir);
}

/** Clone a repository (git CLI under the hood for credential parity). */
export function clone(url, target, options = {}, signal) {
	return api().vcsGitClone(url, target, options, signal);
}

/** Sever a copied working tree from shared git metadata. */
export function detachGitDir(worktreeRoot, sourceCommonDir, signal) {
	return api().vcsDetachGitDir(worktreeRoot, sourceCommonDir, signal);
}

/**
 * Publish `from` at `to` only once fully written: copy to a sibling temp name,
 * then hard-link it into place (Git's own `finalize_object_file` strategy) so
 * readers never see a partial file and an interrupted copy leaves only a
 * `tmp_` file that `git gc` prunes. An existing `to` was itself published
 * whole and holds the same content-addressed bytes, so it is kept.
 */
async function publishGitObjectFile(from, to) {
	const tmp = path.join(path.dirname(to), `tmp_obj_omp_${crypto.randomUUID()}`);
	try {
		await fs.promises.copyFile(from, tmp, fs.constants.COPYFILE_EXCL);
		try {
			await fs.promises.link(tmp, to);
		} catch (error) {
			if (error?.code === "EEXIST") return;
			// Filesystems without hard links: rename is still atomic, and any
			// file it replaces holds identical content-addressed bytes.
			if (error?.code !== "EPERM" && error?.code !== "ENOTSUP" && error?.code !== "EXDEV") throw error;
			await fs.promises.rename(tmp, to);
		}
	} finally {
		await fs.promises.rm(tmp, { force: true });
	}
}

/**
 * Keep objects created in an isolated Git repository reachable after its
 * worktree is removed, without changing the destination's refs or index.
 * Every file is published atomically; a pack is published before its index.
 */
export async function copyGitObjects(isolationRoot, sourceRoot) {
	const from = path.join(requireGit(isolationRoot).info().commonDir, "objects");
	const to = path.join(requireGit(sourceRoot).info().commonDir, "objects");
	for (const entry of await fs.promises.readdir(from, { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^[0-9a-f]{2}$/.test(entry.name)) continue;
		await fs.promises.mkdir(path.join(to, entry.name), { recursive: true });
		for (const name of await fs.promises.readdir(path.join(from, entry.name))) {
			if (!/^[0-9a-f]{38,62}$/.test(name)) continue;
			await publishGitObjectFile(path.join(from, entry.name, name), path.join(to, entry.name, name));
		}
	}
	const packs = (await fs.promises.readdir(path.join(from, "pack"))).filter(name => name.startsWith("pack-"));
	await fs.promises.mkdir(path.join(to, "pack"), { recursive: true });
	// The index must only become visible after the pack it describes.
	for (const name of packs.filter(name => name.endsWith(".pack"))) {
		await publishGitObjectFile(path.join(from, "pack", name), path.join(to, "pack", name));
	}
	for (const name of packs.filter(name => /\.(?:idx|rev|keep|promisor|mtimes)$/.test(name))) {
		await publishGitObjectFile(path.join(from, "pack", name), path.join(to, "pack", name));
	}
}

/** Bytes kept from the end of each of the hook's output streams. */
const HOOK_OUTPUT_TAIL_BYTES = 64 * 1024;
/** Size of a running hook's capture file above which it is cut down to its tail. */
const HOOK_CAPTURE_CAP_BYTES = 1024 * 1024;
const HOOK_CAPTURE_POLL_MS = 250;
// POSIX: truncating an append-mode file frees its space while the child keeps writing at the end. Windows: a child
// can't write to an append-mode handle, and truncating without append frees nothing, so the head is deallocated instead.
const TRUNCATE_HOOK_CAPTURE = process.platform !== "win32";
const HOOK_CAPTURE_PREFIX = "omp-post-checkout-";
/** Read `read()`, or "" when it fails: a missing part (no /proc, an AppArmor profile denying `boot_id`) must not take the others with it. */
function scopePart(read) {
	try {
		return read() ?? "";
	} catch {
		return "";
	}
}
/**
 * Where pids mean the same, in parts: the machine (hostname plus the machine id: Linux's
 * `/etc/machine-id`, macOS's hardware UUID, Windows' machine GUID, so two machines sharing a
 * hostname differ), and on Linux the boot and the pid namespace, so containers sharing a hostname
 * and the TMPDIR but not their pids (a pod's sidecars) differ too. Linux reads /proc and /etc,
 * which never stall.
 */
const linux = process.platform === "linux";
const MACHINE_ID = linux
	? scopePart(() => fs.readFileSync("/etc/machine-id", "utf8").trim())
	: scopePart(() => api().vcsMachineId());
const SCOPE = {
	machine: Bun.hash(`${os.hostname()}\0${MACHINE_ID}`).toString(36),
	boot: Bun.hash(linux ? scopePart(() => fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()) : "").toString(36),
	namespace: Bun.hash(linux ? scopePart(() => fs.readlinkSync("/proc/self/ns/pid")) : "").toString(36),
};
/**
 * This process's pid scope as a tag. Pids only identify processes within one scope, so what
 * another host or container left behind is never judged by them.
 */
const PID_SCOPE = `${SCOPE.machine}.${SCOPE.boot}.${SCOPE.namespace}`;
/** A capture directory with its creator as a setup owner would name it (`<pid scope>-<pid>`), judged by {@link isWorktreeSetupOwnerAlive}. */
const HOOK_CAPTURE_OWNER = new RegExp(`^${HOOK_CAPTURE_PREFIX}([^-]+-\\d+)-`);

/** Whether process `pid` still exists (EPERM: it does, under another user). */
function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

/** Start identity of process `pid`, where the platform reports one (see `isWorktreeSetupOwnerAlive`). */
function processStart(pid) {
	try {
		return api().vcsProcessStartTime(pid) ?? undefined;
	} catch {
		// An addon older than this binding is allowed to load; it just can't tell a reused pid.
		return undefined;
	}
}

let ownStart;
let ownStartRead = false;

/**
 * This process as the owner of a worktree setup (`setupOwner` of `worktreeAdd`): scope, pid and,
 * where the platform reports it, start time.
 */
export function worktreeSetupOwner() {
	if (!ownStartRead) {
		ownStart = processStart(process.pid);
		ownStartRead = true;
	}
	return ownStart === undefined ? `${PID_SCOPE}-${process.pid}` : `${PID_SCOPE}-${process.pid}-${ownStart}`;
}

/**
 * Wait up to 9 s for the running `worktreeAdd`s of this process to finish (registered as exit
 * cleanup; where the filesystem has no file locks they hold an `omp-worktree-add.claim`). The
 * claims of adds still running then are left in place: removing them would let another process add
 * the same path while this one still writes it. Such a leftover makes a later add fail naming the
 * file.
 */
export function releaseWorktreeAddClaims() {
	return api().vcsReleaseWorktreeAddClaims();
}

/**
 * Whether the owner of a worktree setup may still be running it: its process exists and, when the
 * owner recorded a start time and the platform reports one, started then (else the pid was reused);
 * or it is in another pid scope (another host or container), where this process can't tell. An
 * owner from an earlier boot of this machine is gone, also after a restart cut its setup short.
 * shortcut: two machines cloned with the same machine id and hostname count as one, so a live owner on the other is
 * taken for one from an earlier boot; regenerate the clone's machine id (`systemd-machine-id-setup`) if they share repositories.
 */
export function isWorktreeSetupOwnerAlive(owner) {
	const match = /^([^-]+)-(\d+)(?:-(\d+))?$/.exec(owner);
	if (!match) return true;
	const [machine, boot, namespace] = match[1].split(".");
	if (machine !== SCOPE.machine) return true;
	// Only a machine id tells this machine after a reboot from another one with the same hostname.
	if (boot !== SCOPE.boot) return MACHINE_ID === "";
	if (namespace !== SCOPE.namespace) return true;
	const pid = Number(match[2]);
	if (!processAlive(pid)) return false;
	const current = match[3] === undefined ? undefined : processStart(pid);
	return current === undefined || current === match[3];
}

/**
 * Delete capture directories whose omp process is gone (see {@link isWorktreeSetupOwnerAlive}): it
 * crashed or was killed before its own cleanup, also before a reboot, or (Windows) a background
 * process the hook left running kept the files open then. A run in progress is never touched,
 * however long it takes: its omp is alive. Nor is another host's or container's.
 * shortcut: a pid reused by an unrelated process keeps its leftover until that process exits, fine for a few small directories.
 */
async function sweepStaleHookCaptures() {
	const tmp = os.tmpdir();
	for (const name of await fs.promises.readdir(tmp).catch(() => [])) {
		const owner = HOOK_CAPTURE_OWNER.exec(name)?.[1];
		if (owner === undefined || isWorktreeSetupOwnerAlive(owner)) continue;
		await fs.promises.rm(path.join(tmp, name), { recursive: true, force: true }).catch(() => {});
	}
}

/** Oldest Git with `git hook run`. */
const HOOK_RUN_MIN_GIT = [2, 36];

/** Settle with `promise`, or reject with the abort reason as soon as `signal` aborts. */
async function untilAborted(promise, signal) {
	if (!signal) return promise;
	// Observed even when the abort wins, so its later failure never goes unhandled.
	promise.catch(() => {});
	const aborted = Promise.withResolvers();
	const onAbort = () => aborted.reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		signal.throwIfAborted();
		return await Promise.race([promise, aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Open `file` for a child's output, raced against the abort. Asynchronous, unlike handing
 * `Bun.spawn` a `BunFile`, which opens it on the JS thread, where a stalled TMPDIR would block it.
 */
async function openCapture(file, signal, flags = "w") {
	const opening = fs.promises.open(file, flags);
	try {
		return await untilAborted(opening, signal);
	} catch (error) {
		// Opened after the abort: close it once it is.
		opening.then(handle => handle.close(), () => {});
		throw error;
	}
}

/**
 * Up to `maxBytes` of an open capture, from its start or (`fromEnd`) its end.
 */
async function readHandle(handle, maxBytes, fromEnd) {
	const { size } = await handle.stat();
	const length = Math.min(size, maxBytes);
	const bytes = new Uint8Array(length);
	const { bytesRead } = await handle.read(bytes, 0, length, fromEnd ? size - length : 0);
	return bytes.subarray(0, bytesRead);
}

/**
 * Up to `maxBytes` of a capture file, from its start or (`fromEnd`) its end, read through a file
 * handle off the JS thread and raced against the abort. A missing file reads as empty.
 */
function readCapture(file, maxBytes, { fromEnd = false, signal } = {}) {
	const read = async () => {
		let handle;
		try {
			handle = await fs.promises.open(file, "r");
		} catch (error) {
			if (error?.code === "ENOENT") return new Uint8Array();
			throw error;
		}
		try {
			return await readHandle(handle, maxBytes, fromEnd);
		} finally {
			await handle.close();
		}
	};
	return untilAborted(read(), signal);
}

/**
 * Run `git <args>` with output to the files `stdout`/`stderr` (paths, or "ignore") and resolve with
 * its exit code. `readStdout(stream, exited)` / `readStderr(stream, exited)` instead pipe that stream to
 * the function, awaited alongside the exit; they may return before EOF, closing the stream.
 * Aborting `signal` kills its process tree, descendants that left its process group
 * included (see the shortcut below), and rejects with the reason. Throws `ENOENT` when no git is on
 * `env`'s PATH. `detached` runs it in its own session even without a signal (POSIX), away from the
 * caller's terminal. `stdout`/`stderr` may also be "inherit". `retain` (`{ handles: Map, pgid, start }`) keeps our handles to the files open past a
 * normal return, for the caller to close: `handles` maps path to handle, `pgid` is the process group
 * the child leads, if it does, `start` the child's start identity, if known.
 */
async function runGitToFiles(
	args,
	{ cwd, env, stdout = "ignore", stderr = "ignore", signal, detached = false, append = false, readStdout, readStderr, retain },
) {
	const posix = process.platform !== "win32";
	const handles = [];
	let keep = false;
	const sink = async file => {
		if (file === "ignore" || file === "inherit") return file;
		// O_APPEND: the child's writes land at the current end even after the capture is truncated; readable for the trim.
		const handle = await openCapture(file, signal, append ? "a+" : "w");
		handles.push(handle);
		retain?.handles.set(file, handle);
		return handle.fd;
	};
	try {
		const out = readStdout ? "pipe" : await sink(stdout);
		const err = readStderr ? "pipe" : await sink(stderr);
		// No await between this check and the abort listener below, so no abort can be missed.
		signal?.throwIfAborted();
		const ownGroup = posix && (detached || signal !== undefined);
		const child = Bun.spawn(["git", ...args], {
			cwd,
			env,
			stdin: "ignore",
			stdout: out,
			stderr: err,
			// Own session (setsid): an abort can stop what it spawned, e.g. `npm install`, and without a controlling
			// terminal a prompt on /dev/tty fails instead of writing into the caller's TUI.
			detached: ownGroup,
		});
		if (retain) {
			retain.start = processStart(child.pid);
			if (ownGroup) retain.pgid = child.pid;
		}

		// Pin the root now: killTree walks its descendants by parent, so it also reaches one that left the
		// process group (setsid), and on Windows, which has no process groups, finds them at all.
		// shortcut: a descendant that double-forks out to init escapes, as do commands MSYS `sh` starts through fork
		// stubs on Windows (taskkill /T misses them too), upgrade to ptree's Linux subreaper / a Job Object if hooks
		// that daemonize must be stopped.
		const root = signal ? api().Process.fromPid(child.pid) : null;
		const onAbort = () => {
			// killTree snapshots the descendants, then signals the root's process group, the descendants and the root;
			// the group kill after it covers a root that had exited before it could be pinned.
			try {
				if (posix) root?.killTree(9);
				else root?.killTree();
			} catch {
				// Already exited.
			}
			try {
				if (posix) process.kill(-child.pid, "SIGKILL");
			} catch {
				// Already exited.
			}
			child.kill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		let exitCode;
		try {
			const reading = readStdout?.(child.stdout, child.exited);
			const readingErr = readStderr?.(child.stderr, child.exited);
			[exitCode] = await Promise.all([child.exited, reading, readingErr]);
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
		signal?.throwIfAborted();
		keep = retain !== undefined;
		return exitCode;
	} finally {
		// Our copies only; the child (and anything it left running) holds its own. Not awaited, like the capture cleanup.
		if (!keep) {
			for (const handle of handles) void handle.close().catch(() => {});
			retain?.handles.clear();
		}
	}
}

/** Spawn errors meaning the `git` on PATH cannot start: missing, not a runnable binary, or not executable. */
const GIT_CANNOT_START = new Set(["ENOENT", "ENOEXEC", "EACCES"]);

/** Bytes read from a probe's output: enough for a version line or a path, bounded for noisy wrappers. */
const PROBE_OUTPUT_BYTES = 4096;
/** How long a pipe is still read after git exited: output git wrote just before exiting, not a writer it left behind. */
const EXIT_GRACE_MS = 100;

/**
 * Read up to {@link PROBE_OUTPUT_BYTES} of `stream`, stopping at EOF, the cap, git's exit with a
 * finished line read, or {@link EXIT_GRACE_MS} after its exit. Then the read end is closed,
 * so a lingering writer gets EPIPE instead of holding the probe up or growing a file.
 */
async function readProbeOutput(stream, exited) {
	const reader = stream.getReader();
	const bytes = new Uint8Array(PROBE_OUTPUT_BYTES);
	let length = 0;
	let exitSeen = false;
	const endsLine = () => length > 0 && bytes[length - 1] === 0x0a;
	let wake = exited.then(
		() => "exit",
		() => "exit",
	);
	const grace = wake.then(() => Bun.sleep(EXIT_GRACE_MS)).then(() => "grace");
	const readNext = () => {
		const read = reader.read();
		read.catch(() => {});
		return read;
	};
	let pending = readNext();
	try {
		for (;;) {
			const next = await Promise.race([pending, wake]);
			if (next === "exit") {
				exitSeen = true;
				wake = grace;
				if (endsLine()) break;
				continue;
			}
			if (next === "grace") break;
			if (next.done) break;
			const chunk = next.value.subarray(0, PROBE_OUTPUT_BYTES - length);
			bytes.set(chunk, length);
			length += chunk.length;
			if (length >= PROBE_OUTPUT_BYTES || (exitSeen && endsLine())) break;
			pending = readNext();
		}
	} finally {
		void reader.cancel().catch(() => {});
	}
	return new TextDecoder().decode(bytes.subarray(0, length));
}

/**
 * Run `git <args>` for its output, read from a pipe by {@link readProbeOutput}: never a file, which
 * a wrapper's lingering child could keep growing. Null when no git starts or the command fails.
 */
async function gitProbe(args, cwd, { env, signal, detached }) {
	let output = "";
	try {
		const exitCode = await runGitToFiles(args, {
			cwd,
			env,
			signal,
			detached,
			readStdout: async (stream, exited) => {
				output = await readProbeOutput(stream, exited);
			},
		});
		if (exitCode !== 0) return null;
	} catch (error) {
		if (GIT_CANNOT_START.has(error?.code)) return null;
		throw error;
	}
	return output;
}

/**
 * Whether the git on `env`'s PATH can run hooks: "no-git" when none starts or `git version`
 * fails, "old-git" when it predates `git hook run`, else undefined.
 */
async function hookRunnerProblem(cwd, gitOptions) {
	const version = await gitProbe(["version"], cwd, gitOptions);
	if (version === null) return "no-git";
	const match = /^git version (\d+)\.(\d+)/.exec(version);
	// An unrecognised version string gets the benefit of the doubt.
	if (!match) return undefined;
	const [major, minor] = [Number(match[1]), Number(match[2])];
	const [minMajor, minMinor] = HOOK_RUN_MIN_GIT;
	return major < minMajor || (major === minMajor && minor < minMinor) ? "old-git" : undefined;
}

/**
 * Where git looks for the `post-checkout` hook. The git on `env`'s PATH answers whenever it can,
 * since only it sees every config source (wrappers, distribution system config, `-c` and
 * environment overrides). Without a git that starts and answers, the in-process lookup (`find_hook`
 * rules) stands, so a hook it finds is reported as not run rather than treated as missing.
 */
async function postCheckoutHookPath(worktreeRoot, gitOptions) {
	const answer = await gitProbe(["rev-parse", "--git-path", "hooks/post-checkout"], worktreeRoot, gitOptions);
	// Only the line break git ends it with: a relative `core.hooksPath` may start or end with spaces.
	const reported = answer?.replace(/\r?\n$/, "");
	// Nothing usable (no answer, empty, or an MSYS/Cygwin `/c/…` path on Windows; `//server/share` UNC paths are fine).
	if (!reported || (process.platform === "win32" && reported.startsWith("/") && !reported.startsWith("//"))) {
		// Discovery reads the repository too: off the JS thread, raced against the abort like the rest.
		const location = api().vcsGitHookLocation(worktreeRoot, "post-checkout", gitOptions.signal);
		return (await untilAborted(location, gitOptions.signal)) ?? undefined;
	}
	// A relative result is relative to the worktree, where `git hook run` runs.
	return path.resolve(worktreeRoot, reported);
}

/** Remove a capture directory. Failures leave it behind (a lingering child may hold its files open on Windows): a TMPDIR one is swept once this omp is gone, one in the worktree's git directory goes with the worktree. */
const removeCapture = dir => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});

/** Run `step` every {@link HOOK_CAPTURE_POLL_MS} on an unref'd timer until it resolves true or fails, then `finish`. */
function pollInBackground(step, finish) {
	const schedule = () => setTimeout(tick, HOOK_CAPTURE_POLL_MS).unref();
	const tick = () =>
		step()
			.catch(() => true)
			.then(done => (done ? finish?.() : schedule()));
	schedule();
}

/** Whether a process group still has members; EPERM means it does, but not ours to signal. */
function groupAlive(pgid) {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

/**
 * Linux: processes (other than us) with a descriptor on one of the hook's capture files, found via /proc; none
 * elsewhere or on any failure. Matches by readlink, which never touches the target filesystem, so a process
 * holding a file on a dead network mount can't hang a threadpool thread (stat would). Only processes started
 * at or after the hook root (`held.start`, when known) are read: older ones can't have inherited the files.
 */
async function captureHolders(held) {
	if (process.platform !== "linux") return [];
	try {
		// An unlinked capture reads back with this suffix.
		const targets = new Set(held.realPaths.flatMap(file => [file, `${file} (deleted)`]));
		const since = held.start === undefined ? undefined : BigInt(held.start);
		const holders = [];
		for (const name of await fs.promises.readdir("/proc")) {
			const pid = Number(name);
			if (!(pid > 0) || pid === process.pid) continue;
			const start = processStart(pid);
			try {
				if (since !== undefined && start !== undefined && BigInt(start) < since) continue;
			} catch {
				continue;
			}
			const fds = await fs.promises.readdir(`/proc/${pid}/fd`).catch(() => []);
			for (const fd of fds) {
				const link = await fs.promises.readlink(`/proc/${pid}/fd/${fd}`).catch(() => undefined);
				if (link !== undefined && targets.has(link)) {
					holders.push({ pid, start });
					break;
				}
			}
		}
		return holders;
	} catch {
		return [];
	}
}

/**
 * POSIX: after `git hook run` exited, keep trimming the captures through our handles (the names are
 * gone) while the hook's process group still has members, then, on Linux, while any process still
 * holding them lives (found once, via /proc), then close them.
 * shortcut: only Linux follows a writer that left the group (setsid, double fork) or runs without one
 * (the CLI); elsewhere trimming stops with the group. Trimming also stops once omp exits (a process
 * still writing then grows the unlinked file until it ends), upgrade to ptree's Linux subreaper
 * (or a per-OS holder lookup) if those must be bounded.
 */
function followHookWriters(held, trimAll) {
	const close = () => {
		for (const handle of held.handles.values()) void handle.close().catch(() => {});
	};
	if (!trimAll) return close();
	const followHolders = async () => {
		const holders = await captureHolders(held);
		const alive = ({ pid, start }) => processAlive(pid) && (start === undefined || processStart(pid) === start);
		if (!holders.length) return close();
		pollInBackground(async () => {
			await trimAll(true);
			return !holders.some(alive);
		}, close);
	};
	if (held.pgid === undefined || !groupAlive(held.pgid)) return void followHolders();
	pollInBackground(async () => {
		await trimAll(true);
		return !groupAlive(held.pgid);
	}, followHolders);
}

/**
 * Windows: deleting an open file succeeds there (POSIX semantics) and hides a lingering child's
 * growing capture, so while one is held keep dropping heads by path and remove the directory once released.
 * shortcut: the poll ends with omp, the folder then stays until a later run's sweep.
 */
async function removeCaptureOnceReleased(dir, after) {
	const held = async () => {
		const heldFile = async file => {
			try {
				return await api().vcsCaptureHeld(file);
			} catch {
				return false;
			}
		};
		return (await Promise.all([heldFile(path.join(dir, "stdout")), heldFile(path.join(dir, "stderr"))])).some(Boolean);
	};
	if (!after || !(await held())) return void removeCapture(dir);
	pollInBackground(async () => {
		await after.trimAll(true);
		if (after.exhausted()) return true;
		if (await held()) return false;
		await removeCapture(dir);
		return true;
	});
}

/** `mkdtemp(prefix)` raced against the abort; one created after the abort is removed once it exists. */
async function makeCaptureDir(prefix, signal) {
	const creating = fs.promises.mkdtemp(prefix);
	try {
		return await untilAborted(creating, signal);
	} catch (error) {
		creating.then(removeCapture, () => {});
		throw error;
	}
}

/**
 * Whether the volume of the capture file `file` supports sparse files (Windows), so the head of a
 * growing capture can be dropped. Creates `file` empty and tries to mark it sparse; any failure but
 * an abort counts as unsupported.
 */
async function captureVolumeIsSparse(file, signal) {
	try {
		await untilAborted(fs.promises.writeFile(file, ""), signal);
		return (await untilAborted(api().vcsDropCaptureHead(file, HOOK_OUTPUT_TAIL_BYTES, signal), signal)) === true;
	} catch (error) {
		if (signal?.aborted) throw error;
		return false;
	}
}

/**
 * Read `stream`, keeping only its last {@link HOOK_OUTPUT_TAIL_BYTES} in memory. Resolves with that
 * tail at EOF or {@link EXIT_GRACE_MS} after `exited`, whichever is first, then closes the read end,
 * as the git probes do: a background process the hook left keeps the pipe open, and a pending read
 * would keep this process alive until it ends. That process gets a broken pipe at its next write.
 */
async function readPipeTail(stream, exited) {
	const reader = stream.getReader();
	let chunks = [];
	let kept = 0;
	let collecting = true;
	const pump = (async () => {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			if (!collecting) continue;
			chunks.push(value);
			kept += value.length;
			// Drop from the front while the rest still covers the tail.
			while (chunks.length > 1 && kept - chunks[0].length >= HOOK_OUTPUT_TAIL_BYTES) kept -= chunks.shift().length;
		}
	})().catch(() => {});
	const grace = exited.then(
		() => Bun.sleep(EXIT_GRACE_MS),
		() => Bun.sleep(EXIT_GRACE_MS),
	);
	await Promise.race([pump, grace]);
	collecting = false;
	void reader.cancel().catch(() => {});
	const joined = new Uint8Array(kept);
	let at = 0;
	for (const chunk of chunks) {
		joined.set(chunk, at);
		at += chunk.length;
	}
	chunks = [];
	return joined.subarray(Math.max(0, joined.length - HOOK_OUTPUT_TAIL_BYTES));
}

/**
 * Run Git's checkout hook in a newly created linked worktree, using the same
 * null old HEAD and branch-switch flag as `git worktree add`. Git locates the
 * hook; without a usable git the in-process lookup does, so no git binary is
 * needed when there is no hook. Returns once `git hook run` exits, even if the
 * hook left a background process running, with the last 64 KiB of each output
 * stream; `skipped` says why an existing hook did not run. Aborting
 * `options.signal` kills the hook's process tree and rejects with the reason, also while a
 * lookup, a file check or a read is stalled (starting git still happens on this thread). The output
 * goes to files under TMPDIR, or, when none can be created there, under the worktree's git directory;
 * on Windows, where that volume has no sparse files, it goes through pipes kept to their tail in memory
 * and nothing is written to disk.
 * With `options.inheritOutput` the hook writes to this process's stdout/stderr instead, nothing is
 * captured and the result's `stdout`/`stderr` are empty.
 */
export async function runPostCheckoutHook(worktreeRoot, head, options = {}) {
	const { signal, env, detached, inheritOutput } = options;
	signal?.throwIfAborted();
	const notRun = { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
	const posix = process.platform !== "win32";
	// Awaited, raced against the abort: a stalled TMPDIR holds the run up until then, as `mkdtemp` would.
	await untilAborted(sweepStaleHookCaptures(), signal);
	// Files, not pipes: a background process git or the hook starts inherits them, and pipes would stay open until it exits.
	// The exception is a Windows volume without sparse files (see below), where the output is read from pipes.
	let dir;
	// Inherited output is captured nowhere, so there is no directory.
	if (!inheritOutput) {
		try {
			// Host and pid let a later run tell this directory from one whose omp process is gone.
			dir = await makeCaptureDir(path.join(os.tmpdir(), `${HOOK_CAPTURE_PREFIX}${PID_SCOPE}-${process.pid}-`), signal);
		} catch (error) {
			if (signal?.aborted) throw error;
			// TMPDIR missing, read-only or full: the new worktree's git directory, just written, holds the hook's output
			// instead. Removed with the worktree should this process die first.
			try {
				const gitDir = (await discoverGit(worktreeRoot, signal))?.info().gitDir;
				if (!gitDir) throw error;
				dir = await makeCaptureDir(path.join(gitDir, HOOK_CAPTURE_PREFIX), signal);
			} catch (fallbackError) {
				if (signal?.aborted) throw fallbackError;
				throw error;
			}
		}
	}
	const gitOptions = { env, signal, detached };
	// Our handles to the capture files, their resolved paths (what /proc reports), and the hook's process group and start identity, kept past `git hook run` (POSIX).
	const held = { handles: new Map(), pgid: undefined, start: undefined, realPaths: [] };
	if (dir) {
		const dirReal = await untilAborted(fs.promises.realpath(dir), signal).catch(() => dir);
		held.realPaths = [path.join(dirReal, "stdout"), path.join(dirReal, "stderr")];
	}
	// Set once the hook ran: how to keep trimming the captures after it exited.
	let after = null;
	try {
		const foundAt = await postCheckoutHookPath(worktreeRoot, gitOptions);
		if (!foundAt) return notRun;
		// Only a missing path means no hook; any other failure (EACCES, EIO) is reported, not mistaken for one.
		const missing = error => error?.code === "ENOENT" || error?.code === "ENOTDIR";
		const statHook = file =>
			untilAborted(
				fs.promises.stat(file).catch(error => (missing(error) ? null : error)),
				signal,
			);
		let hookPath = foundAt;
		let stat = await statHook(hookPath);
		// Git for Windows' `find_hook` also takes the name with `.exe` appended.
		if (!posix && stat === null) {
			const exeStat = await statHook(`${foundAt}.exe`);
			if (exeStat !== null) [hookPath, stat] = [`${foundAt}.exe`, exeStat];
		}
		if (stat instanceof Error) return { ...notRun, skipped: { path: hookPath, reason: "inaccessible" } };
		// Anything else there, even a directory, isn't missing: git tries to run it and reports the failure.
		if (stat === null) return notRun;
		// Git's own `access(X_OK)` check; Git for Windows ignores the bit.
		if (posix) {
			const access = fs.promises.access(hookPath, fs.constants.X_OK).then(
				() => true,
				() => false,
			);
			if (!(await untilAborted(access, signal))) {
				return { ...notRun, skipped: { path: hookPath, reason: "not-executable" } };
			}
		}
		const reason = await hookRunnerProblem(worktreeRoot, gitOptions);
		if (reason) return { ...notRun, skipped: { path: hookPath, reason } };
		if (inheritOutput) {
			const exitCode = await runGitToFiles(["hook", "run", "--ignore-missing", "post-checkout", "--", "0".repeat(head.length), head, "1"], {
				cwd: worktreeRoot,
				env,
				stdout: "inherit",
				stderr: "inherit",
				signal,
				detached,
			});
			return { ...notRun, exitCode };
		}
		// Windows: a volume without sparse files cannot shed a capture's head, so a chatty hook would grow it without bound.
		// Its output goes through pipes kept to their tail in memory instead, with nothing on disk.
		if (!posix && !(await captureVolumeIsSparse(path.join(dir, "stdout"), signal))) {
			await untilAborted(removeCapture(dir), signal);
			dir = undefined;
			let stdout = new Uint8Array();
			let stderr = new Uint8Array();
			// shortcut: the pipes close once git exited, so a writer the hook left running gets a broken pipe at its next
			// write, where a file would outlive it; reading on would keep this process alive until the writer ends.
			const exitCode = await runGitToFiles(["hook", "run", "--ignore-missing", "post-checkout", "--", "0".repeat(head.length), head, "1"], {
				cwd: worktreeRoot,
				env,
				signal,
				detached,
				readStdout: async (stream, exited) => {
					stdout = await readPipeTail(stream, exited);
				},
				readStderr: async (stream, exited) => {
					stderr = await readPipeTail(stream, exited);
				},
			});
			return { exitCode, stdout, stderr };
		}
		const outPath = path.join(dir, "stdout");
		const errPath = path.join(dir, "stderr");
		const nullOid = "0".repeat(head.length);
		// Cut each capture file down to its tail while the hook runs, so a chatty one cannot fill the disk.
		// Output written between reading the tail and truncating is lost; only matters past the cap, and the latest output survives.
		const saved = new Map([
			[outPath, new Uint8Array()],
			[errPath, new Uint8Array()],
		]);
		const stopped = Promise.withResolvers();
		// Windows: the logical size keeps growing, so drop only once it is a cap past the last drop; bytes at the end stay intact.
		const droppedAt = new Map([
			[outPath, 0],
			[errPath, 0],
		]);
		// `background`: after the hook exited, no abort signal applies.
		const trim = async (file, background = false) => {
			const sig = background ? undefined : signal;
			const handle = held.handles.get(file);
			let size;
			try {
				({ size } = await untilAborted(handle ? handle.stat() : fs.promises.stat(file), sig));
			} catch (error) {
				// Not opened yet.
				if (error?.code === "ENOENT") return;
				throw error;
			}
			if (!TRUNCATE_HOOK_CAPTURE) {
				const last = droppedAt.get(file);
				// No sparse support (last is null): nothing to free.
				if (last === null || size - last <= HOOK_CAPTURE_CAP_BYTES) return;
				const dropped = await untilAborted(api().vcsDropCaptureHead(file, HOOK_OUTPUT_TAIL_BYTES, sig), sig);
				droppedAt.set(file, dropped ? size : null);
				return;
			}
			if (size <= HOOK_CAPTURE_CAP_BYTES) return;
			// Through the handle once there is one: it keeps working after the names are unlinked. After the hook exited nothing reads `saved`.
			if (!background) {
				const tail = handle
					? untilAborted(readHandle(handle, HOOK_OUTPUT_TAIL_BYTES, true), sig)
					: readCapture(file, HOOK_OUTPUT_TAIL_BYTES, { fromEnd: true, signal: sig });
				saved.set(file, await tail);
			}
			await untilAborted(handle ? handle.truncate(0) : fs.promises.truncate(file, 0), sig);
		};
		const trimAll = background => Promise.all([trim(outPath, background), trim(errPath, background)]);
		after = { trimAll, exhausted: () => [...droppedAt.values()].every(last => last === null) };
		let running = true;
		const poll = (async () => {
			while (running) {
				await Promise.race([Bun.sleep(HOOK_CAPTURE_POLL_MS), stopped.promise]);
				if (running) await Promise.all([trim(outPath), trim(errPath)]);
			}
		})();
		// Observed now so a failure during the run is not unhandled; it is rethrown below.
		poll.catch(() => {});
		let exitCode;
		try {
			exitCode = await runGitToFiles(["hook", "run", "--ignore-missing", "post-checkout", "--", nullOid, head, "1"], {
				cwd: worktreeRoot,
				env,
				stdout: outPath,
				stderr: errPath,
				signal,
				detached,
				append: TRUNCATE_HOOK_CAPTURE,
				retain: posix ? held : undefined,
			});
		} finally {
			running = false;
			stopped.resolve();
		}
		await untilAborted(poll, signal);
		const tail = async file => {
			const kept = saved.get(file);
			const current = await readCapture(file, HOOK_OUTPUT_TAIL_BYTES, { fromEnd: true, signal });
			const joined = new Uint8Array(kept.length + current.length);
			joined.set(kept);
			joined.set(current, kept.length);
			return joined.subarray(Math.max(0, joined.length - HOOK_OUTPUT_TAIL_BYTES));
		};
		const [stdout, stderr] = await Promise.all([tail(outPath), tail(errPath)]);
		return { exitCode, stdout, stderr };
	} finally {
		// Not awaited: a stalled filesystem must not hold up the result or an abort.
		if (dir && posix) {
			void removeCapture(dir);
			if (after) followHookWriters(held, after.trimAll);
		} else if (dir) {
			void removeCaptureOnceReleased(dir, after);
		}
	}
}

/** Join patch fragments, preserving each part's trailing newline. */
export function joinPatches(parts) {
	return api().vcsJoinPatches(parts);
}

/** Validate hunk selections against a raw diff. */
export function validateHunkSelections(rawDiff, selections) {
	return api().vcsValidateHunkSelections(rawDiff, selections);
}

/** Stat-poll interval for {@link watch}. */
export const HEAD_WATCH_INTERVAL_MS = 1000;

/**
 * Watch a repository for head changes; returns a disposer.
 *
 * Stat-polls via `fs.watchFile` instead of `fs.watch`: backends may atomically
 * replace the watched entry, permanently silencing inotify-backed watchers.
 */
export function watch(repo, onChange, intervalMs = HEAD_WATCH_INTERVAL_MS) {
	const target = repo.watchTarget();
	const listener = (curr, prev) => {
		if (curr.mtimeMs !== prev.mtimeMs || curr.ino !== prev.ino || curr.size !== prev.size) onChange();
	};
	fs.watchFile(target, { interval: intervalMs }, listener).unref();
	return () => fs.unwatchFile(target, listener);
}
