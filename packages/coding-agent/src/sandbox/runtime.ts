/**
 * Per-workspace sandbox runtime: effective configuration, backend availability, the filesystem
 * policy context (the I/O `policy.ts` leaves out), the per-realm egress proxy, and contained
 * spawns.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import {
	type SandboxPolicy as NativeSandboxPolicy,
	type SandboxSupport,
	sandboxDiscoverPaths,
	sandboxSupport,
} from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { expandTilde, getNativesDir, logger, untilAborted } from "@oh-my-pi/pi-utils";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { getPackageDir } from "../config";
import { combine, type Setting } from "../config/registry";
import { Settings } from "../config/settings";
import { EgressProxy } from "./egress-proxy";
import { definedEnv } from "./env";
import { compactPaths, isFilesystemRoot, isWithin, ompRuntimePaths } from "./platform";
import {
	expandSandboxPath,
	hostMatches,
	type ResolvedFsPolicy,
	readSandboxConfig,
	resolveFsPolicy,
	type SandboxPolicyContext,
} from "./policy";
import { spawnSandboxChild } from "./process";
import {
	cfgSandboxAllowedHosts,
	cfgSandboxAllowRead,
	cfgSandboxAllowWrite,
	cfgSandboxDenyRead,
	cfgSandboxEnabled,
	cfgSandboxFallback,
	cfgSandboxListDrives,
	cfgSandboxMode,
	cfgSandboxNetworkMode,
	cfgSandboxReadScope,
	cfgSandboxScope,
} from "./settings";
import type { SandboxConfig, SandboxNetworkMode, SandboxResultMeta, SandboxScope } from "./types";

export type SandboxStatus =
	| { state: "off" }
	| { state: "active"; backend: string; network: SandboxNetworkMode; warnings: readonly string[] }
	| { state: "unavailable"; reason: string; fallback: "warn" | "block" };

export interface SandboxSpawnRequest {
	argv: string[];
	cwd: string;
	env: Record<string, string>;
	extraWrite?: readonly string[];
	extraRead?: readonly string[];
	/** Override the configured network mode (MCP servers). */
	network?: SandboxNetworkMode;
}

/** The subset of Bun's Subprocess the spawn sites use. */
export interface SandboxChild {
	readonly pid: number;
	readonly stdin: { write(data: string | Uint8Array): void; flush(): void; end(): void };
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	readonly exitCode: number | null;
	kill(): void;
}

export type HostApproval = "once" | "session" | "always" | "deny";

export type SandboxHostApprover = (host: string, port: number) => Promise<HostApproval>;

/** Receives the one per-realm "enabled but unavailable, running unsandboxed" warning. */
export type SandboxWarningSink = (message: string) => void;

export type SandboxAccessKind = "write" | "read" | "host";

/** What the approver is shown. `target` is already resolved (absolute realpath-or-self path, or canonical host). */
export interface SandboxAccessRequest {
	kind: SandboxAccessKind;
	target: string;
	/** What the agent is trying to do and why it needs this target: one or two plain sentences, written for the user. */
	intent: string;
	/** The command that needs the access (failed or about to run), verbatim. */
	command?: string;
	/** What the agent will do instead if the request is denied. */
	alternative?: string;
	workspace: string;
	/** False when the backing list setting is locked (env/override/project): no "always" option. */
	canAlways: boolean;
}

export type SandboxAccessAnswer =
	| { decision: "session" | "always" | "deny" }
	/** The user answered with instructions instead of a decision: nothing is granted. */
	| { decision: "instruct"; instructions: string };

export type SandboxAccessApprover = (
	request: SandboxAccessRequest,
	signal?: AbortSignal,
) => Promise<SandboxAccessAnswer>;

export type SandboxAccessOutcome =
	| { status: "granted"; scope: "session" | "always"; target: string }
	| { status: "already-allowed"; target: string }
	| { status: "denied"; target: string }
	| { status: "instructed"; target: string; instructions: string }
	/** Never shown to the user: invalid target, protected path, sandbox off/unavailable, read-only mode for a write, or nobody to ask. */
	| { status: "refused"; reason: string };

export interface SandboxAccessInput {
	kind: SandboxAccessKind;
	target: string;
	intent: string;
	command?: string;
	alternative?: string;
	/** Base for a relative path target; default: the workspace. */
	cwd?: string;
}

/** The consequence of granting `target`, computed by omp (never by the agent), for every approval UI. */
export function sandboxAccessEffect(kind: SandboxAccessKind, target: string): string {
	switch (kind) {
		case "write":
			return `Contained commands will be able to create, change and delete files under ${target}.`;
		case "read":
			return `Contained commands will be able to read files under ${target}.`;
		case "host":
			return `Contained commands will be able to connect to ${target} on any port.`;
	}
}

/** A path or host the agent may not have: invalid, a filesystem root, protected, or a locked list. */
export class SandboxAccessError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxAccessError";
	}
}

/** The sandbox is enabled with `fallback: block` but no backend can contain processes here. */
export class SandboxUnavailableError extends Error {
	readonly reason: string;

	constructor(reason: string) {
		super(`Sandbox unavailable: ${reason}`);
		this.name = "SandboxUnavailableError";
		this.reason = reason;
	}
}

/** Every `sandbox.*` setting; a change to any of them invalidates the cached configuration. */
const cfgSandboxAll = combine({
	enabled: cfgSandboxEnabled,
	mode: cfgSandboxMode,
	scope: cfgSandboxScope,
	fallback: cfgSandboxFallback,
	readScope: cfgSandboxReadScope,
	allowWrite: cfgSandboxAllowWrite,
	allowRead: cfgSandboxAllowRead,
	denyRead: cfgSandboxDenyRead,
	networkMode: cfgSandboxNetworkMode,
	allowedHosts: cfgSandboxAllowedHosts,
	listDrives: cfgSandboxListDrives,
});

/** Output fragments that point at a filesystem denial by the sandbox (shell, Node/Bun and Python spellings). */
const DENIAL_PATTERN = /operation not permitted|permission denied|read-only file system|\b(?:EPERM|EACCES|EROFS)\b/i;

/**
 * Windows STATUS_DLL_INIT_FAILED. The processcontainer sandbox launches every process with Mandatory
 * ASLR, so programs whose runtime needs a fixed image base (MSYS2/Cygwin: Git Bash, `sh`, Git's own
 * `ssh`, …) fail to start with it. Shells report it signed (-1073741502) or unsigned (3221225794).
 */
const STATUS_DLL_INIT_FAILED = 0xc0000142;
const DLL_INIT_FAILED_PATTERN = /(?:^|[^\d])(?:-1073741502|3221225794)(?!\d)|\b0xc0000142\b/i;

/** Windows OpenSSH, which (unlike the `ssh` Git for Windows bundles) runs inside the sandbox. */
function windowsOpenSsh(): string | undefined {
	const ssh = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
	return fs.existsSync(ssh) ? ssh : undefined;
}

/**
 * Contained environment additions on Windows. Git for Windows runs its bundled `ssh`, which cannot
 * start in the sandbox; `GIT_SSH` has the lowest precedence of git's ssh settings, so an explicit
 * `GIT_SSH_COMMAND` or `core.sshCommand` still wins.
 */
function windowsContainedEnv(env: Record<string, string>): Record<string, string> {
	if (process.platform !== "win32" || env.GIT_SSH !== undefined) return {};
	const ssh = windowsOpenSsh();
	return ssh ? { GIT_SSH: ssh } : {};
}

/** Status warning for a configured network mode this host cannot enforce, which runs as `deny`. */
function networkDegradedWarning(mode: SandboxNetworkMode, backend: string): string {
	return mode === "allowlist"
		? "Network allowlist needs loopback proxy confinement, which this host lacks; network is denied instead."
		: `Network mode "${mode}" on ${backend} needs the host networking tools (slirp4netns, iptables), which this host lacks; network is denied instead.`;
}

/** Status warning on Windows: what the processcontainer sandbox cannot run (docs/sandbox.md, "Windows"). */
const WINDOWS_LIMITATION_WARNING =
	"Windows: some programs cannot start inside the sandbox and fail with exit code 0xC0000142 (STATUS_DLL_INIT_FAILED), for example Git Bash and other MSYS2/Cygwin tools, so git hooks fail too. Native Windows programs and the shell's built-in commands work. See the Windows section of docs/sandbox.md.";

// ── Per-realm state ──────────────────────────────────────────────────────────
// Module state lives per JS realm. Subagents on worker threads replicate the main thread's session
// grants and report their proxy refusals to it through the sandbox thread service
// (`thread/services/sandbox.ts`, via the seam below); `always` grants reach them through settings.

let supportProbe: SandboxSupport | undefined;
let warningSink: SandboxWarningSink | undefined;
let unavailableWarned = false;
let hostApprover: SandboxHostApprover | undefined;
/** Hosts allowed for the rest of this realm (`session` approvals and `always` grants). */
const sessionGrants = new Set<string>();
/** Proxy refusals: host → time of its latest refusal, least recent first. */
const blockedLog = new Map<string, number>();
let accessApprover: SandboxAccessApprover | undefined;
/** Exact paths granted for the rest of this realm, realpath'd; a write grant also reads. */
const sessionPathGrants = { write: new Set<string>(), read: new Set<string>() };
/** Bumped on every session path grant change: part of each runtime's cached fingerprint. */
let pathGrantRevision = 0;
/** A dialog being asked or queued, shared by identical requests; aborts once every waiter gave up. */
interface PendingAccess {
	answer: Promise<SandboxAccessOutcome>;
	controller: AbortController;
	waiters: number;
}
/** Access requests waiting for an answer, by kind and target; identical requests share one. */
const pendingAccess = new Map<string, PendingAccess>();
/** Line breaks and terminal control characters, which no access target may contain. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
/** Tail of the one-dialog-at-a-time queue. */
let accessQueue: Promise<unknown> = Promise.resolve();
/** The list setting an `always` answer appends to, per access kind. */
const ACCESS_LISTS = {
	write: cfgSandboxAllowWrite,
	read: cfgSandboxAllowRead,
	host: cfgSandboxAllowedHosts,
} as const satisfies Record<SandboxAccessKind, Setting<string[]>>;
/**
 * Egress proxies per runtime, then per allowlist a contained process started under. Each process
 * reaches only the hosts its runtime listed when it started plus hosts you add to your own list
 * later, so it never gains another runtime's list or one a later project leaves in (a
 * `reloadForCwd` changes the settings in place).
 */
const proxies = new Map<SandboxRuntime, Map<string, Promise<EgressProxy>>>();
let cancelProxyCleanup: (() => void) | undefined;
/** Live runtimes by settings instance, then realpath'd workspace. */
const runtimes = new WeakMap<Settings, Map<string, SandboxRuntime>>();
/** Workspace paths as given → the canonical path at first sight, per realm. */
const workspacePins = new Map<string, string>();
const liveRuntimes = new Set<SandboxRuntime>();

function support(): SandboxSupport {
	supportProbe ??= sandboxSupport();
	return supportProbe;
}

function emitUnavailableWarning(reason: string): void {
	if (unavailableWarned) return;
	unavailableWarned = true;
	const message = `Sandbox unavailable (${reason}); running unsandboxed because sandbox.fallback is "warn".`;
	if (warningSink) warningSink(message);
	else logger.warn(message);
}

/** A runtime's allowlist when a contained process started: effective, and of the operator layers alone. */
interface AllowlistAtStart {
	hosts: ReadonlySet<string>;
	operator: ReadonlySet<string>;
}

/**
 * Exact proxy entries of one process: the hosts `runtime` lists now that it listed when the process
 * started or that the operator layers gained since (you added them), so a removal takes effect live
 * and a project reload adds nothing. Session grants are answered by {@link decideHost} instead, so
 * they keep the proxy's prompt-approved rules (private ranges yes, loopback/link-local/unspecified
 * no) rather than the unrestricted rules of an exact entry.
 */
function proxyAllowedHosts(runtime: SandboxRuntime, atStart: AllowlistAtStart): string[] {
	const operator = runtime.operatorHosts();
	return runtime
		.configuredHosts()
		.filter(host => atStart.hosts.has(host) || (operator.includes(host) && !atStart.operator.has(host)));
}

function notifyAll(): void {
	for (const runtime of liveRuntimes) runtime.notify();
}

/** Session host and path grants of a realm, as a worker realm replicates them. @internal */
export interface SandboxSessionGrants {
	readonly hosts: readonly string[];
	readonly write: readonly string[];
	readonly read: readonly string[];
}

/** Observers of this realm's session grant set (the sandbox thread service). */
const grantListeners = new Set<() => void>();
/** Observers of this realm's proxy refusals (the sandbox thread service). */
const blockedListeners = new Set<(host: string, at: number) => void>();

/** After any change to {@link sessionGrants} or {@link sessionPathGrants}. */
function grantsChanged(): void {
	notifyAll();
	for (const listener of Array.from(grantListeners)) listener();
}

/** This realm's session grants. @internal */
export function sandboxSessionGrants(): SandboxSessionGrants {
	return { hosts: [...sessionGrants], write: [...sessionPathGrants.write], read: [...sessionPathGrants.read] };
}

/** Runs `listener` after every change to this realm's session grants; returns its unsubscribe. @internal */
export function onSandboxSessionGrantsChange(listener: () => void): () => void {
	grantListeners.add(listener);
	return () => {
		grantListeners.delete(listener);
	};
}

/** Replaces this realm's session grants with `grants` (a worker realm's replica of main's). @internal */
export function replicateSandboxSessionGrants(grants: SandboxSessionGrants): void {
	sessionGrants.clear();
	for (const host of grants.hosts) {
		sessionGrants.add(host);
		blockedLog.delete(host);
	}
	for (const kind of ["write", "read"] as const) {
		sessionPathGrants[kind].clear();
		for (const grant of grants[kind]) sessionPathGrants[kind].add(grant);
	}
	// Like a local path grant: invalidates every runtime's cached config and fingerprint.
	pathGrantRevision++;
	grantsChanged();
}

/** Records a proxy refusal of `host` at `at` (this realm's own, or one a worker realm reported). @internal */
export function recordBlockedHost(host: string, at: number = Date.now()): void {
	blockedLog.delete(host);
	blockedLog.set(host, at);
	notifyAll();
	for (const listener of Array.from(blockedListeners)) listener(host, at);
}

/** Runs `listener` after every refusal recorded in this realm; returns its unsubscribe. @internal */
export function onSandboxHostBlocked(listener: (host: string, at: number) => void): () => void {
	blockedListeners.add(listener);
	return () => {
		blockedListeners.delete(listener);
	};
}

/** Allows `host` for this realm; `always` also appends it to the global `sandbox.network.allowedHosts`. */
function grantHostIn(settings: Settings, host: string, scope: "session" | "always"): void {
	sessionGrants.add(host);
	// A grant clears the record; a host the proxy still refuses (resolves to loopback) shows up again.
	blockedLog.delete(host);
	if (scope === "always") {
		// The operator layers only: copying project-layer entries into global config would loosen it.
		const current = cfgSandboxAllowedHosts.get(settings.grantAuthority());
		if (!current.includes(host)) cfgSandboxAllowedHosts.set(settings, [...current, host]);
	}
	grantsChanged();
}

/** `settings` receives an `always` approval: the settings of the runtime the asking process runs under. */
async function decideHost(settings: Settings, host: string, port: number): Promise<boolean> {
	if (hostMatches(host, [...sessionGrants])) return true;
	if (!hostApprover) return false;
	const answer = await hostApprover(host, port);
	switch (answer) {
		case "once":
			return true;
		case "session":
		case "always":
			grantHostIn(settings, host, answer);
			return true;
		case "deny":
			return false;
	}
}

function ensureProxy(runtime: SandboxRuntime, settings: Settings): Promise<EgressProxy> {
	let byAllowlist = proxies.get(runtime);
	if (!byAllowlist) {
		byAllowlist = new Map();
		proxies.set(runtime, byAllowlist);
	}
	const atStart: AllowlistAtStart = {
		hosts: new Set(runtime.configuredHosts()),
		operator: new Set(runtime.operatorHosts()),
	};
	const key = JSON.stringify([[...atStart.hosts].sort(), [...atStart.operator].sort()]);
	const existing = byAllowlist.get(key);
	if (existing) return existing;
	const start = EgressProxy.start({
		allowedHosts: () => proxyAllowedHosts(runtime, atStart),
		decide: (host, port) => decideHost(settings, host, port),
		onBlocked: host => recordBlockedHost(host),
	});
	byAllowlist.set(key, start);
	cancelProxyCleanup ??= postmortem.register("sandbox-egress-proxy", closeProxies);
	start.catch(() => {
		if (byAllowlist.get(key) === start) byAllowlist.delete(key);
	});
	return start;
}

async function closeProxies(): Promise<void> {
	const starts = [...proxies.values()].flatMap(byAllowlist => [...byAllowlist.values()]);
	proxies.clear();
	cancelProxyCleanup?.();
	cancelProxyCleanup = undefined;
	await Promise.all(starts.map(async start => (await start.catch(() => undefined))?.close()));
}

// ── Policy context gathering ─────────────────────────────────────────────────

/** Realpath of `p`, or `undefined` when it does not exist. */
function realpathIfExists(p: string): string | undefined {
	try {
		return fs.realpathSync(p);
	} catch {
		return undefined;
	}
}

function realpathOrSelf(p: string): string {
	return realpathIfExists(p) ?? path.resolve(p);
}

/**
 * Absolute form of `p` with symlinks resolved through its longest existing ancestor, so a path
 * that does not exist yet (a build dir about to be created) still names its real location.
 */
function realpathThroughAncestors(p: string): string {
	const absolute = path.resolve(p);
	const real = realpathIfExists(absolute);
	if (real !== undefined) return real;
	const parent = path.dirname(absolute);
	return parent === absolute ? absolute : path.join(realpathThroughAncestors(parent), path.basename(absolute));
}

/**
 * Canonical hostname of an access request: lower-case, no trailing dot, a bare name or IPv4
 * literal only.
 * @throws SandboxAccessError for wildcards, schemes, ports, paths or anything not a hostname.
 */
function canonicalAccessHost(raw: string): string {
	const host = raw.trim().toLowerCase().replace(/\.$/, "");
	if (!host || /[\s*/:@?#[\]]/.test(host)) {
		throw new SandboxAccessError(
			`"${raw}" is not a hostname: give the exact host, without scheme, port or wildcard.`,
		);
	}
	let parsed: string;
	try {
		parsed = new URL(`http://${host}/`).hostname;
	} catch {
		throw new SandboxAccessError(`"${raw}" is not a valid hostname.`);
	}
	if (parsed !== host) throw new SandboxAccessError(`"${raw}" is not a valid hostname.`);
	return host;
}

/**
 * Whether a global write to `list` would not take effect: a layer above global config sets it,
 * or project config narrows it (project lists only keep entries the operator layers also hold).
 */
function listLocked(list: Setting<string[]>, settings: Settings): boolean {
	const provenance = list.provenance(settings);
	return provenance === "env" || provenance === "runtime" || provenance === "overlay" || provenance === "project";
}

/**
 * Existing entries of `paths`, realpath'd. With `access`, entries the invoking user cannot access
 * that way are dropped too: bubblewrap refuses a whole request naming a path such as `/root`.
 */
function existingReal(paths: readonly string[], access?: number): string[] {
	const out: string[] = [];
	for (const p of paths) {
		const real = realpathIfExists(p);
		if (real === undefined) continue;
		if (access !== undefined) {
			try {
				fs.accessSync(real, access);
			} catch {
				continue;
			}
		}
		out.push(real);
	}
	return out;
}

/**
 * Root of the JS tree omp runs from, so hoisted dependencies and monorepo siblings stay readable:
 * in an installed layout the outermost `node_modules` directory above the package, in a checkout
 * the nearest ancestor holding `.git` (the package directory when there is none). `undefined` for
 * compiled binaries.
 */
function sourceRoot(): string | undefined {
	const packageDir = getPackageDir();
	if (!packageDir) return undefined;
	const segments = packageDir.split(path.sep);
	const nodeModules = segments.indexOf("node_modules");
	if (nodeModules !== -1) return segments.slice(0, nodeModules + 1).join(path.sep);
	for (let dir = packageDir; dir !== path.dirname(dir); dir = path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
	}
	return packageDir;
}

/**
 * Directory of the loaded `pi_natives` addon. `@oh-my-pi/pi-natives` does not export the loaded
 * addon's path, so this is the package's `native/` directory, where a checkout or npm install loads
 * it from; compiled binaries extract it under {@link getNativesDir}, which is added separately.
 */
function nativeAddonDir(): string | undefined {
	try {
		const entry = url.fileURLToPath(import.meta.resolve("@oh-my-pi/pi-natives"));
		return fs.existsSync(entry) ? path.dirname(entry) : undefined;
	} catch {
		return undefined;
	}
}

/** Git metadata outside the workspace that contained git reads (`read`) and writes (`write`) to commit. */
interface GitGrant {
	read: string;
	write: string[];
}

/** Common-dir stores a linked worktree's commits and fetches write: objects, refs and reflogs. */
const LINKED_WORKTREE_STORES = ["objects", "refs", "logs", "reftable"] as const;

/**
 * Git metadata contained git needs to commit, when it lies outside the workspace; `undefined`
 * otherwise. Covers a linked worktree rooted at the workspace and a workspace that is a strict
 * subdirectory of a checkout: an ordinary one (its `.git` directory, which git writes at its root)
 * or a linked worktree. Never granted for a repository rooted at the filesystem root, the home
 * directory or an ancestor of it (a dotfiles repo at `~`).
 *
 * A linked worktree's common dir is shared with the main checkout and every other worktree, so it is
 * readable but only its object, ref and reflog stores are writable, plus this worktree's own
 * `worktrees/<name>` (index, HEAD). Its `hooks/`, `config` and other worktrees' metadata stay
 * read-only: host git in the main checkout runs those, and the worktree's diff never shows them.
 *
 * The workspace's `.git` metadata is writable by contained processes, so a linked worktree's common
 * dir is accepted only when it has the real linked-worktree shape: the git dir is
 * `<commonDir>/worktrees/<name>` outside the workspace, and its `gitdir` back-pointer (written by
 * git, outside the workspace) names the worktree's `.git` entry.
 */
function gitGrant(workspace: string, home: string, platform: NodeJS.Platform): GitGrant | undefined {
	try {
		const info = vcs.gitInfo(workspace);
		if (!info) return undefined;
		// A symlinked entry would let a contained process point the comparison at another worktree.
		const entryStat = fs.lstatSync(info.gitEntryPath);
		if (entryStat.isSymbolicLink()) return undefined;
		const entry = realpathIfExists(info.gitEntryPath);
		if (!entry) return undefined;
		const repoRoot = path.dirname(entry);
		if (repoRoot === path.dirname(repoRoot) || isWithin(home, repoRoot, platform)) return undefined;
		const atWorkspace = isWithin(workspace, repoRoot, platform) && isWithin(repoRoot, workspace, platform);
		if (!atWorkspace && !isWithin(workspace, repoRoot, platform)) return undefined;
		const gitDir = realpathIfExists(info.gitDir);
		const commonDir = realpathIfExists(info.commonDir);
		if (!gitDir || !commonDir) return undefined;
		if (entryStat.isDirectory()) {
			// Ordinary checkout: at the workspace root its `.git` is already writable.
			if (atWorkspace || gitDir !== entry || commonDir !== entry) return undefined;
			return { read: entry, write: [entry] };
		}
		if (gitDir === commonDir) return undefined;
		const worktrees = path.dirname(gitDir);
		if (path.basename(worktrees) !== "worktrees" || path.dirname(worktrees) !== commonDir) return undefined;
		if (isWithin(gitDir, workspace, platform)) return undefined;
		const backPointer = fs.readFileSync(path.join(gitDir, "gitdir"), "utf8").trim();
		if (realpathIfExists(path.resolve(gitDir, backPointer)) !== entry) return undefined;
		// A store replaced by a symlink would carry the grant out of the common dir.
		const stores = LINKED_WORKTREE_STORES.map(store => path.join(commonDir, store)).filter(
			store => realpathIfExists(store) === store,
		);
		return { read: commonDir, write: [gitDir, ...stores] };
	} catch (error) {
		logger.debug("sandbox: git dir lookup failed", { workspace, error: String(error) });
		return undefined;
	}
}

/** Everything in {@link SandboxPolicyContext} except the per-request extras. */
type BaseContext = Omit<SandboxPolicyContext, "extraRead" | "extraWrite"> & { git?: GitGrant };

/**
 * Synchronous (~10 ms, once per runtime) so {@link SandboxRuntime.effectivePolicy} can stay
 * synchronous. `tmpdir` is the runtime's private temp dir, the only writable temp root.
 */
function gatherContext(workspace: string, tmpdir: string): BaseContext {
	const platform = process.platform;
	const home = realpathOrSelf(os.homedir());
	const rootEntries = platform === "win32" ? [] : fs.readdirSync("/").map(name => path.posix.join("/", name));
	const discovered = sandboxDiscoverPaths(definedEnv(process.env));
	const runtimePaths = ompRuntimePaths(platform, {
		execPath: process.execPath,
		nativeAddonPath: nativeAddonDir(),
		packageRoot: sourceRoot(),
	});
	runtimePaths.push(getNativesDir());
	return {
		workspace,
		home,
		tmpdir,
		platform,
		rootEntries,
		discovered,
		runtimePaths,
		git: gitGrant(workspace, home, platform),
	};
}

/** Whether `canonical` exists, is not a symlink, and still resolves to itself. */
function stillCanonical(canonical: string): boolean {
	const stat = fs.lstatSync(canonical, { throwIfNoEntry: false });
	return stat !== undefined && !stat.isSymbolicLink() && realpathIfExists(canonical) === canonical;
}

/**
 * Recreates a missing canonical write grant as an empty directory, never through a symlink: only
 * while its parent still resolves to itself. Best effort; a grant that stays missing is simply not
 * materialised.
 */
function recreateMissingGrant(grant: string): void {
	const parent = path.dirname(grant);
	if (realpathIfExists(parent) !== parent) return;
	try {
		fs.mkdirSync(grant);
	} catch (error) {
		logger.debug("sandbox: recreating a missing session write grant failed", { path: grant, error: String(error) });
	}
}

/**
 * `policy` restricted to existing paths the user can access, each realpath'd (macOS `/tmp` →
 * `/private/tmp`), then compacted again; readable entries inside a writable one are dropped.
 */
function materialize(policy: ResolvedFsPolicy, platform: NodeJS.Platform): ResolvedFsPolicy {
	const { R_OK, W_OK } = fs.constants;
	const readwritePaths = compactPaths(existingReal(policy.readwritePaths, R_OK | W_OK), platform);
	const readonlyPaths = compactPaths(existingReal(policy.readonlyPaths, R_OK), platform).filter(
		entry => !readwritePaths.some(rw => isWithin(entry, rw, platform)),
	);
	return { readwritePaths, readonlyPaths, deniedPaths: compactPaths(existingReal(policy.deniedPaths), platform) };
}

// ── Runtime ──────────────────────────────────────────────────────────────────

interface ConfigSnapshot {
	revision: number;
	/** {@link pathGrantRevision} the snapshot was read at. */
	grants: number;
	config: SandboxConfig;
	fingerprint: string;
}

export class SandboxRuntime {
	readonly #settings: Settings;
	readonly #workspace: string;
	/** Gathered on first policy use, so a disabled sandbox never pays for the native discovery and fs probing. */
	#context: BaseContext | undefined;
	/** Writable `allowWrite`/`extraWrite` entries (expanded) → the canonical path first resolved. */
	readonly #writePins = new Map<string, string>();
	/** Re-pointed write entries already warned about. */
	readonly #warnedPins = new Set<string>();
	/** Private writable temp root of contained processes (`TMPDIR`); created on first policy use. */
	#tempDir: string | undefined;
	#cancelTempDirCleanup: (() => void) | undefined;
	readonly #listeners = new Set<() => void>();
	readonly #unsubscribe: () => void;
	#snapshot: ConfigSnapshot;
	/**
	 * What the change listeners last saw: the fingerprint plus the allowlist and ignored project values,
	 * which the fingerprint leaves out but listeners display. Reads may refresh {@link #snapshot}
	 * before the settings listener runs.
	 */
	#notifiedView: string;
	#disposed = false;

	private constructor(settings: Settings, workspace: string) {
		this.#settings = settings;
		this.#workspace = workspace;
		this.#snapshot = this.#read();
		this.#notifiedView = this.#view();
		this.#unsubscribe = cfgSandboxAll.listen(settings, () => {
			const view = this.#view();
			if (view === this.#notifiedView) return;
			this.#notifiedView = view;
			this.notify();
		});
	}

	/**
	 * One runtime per resolved workspace directory (realpath'd when it exists); settings are the
	 * process-global instance. Cheap: the policy context is gathered on first policy use.
	 */
	static async for(workspace: string): Promise<SandboxRuntime> {
		const settings = await Settings.init();
		const absolute = path.resolve(workspace);
		// Pinned on first sight: a workspace a contained process replaced with a symlink keeps its
		// original runtime, whose spawns then fail closed.
		let resolved = workspacePins.get(absolute);
		if (resolved === undefined) {
			// The resolver `stillCanonical` uses, so the pin and the spawn check cannot disagree.
			resolved = realpathIfExists(absolute);
			if (resolved !== undefined) workspacePins.set(absolute, resolved);
			else resolved = absolute;
		}
		let bySettings = runtimes.get(settings);
		if (!bySettings) {
			bySettings = new Map();
			runtimes.set(settings, bySettings);
		}
		let runtime = bySettings.get(resolved);
		if (!runtime) {
			runtime = new SandboxRuntime(settings, resolved);
			bySettings.set(resolved, runtime);
			liveRuntimes.add(runtime);
		}
		return runtime;
	}

	/**
	 * The runtime `scope` runs contained under in `workspace`, or `undefined` when it runs
	 * unsandboxed. A disabled sandbox never creates a runtime (or touches native probes). Throws
	 * `SandboxUnavailableError` when the sandbox is required but no backend can provide it.
	 */
	static async forScope(workspace: string, scope: SandboxScope | "mcp"): Promise<SandboxRuntime | undefined> {
		if (!readSandboxConfig(await Settings.init()).enabled) return undefined;
		const runtime = await SandboxRuntime.for(workspace);
		return runtime.applies(scope) ? runtime : undefined;
	}

	/**
	 * Test seam: number of live (undisposed) runtimes in this realm.
	 * @internal
	 */
	static liveCountForTest(): number {
		return liveRuntimes.size;
	}

	/** Interactive mode, and RPC mode after `set_sandbox_host_prompts`, install this; without it unknown hosts are refused. */
	static setHostApprover(approver: SandboxHostApprover | undefined): void {
		hostApprover = approver;
	}

	/** Where the one "enabled but unavailable" warning goes; `undefined` restores `logger.warn`. */
	static setWarningSink(sink: SandboxWarningSink | undefined): void {
		warningSink = sink;
	}

	/**
	 * Test seam: replaces the probed backend availability (`undefined` re-probes on next use) and
	 * clears per-realm session state (the once-only unavailable warning, host grants, blocked log,
	 * and the pooled egress proxy, which is closed in the background).
	 * @internal
	 */
	static resetForTest(supportOverride?: SandboxSupport): void {
		supportProbe = supportOverride;
		unavailableWarned = false;
		sessionGrants.clear();
		blockedLog.clear();
		sessionPathGrants.write.clear();
		sessionPathGrants.read.clear();
		pathGrantRevision++;
		pendingAccess.clear();
		workspacePins.clear();
		accessQueue = Promise.resolve();
		void closeProxies();
	}

	status(): SandboxStatus {
		const { config } = this.#current();
		if (!config.enabled) return { state: "off" };
		const probe = support();
		if (!probe.supported) {
			return { state: "unavailable", reason: probe.reason ?? "unsupported platform", fallback: config.fallback };
		}
		const network = this.#effectiveNetwork(config.networkMode);
		const backend = probe.backend ?? "unknown";
		const warnings = [...probe.warnings];
		if (network !== config.networkMode) warnings.push(networkDegradedWarning(config.networkMode, backend));
		if (backend === "processcontainer") warnings.push(WINDOWS_LIMITATION_WARNING);
		return { state: "active", backend, network, warnings };
	}

	/** True when `scope` must run contained. Throws SandboxUnavailableError when unavailable and fallback is "block". */
	applies(scope: SandboxScope | "mcp"): boolean {
		const { config } = this.#current();
		if (!config.enabled) return false;
		if (scope !== "mcp" && !config.scope.includes(scope)) return false;
		const probe = support();
		if (probe.supported) return true;
		const reason = probe.reason ?? "unsupported platform";
		if (config.fallback === "block") throw new SandboxUnavailableError(reason);
		emitUnavailableWarning(reason);
		return false;
	}

	/** Changes whenever the effective policy changes; part of the bash session key. */
	fingerprint(): string {
		return this.#current().fingerprint;
	}

	/**
	 * Filesystem policy the next {@link spawn} would use, without per-request extras. Recomputed on
	 * every call: path existence (a denied store created later, a new writable dir) is live.
	 */
	effectivePolicy(): ResolvedFsPolicy {
		return this.#policy(this.#current().config);
	}

	/**
	 * Private temp directory of this runtime's contained processes: their only writable temp root
	 * and their `TMPDIR`/`TMP`/`TEMP`, so the shared system temp dir — files the parent later sources
	 * or runs, other programs' control sockets — stays out of reach. Created (mode 0700) on first use,
	 * recreated if a contained process removed it, deleted on {@link dispose} and at process exit.
	 */
	tempDir(): string {
		const current = this.#tempDir;
		if (current !== undefined) {
			// Contained processes may remove or replace their writable root: never follow a replacement.
			const stat = fs.lstatSync(current, { throwIfNoEntry: false });
			if (stat?.isDirectory()) return current;
			if (stat === undefined) {
				try {
					fs.mkdirSync(current, { mode: 0o700 });
					return current;
				} catch {}
			}
			this.#cancelTempDirCleanup?.();
			this.#cancelTempDirCleanup = undefined;
			this.#tempDir = undefined;
		}
		// Short name: macOS `sun_path` is 104 bytes and the Python tool bridge's socket lives here.
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-sb-")));
		this.#tempDir = dir;
		this.#cancelTempDirCleanup = postmortem.register("sandbox-temp-dir", () => {
			fs.rmSync(dir, { recursive: true, force: true });
		});
		return dir;
	}

	async spawn(request: SandboxSpawnRequest): Promise<SandboxChild> {
		const probe = support();
		if (!probe.supported) throw new SandboxUnavailableError(probe.reason ?? "unsupported platform");
		// Fail closed: a workspace replaced by a symlink (or removed) must not be followed or recreated.
		if (!stillCanonical(this.#workspace)) {
			throw new Error(
				`Sandbox workspace path was replaced: ${this.#workspace} is missing or no longer resolves to itself; refusing to run contained commands there.`,
			);
		}
		const { config } = this.#current();
		const network = this.#effectiveNetwork(request.network ?? config.networkMode);
		if (request.network !== undefined && network !== request.network) {
			// `status()` only describes the configured mode; say so for a degraded per-request override.
			logger.warn("sandbox: requested network mode is not enforceable here; network is denied instead", {
				requested: request.network,
				effective: network,
			});
		}
		let policy: NativeSandboxPolicy;
		const fsPolicy = this.#policy(config, request.extraWrite, request.extraRead);
		const tempDir = this.tempDir();
		if (network === "allowlist") {
			const proxy = await ensureProxy(this, this.#settings);
			policy = { ...fsPolicy, network: "proxy", proxyUrl: proxy.url, listVolumeRoots: config.listDrives };
		} else {
			policy = { ...fsPolicy, network, listVolumeRoots: config.listDrives };
		}
		return spawnSandboxChild({
			argv: request.argv,
			cwd: request.cwd,
			env: {
				...request.env,
				...windowsContainedEnv(request.env),
				OMP_SANDBOX: "1",
				TMPDIR: tempDir,
				TMP: tempDir,
				TEMP: tempDir,
			},
			policy,
		});
	}

	/**
	 * Result annotation for one contained call; `undefined` unless active. `blockedHosts` lists the
	 * hosts the proxy refused since `blockedSince`; `denied` flags denial-looking `output` (callers
	 * pass `output` only for a non-zero exit); `startFailed` flags a Windows program that could not
	 * start under the sandbox, seen in `exitCode` or reported in `output`.
	 */
	resultMeta(extra?: { blockedSince?: number; output?: string; exitCode?: number }): SandboxResultMeta | undefined {
		const status = this.status();
		if (status.state !== "active") return undefined;
		const meta: SandboxResultMeta = {
			backend: status.backend,
			mode: this.#current().config.mode,
			network: status.network,
		};
		const since = extra?.blockedSince;
		if (since !== undefined) {
			const hosts = [...blockedLog].filter(([, at]) => at >= since).map(([host]) => host);
			if (hosts.length > 0) meta.blockedHosts = hosts;
		}
		if (extra?.output !== undefined && DENIAL_PATTERN.test(extra.output)) meta.denied = true;
		if (process.platform === "win32") {
			const exitCode = extra?.exitCode;
			if (
				(exitCode !== undefined && exitCode >>> 0 === STATUS_DLL_INIT_FAILED) ||
				(extra?.output !== undefined && DLL_INIT_FAILED_PATTERN.test(extra.output))
			) {
				meta.startFailed = true;
			}
		}
		return meta;
	}

	/** Hosts refused this session that are still not allowed, most recent first. */
	blockedHosts(): readonly string[] {
		const allowed = this.#current().config.allowedHosts;
		const hosts: string[] = [];
		for (const host of blockedLog.keys()) if (!hostMatches(host, allowed)) hosts.push(host);
		return hosts.reverse();
	}

	/** Allows `host` for this JS realm; `always` also appends it to the global `sandbox.network.allowedHosts`. */
	async grantHost(host: string, scope: "session" | "always"): Promise<void> {
		grantHostIn(this.#settings, host, scope);
	}

	/** Hosts this JS realm allows through a session grant that the configured allowlist does not list exactly. */
	sessionHosts(): readonly string[] {
		const configured = this.#current().config.allowedHosts;
		return [...sessionGrants].filter(host => !configured.includes(host));
	}

	/** Drops the session grant of `host` (a persisted allowlist entry stays); notifies listeners when one existed. */
	revokeHost(host: string): void {
		if (sessionGrants.delete(host)) grantsChanged();
	}

	/** Interactive mode and RPC mode (after `set_sandbox_access_prompts`) install this; without it access requests are refused. */
	static setAccessApprover(approver: SandboxAccessApprover | undefined): void {
		accessApprover = approver;
	}

	/**
	 * Asks the user (through the installed approver) to let contained commands write, read or reach
	 * `input.target`. Never prompts for a target that is invalid, protected, already allowed, or that
	 * the current mode cannot grant; one request at a time per realm, identical requests share it.
	 * Rejects with `signal`'s reason when `signal` aborts first; other callers sharing the dialog are
	 * unaffected, and a queued request every caller abandoned never reaches the approver.
	 */
	async requestAccess(input: SandboxAccessInput, signal?: AbortSignal): Promise<SandboxAccessOutcome> {
		signal?.throwIfAborted();
		const intent = input.intent.trim();
		if (!intent) return { status: "refused", reason: "Say what you are trying to do: intent is empty." };
		const status = this.status();
		if (status.state === "off") return { status: "refused", reason: "The sandbox is off; nothing to request." };
		if (status.state === "unavailable") {
			return { status: "refused", reason: `The sandbox is unavailable here (${status.reason}).` };
		}
		// Every UI interpolates the target: no line breaks or terminal control sequences.
		if (CONTROL_CHARACTERS.test(input.target)) {
			return { status: "refused", reason: "Invalid target: it contains control characters or line breaks." };
		}
		let target: string;
		try {
			target = input.kind === "host" ? canonicalAccessHost(input.target) : this.#accessPath(input.target, input.cwd);
		} catch (error) {
			return { status: "refused", reason: error instanceof Error ? error.message : String(error) };
		}
		const { config } = this.#current();
		if (input.kind === "write" && config.mode === "read-only") {
			return {
				status: "refused",
				reason: "The sandbox is in read-only mode; only the user can switch it to workspace-write.",
			};
		}
		if (input.kind === "host") {
			// The allowlist applies only in `allowlist` mode (as enforced: a degraded mode counts).
			if (status.network === "deny") {
				return {
					status: "refused",
					reason: "Network is off for contained commands; only the user can change sandbox.network.mode.",
				};
			}
			if (status.network === "allow") return { status: "already-allowed", target };
		}
		if (this.#allows(input.kind, target)) return { status: "already-allowed", target };
		const approver = accessApprover;
		if (!approver) {
			return { status: "refused", reason: "No one to ask: access requests need an interactive approver." };
		}
		const key = `${input.kind}\0${target}`;
		let pending = pendingAccess.get(key);
		if (!pending) {
			const request: SandboxAccessRequest = {
				kind: input.kind,
				target,
				intent,
				command: input.command?.trim() || undefined,
				alternative: input.alternative?.trim() || undefined,
				workspace: this.#workspace,
				canAlways: !listLocked(ACCESS_LISTS[input.kind], this.#settings),
			};
			// The dialog's own signal aborts once every caller waiting on it has given up.
			const controller = new AbortController();
			// One dialog at a time per realm: queue behind whatever is being asked.
			const answer = accessQueue.then(() => this.#ask(approver, request, controller.signal));
			accessQueue = answer.catch(() => undefined);
			const entry: PendingAccess = { answer, controller, waiters: 0 };
			pending = entry;
			pendingAccess.set(key, entry);
			void answer
				.finally(() => {
					if (pendingAccess.get(key) === entry) pendingAccess.delete(key);
				})
				.catch(() => undefined);
		}
		pending.waiters++;
		try {
			return await untilAborted(signal, () => pending.answer);
		} finally {
			if (--pending.waiters === 0) {
				pending.controller.abort(signal?.reason);
				// A later identical request must open its own dialog, not join this abandoned one.
				if (pendingAccess.get(key) === pending) pendingAccess.delete(key);
			}
		}
	}

	/**
	 * Allows contained commands to write (and read) or read exactly `target` for this realm, or
	 * (`always`) appends it to the global `sandbox.filesystem.allowWrite`/`allowRead`. A write
	 * target that does not exist yet is created (an empty directory): policy entries must exist.
	 * @throws SandboxAccessError for an invalid, root or protected path, or `always` on a locked list.
	 */
	grantPath(kind: "write" | "read", target: string, scope: "session" | "always"): void {
		const resolved = this.#accessPath(target);
		const list = ACCESS_LISTS[kind];
		if (scope === "always" && listLocked(list, this.#settings)) {
			throw new SandboxAccessError(`${list.id} cannot be changed here: it is set outside your config.`);
		}
		if (kind === "write" && !fs.existsSync(resolved)) {
			try {
				fs.mkdirSync(resolved, { recursive: true });
			} catch (error) {
				logger.debug("sandbox: creating a granted write target failed", { target: resolved, error: String(error) });
			}
		}
		if (scope === "always") {
			list.setMember(this.#settings, resolved, { member: true });
			notifyAll();
		} else {
			sessionPathGrants[kind].add(resolved);
			pathGrantRevision++;
			grantsChanged();
		}
	}

	/** Drops a session path grant (persisted entries stay); notifies listeners when one existed. */
	revokePath(kind: "write" | "read", target: string): void {
		const grants = sessionPathGrants[kind];
		const resolved = realpathThroughAncestors(path.resolve(this.#workspace, expandTilde(target.trim())));
		if (!grants.delete(resolved) && !grants.delete(target)) return;
		pathGrantRevision++;
		grantsChanged();
	}

	/** Paths this realm granted for the session, by kind. */
	sessionPaths(): { write: readonly string[]; read: readonly string[] } {
		return { write: [...sessionPathGrants.write], read: [...sessionPathGrants.read] };
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe();
		this.#listeners.clear();
		liveRuntimes.delete(this);
		runtimes.get(this.#settings)?.delete(this.#workspace);
		this.#removeTempDir();
		if (liveRuntimes.size === 0) await closeProxies();
	}

	#removeTempDir(): void {
		this.#cancelTempDirCleanup?.();
		this.#cancelTempDirCleanup = undefined;
		if (this.#tempDir !== undefined) fs.rmSync(this.#tempDir, { recursive: true, force: true });
		this.#tempDir = undefined;
		// The cached policy context names the removed directory.
		this.#context = undefined;
	}

	/** Configured allowlist (proxy input). @internal */
	configuredHosts(): readonly string[] {
		return this.#current().config.allowedHosts;
	}

	/** The allowlist of the operator layers alone (yours, never a project's). @internal */
	operatorHosts(): readonly string[] {
		return cfgSandboxAllowedHosts.get(this.#settings.grantAuthority());
	}

	/** Runs the change listeners. @internal */
	notify(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch (error) {
				logger.warn("sandbox: change listener failed", { error: String(error) });
			}
		}
	}

	#current(): ConfigSnapshot {
		if (this.#snapshot.revision !== this.#settings.revision || this.#snapshot.grants !== pathGrantRevision) {
			this.#snapshot = this.#read();
		}
		return this.#snapshot;
	}

	/** What change listeners display: the fingerprint plus the allowlist and ignored project values it leaves out. */
	#view(): string {
		const { fingerprint, config } = this.#current();
		return JSON.stringify([fingerprint, config.allowedHosts, config.ignored]);
	}

	#read(): ConfigSnapshot {
		const revision = this.#settings.revision;
		const grants = pathGrantRevision;
		const config = readSandboxConfig(this.#settings);
		// The proxy reads the allowlist live, so approving a host must not retire running hosts and kernels.
		const { ignored: _ignored, allowedHosts: _allowedHosts, ...effective } = config;
		// Session path grants change the policy: contained shells and kernels restart to pick them up.
		const paths = [[...sessionPathGrants.write], [...sessionPathGrants.read]];
		const fingerprint = Bun.hash(JSON.stringify([this.#workspace, effective, paths])).toString(36);
		return { revision, grants, config, fingerprint };
	}

	async #ask(
		approver: SandboxAccessApprover,
		request: SandboxAccessRequest,
		signal: AbortSignal | undefined,
	): Promise<SandboxAccessOutcome> {
		signal?.throwIfAborted();
		// The answer to an earlier queued request may already cover this one.
		if (this.#allows(request.kind, request.target)) return { status: "already-allowed", target: request.target };
		const answer = await approver(request, signal);
		const { kind, target } = request;
		switch (answer.decision) {
			case "deny":
				return { status: "denied", target };
			case "instruct":
				return { status: "instructed", target, instructions: answer.instructions };
			case "session":
			case "always": {
				const scope = answer.decision === "always" && request.canAlways ? "always" : "session";
				try {
					if (kind === "host") grantHostIn(this.#settings, target, scope);
					else this.grantPath(kind, target, scope);
				} catch (error) {
					return { status: "refused", reason: error instanceof Error ? error.message : String(error) };
				}
				return { status: "granted", scope, target };
			}
		}
	}

	/** Whether the effective policy (configured lists plus session grants) already allows `kind` on `target`. */
	#allows(kind: SandboxAccessKind, target: string): boolean {
		if (kind === "host") return hostMatches(target, [...this.#current().config.allowedHosts, ...sessionGrants]);
		const policy = this.effectivePolicy();
		const platform = process.platform;
		const under = (roots: readonly string[]) => roots.some(root => isWithin(target, root, platform));
		if (kind === "write") return under(policy.readwritePaths);
		return (under(policy.readwritePaths) || under(policy.readonlyPaths)) && !under(policy.deniedPaths);
	}

	/**
	 * Why omp's in-process file tools may not `kind` the absolute path `target` under the effective
	 * policy (configured lists plus session grants), or `undefined` when they may. `protected` marks
	 * a `denyRead` hit, which no access request can lift. `recursive` is a call that reaches below
	 * `target` (a tree search or a glob rewrite): a protected path inside it refuses it too.
	 */
	fileAccessDenial(
		kind: "read" | "write",
		target: string,
		recursive = false,
	): { reason: string; protected: boolean } | undefined {
		const platform = process.platform;
		const resolved = realpathThroughAncestors(target);
		const policy = this.effectivePolicy();
		const under = (roots: readonly string[]) => roots.some(root => isWithin(resolved, root, platform));
		if (under(policy.deniedPaths)) {
			return { reason: `${resolved} is protected by sandbox.filesystem.denyRead`, protected: true };
		}
		if (recursive) {
			const inside = policy.deniedPaths.find(denied => isWithin(denied, resolved, platform));
			if (inside !== undefined) {
				return {
					reason: `${resolved} contains ${inside}, protected by sandbox.filesystem.denyRead; name a narrower path`,
					protected: true,
				};
			}
		}
		// The readable roots contained processes get, so `readScope: all` stops where theirs does
		// (device and virtual trees, Linux `/tmp`, everything outside the profile on Windows).
		const allowed = under(policy.readwritePaths) || (kind === "read" && under(policy.readonlyPaths));
		if (allowed) return undefined;
		const roots = kind === "write" ? "writable" : "readable";
		return { reason: `${resolved} is outside the sandbox's ${roots} roots`, protected: false };
	}

	/**
	 * Absolute, realpath-or-self form of a requested path (`~` expanded, relative against `cwd` or the
	 * workspace).
	 * @throws SandboxAccessError for a filesystem root or a path at or under a denied entry.
	 */
	#accessPath(target: string, cwd?: string): string {
		const trimmed = target.trim();
		if (!trimmed) throw new SandboxAccessError("The target path is empty.");
		const platform = process.platform;
		const resolved = realpathThroughAncestors(path.resolve(cwd ?? this.#workspace, expandTilde(trimmed)));
		if (isFilesystemRoot(resolved, platform)) throw new SandboxAccessError("A filesystem root cannot be granted.");
		const tmpdir = this.tempDir();
		const ctx = { workspace: this.#workspace, home: os.homedir(), tmpdir, platform };
		for (const entry of this.#current().config.denyRead) {
			const denied = realpathOrSelf(expandSandboxPath(entry, ctx));
			if (isWithin(resolved, denied, platform)) {
				throw new SandboxAccessError(`${resolved} is protected by sandbox.filesystem.denyRead (${entry}).`);
			}
		}
		return resolved;
	}

	/**
	 * `mode` as this host can enforce it: `allowlist` needs proxy confinement, and on bubblewrap
	 * every non-`deny` mode needs the same host networking tools; otherwise network is denied.
	 */
	#effectiveNetwork(mode: SandboxNetworkMode): SandboxNetworkMode {
		const probe = support();
		if (probe.proxy || mode === "deny") return mode;
		return mode === "allowlist" || probe.backend === "bubblewrap" ? "deny" : mode;
	}

	#policy(config: SandboxConfig, extraWrite?: readonly string[], extraRead?: readonly string[]): ResolvedFsPolicy {
		const tempDir = this.tempDir();
		if (this.#context?.tmpdir !== tempDir) this.#context = gatherContext(this.#workspace, tempDir);
		const { git, ...context } = this.#context;
		const platform = context.platform;
		// Writable roots are pinned to the canonical path they had when first admitted: a contained
		// process can replace a writable root with a symlink, which must never be followed.
		const sessionWrites = this.#intactSessionWrites();
		const pin = (entries: readonly string[]) => entries.flatMap(entry => this.#pinnedWrite(entry, context));
		const allowWrite = pin(config.allowWrite);
		const pinnedExtra = pin([...(git?.write ?? []), ...(extraWrite ?? [])]);
		const write = [...sessionWrites, ...pinnedExtra];
		// Readable too: read-only mode drops `extraWrite`, and `readScope: workspace` would hide it.
		const read = [...(git ? [git.read] : []), ...sessionWrites, ...sessionPathGrants.read, ...(extraRead ?? [])];
		const resolved = materialize(
			resolveFsPolicy({ ...config, allowWrite }, { ...context, extraWrite: write, extraRead: read }),
			platform,
		);
		const workspaceIntact = stillCanonical(this.#workspace);
		const pinned = new Set([tempDir, ...allowWrite, ...write, ...(workspaceIntact ? [this.#workspace] : [])]);
		const replacedWorkspace = workspaceIntact ? undefined : realpathIfExists(this.#workspace);
		return {
			readwritePaths: resolved.readwritePaths.filter(entry => pinned.has(entry)),
			readonlyPaths: resolved.readonlyPaths.filter(entry => entry !== replacedWorkspace),
			deniedPaths: resolved.deniedPaths,
		};
	}

	/**
	 * Session write grants still at their canonical path. A grant whose path was replaced (by a
	 * symlink or anything not resolving to itself) is dropped, like a replaced private temp dir. A
	 * grant whose directory is merely missing (`rm -rf build`) is kept and recreated empty, as at
	 * grant time: a contained process cannot recreate it, since its parent is not writable.
	 */
	#intactSessionWrites(): string[] {
		let dropped = false;
		for (const grant of sessionPathGrants.write) {
			if (fs.lstatSync(grant, { throwIfNoEntry: false }) === undefined) {
				recreateMissingGrant(grant);
				continue;
			}
			if (stillCanonical(grant)) continue;
			sessionPathGrants.write.delete(grant);
			dropped = true;
			logger.warn("sandbox: dropped a session write grant whose path was replaced", { path: grant });
		}
		if (dropped) {
			pathGrantRevision++;
			grantsChanged();
		}
		return [...sessionPathGrants.write];
	}

	/**
	 * The canonical path `entry` (an `allowWrite`/`extraWrite` entry) was first resolved to, while it
	 * still resolves there; `[]` when it does not exist or was re-pointed since (skipped, warned once).
	 */
	#pinnedWrite(entry: string, ctx: Omit<BaseContext, "gitCommonDir">): string[] {
		const expanded = expandSandboxPath(entry, ctx);
		const real = realpathIfExists(expanded);
		if (real === undefined) return [];
		const pin = this.#writePins.get(expanded);
		if (pin === undefined) {
			this.#writePins.set(expanded, real);
			return [real];
		}
		if (real === pin && stillCanonical(pin)) return [pin];
		if (!this.#warnedPins.has(expanded)) {
			this.#warnedPins.add(expanded);
			const message = `Sandbox: ${entry} now resolves to ${real} instead of ${pin}; it is no longer writable for contained commands.`;
			if (warningSink) warningSink(message);
			else logger.warn(message);
		}
		return [];
	}
}
