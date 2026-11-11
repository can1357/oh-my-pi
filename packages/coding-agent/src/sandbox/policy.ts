// oxlint-disable no-template-curly-in-string -- literal `${…}` sandbox path tokens
/**
 * Sandbox configuration and filesystem policy. Pure: everything host-specific arrives through the
 * settings instance or the {@link SandboxPolicyContext} the runtime gathers.
 */
import { expandTilde, getAgentDbPath, getAgentDir } from "@oh-my-pi/pi-utils";
import type { Setting } from "../config/registry";
import type { Settings } from "../config/settings";
import { compactPaths, isWithin, pathApi, readRoots } from "./platform";
import {
	cfgSandboxAllowedHosts,
	cfgSandboxAllowRead,
	cfgSandboxAllowWrite,
	cfgSandboxDenyRead,
	cfgSandboxEnabled,
	cfgSandboxFallback,
	cfgSandboxMode,
	cfgSandboxListDrives,
	cfgSandboxLoopback,
	cfgSandboxNetworkMode,
	cfgSandboxReadScope,
	cfgSandboxScope,
	SANDBOX_AGENT_DIR_TOKEN,
	SANDBOX_AUTH_DB_TOKEN,
	SANDBOX_SCOPES,
} from "./settings";
import type { SandboxConfig, SandboxScope } from "./types";

type Ignored = { id: string; reason: string }[];

/**
 * Effective value and the value the operator layers produce without any project layer
 * ({@link Settings.grantAuthority}). They differ only when the project layer contributed, including
 * a `null` that resets the operator's value to the default.
 */
function layered<T>(setting: Setting<T>, settings: Settings): { value: T; base: T } {
	return { value: setting.get(settings), base: setting.get(settings.grantAuthority()) };
}

/** `order` runs loosest → strictest; a project value looser than the base one is dropped. */
function atLeastAsStrict<T>(setting: Setting<T>, order: readonly T[], settings: Settings, ignored: Ignored): T {
	const { value, base } = layered(setting, settings);
	if (order.indexOf(value) >= order.indexOf(base)) return value;
	ignored.push({
		id: setting.id,
		reason: `project config sets ${JSON.stringify(value)}, looser than ${JSON.stringify(base)}`,
	});
	return base;
}

/** Lists where entries tighten (`denyRead`, `scope`): the project may add entries, never remove one. */
function noRemovals(setting: Setting<readonly string[]>, settings: Settings, ignored: Ignored): string[] {
	const { value, base } = layered(setting, settings);
	const removed = base.filter(entry => !value.includes(entry));
	if (removed.length > 0) {
		ignored.push({ id: setting.id, reason: `project config cannot remove ${removed.join(", ")}` });
	}
	return [...new Set([...base, ...value])];
}

/** Lists where entries loosen (`allowWrite`, `allowRead`, `allowedHosts`): the project may drop entries, never add one. */
function noAdditions(setting: Setting<readonly string[]>, settings: Settings, ignored: Ignored): string[] {
	const { value, base } = layered(setting, settings);
	const added = value.filter(entry => !base.includes(entry));
	if (added.length > 0) {
		ignored.push({ id: setting.id, reason: `project config cannot add ${added.join(", ")}` });
	}
	return value.filter(entry => base.includes(entry));
}

/**
 * Effective `sandbox.enabled` (the project layer may only enable), as {@link readSandboxConfig}
 * reports it: on when either the merged value or the operator view ({@link Settings.grantAuthority},
 * cached per revision) has it on, so a project `false` or `null` cannot switch it off.
 */
export function sandboxEnabled(settings: Settings): boolean {
	return cfgSandboxEnabled.get(settings) || cfgSandboxEnabled.get(settings.grantAuthority());
}

/**
 * Effective sandbox configuration. A `sandbox.*` value the project layer changes is honoured only
 * when it is at least as strict as what the operator layers produce (enabling, stricter enums,
 * extra denied paths, fewer grants); the loosening part is dropped and listed in `ignored`.
 */
export function readSandboxConfig(settings: Settings): SandboxConfig {
	const ignored: Ignored = [];
	const scope = noRemovals(cfgSandboxScope, settings, ignored);
	return {
		enabled: atLeastAsStrict(cfgSandboxEnabled, [false, true], settings, ignored),
		mode: atLeastAsStrict(cfgSandboxMode, ["workspace-write", "read-only"], settings, ignored),
		scope: SANDBOX_SCOPES.filter((entry: SandboxScope) => scope.includes(entry)),
		fallback: atLeastAsStrict(cfgSandboxFallback, ["warn", "block"], settings, ignored),
		readScope: atLeastAsStrict(cfgSandboxReadScope, ["all", "workspace"], settings, ignored),
		allowWrite: noAdditions(cfgSandboxAllowWrite, settings, ignored),
		allowRead: noAdditions(cfgSandboxAllowRead, settings, ignored),
		denyRead: noRemovals(cfgSandboxDenyRead, settings, ignored),
		networkMode: atLeastAsStrict(cfgSandboxNetworkMode, ["allow", "allowlist", "deny"], settings, ignored),
		allowedHosts: noAdditions(cfgSandboxAllowedHosts, settings, ignored),
		listDrives: atLeastAsStrict(cfgSandboxListDrives, [true, false], settings, ignored),
		loopback: atLeastAsStrict(cfgSandboxLoopback, [true, false], settings, ignored),
		ignored,
	};
}

export interface SandboxPolicyContext {
	workspace: string;
	home: string;
	/**
	 * The runtime's private temp directory (the `${tmp}` token): contained processes' only writable
	 * temp root. Never the system temp dir, which holds files the parent later runs and other
	 * programs' control sockets.
	 */
	tmpdir: string;
	platform: NodeJS.Platform;
	/** Children of the filesystem root, discovered tool paths, omp runtime paths: gathered by the runtime. */
	rootEntries: readonly string[];
	discovered: { readonlyPaths: readonly string[]; readwritePaths: readonly string[] };
	runtimePaths: readonly string[];
	extraWrite?: readonly string[];
	extraRead?: readonly string[];
	/** omp's credential database, the `${authDb}` token; defaults to this process's `getAgentDbPath()`. */
	authDb?: string;
	/** omp's agent directory (`.env`, `models.yml`, `mcp.json`), the `${agentDir}` token; defaults to `getAgentDir()`. */
	agentDir?: string;
}

export interface ResolvedFsPolicy {
	readwritePaths: string[];
	readonlyPaths: string[];
	deniedPaths: string[];
}

/**
 * Absolute path for a policy entry: a leading `~` (`expandTilde`), `${home}`, `${workspace}`,
 * `${tmp}`, `${authDb}` and `${agentDir}` expand; a relative result resolves against the
 * workspace. `platform` defaults to this host's.
 */
export function expandSandboxPath(
	entry: string,
	ctx: Pick<SandboxPolicyContext, "workspace" | "home" | "tmpdir"> &
		Partial<Pick<SandboxPolicyContext, "platform" | "authDb" | "agentDir">>,
): string {
	const api = pathApi(ctx.platform ?? process.platform);
	let expanded = expandTilde(entry.trim(), ctx.home, api)
		.replaceAll("${home}", ctx.home)
		.replaceAll("${workspace}", ctx.workspace)
		.replaceAll("${tmp}", ctx.tmpdir);
	if (expanded.includes(SANDBOX_AUTH_DB_TOKEN)) {
		expanded = expanded.replaceAll(SANDBOX_AUTH_DB_TOKEN, ctx.authDb ?? getAgentDbPath());
	}
	if (expanded.includes(SANDBOX_AGENT_DIR_TOKEN)) {
		expanded = expanded.replaceAll(SANDBOX_AGENT_DIR_TOKEN, ctx.agentDir ?? getAgentDir());
	}
	return api.resolve(ctx.workspace, expanded);
}

/**
 * Filesystem policy for `config` in `ctx`. `workspace-write` writes the workspace, the private
 * tmpdir, `allowWrite` and `extraWrite`; `read-only` writes the private tmpdir only. Readable: the
 * workspace, the read roots, `allowRead`, `extraRead` and the runtime paths, minus anything
 * writable. Denied: `denyRead`.
 * Every list is de-duplicated, never holds a filesystem root, and drops entries nested under
 * an equal-or-wider entry of the same list.
 */
export function resolveFsPolicy(config: SandboxConfig, ctx: SandboxPolicyContext): ResolvedFsPolicy {
	const { platform } = ctx;
	const expandAll = (entries: readonly string[]): string[] => entries.map(entry => expandSandboxPath(entry, ctx));
	const readwritePaths = compactPaths(
		config.mode === "workspace-write"
			? [ctx.workspace, ctx.tmpdir, ...expandAll(config.allowWrite), ...expandAll(ctx.extraWrite ?? [])]
			: [ctx.tmpdir],
		platform,
	);
	const readable = compactPaths(
		expandAll([
			ctx.workspace,
			...readRoots(platform, config.readScope, ctx),
			...config.allowRead,
			...(ctx.extraRead ?? []),
			...ctx.runtimePaths,
		]),
		platform,
	);
	return {
		readwritePaths,
		readonlyPaths: readable.filter(entry => !readwritePaths.some(rw => isWithin(entry, rw, platform))),
		deniedPaths: compactPaths(expandAll(config.denyRead), platform),
	};
}

/** Lower-cased host without the trailing root dot. */
function canonicalHost(host: string): string {
	const lower = host.trim().toLowerCase();
	return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

/**
 * Whether `host` is allowed by `patterns`: an exact name, or `*.example.com`, which matches
 * subdomains of example.com but not example.com itself. Case and a trailing dot are ignored.
 */
export function hostMatches(host: string, patterns: readonly string[]): boolean {
	const target = canonicalHost(host);
	if (target.length === 0) return false;
	for (const raw of patterns) {
		const pattern = canonicalHost(raw);
		if (pattern.startsWith("*.")) {
			const suffix = pattern.slice(1);
			if (target.length > suffix.length && target.endsWith(suffix)) return true;
		} else if (pattern.length > 0 && pattern === target) {
			return true;
		}
	}
	return false;
}
