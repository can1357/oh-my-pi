// oxlint-disable no-template-curly-in-string -- literal `${…}` sandbox path tokens
/**
 * Sandbox configuration, filesystem policy and the network policy's host rules. Pure, but for
 * {@link resolveHostAddresses}: everything host-specific arrives through the settings instance or the
 * {@link SandboxPolicyContext} the runtime gathers.
 */
import { isIP } from "node:net";
import { expandTilde, getAgentDbPath, getAgentDir, getConfigRootDir, untilAborted } from "@oh-my-pi/pi-utils";
import type { Setting } from "../config/registry";
import type { Settings } from "../config/settings";
import { isHostLocalAddress, isPublicAddress } from "../utils/ip-address";
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
	PATH_TOKEN_NAMES,
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

/**
 * Lists where entries tighten (`denyRead`, `scope`): the project may add entries, never remove one.
 * A project list replaces the operator's, so one that repeats none of the operator's entries only
 * adds and is not reported; one that is empty, resets to the default (`null`), or repeats some
 * entries but omits others tried to remove those.
 */
function noRemovals(setting: Setting<readonly string[]>, settings: Settings, ignored: Ignored): string[] {
	const { value, base } = layered(setting, settings);
	const removed = base.filter(entry => !value.includes(entry));
	const reset = value.length === setting.default.length && value.every(entry => setting.default.includes(entry));
	const onlyAdds = value.length > 0 && removed.length === base.length && !reset;
	if (removed.length > 0 && !onlyAdds) {
		ignored.push({
			id: setting.id,
			reason: `project config cannot remove ${removed.join(", ")}; they stay in effect, its added entries apply`,
		});
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
	/**
	 * Read-only roots of `readScope: workspace` only, computed on first call (`readRoots` in ./platform):
	 * what the symlinked `PATH` tools need to start and the global git configuration.
	 */
	workspaceRead?: () => readonly string[];
	/** Writable in `workspace-write` mode only (git metadata, session grants). */
	extraWrite?: readonly string[];
	/**
	 * Roots omp itself owns for the session (its `local://` directory): writable in every mode,
	 * `read-only` included, since omp chose their location and the agent cannot name another.
	 */
	harnessWrite?: readonly string[];
	extraRead?: readonly string[];
	/**
	 * Paths omp loads or runs outside the sandbox (git hooks and config, project config), each as
	 * listed and as it resolves now: read-only carve-outs inside writable roots, unless a writable
	 * entry at or below one lifts it there.
	 */
	protectedPaths?: readonly ProtectedPath[];
}

/** A protected path as listed (`entry`) and as it resolves at policy time (`real`; a symlink's target). */
export interface ProtectedPath {
	entry: string;
	real: string;
}

export interface ResolvedFsPolicy {
	readwritePaths: string[];
	readonlyPaths: string[];
	deniedPaths: string[];
	/**
	 * Protected paths, existing or not, except those a writable entry names exactly (either form);
	 * the existing ones inside a writable root are also read-only entries. A writable entry below
	 * one lifts it there.
	 */
	protectedPaths: ProtectedPath[];
}

/** Matches any `${name}` token {@link expandSandboxPath} expands. */
const PATH_TOKEN = new RegExp(`\\$\\{(${PATH_TOKEN_NAMES.join("|")})\\}`, "g");

/**
 * Absolute path for a policy entry: a leading `~`, `~/…` or `~\…` (`expandTilde`; the settings
 * validator rejects `~name`, and `~\…` off Windows), `${home}`, `${workspace}`, `${tmp}`,
 * `${authDb}` (this process's `getAgentDbPath()`), `${agentDir}` (its `getAgentDir()`) and
 * `${configRoot}` (its `getConfigRootDir()`) expand; a relative result resolves against the
 * workspace.
 */
export function expandSandboxPath(
	entry: string,
	ctx: Pick<SandboxPolicyContext, "workspace" | "home" | "tmpdir" | "platform">,
): string {
	const expanded = expandTilde(entry.trim(), ctx.home).replace(PATH_TOKEN, (_token, name: string) => {
		switch (name) {
			case "home":
				return ctx.home;
			case "workspace":
				return ctx.workspace;
			case "tmp":
				return ctx.tmpdir;
			case "authDb":
				return getAgentDbPath();
			case "configRoot":
				return getConfigRootDir();
			default:
				return getAgentDir();
		}
	});
	return pathApi(ctx.platform).resolve(ctx.workspace, expanded);
}

/**
 * Filesystem policy for `config` in `ctx`. `workspace-write` writes the workspace, the private
 * tmpdir, `allowWrite` and `extraWrite`; `read-only` writes the private tmpdir only. Both modes
 * write `harnessWrite`. Readable: the
 * workspace, the read roots, `allowRead`, `extraRead` and the runtime paths, minus anything
 * writable. Denied: `denyRead`. Protected: `ctx.protectedPaths` minus those a writable entry names
 * exactly (lifted, existing or not), carved out once the policy is materialized (`materialize` in
 * `./context`).
 * Every list is de-duplicated, never holds a filesystem root, and drops entries nested under
 * an equal-or-wider entry of the same list, except a writable entry at or below a protected path:
 * it lifts the protection there (also when the protected path is a symlink to it), so it stays
 * an entry of its own.
 */
export function resolveFsPolicy(config: SandboxConfig, ctx: SandboxPolicyContext): ResolvedFsPolicy {
	const { platform } = ctx;
	const expandAll = (entries: readonly string[]): string[] => entries.map(entry => expandSandboxPath(entry, ctx));
	const writable =
		config.mode === "workspace-write" ? [...expandAll(config.allowWrite), ...expandAll(ctx.extraWrite ?? [])] : [];
	const roots = compactPaths(
		[
			...(config.mode === "workspace-write" ? [ctx.workspace, ctx.tmpdir, ...writable] : [ctx.tmpdir]),
			...expandAll(ctx.harnessWrite ?? []),
		],
		platform,
	);
	const listed = ctx.protectedPaths ?? [];
	// The lift rule ("a writable entry at or below a protected path wins") is also encoded in
	// `materialize` (./context) and `SandboxRuntime#pathDenial`: keep the three in step.
	// Compacting folds a grant of a missing protected file into its root: match before that.
	const named = (p: string) => writable.some(rw => isWithin(p, rw, platform) && isWithin(rw, p, platform));
	const protectedPaths = listed.filter(({ entry, real }) => !named(entry) && !named(real));
	const lifts = writable.filter(
		entry =>
			!roots.includes(entry) &&
			listed.some(p => isWithin(entry, p.entry, platform) || isWithin(entry, p.real, platform)),
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
		readwritePaths: [...roots, ...new Set(lifts)],
		readonlyPaths: readable.filter(entry => !roots.some(rw => isWithin(entry, rw, platform))),
		deniedPaths: compactPaths(expandAll(config.denyRead), platform),
		protectedPaths,
	};
}

/**
 * Whether canonical `host` ({@link canonicalHost}) is an IP literal, `localhost` or a `*.localhost`
 * name: these reach host-local addresses, so only an allowlist entry listing them verbatim allows
 * them, never a wildcard, a prompt or a session grant.
 */
export function hostLocalName(host: string): boolean {
	return isIP(host) !== 0 || host === "localhost" || host.endsWith(".localhost");
}

/**
 * Whether `patterns` list canonical `host` verbatim: a non-wildcard entry that canonicalizes to it.
 * Only such an entry reaches an IP literal or host-local name; the egress proxy and the access
 * check both decide it here.
 */
export function hostListedVerbatim(host: string, patterns: readonly string[]): boolean {
	return patterns.some(pattern => !pattern.trim().startsWith("*.") && canonicalHost(pattern) === host);
}

/**
 * Canonical form of a bare host (name, IPv4 or IPv6, brackets optional) as the WHATWG URL parser
 * gives it: IDNA to punycode, lower-case, IPv4/IPv6 normalized, brackets and trailing dots removed.
 * `undefined` when the value is not a valid bare host (empty, or carrying a port, path or userinfo).
 */
export function canonicalHost(raw: string): string | undefined {
	const value = raw.trim();
	if (value === "" || /[/?#@\\\s]/.test(value)) return undefined;
	// No port can reach the parser, which would drop a default or empty one (`[::1]:80` → `::1`): a
	// bracketed value must end at its bracket, and an unbracketed value with a colon is bracketed whole.
	if (value.startsWith("[") && !value.endsWith("]")) return undefined;
	const bracketed = value.startsWith("[") ? value : value.includes(":") ? `[${value}]` : value;
	let host: string;
	try {
		host = new URL(`http://${bracketed}/`).hostname;
	} catch {
		return undefined;
	}
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	while (host.endsWith(".")) host = host.slice(0, -1);
	return host === "" ? undefined : host;
}

/**
 * Whether `host` is allowed by `patterns`: an exact name, or `*.example.com`, which matches
 * subdomains of example.com but not example.com itself. Host and patterns compare in
 * {@link canonicalHost} form, so case, trailing dots and IDNA spelling are ignored, and an entry
 * that is not a valid host matches nothing. A wildcard never matches an IP literal: a numeric
 * suffix canonicalizes to a whole IPv4 address, which no other address ends with.
 */
export function hostMatches(host: string, patterns: readonly string[]): boolean {
	const target = canonicalHost(host);
	if (target === undefined) return false;
	for (const raw of patterns) {
		const entry = raw.trim();
		if (entry.startsWith("*.")) {
			const suffix = canonicalHost(entry.slice(2));
			if (suffix !== undefined && target.length > suffix.length + 1 && target.endsWith(`.${suffix}`)) return true;
		} else if (canonicalHost(entry) === target) {
			return true;
		}
	}
	return false;
}

/**
 * How canonical `host` is allowed by name: `listed` by a non-wildcard entry of `patterns` that names
 * it verbatim, `wildcard` by a `*.` entry alone, `approved` by neither (so only a prompt approval or a
 * session grant can allow it).
 */
export type HostAdmission = "listed" | "approved" | "wildcard";

/** How `patterns` admit canonical `host`; see {@link HostAdmission}. A verbatim entry wins over a wildcard. */
export function hostAdmission(host: string, patterns: readonly string[]): HostAdmission {
	if (hostListedVerbatim(host, patterns)) return "listed";
	return hostMatches(host, patterns) ? "wildcard" : "approved";
}

/**
 * Whether a host allowed by name as `admission` may not connect to `addresses` (what it resolves
 * to; an IP literal is its own address). Only an IP literal, `localhost` or `*.localhost` listed
 * verbatim may reach host-local addresses (loopback, unspecified, link-local incl. cloud metadata).
 * Any other name never may, however it was allowed: whoever controls its DNS can re-point it at the
 * host (DNS rebinding), and neither an entry nor a prompt says where it points.
 * - Exactly listed DNS name: public and private ranges, never host-local.
 * - Prompt-approved or session-granted name: the same.
 * - Wildcard-matched name: public addresses only.
 * The egress proxy and the in-process web-read guard both decide addresses here.
 */
export function hostAddressRefused(host: string, admission: HostAdmission, addresses: readonly string[]): boolean {
	switch (admission) {
		case "listed":
			return !hostLocalName(host) && addresses.some(isHostLocalAddress);
		case "approved":
			return addresses.some(isHostLocalAddress);
		case "wildcard":
			return addresses.some(address => !isPublicAddress(address));
	}
}

/** The rule {@link hostAddressRefused} applies to a name allowed as `admission`, as a refusal states it. */
export const HOST_ADDRESS_RULES: Readonly<Record<HostAdmission, string>> = {
	listed:
		"a DNS name on the allowlist never reaches the host itself (loopback, link-local, unspecified); only an IP literal or `localhost` listed verbatim in sandbox.network.allowedHosts does",
	approved:
		"a name allowed by a session grant never reaches the host itself (loopback, link-local, unspecified); only an IP literal or `localhost` listed verbatim in sandbox.network.allowedHosts does",
	wildcard: "a name allowed by a wildcard entry reaches public addresses only",
};

/**
 * The distinct addresses canonical `host` resolves to (an IP literal is its own). Rejects with
 * `cannot resolve <host>` when the lookup fails or answers nothing, or once `signal` aborts, without
 * waiting for the lookup.
 */
export async function resolveHostAddresses(host: string, signal?: AbortSignal): Promise<string[]> {
	if (isIP(host) !== 0) return [host];
	let records: { address: string }[];
	try {
		records = await untilAborted(signal, Bun.dns.lookup(host));
	} catch (error) {
		throw new Error(`cannot resolve ${host}`, { cause: error });
	}
	const addresses = [...new Set(records.map(record => record.address))];
	if (addresses.length === 0) throw new Error(`cannot resolve ${host}`);
	return addresses;
}
