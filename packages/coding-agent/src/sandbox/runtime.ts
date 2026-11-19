/**
 * Per-workspace sandbox runtime: effective configuration, backend availability, the filesystem
 * policy, the per-realm egress proxy, and contained spawns. Session grants live in `grants.ts`,
 * access request routing in `access.ts`, the filesystem probing in `context.ts`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SandboxSubject } from "@oh-my-pi/pi-agent-core";
import { type SandboxPolicy as NativeSandboxPolicy, type SandboxSupport, sandboxSupport } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { expandTilde, logger, prompt, resolveEquivalentPath } from "@oh-my-pi/pi-utils";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { combine } from "../config/registry";
import sandboxCreatedIntentPrompt from "../prompts/tools/sandbox-created-intent.md" with { type: "text" };
import { Settings } from "../config/settings";
import {
	ACCESS_LISTS,
	answersAccessRequests,
	CONTROL_CHARACTERS,
	canonicalAccessHost,
	listLocked,
	resetAccessForTest,
	routeAccessRequest,
	SandboxAccessError,
	setAccessApprover,
	sandboxAccessEffect,
	setAccessPromptHost,
} from "./access";
import {
	type BaseContext,
	gatherContext,
	gitHooksPath,
	materialize,
	realpathIfExists,
	recreateMissingGrant,
	stillCanonical,
} from "./context";
import { EgressProxy } from "./egress-proxy";
import {
	changedIdentities,
	type IdentitySnapshot,
	identitySnapshot,
	recordSandboxCreated,
	removeSandboxCreated,
	type SandboxCreatedEntry,
	type SandboxCreatedPath,
	sandboxCreatedEntries,
	sandboxCreatedExists,
	sandboxCreatedLedgerPath,
	sandboxCreatedRefusesRepo,
	sandboxCreatedRevision,
	setSandboxCreatedCheck,
} from "./ledger";
import {
	blockedLog,
	decideHost,
	grantExecIn,
	grantHostIn,
	grantsChanged,
	liveRuntimes,
	notifyAll,
	pathGrantRevision,
	pathGrantsChanged,
	recordBlockedHost,
	resetGrantsForTest,
	sandboxSessionGrants,
	sessionExecGrants,
	sessionGrants,
	sessionPathGrants,
	setHostApprover,
} from "./grants";
import { isFilesystemRoot, isWithin, networkPackages } from "./platform";
import {
	expandSandboxPath,
	canonicalHost,
	hostMatches,
	type ProtectedPath,
	type ResolvedFsPolicy,
	readSandboxConfig,
	resolveFsPolicy,
	sandboxEnabled,
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
	cfgSandboxLoopback,
	cfgSandboxMode,
	cfgSandboxNetworkMode,
	cfgSandboxReadScope,
	cfgSandboxScope,
} from "./settings";
import type {
	SandboxAccessApprover,
	SandboxAccessInput,
	SandboxAccessKind,
	SandboxAccessOutcome,
	SandboxAccessPromptHost,
	SandboxAccessRequest,
	SandboxChild,
	SandboxConfig,
	SandboxHostApprover,
	SandboxNetworkMode,
	SandboxResultMeta,
	SandboxScope,
} from "./types";

/**
 * Why a call may not do one of its subjects. `liftable`: a `sandbox_request` of `kind` for `target`
 * (the path, host or exec target to ask for) can allow it; otherwise nothing can (`denyRead`, an
 * invalid target, network off, a write in read-only mode). `protectedPath`: a write refused because
 * omp runs git in or loads project config from `target` outside the sandbox.
 */
export interface SandboxAccessDenial {
	reason: string;
	liftable: boolean;
	kind: SandboxAccessKind;
	target: string;
	protectedPath?: boolean;
}

export type SandboxStatus =
	| { state: "off" }
	| { state: "active"; backend: string; network: SandboxNetworkMode; warnings: readonly string[] }
	| { state: "unavailable"; reason: string; fallback: "warn" | "block" };

export interface SandboxSpawnRequest {
	argv: string[];
	cwd: string;
	env: Record<string, string>;
	/** Roots omp owns for the session (its `local://` directory), writable in every sandbox mode. */
	extraWrite?: readonly string[];
	extraRead?: readonly string[];
	/** Override the configured network mode (MCP servers). */
	network?: SandboxNetworkMode;
}

/** Receives the one per-realm "enabled but unavailable, running unsandboxed" warning. */
export type SandboxWarningSink = (message: string) => void;

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
	loopback: cfgSandboxLoopback,
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

/**
 * Why this host cannot enforce network `mode`, as user-facing text naming the missing packages and
 * commands when the probe found them; undefined when it can (`deny` always can) or when no backend
 * contains processes at all (the sandbox's own unavailability is reported instead). Contained
 * processes run such a mode as `deny`; every interactive setter refuses it with this text.
 */
export function networkModeUnavailable(mode: SandboxNetworkMode): string | undefined {
	const probe = support();
	if (!probe.supported || probe.proxy || mode === "deny") return undefined;
	// `allow` needs no proxy confinement except on bubblewrap, whose unrestricted egress runs through it.
	if (mode === "allow" && probe.backend !== "bubblewrap") return undefined;
	const commands = probe.networkMissing;
	if (commands.length > 0) {
		const packages = networkPackages(commands);
		const one = packages.length === 1;
		return `Network mode "${mode}" is unavailable on this host: ${one ? "package" : "packages"} ${packages.join(", ")} ${one ? "is" : "are"} missing (${commands.length === 1 ? "command" : "commands"}: ${commands.join(", ")}). Install ${one ? "it" : "them"} to use this mode.`;
	}
	const reason =
		probe.networkReason?.trim().replace(/\.+$/, "") || "the sandbox backend cannot confine network access here";
	return `Network mode "${mode}" is unavailable on this host: ${reason}.`;
}

/** The network mode contained processes run under when `mode` is requested: `mode`, or `deny` where this host cannot enforce it. */
export function effectiveNetworkMode(mode: SandboxNetworkMode): SandboxNetworkMode {
	return networkModeUnavailable(mode) === undefined ? mode : "deny";
}

/** Status warning on Windows: what the processcontainer sandbox cannot run (docs/sandbox.md, "Windows"). */
const WINDOWS_LIMITATION_WARNING =
	"Windows: some programs cannot start inside the sandbox and fail with exit code 0xC0000142 (STATUS_DLL_INIT_FAILED), for example Git Bash and other MSYS2/Cygwin tools, so git hooks fail too. Native Windows programs and the shell's built-in commands work. See the Windows section of docs/sandbox.md.";

// ── Per-realm state ──────────────────────────────────────────────────────────

let supportProbe: SandboxSupport | undefined;
let warningSink: SandboxWarningSink | undefined;
let unavailableWarned = false;
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

function support(): SandboxSupport {
	supportProbe ??= sandboxSupport();
	return supportProbe;
}

/** To the warning sink, or `logger.warn` without one. */
function warn(message: string): void {
	if (warningSink) warningSink(message);
	else logger.warn(message);
}

function emitUnavailableWarning(reason: string): void {
	if (unavailableWarned) return;
	unavailableWarned = true;
	warn(`Sandbox unavailable (${reason}); running unsandboxed because sandbox.fallback is "warn".`);
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
 * they keep the proxy's prompt-approved rules: a granted DNS name may reach private ranges but never
 * loopback/link-local/unspecified addresses, and an IP literal or `localhost` is never granted that way
 * (only listing it verbatim here allows it). An exact DNS-name entry follows the same address rule.
 */
function proxyAllowedHosts(runtime: SandboxRuntime, atStart: AllowlistAtStart): string[] {
	const operator = runtime.operatorHosts();
	return runtime
		.configuredHosts()
		.filter(host => atStart.hosts.has(host) || (operator.includes(host) && !atStart.operator.has(host)));
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

// ── Runtime ──────────────────────────────────────────────────────────────────

interface ConfigSnapshot {
	revision: number;
	/** {@link pathGrantRevision} the snapshot was read at. */
	grants: number;
	/** {@link sandboxCreatedRevision} the snapshot was read at. */
	ledger: number;
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
	/** Resolved `core.hooksPath` of the workspace's repository: a protected path; refreshed before every spawn. */
	#hooksPath: string | undefined;
	/** The first {@link #hooksPath} read, which every {@link SandboxRuntime.for} caller awaits. */
	#hooksPathRead: Promise<void> | undefined;
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
	/**
	 * Identity snapshot of the watch set (protected paths and their ancestors inside a writable
	 * root) since the first contained spawn; kept across idle gaps, compared at every check (G7).
	 */
	#watch: IdentitySnapshot | undefined;
	/** Ledgered paths whose trust dialog is open. */
	readonly #asking = new Set<string>();

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

	/** The realpath'd workspace this runtime contains. */
	get workspace(): string {
		return this.#workspace;
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
			// Read whether or not the sandbox is on now: it may be turned on before the first spawn.
			runtime.#hooksPathRead = runtime.#refreshHooksPath();
		}
		// A concurrent caller must not use the runtime before the gate knows the protected hooks path.
		await runtime.#hooksPathRead;
		return runtime;
	}

	/** Runs the identity watch (G7) of every live runtime of this realm: lstat only, cheap. */
	static checkCreated(): void {
		for (const runtime of liveRuntimes) if (runtime instanceof SandboxRuntime) runtime.#detectCreated();
	}

	/**
	 * The runtime `scope` runs contained under in `workspace`, or `undefined` when it runs
	 * unsandboxed. A disabled sandbox never creates a runtime (or touches native probes). Throws
	 * `SandboxUnavailableError` when the sandbox is required but no backend can provide it.
	 */
	static async forScope(workspace: string, scope: SandboxScope | "mcp" | "lsp"): Promise<SandboxRuntime | undefined> {
		if (!sandboxEnabled(await Settings.init())) return undefined;
		const runtime = await SandboxRuntime.for(workspace);
		return runtime.applies(scope) ? runtime : undefined;
	}

	/** Interactive mode, and RPC mode after `set_sandbox_host_prompts`, install this; without it unknown hosts are refused. */
	static setHostApprover(approver: SandboxHostApprover | undefined): void {
		setHostApprover(approver);
	}

	/** Where the one "enabled but unavailable" warning goes; `undefined` restores `logger.warn`. */
	static setWarningSink(sink: SandboxWarningSink | undefined): void {
		warningSink = sink;
	}

	/**
	 * Test seam: replaces the probed backend availability (`undefined` re-probes on next use) and
	 * clears per-realm session state (the once-only unavailable warning, host grants, blocked log,
	 * access prompt host, approver route and thread-service listeners, and the pooled egress proxy,
	 * which is closed in the background).
	 * @internal
	 */
	static resetForTest(supportOverride?: SandboxSupport): void {
		supportProbe = supportOverride;
		unavailableWarned = false;
		resetGrantsForTest();
		resetAccessForTest();
		workspacePins.clear();
		void closeProxies();
	}

	status(): SandboxStatus {
		const { config } = this.#current();
		if (!config.enabled) return { state: "off" };
		const probe = support();
		if (!probe.supported) {
			return { state: "unavailable", reason: probe.reason ?? "unsupported platform", fallback: config.fallback };
		}
		const unavailable = networkModeUnavailable(config.networkMode);
		const network = effectiveNetworkMode(config.networkMode);
		const backend = probe.backend ?? "unknown";
		const warnings = [...probe.warnings];
		if (unavailable) warnings.push(`${unavailable} Network is denied instead.`);
		if (backend === "processcontainer") warnings.push(WINDOWS_LIMITATION_WARNING);
		return { state: "active", backend, network, warnings };
	}

	/**
	 * True when `scope` must run contained. `mcp` and `lsp` (servers omp starts) ignore
	 * `sandbox.scope`. Throws SandboxUnavailableError when unavailable and fallback is "block".
	 */
	applies(scope: SandboxScope | "mcp" | "lsp"): boolean {
		const { config } = this.#current();
		if (!config.enabled) return false;
		if (scope !== "mcp" && scope !== "lsp" && !config.scope.includes(scope)) return false;
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
		await this.#refreshHooksPath();
		this.#detectCreated();
		const { config } = this.#current();
		const requested = request.network ?? config.networkMode;
		// A mode this host cannot enforce runs as `deny`.
		const network = effectiveNetworkMode(requested);
		if (request.network !== undefined && network !== request.network) {
			// `status()` only describes the configured mode; say so for a degraded per-request override.
			logger.warn("sandbox: requested network mode is not enforceable here; network is denied instead", {
				requested: request.network,
				effective: network,
			});
		}
		let policy: NativeSandboxPolicy;
		const resolved = this.#policy(config, request.extraWrite, request.extraRead);
		const { readwritePaths, readonlyPaths, deniedPaths } = resolved;
		const fsPolicy = { readwritePaths, readonlyPaths, deniedPaths };
		const tempDir = this.tempDir();
		if (network === "allowlist") {
			const proxy = await ensureProxy(this, this.#settings);
			policy = {
				...fsPolicy,
				network: "proxy",
				proxyUrl: proxy.url,
				listVolumeRoots: config.listDrives,
				loopback: config.loopback,
			};
		} else {
			policy = { ...fsPolicy, network, listVolumeRoots: config.listDrives, loopback: config.loopback };
		}
		// Compares what is watched so far and adds this spawn's watch set: nothing is re-baselined uncompared.
		this.#detectCreated(this.#watchSet(resolved));
		const child = await spawnSandboxChild({
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
		// Registered before the caller sees the child: the ledger is current when its result is.
		void child.exited.then(() => this.#detectCreated());
		return child;
	}

	/**
	 * URL of this runtime's egress proxy (started on demand) while the sandbox is active and the
	 * effective network mode is `allowlist`; `undefined` otherwise. For host processes omp starts
	 * on the agent's behalf whose traffic must follow the contained allowlist.
	 */
	async egressProxyUrl(): Promise<string | undefined> {
		const status = this.status();
		if (status.state !== "active" || status.network !== "allowlist") return undefined;
		return (await ensureProxy(this, this.#settings)).url;
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
	grantHost(host: string, scope: "session" | "always"): void {
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

	/** Exec targets this realm granted for the session. */
	sessionExec(): readonly string[] {
		return [...sessionExecGrants];
	}

	/** Drops the session grant of exec `target`; notifies listeners when one existed. */
	revokeExec(target: string): void {
		if (sessionExecGrants.delete(target.trim())) grantsChanged();
	}

	/** Paths contained processes of this workspace created or replaced (the ledger), each with whether it exists now. */
	createdPaths(): readonly SandboxCreatedPath[] {
		return sandboxCreatedEntries()
			.filter(entry => entry.workspace === this.#workspace)
			.map(entry => ({ ...entry, exists: sandboxCreatedExists(entry) }));
	}

	/**
	 * Trusts a ledgered path: grants contained commands write access to it for the session (which
	 * lifts its protection) and removes its ledger entry.
	 * @throws SandboxAccessError when `target` is not ledgered for this workspace, or the grant is refused.
	 */
	trustCreated(target: string): void {
		const entry = this.#createdEntry(target);
		this.grantPath("write", entry.path, "session");
		removeSandboxCreated(entry.path);
		notifyAll();
	}

	/**
	 * Removes the ledger entry of a path that no longer exists.
	 * @throws SandboxAccessError when `target` is not ledgered for this workspace or still exists.
	 */
	forgetCreated(target: string): void {
		const entry = this.#createdEntry(target);
		if (entry.exists) {
			throw new SandboxAccessError(`${entry.path} still exists: trust it, or delete it before removing its record.`);
		}
		removeSandboxCreated(entry.path);
		notifyAll();
	}

	/**
	 * Interactive mode and RPC mode (after `set_sandbox_access_prompts`) install this; without it
	 * access requests are refused, or forwarded to the main realm's approver from a worker realm.
	 */
	static setAccessApprover(approver: SandboxAccessApprover | undefined): void {
		setAccessApprover(approver);
	}

	/**
	 * Declares who installs an access approver in this process (before any session exists), so
	 * sessions offer `sandbox_request`; `undefined`: nobody (print mode, ACP, SDK default).
	 */
	static setAccessPromptHost(host: SandboxAccessPromptHost | undefined): void {
		setAccessPromptHost(host);
	}

	/**
	 * Whether someone can answer this realm's access requests: a declared prompt host, an installed
	 * approver (an SDK embedder's), or in a worker realm the main realm's (as it was at boot).
	 */
	static answersAccessRequests(): boolean {
		return answersAccessRequests();
	}

	/**
	 * Asks the user (through the installed approver, or main's from a worker realm) to let contained
	 * commands write, read or reach `input.target`, or (`exec`) to let omp perform it on the host for
	 * the session. Never prompts for a target that is invalid, `denyRead`-protected, already allowed,
	 * or that the current mode cannot grant; one request at a time per
	 * realm, identical requests share it (a worker realm's requests are queued and shared on main).
	 * Rejects with `signal`'s reason when `signal` aborts first; other callers sharing the dialog
	 * are unaffected, and a queued request every caller abandoned never reaches the approver.
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
		let target: string;
		try {
			if (input.kind === "host") target = canonicalAccessHost(input.target);
			else if (input.kind !== "exec") target = this.#accessPath(input.target, input.cwd);
			else target = input.target.trim();
		} catch (error) {
			return { status: "refused", reason: error instanceof Error ? error.message : String(error) };
		}
		// Refuses an invalid host or exec target, and a write in read-only mode, without asking.
		const denial = this.accessDenial([{ kind: input.kind, target }]);
		if (!denial) return { status: "already-allowed", target };
		if (!denial.liftable) return { status: "refused", reason: denial.reason };
		const resolved = {
			kind: input.kind,
			target,
			intent,
			command: input.command,
			alternative: input.alternative,
			effect: sandboxAccessEffect(input.kind, target, denial.protectedPath),
		};
		return await routeAccessRequest(
			this.#workspace,
			this.#settings,
			resolved,
			(approver, request, dialog) => this.#ask(approver, request, dialog),
			signal,
		);
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
		// A protected path may be a file (`.git/config`); its writable parent needs no entry of its own.
		// Checked against the full listed set: a path an earlier grant lifted is still protected.
		if (
			kind === "write" &&
			!fs.existsSync(resolved) &&
			!this.#listedProtected(this.#baseContext(this.tempDir())).some(
				({ entry, real }) => entry === resolved || real === resolved,
			)
		) {
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
			pathGrantsChanged();
		}
	}

	/** Drops a session path grant (persisted entries stay); notifies listeners when one existed. */
	revokePath(kind: "write" | "read", target: string): void {
		const grants = sessionPathGrants[kind];
		const resolved = this.#resolveTarget(target);
		if (!grants.delete(resolved) && !grants.delete(target)) return;
		pathGrantsChanged();
	}

	/** Paths this realm granted for the session, by kind. */
	sessionPaths(): { write: readonly string[]; read: readonly string[] } {
		const { write, read } = sandboxSessionGrants();
		return { write, read };
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
		this.#detectCreated();
		this.#watch = undefined;
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
		if (
			this.#snapshot.revision !== this.#settings.revision ||
			this.#snapshot.grants !== pathGrantRevision() ||
			this.#snapshot.ledger !== sandboxCreatedRevision()
		) {
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
		const grants = pathGrantRevision();
		const config = readSandboxConfig(this.#settings);
		// The proxy reads the allowlist live, so approving a host must not retire running hosts and kernels.
		const { ignored: _ignored, allowedHosts: _allowedHosts, ...effective } = config;
		const ledger = sandboxCreatedRevision();
		// Session path grants, the protected `core.hooksPath` and ledgered paths change the policy:
		// contained shells and kernels restart to pick them up.
		const paths = [
			[...sessionPathGrants.write],
			[...sessionPathGrants.read],
			this.#hooksPath,
			sandboxCreatedEntries().map(entry => entry.path),
		];
		const fingerprint = Bun.hash(JSON.stringify([this.#workspace, effective, paths])).toString(36);
		return { revision, grants, ledger, config, fingerprint };
	}

	/** Re-reads `core.hooksPath`; a change refreshes the fingerprint and tells the listeners. */
	async #refreshHooksPath(): Promise<void> {
		const hooksPath = await gitHooksPath(this.#workspace, this.#hooksPath);
		if (hooksPath === this.#hooksPath) return;
		this.#hooksPath = hooksPath;
		this.#snapshot = this.#read();
		this.notify();
	}

	async #ask(
		approver: SandboxAccessApprover,
		request: SandboxAccessRequest,
		signal: AbortSignal | undefined,
	): Promise<SandboxAccessOutcome> {
		signal?.throwIfAborted();
		// The answer to an earlier queued request may already cover this one.
		if (!this.accessDenial([request])) return { status: "already-allowed", target: request.target };
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
					else if (kind === "exec") grantExecIn(target);
					else this.grantPath(kind, target, scope);
				} catch (error) {
					return { status: "refused", reason: error instanceof Error ? error.message : String(error) };
				}
				return { status: "granted", scope, target };
			}
		}
	}

	/**
	 * Why a call may not do one of `subjects` under the effective policy (configured lists plus
	 * session grants), or `undefined` when it may do them all. Checked in this order: host and exec
	 * subjects as listed (the first denied wins), then every read, then every write. A host must be
	 * allowed for contained commands; an exec target (compared verbatim after trimming) only by a
	 * session grant: policy never allows one. Paths: see {@link #fileAccessDenial}.
	 */
	accessDenial(subjects: readonly SandboxSubject[]): SandboxAccessDenial | undefined {
		const paths: Record<"read" | "write", { path: string; recursive?: boolean }[]> = { read: [], write: [] };
		for (const { kind, target: raw, recursive } of subjects) {
			if (kind === "read" || kind === "write") {
				paths[kind].push({ path: raw, recursive });
				continue;
			}
			const target = raw.trim();
			if (!target || CONTROL_CHARACTERS.test(target)) {
				return { reason: `invalid ${kind} target ${JSON.stringify(raw)}`, liftable: false, kind, target };
			}
			if (kind === "exec") {
				if (sessionExecGrants.has(target)) continue;
				return {
					reason: `${target} runs on the host outside the sandbox and needs the user's approval for this session`,
					liftable: true,
					kind,
					target,
				};
			}
			const status = this.status();
			const network = status.state === "active" ? status.network : "allow";
			if (network === "deny") {
				return {
					reason: "Network is off for contained commands; only the user can change sandbox.network.mode.",
					liftable: false,
					kind,
					target,
				};
			}
			const host = canonicalHost(target) ?? target;
			if (network === "allow" || hostMatches(host, [...this.#current().config.allowedHosts, ...sessionGrants]))
				continue;
			return { reason: `${host} is not on the sandbox's network allowlist`, liftable: true, kind, target: host };
		}
		return this.#fileAccessDenial("read", paths.read) ?? this.#fileAccessDenial("write", paths.write);
	}

	/**
	 * Why omp's in-process file tools may not `kind` the first denied of `subjects` (absolute paths)
	 * under the effective policy (configured lists plus session grants), or `undefined` when they
	 * may all. A `denyRead` hit is not liftable; a write at or under a protected path is, by a write
	 * grant of that path or one below it. In `read-only` mode no write denial is liftable: only the
	 * user can switch modes. A `recursive` subject is a call that reaches below its path (a tree
	 * search or a glob rewrite): a `denyRead` path inside it refuses it too.
	 */
	#fileAccessDenial(
		kind: "read" | "write",
		subjects: readonly { path: string; recursive?: boolean }[],
	): SandboxAccessDenial | undefined {
		if (subjects.length === 0) return undefined;
		// One policy for every subject: resolving it probes the filesystem.
		const policy = this.effectivePolicy();
		for (const subject of subjects) {
			const denial = this.#pathDenial(policy, kind, subject.path, subject.recursive === true);
			if (!denial) continue;
			if (kind === "write" && denial.liftable && this.#current().config.mode === "read-only") {
				return {
					...denial,
					reason: `${denial.reason}; the sandbox is in read-only mode, and only the user can switch it to workspace-write`,
					liftable: false,
				};
			}
			return denial;
		}
		return undefined;
	}

	#pathDenial(
		policy: ResolvedFsPolicy,
		kind: "read" | "write",
		target: string,
		recursive: boolean,
	): SandboxAccessDenial | undefined {
		const platform = process.platform;
		const resolved = resolveEquivalentPath(target, { throughMissing: true });
		const under = (roots: readonly string[]) => roots.some(root => isWithin(resolved, root, platform));
		if (under(policy.deniedPaths)) {
			return {
				reason: `${resolved} is protected by sandbox.filesystem.denyRead`,
				liftable: false,
				kind,
				target: resolved,
			};
		}
		if (recursive) {
			const inside = policy.deniedPaths.find(denied => isWithin(denied, resolved, platform));
			if (inside !== undefined) {
				return {
					reason: `${resolved} contains ${inside}, protected by sandbox.filesystem.denyRead; name a narrower path`,
					liftable: false,
					kind,
					target: resolved,
				};
			}
		}
		if (kind === "write") {
			// Both the canonical and the lexical form: a protected entry may be (or become) a symlink.
			const forms = [resolved, path.resolve(target)];
			// A writable entry at or below the protected path (a grant of it) wins, as in the backend;
			// the same lift rule is encoded in `resolveFsPolicy` and `materialize`: keep them in step.
			const guard = policy.protectedPaths.find(
				({ entry, real }) =>
					forms.some(form => isWithin(form, entry, platform) || isWithin(form, real, platform)) &&
					!policy.readwritePaths.some(rw => isWithin(resolved, rw, platform) && isWithin(rw, real, platform)),
			);
			if (guard !== undefined) {
				return {
					reason: `${guard.entry} is protected: omp runs git or loads project config from it outside the sandbox`,
					liftable: true,
					kind,
					target: guard.entry,
					protectedPath: true,
				};
			}
		}
		// The readable roots contained processes get, so `readScope: all` stops where theirs does
		// (device and virtual trees, Linux `/tmp`, everything outside the profile on Windows).
		const allowed = under(policy.readwritePaths) || (kind === "read" && under(policy.readonlyPaths));
		if (allowed) return undefined;
		const roots = kind === "write" ? "writable" : "readable";
		// A write grant names the directory written: a file's own parent.
		const directory = recursive || kind === "read" || fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory();
		return {
			reason: `${resolved} is outside the sandbox's ${roots} roots`,
			liftable: true,
			kind,
			target: directory ? resolved : path.dirname(resolved),
		};
	}

	/**
	 * Absolute, realpath-or-self form of a requested path (`~` expanded, relative against `cwd` or the
	 * workspace).
	 * @throws SandboxAccessError for an empty path, one with control characters (every UI
	 * interpolates it), a filesystem root or a path at or under a denied entry.
	 */
	#accessPath(target: string, cwd?: string): string {
		if (!target.trim()) throw new SandboxAccessError("The target path is empty.");
		if (CONTROL_CHARACTERS.test(target)) {
			throw new SandboxAccessError("Invalid target: it contains control characters or line breaks.");
		}
		const platform = process.platform;
		const resolved = this.#resolveTarget(target, cwd);
		if (isFilesystemRoot(resolved, platform)) throw new SandboxAccessError("A filesystem root cannot be granted.");
		const tmpdir = this.tempDir();
		const ctx = { workspace: this.#workspace, home: os.homedir(), tmpdir, platform };
		for (const entry of this.#current().config.denyRead) {
			const denied = resolveEquivalentPath(expandSandboxPath(entry, ctx));
			if (isWithin(resolved, denied, platform)) {
				throw new SandboxAccessError(`${resolved} is protected by sandbox.filesystem.denyRead (${entry}).`);
			}
		}
		return resolved;
	}

	/** Absolute, realpath-or-self form of `target` (`~` expanded, relative against `cwd` or the workspace). */
	#resolveTarget(target: string, cwd?: string): string {
		return resolveEquivalentPath(path.resolve(cwd ?? this.#workspace, expandTilde(target.trim())), {
			throughMissing: true,
		});
	}

	/** The gathered context for the current private temp dir (regathered when that changed). */
	#baseContext(tempDir: string): BaseContext {
		if (this.#context?.tmpdir !== tempDir) this.#context = gatherContext(this.#workspace, tempDir);
		return this.#context;
	}

	/**
	 * Every protected path as listed (ledgered paths included, in both forms), each with what it
	 * resolves to now (a symlink, maybe created since): the backend can only carve out the target,
	 * and omp's file tools refuse the link too. The full set, before `resolveFsPolicy` drops entries
	 * a writable grant names exactly.
	 */
	#listedProtected(context: Pick<BaseContext, "protectedPaths">): ProtectedPath[] {
		const listed = new Set(context.protectedPaths);
		if (this.#hooksPath !== undefined) listed.add(this.#hooksPath);
		for (const { path: entry, real } of sandboxCreatedEntries()) listed.add(entry).add(real);
		// Contained code must not drop entries, wherever a writable root covers the agent dir.
		listed.add(sandboxCreatedLedgerPath());
		return [...listed].map(entry => ({ entry, real: resolveEquivalentPath(entry, { throughMissing: true }) }));
	}

	/**
	 * What the identity watch covers for `policy`: each protected path (both forms) inside a
	 * writable root, and every directory between it and the outermost such root. Not the ledger:
	 * omp itself creates and replaces it.
	 */
	#watchSet(policy: ResolvedFsPolicy): Set<string> {
		const platform = process.platform;
		const ledger = sandboxCreatedLedgerPath();
		const watched = new Set<string>();
		for (const { entry, real } of policy.protectedPaths) {
			if (entry === ledger) continue;
			for (const target of [entry, real]) {
				const root = policy.readwritePaths
					.filter(rw => rw !== target && isWithin(target, rw, platform))
					.reduce<string | undefined>(
						(outer, rw) => (outer === undefined || rw.length < outer.length ? rw : outer),
						undefined,
					);
				if (root === undefined) continue;
				for (let dir = target; dir !== root && isWithin(dir, root, platform); dir = path.dirname(dir))
					watched.add(dir);
			}
		}
		return watched;
	}

	/**
	 * Compares the watched paths with their snapshot and keeps the fresh one, extended by `next`
	 * (a spawn's watch set; its new paths are the baseline). A path that appeared or was replaced
	 * since is ledgered, reported, and offered to the user as a `write` access request; the
	 * request is not awaited.
	 */
	#detectCreated(next?: Iterable<string>): void {
		const before = this.#watch;
		if (before === undefined && next === undefined) return;
		let after: IdentitySnapshot;
		try {
			after = identitySnapshot(new Set([...(before?.keys() ?? []), ...(next ?? [])]));
		} catch (error) {
			logger.warn("sandbox: reading the protected paths' identities failed", { error: String(error) });
			return;
		}
		this.#watch = after;
		if (before === undefined) return;
		const changed = changedIdentities(before, after);
		if (changed.length === 0) return;
		const platform = process.platform;
		const hooksPath = this.#hooksPath;
		const at = Date.now();
		let added: SandboxCreatedEntry[];
		let repository: string[] = [];
		try {
			const info = vcs.gitInfo(this.#workspace);
			if (info) repository = [info.gitEntryPath, info.gitDir, info.commonDir];
			const commonDir = info ? realpathIfExists(info.commonDir) : undefined;
			added = recordSandboxCreated(
				changed.map(target => {
					const entry = {
						path: target,
						real: resolveEquivalentPath(target, { throughMissing: true }),
						workspace: this.#workspace,
						at,
					};
					// Hooks outside the git dir: host git must refuse the repository that runs them.
					const hooks =
						hooksPath !== undefined &&
						(isWithin(target, hooksPath, platform) || isWithin(hooksPath, target, platform));
					return hooks && commonDir !== undefined ? { ...entry, gitDir: commonDir } : entry;
				}),
			);
		} catch (error) {
			// Compared again against the same values next time.
			this.#watch = new Map([...after, ...before]);
			logger.warn("sandbox: recording created protected paths failed", { paths: changed, error: String(error) });
			return;
		}
		if (added.length === 0) return;
		// Every runtime's protected set (and fingerprint) includes the ledger.
		notifyAll();
		for (const entry of added) {
			const git = entry.gitDir !== undefined || repository.some(dir => sandboxCreatedRefusesRepo(dir, [entry]));
			warn(
				`Sandbox: a sandboxed command created or replaced ${entry.path}; omp keeps it protected, skips project config in it${git ? " and refuses git on its repository" : ""} until you trust it in /sandbox.`,
			);
			this.#askTrust(entry.path, git);
		}
	}

	/** Asks the user (fire and forget) whether to trust ledgered `target`; an allow removes its entry. */
	#askTrust(target: string, git: boolean): void {
		if (this.#disposed || this.#asking.has(target) || !answersAccessRequests()) return;
		this.#asking.add(target);
		const intent = prompt.render(sandboxCreatedIntentPrompt, { path: target, git }).trim();
		this.requestAccess({ kind: "write", target, intent })
			.then(outcome => {
				const trusted = outcome.status === "granted" || outcome.status === "already-allowed";
				if (trusted && removeSandboxCreated(target)) notifyAll();
			})
			.catch(error =>
				logger.warn("sandbox: asking about a created path failed", { path: target, error: String(error) }),
			)
			.finally(() => this.#asking.delete(target));
	}

	/** The ledger entry of this workspace naming `target` (either form). */
	#createdEntry(target: string): SandboxCreatedPath {
		const entry = this.createdPaths().find(created => created.path === target || created.real === target);
		if (!entry) throw new SandboxAccessError(`${target} is not a path a sandboxed command created here.`);
		return entry;
	}

	#policy(config: SandboxConfig, extraWrite?: readonly string[], extraRead?: readonly string[]): ResolvedFsPolicy {
		const tempDir = this.tempDir();
		const { git, ...context } = this.#baseContext(tempDir);
		const platform = context.platform;
		const protectedPaths = this.#listedProtected(context);
		// Writable roots are pinned to the canonical path they had when first admitted: a contained
		// process can replace a writable root with a symlink, which must never be followed.
		const sessionWrites = this.#intactSessionWrites(protectedPaths);
		const pin = (entries: readonly string[]) => entries.flatMap(entry => this.#pinnedWrite(entry, context));
		const allowWrite = pin(config.allowWrite);
		const write = [...sessionWrites, ...pin(git?.write ?? [])];
		// omp-owned roots (`local://`) stay writable in read-only mode too.
		const harnessWrite = pin(extraWrite ?? []);
		// Readable too: read-only mode drops `write`, and `readScope: workspace` would hide it.
		const read = [...(git ? [git.read] : []), ...sessionWrites, ...sessionPathGrants.read, ...(extraRead ?? [])];
		const resolved = materialize(
			resolveFsPolicy(
				{ ...config, allowWrite },
				{ ...context, extraWrite: write, harnessWrite, extraRead: read, protectedPaths },
			),
			platform,
		);
		const workspaceIntact = stillCanonical(this.#workspace);
		const pinned = [tempDir, ...allowWrite, ...write, ...harnessWrite, ...(workspaceIntact ? [this.#workspace] : [])];
		const replacedWorkspace = workspaceIntact ? undefined : realpathIfExists(this.#workspace);
		return {
			// Inside a pinned root: the carve-out's own writable entries (mount points, grants below it).
			readwritePaths: resolved.readwritePaths.filter(entry => pinned.some(root => isWithin(entry, root, platform))),
			readonlyPaths: resolved.readonlyPaths.filter(entry => entry !== replacedWorkspace),
			deniedPaths: resolved.deniedPaths,
			protectedPaths: resolved.protectedPaths,
		};
	}

	/**
	 * Session write grants still at their canonical path. A grant whose path was replaced (by a
	 * symlink or anything not resolving to itself) is dropped, like a replaced private temp dir. A
	 * grant whose directory is merely missing (`rm -rf build`) is kept and recreated empty, as at
	 * grant time: a contained process cannot recreate it, since its parent is not writable. A grant
	 * naming a protected path is never recreated: it may be a file, and its parent is writable.
	 */
	#intactSessionWrites(protectedPaths: readonly ProtectedPath[]): string[] {
		let dropped = false;
		for (const grant of sessionPathGrants.write) {
			if (fs.lstatSync(grant, { throwIfNoEntry: false }) === undefined) {
				if (!protectedPaths.some(({ entry, real }) => entry === grant || real === grant)) {
					recreateMissingGrant(grant);
				}
				continue;
			}
			if (stillCanonical(grant)) continue;
			sessionPathGrants.write.delete(grant);
			dropped = true;
			logger.warn("sandbox: dropped a session write grant whose path was replaced", { path: grant });
		}
		if (dropped) pathGrantsChanged();
		return [...sessionPathGrants.write];
	}

	/**
	 * The canonical path `entry` (an `allowWrite`/`extraWrite` entry) was first resolved to, while it
	 * still resolves there; `[]` when it does not exist or was re-pointed since (skipped, warned once).
	 */
	#pinnedWrite(entry: string, ctx: BaseContext): string[] {
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
			warn(
				`Sandbox: ${entry} now resolves to ${real} instead of ${pin}; it is no longer writable for contained commands.`,
			);
		}
		return [];
	}
}

setSandboxCreatedCheck(() => SandboxRuntime.checkCreated());
