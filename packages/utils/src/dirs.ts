/**
 * Centralized path helpers for omp config directories.
 *
 * Uses PI_CONFIG_DIR (default ".omp") for the config root and
 * PI_CODING_AGENT_DIR to override the agent directory.
 *
 * On Linux, if XDG_DATA_HOME / XDG_STATE_HOME / XDG_CACHE_HOME environment
 * variables are set, paths are redirected to XDG-compliant locations under
 * $XDG_*_HOME/omp/. This requires running `omp config migrate` first to
 * move data to the new locations. No filesystem existence checks are performed
 * — if the env var is set, omp trusts that the migration has been done.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { engines, version } from "../package.json" with { type: "json" };

/** App name (e.g. "omp") */
export const APP_NAME: string = "omp";

/** Config directory name (e.g. ".omp") */
export const CONFIG_DIR_NAME: string = ".omp";

/** Ordered main settings filenames: canonical write target first, legacy-compatible YAML fallback second. */
export const MAIN_CONFIG_FILENAMES = ["config.yml", "config.yaml"] as const;

/** Version (e.g. "1.0.0") */
export const VERSION: string = version;

/** Default User-Agent header string (e.g. "omp/17.2.12") */
export const USER_AGENT = `omp/${VERSION}`;

/** Minimum Bun version */
export const MIN_BUN_VERSION: string = engines.bun.replace(/[^0-9.]/g, "");

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROFILE_ENV_KEYS = ["OMP_PROFILE", "PI_PROFILE"] as const;

/**
 * Names Windows treats as reserved device aliases. Matches the basename
 * itself as well as any `BASENAME.<anything>` form, because Windows reserves
 * `CON.foo`/`PRN.txt`/etc. too — using them as a profile name would let
 * `setProfile` accept the input only for directory creation to fail later
 * with a confusing `ENOENT`/`EINVAL`. Case-insensitive: NTFS treats `CON`
 * and `con` identically.
 */
const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

/**
 * Normalize and validate a profile name. Returns `undefined` for the implicit
 * default (empty string, whitespace, or the explicit "default" sentinel) and
 * throws for syntactically invalid or platform-reserved names.
 *
 * Exported so consumers of `@oh-my-pi/pi-utils/dirs` (CLI bootstrap, tests,
 * downstream tools) can validate user input without re-deriving the rules.
 */
export function normalizeProfileName(profile: string | undefined): string | undefined {
	const normalized = profile?.trim();
	if (!normalized || normalized === "default") return undefined;
	if (
		normalized === "." ||
		normalized === ".." ||
		normalized.endsWith(".") ||
		!PROFILE_NAME_RE.test(normalized) ||
		WINDOWS_RESERVED_BASENAME_RE.test(normalized)
	) {
		throw new Error(
			`Invalid OMP profile "${profile}". Profile names must match ${PROFILE_NAME_RE.source}, ` +
				`cannot be "." or "..", cannot end with ".", and cannot be a Windows reserved device name ` +
				`(CON, PRN, AUX, NUL, COM0-9, LPT0-9, or any of those with an extension).`,
		);
	}
	return normalized;
}

/**
 * Resolve the active profile from the two profile env vars. `OMP_PROFILE` is the
 * canonical variable and takes precedence; `PI_PROFILE` is the legacy
 * compatibility fallback, consulted only when `OMP_PROFILE` is undefined. An
 * explicitly-empty `OMP_PROFILE` therefore selects the default profile rather
 * than silently inheriting `PI_PROFILE`. Delegates validation/normalization to
 * {@link normalizeProfileName} (which throws on a syntactically invalid value).
 */
export function resolveProfileEnv(omp: string | undefined, pi: string | undefined): string | undefined {
	return normalizeProfileName(omp !== undefined ? omp : pi);
}

function getProfileFromEnv(): string | undefined {
	return resolveProfileEnv(process.env.OMP_PROFILE, process.env.PI_PROFILE);
}

/**
 * Module-load profile resolution. Unlike {@link getProfileFromEnv}, an invalid
 * OMP_PROFILE/PI_PROFILE value does NOT throw here — a bad env var must not
 * crash a bare `import` of this module with an uncaught stack trace before the
 * CLI's error handling is in scope. The default profile is used instead; the
 * CLI re-validates the env (see `runCli` in coding-agent/src/cli.ts) so the
 * user still gets a clean "Invalid OMP profile" message.
 */
function readProfileFromEnvSafe(): string | undefined {
	try {
		return getProfileFromEnv();
	} catch {
		return undefined;
	}
}

function getBaseConfigRoot(): string {
	return path.join(os.homedir(), getConfigDirName());
}

function getProfileConfigRoot(profile: string | undefined): string {
	const root = getBaseConfigRoot();
	return profile ? path.join(root, "profiles", profile) : root;
}

function readPiProfileFromEnvSafe(): string | undefined {
	try {
		return normalizeProfileName(process.env.PI_PROFILE);
	} catch {
		return undefined;
	}
}

function getProfileAgentDir(profile: string): string {
	return path.join(getProfileConfigRoot(profile), "agent");
}

function isProfileDerivedAgentDir(profile: string | undefined, agentDirEnv: string | undefined): boolean {
	return profile !== undefined && agentDirEnv === getProfileAgentDir(profile);
}
// =============================================================================
// Project directory
// =============================================================================

/**
 * On macOS, strip /private prefix only when both paths resolve to the same location.
 * This preserves aliases like /private/tmp -> /tmp without rewriting unrelated paths.
 */
function standardizeMacOSPath(p: string): string {
	if (process.platform !== "darwin" || !p.startsWith("/private/")) return p;
	const stripped = p.slice("/private".length);
	try {
		if (fs.realpathSync(p) === fs.realpathSync(stripped)) {
			return stripped;
		}
	} catch {}
	return p;
}

export function resolveEquivalentPath(inputPath: string): string {
	const resolvedPath = path.resolve(inputPath);
	try {
		return fs.realpathSync(resolvedPath);
	} catch {
		return resolvedPath;
	}
}

export function normalizePathForComparison(inputPath: string): string {
	const resolvedPath = resolveEquivalentPath(inputPath);
	return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

export function pathIsWithin(root: string, candidate: string): boolean {
	const normalizedRoot = normalizePathForComparison(root);
	const normalizedCandidate = normalizePathForComparison(candidate);
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function relativePathWithinRoot(root: string, candidate: string): string | null {
	if (!pathIsWithin(root, candidate)) return null;
	const normalizedRoot = normalizePathForComparison(root);
	const normalizedCandidate = normalizePathForComparison(candidate);
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	return relative || null;
}

let projectDir = standardizeMacOSPath(process.cwd());

/** Get the project directory. */
export function getProjectDir(): string {
	return projectDir;
}

/** Set the project directory. */
export function setProjectDir(dir: string): void {
	projectDir = standardizeMacOSPath(path.resolve(dir));
	process.chdir(projectDir);
}

/**
 * Whether `dir` resolves to an existing directory. Any stat failure — a deleted
 * path (ENOENT), permission error, or a non-directory — returns `false`, so
 * callers can decide whether a directory is safe to `chdir` into or adopt as a
 * working directory before {@link setProjectDir} throws on it.
 */
export async function directoryExists(dir: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(dir)).isDirectory();
	} catch {
		return false;
	}
}

/** Get the config directory name relative to home (e.g. ".omp" or PI_CONFIG_DIR override). */
export function getConfigDirName(): string {
	return process.env.PI_CONFIG_DIR || CONFIG_DIR_NAME;
}

/** Get the config agent directory name relative to home (e.g. ".omp/agent" or PI_CONFIG_DIR + "/agent"). */
export function getConfigAgentDirName(): string {
	const profile = getActiveProfile();
	return profile ? path.join(getConfigDirName(), "profiles", profile, "agent") : `${getConfigDirName()}/agent`;
}

// =============================================================================
// DirResolver — cached, XDG-aware path resolution
// =============================================================================

type XdgCategory = "data" | "state" | "cache";

/**
 * Resolves and caches all omp directory paths. On Linux, when XDG environment
 * variables are set, paths are redirected under $XDG_*_HOME/omp/. A new
 * instance is created whenever the agent directory changes, which naturally
 * invalidates all cached paths.
 */
class DirResolver {
	readonly configRoot: string;
	readonly agentDir: string;

	// Per-category base dirs. Without XDG, all three equal configRoot / agentDir.
	// With XDG on Linux, they point to $XDG_*_HOME/omp/.
	readonly #rootDirs: Record<XdgCategory, string>;
	readonly #agentDirs: Record<XdgCategory, string>;

	readonly #rootCache = new Map<string, string>();
	readonly #agentCache = new Map<string, string>();

	constructor(options: { agentDirOverride?: string; profile?: string } = {}) {
		const profile = normalizeProfileName(options.profile);
		this.configRoot = getProfileConfigRoot(profile);

		const defaultAgent = path.join(this.configRoot, "agent");
		const agentDirOverride = profile ? undefined : options.agentDirOverride;
		this.agentDir = agentDirOverride ? path.resolve(agentDirOverride) : defaultAgent;
		const isDefault = this.agentDir === defaultAgent;

		// XDG is a Linux convention. On supported platforms, default profile state
		// resolves under $XDG_*_HOME/omp once `omp config init-xdg` has migrated
		// the user's data. Named profiles follow a stricter rule: the XDG choice
		// is keyed on the profile-specific XDG path, never the base app root.
		//
		// Why: if we consulted the base app root for named profiles too, the same
		// profile could resolve to `~/.omp/profiles/<name>` on first activation
		// (when no $XDG_*_HOME/omp exists yet) and then silently move to
		// `$XDG_*_HOME/omp/profiles/<name>` the moment the base appeared, orphaning
		// the earlier state. Pinning on the profile path means a profile's location
		// is decided at first activation and stays put until the user explicitly
		// migrates it (e.g. by mkdir'ing the XDG profile dir).
		let xdgData: string | undefined;
		let xdgState: string | undefined;
		let xdgCache: string | undefined;
		if ((process.platform === "linux" || process.platform === "darwin") && isDefault) {
			const resolveIf = (envVar: string) => {
				const value = process.env[envVar];
				if (!value) return undefined;
				try {
					const appRoot = path.join(value, APP_NAME);
					if (profile) {
						const profilePath = path.join(appRoot, "profiles", profile);
						if (fs.existsSync(profilePath)) {
							return profilePath;
						}
						return undefined;
					}
					if (fs.existsSync(appRoot)) {
						return appRoot;
					}
				} catch {}
				return undefined;
			};
			xdgData = resolveIf("XDG_DATA_HOME");
			xdgState = resolveIf("XDG_STATE_HOME");
			xdgCache = resolveIf("XDG_CACHE_HOME");
		}

		this.#rootDirs = {
			data: xdgData ?? this.configRoot,
			state: xdgState ?? this.configRoot,
			cache: xdgCache ?? this.configRoot,
		};
		// XDG flattens the agent/ prefix: ~/.omp/agent/sessions → $XDG_DATA_HOME/omp/sessions
		this.#agentDirs = {
			data: xdgData ?? this.agentDir,
			state: xdgState ?? this.agentDir,
			cache: xdgCache ?? this.agentDir,
		};
	}

	/** Config-root subdirectory, with optional XDG override. */
	rootSubdir(subdir: string, xdg?: XdgCategory): string {
		const cached = this.#rootCache.get(subdir);
		if (cached) return cached;
		const base = xdg ? this.#rootDirs[xdg] : this.configRoot;
		const result = path.join(base, subdir);
		this.#rootCache.set(subdir, result);
		return result;
	}

	/** Agent subdirectory, with optional XDG override. */
	agentSubdir(userAgentDir: string | undefined, subdir: string, xdg?: XdgCategory): string {
		if (!userAgentDir || userAgentDir === this.agentDir) {
			const cached = this.#agentCache.get(subdir);
			if (cached) return cached;
			const base = xdg ? this.#agentDirs[xdg] : this.agentDir;
			const result = path.join(base, subdir);
			this.#agentCache.set(subdir, result);
			return result;
		}
		return path.join(userAgentDir, subdir);
	}
}

/**
 * Decide which `PI_CODING_AGENT_DIR` value to capture as the pre-profile
 * baseline. A value equal to a profile's derived agent dir is profile-derived
 * (propagated by a parent's `setProfile`), so it must NOT be snapshotted as the
 * default-mode baseline — otherwise default mode would resolve to the profile's
 * agent dir. The profile source can be the active profile or a lower-priority
 * `PI_PROFILE` that was bypassed because `OMP_PROFILE` explicitly selected the
 * default profile. Returns `undefined` in those cases so reset falls back to the
 * standard `~/.omp/agent`.
 */
function resolvePreProfileAgentDir(
	profile: string | undefined,
	agentDirEnv: string | undefined,
	profileAgentDirSource: string | undefined = profile,
): string | undefined {
	return isProfileDerivedAgentDir(profile ?? profileAgentDirSource, agentDirEnv) ? undefined : agentDirEnv;
}

let activeProfile = readProfileFromEnvSafe();

/**
 * Resolve the agent-dir override for the current `activeProfile` from the live
 * environment. A named profile derives its own agent dir (no override); default
 * mode honors a non-profile `PI_CODING_AGENT_DIR` (see
 * {@link resolvePreProfileAgentDir}). Shared by the module-load resolver and
 * {@link refreshDirsFromEnv} so both apply identical logic.
 */
function resolveActiveAgentDirOverride(): string | undefined {
	return activeProfile
		? undefined
		: resolvePreProfileAgentDir(undefined, process.env.PI_CODING_AGENT_DIR, readPiProfileFromEnvSafe());
}

let dirs = new DirResolver({
	agentDirOverride: resolveActiveAgentDirOverride(),
	profile: activeProfile,
});
/**
 * Snapshot of `PI_CODING_AGENT_DIR` from before the first named-profile
 * activation. Reset paths restore this value (or its absence) instead of
 * unconditionally deleting the env var. Without the snapshot, a process started
 * with `PI_CODING_AGENT_DIR=/custom` then `setProfile("work")` then
 * `setProfile(undefined)` would silently lose `/custom` and fall back to
 * `~/.omp/agent`. Captured at module load — ignoring a profile-derived value
 * inherited from a parent's `setProfile` (see {@link resolvePreProfileAgentDir})
 * — and refreshed on `setAgentDir`, since that call is the user explicitly
 * redefining the baseline.
 */
let preProfileAgentDirEnv: string | undefined = resolvePreProfileAgentDir(
	activeProfile,
	process.env.PI_CODING_AGENT_DIR,
	activeProfile ?? readPiProfileFromEnvSafe(),
);
// Anchor home for the resolver. Captured at module load to stay stable across
// test mocks of `os.homedir()`. `getPluginsDir(home)` compares against this so
// production callers (`home === RESOLVER_HOME`) hit the XDG-aware resolver while
// tests passing a temp HOME short-circuit to a deterministic path.
const RESOLVER_HOME = os.homedir();

/**
 * Rebuild the dirs resolver from the current environment, reusing the profile
 * resolved at module load. Directory-affecting keys (XDG_*_HOME and, in default
 * mode, `PI_CODING_AGENT_DIR`) loaded from a profile/agent `.env` only reach
 * `process.env` *after* this module froze the resolver at import time, so
 * `env.ts` calls this once after applying its `.env` files. The agent `.env`
 * location derives from the profile name + home before this runs, so the
 * rebuild re-reads only the directory vars, never the profile selection. The
 * `preProfileAgentDirEnv` snapshot is intentionally left untouched.
 */
export function refreshDirsFromEnv(): void {
	dirs = new DirResolver({
		agentDirOverride: resolveActiveAgentDirOverride(),
		profile: activeProfile,
	});
}

// =============================================================================
// Root directories
// =============================================================================

/** Get the config root directory (~/.omp). */
export function getConfigRootDir(): string {
	return dirs.configRoot;
}

/** Set the coding agent directory. Creates a fresh resolver, invalidating all cached paths. */
export function setAgentDir(dir: string): void {
	activeProfile = undefined;
	dirs = new DirResolver({ agentDirOverride: dir });
	process.env.PI_CODING_AGENT_DIR = dir;
	preProfileAgentDirEnv = dir;
	for (const key of PROFILE_ENV_KEYS) {
		delete process.env[key];
	}
}

/**
 * Test-only: reset the pre-profile `PI_CODING_AGENT_DIR` snapshot to whatever
 * the current environment looks like. Cross-suite test pollution can otherwise
 * leak a stale snapshot through `setAgentDir` and corrupt `setProfile(undefined)`
 * restore semantics. Production code MUST NOT call this — the snapshot's
 * lifecycle is owned by `setAgentDir` / `setProfile` and a runtime caller has
 * no business clearing it.
 */
export function __resetProfileSnapshotForTests(): void {
	preProfileAgentDirEnv = resolvePreProfileAgentDir(
		activeProfile,
		process.env.PI_CODING_AGENT_DIR,
		activeProfile ?? readPiProfileFromEnvSafe(),
	);
}

/**
 * Test-only: rebuild profile + directory state from the current process env.
 * Production code keeps the module-load profile stable; tests that mutate
 * `setAgentDir`/`setProfile` need an exact restore point after they put env vars
 * back.
 */
export function __resetDirsFromEnvForTests(): void {
	activeProfile = readProfileFromEnvSafe();
	__resetProfileSnapshotForTests();
	refreshDirsFromEnv();
}

/** Activate a named profile. Passing undefined or "default" returns to the default profile. */
export function setProfile(profile: string | undefined): void {
	const next = normalizeProfileName(profile);
	if (next && !activeProfile) {
		// First activation of a named profile in this process: snapshot the
		// current PI_CODING_AGENT_DIR so a later reset can restore the user's
		// explicit override. Subsequent profile switches keep the original
		// snapshot — the "pre-profile" baseline is the state before profiles
		// entered the picture, not the state between two activations.
		preProfileAgentDirEnv = resolvePreProfileAgentDir(
			undefined,
			process.env.PI_CODING_AGENT_DIR,
			readPiProfileFromEnvSafe(),
		);
	}
	activeProfile = next;
	if (activeProfile) {
		dirs = new DirResolver({ profile: activeProfile });
		process.env.OMP_PROFILE = activeProfile;
		process.env.PI_PROFILE = activeProfile;
		process.env.PI_CODING_AGENT_DIR = dirs.agentDir;
	} else {
		for (const key of PROFILE_ENV_KEYS) {
			delete process.env[key];
		}
		if (preProfileAgentDirEnv === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = preProfileAgentDirEnv;
		}
		dirs = new DirResolver({ agentDirOverride: preProfileAgentDirEnv });
	}
}

/** Get the active named profile. Undefined means the default profile. */
export function getActiveProfile(): string | undefined {
	return activeProfile;
}

/** Resolve the config root that backs a profile without activating it. */
export function getProfileRootDir(profile: string | undefined): string {
	return getProfileConfigRoot(normalizeProfileName(profile));
}
/** Get the agent config directory (~/.omp/agent). */
export function getAgentDir(): string {
	return dirs.agentDir;
}

/** Get the project-local config directory (.omp). */
export function getProjectAgentDir(cwd: string = getProjectDir()): string {
	return path.join(cwd, CONFIG_DIR_NAME);
}

// =============================================================================
// Config-root subdirectories (~/.omp/*)
// =============================================================================

/** Get the reports directory (~/.omp/reports). */
export function getReportsDir(): string {
	return dirs.rootSubdir("reports", "state");
}

/** Get the logs directory (~/.omp/logs). */
export function getLogsDir(): string {
	return dirs.rootSubdir("logs", "state");
}

/** Get this process's dated log path (~/.omp/logs/omp.YYYY-MM-DD.PID.log). */
export function getLogPath(date = new Date(), pid = process.pid): string {
	return path.join(getLogsDir(), `${APP_NAME}.${date.toISOString().slice(0, 10)}.${pid}.log`);
}

/**
 * Get the plugins directory (~/.omp/plugins or its XDG equivalent).
 *
 * No-arg form (production callers) goes through the XDG-aware DirResolver so
 * reads and writes always agree. The optional `home` parameter is for test
 * isolation: when it differs from `os.homedir()` it short-circuits the resolver
 * and returns `<home>/<configDir>/plugins` so tests with a temp HOME get a
 * deterministic path. Passing `os.homedir()` explicitly is identical to the
 * no-arg form — XDG semantics are preserved.
 */
export function getPluginsDir(home?: string): string {
	if (home !== undefined && home !== RESOLVER_HOME) {
		return path.join(home, getConfigDirName(), "plugins");
	}
	return dirs.rootSubdir("plugins", "data");
}

/** Where npm installs packages (~/.omp/plugins/node_modules). */
export function getPluginsNodeModules(home?: string): string {
	return path.join(getPluginsDir(home), "node_modules");
}

/** Plugin manifest (~/.omp/plugins/package.json). */
export function getPluginsPackageJson(home?: string): string {
	return path.join(getPluginsDir(home), "package.json");
}

/** Plugin lock file (~/.omp/plugins/omp-plugins.lock.json). */
export function getPluginsLockfile(home?: string): string {
	return path.join(getPluginsDir(home), "omp-plugins.lock.json");
}

/** Get the remote mount directory (~/.omp/remote). */
export function getRemoteDir(): string {
	return dirs.rootSubdir("remote", "data");
}

/**
 * Expand a leading `~` and require an absolute result. Returns `undefined` for
 * empty/whitespace input or a path that is still relative after expansion.
 *
 * A worktree base is process-global and consumed by both creation
 * (PR checkout, task isolation) and cleanup (`omp worktree`). A relative value
 * would resolve against whatever cwd happened to launch `omp`, so checkout and
 * cleanup could disagree — we refuse it rather than silently bind it to cwd.
 */
function resolveWorktreeBase(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	let p = trimmed;
	if (p === "~") p = os.homedir();
	else if (p.startsWith("~/") || p.startsWith("~\\")) p = os.homedir() + p.slice(1);
	return path.isAbsolute(p) ? path.normalize(p) : undefined;
}

let worktreesDirOverride: string | undefined;

/**
 * Relocate the base directory for agent-managed worktrees (PR checkouts, task
 * isolation, and `omp worktree` cleanup all read the same base). Driven by the
 * `worktree.base` setting in coding-agent; pass `undefined`/empty to clear and
 * fall back to `OMP_WORKTREE_DIR` or the `~/.omp/wt` default.
 *
 * `~` is expanded and a relative path is rejected (see {@link resolveWorktreeBase}).
 * Returns the absolute path that took effect, or `undefined` if the input was
 * cleared or rejected — callers can warn on a non-empty input that returns
 * `undefined`.
 */
export function setWorktreesDir(dir: string | undefined): string | undefined {
	worktreesDirOverride = resolveWorktreeBase(dir);
	return worktreesDirOverride;
}

/**
 * Get the agent-managed worktrees directory. Resolution order: the
 * `OMP_WORKTREE_DIR` env var, then the {@link setWorktreesDir} override (the
 * `worktree.base` setting), then the `~/.omp/wt` default. The env var and the
 * override are both `~`-expanded and must be absolute; a relative value is
 * ignored and resolution falls through.
 */
export function getWorktreesDir(): string {
	return resolveWorktreeBase(process.env.OMP_WORKTREE_DIR) ?? worktreesDirOverride ?? dirs.rootSubdir("wt", "data");
}

/** Get the SSH control socket directory (~/.omp/ssh-control). */
export function getSshControlDir(): string {
	return dirs.rootSubdir("ssh-control", "state");
}

/** Get the remote host info directory (~/.omp/remote-host). */
export function getRemoteHostDir(): string {
	return dirs.rootSubdir("remote-host", "data");
}

/** Get the managed Python venv directory (~/.omp/python-env). */
export function getPythonEnvDir(): string {
	return dirs.rootSubdir("python-env", "data");
}

/** Get the shared Python gateway state directory (~/.omp/agent/python-gateway; XDG default: $XDG_STATE_HOME/omp/python-gateway). */
export function getPythonGatewayDir(): string {
	return dirs.agentSubdir(undefined, "python-gateway", "state");
}

/** Get the puppeteer sandbox directory (~/.omp/puppeteer). */
export function getPuppeteerDir(): string {
	return dirs.rootSubdir("puppeteer", "cache");
}

/** Get the browser relay extension install directory (~/.omp/browser-relay). */
export function getBrowserRelayDir(): string {
	return dirs.rootSubdir("browser-relay", "data");
}

/** Get DOCS_RS cache directory () */
export function getDocsRsCacheDir(): string {
	return dirs.rootSubdir("webcache", "cache");
}

/** Get the auto-QA grievances SQLite database path (~/.omp/autoqa.db; XDG: $XDG_DATA_HOME/omp/autoqa.db). */
export function getAutoQaDbPath(): string {
	return dirs.rootSubdir("autoqa.db", "data");
}
/**
 * Stable 7-character hex digest of an absolute filesystem path.
 *
 * Used to pack the project identity into a single short fs-safe segment
 * (e.g. PR-checkout and task-isolation worktree dirs under `~/.omp/wt/`).
 * Bun.hash is non-cryptographic — collision space is ~2^28, which is fine
 * for naming a handful of repos on a single machine. Same input on the
 * same Bun runtime yields the same output.
 */
export function hashPath(absPath: string): string {
	return Bun.hash(path.resolve(absPath)).toString(16).padStart(16, "0").slice(-7);
}

/** Get the path to a single worktree directory (~/.omp/wt/<segment>). */
export function getWorktreeDir(segment: string): string {
	return path.join(getWorktreesDir(), segment);
}

/** Get the GPU cache path (~/.omp/gpu_cache.json). */
export function getGpuCachePath(): string {
	return dirs.rootSubdir("gpu_cache.json", "cache");
}

/**
 * Get the GitHub view cache database path (~/.omp/cache/github-cache.db).
 * Honors the `OMP_GITHUB_CACHE_DB` env var when set so tests can isolate the
 * cache file without touching the rest of the config root.
 */
export function getGithubCacheDbPath(): string {
	const override = process.env.OMP_GITHUB_CACHE_DB;
	if (override) return override;
	return dirs.rootSubdir(path.join("cache", "github-cache.db"), "cache");
}
/**
 * Get the conventional commit inference cache database path (~/.omp/cache/commit-inference.db).
 * Honors `OMP_COMMIT_CACHE_DB` so tests and operators can isolate the cache.
 */
export function getCommitCacheDbPath(): string {
	const override = process.env.OMP_COMMIT_CACHE_DB;
	if (override) return override;
	return dirs.rootSubdir(path.join("cache", "commit-inference.db"), "cache");
}

/** Get the legacy Pi extension parse cache database path. */
export function getLegacyPiExtensionCacheDbPath(): string {
	return dirs.rootSubdir(path.join("cache", "legacy-pi-extension-cache.db"), "cache");
}

/**
 * Get the encrypted auth-broker snapshot cache path (~/.omp/cache/auth-broker-snapshot.enc).
 * Honors the `OMP_AUTH_BROKER_SNAPSHOT_CACHE` env var when set so tests and
 * operators can isolate or relocate the cache file.
 */
export function getAuthBrokerSnapshotCachePath(): string {
	const override = process.env.OMP_AUTH_BROKER_SNAPSHOT_CACHE;
	if (override) return override;
	return dirs.rootSubdir(path.join("cache", "auth-broker-snapshot.enc"), "cache");
}

/** Get the commit-author avatar cache directory (~/.omp/cache/avatars). */
export function getAvatarCacheDir(): string {
	return dirs.rootSubdir(path.join("cache", "avatars"), "cache");
}

/** Get the local FastEmbed model cache directory (~/.omp/cache/fastembed). */
export function getFastembedCacheDir(): string {
	return dirs.rootSubdir(path.join("cache", "fastembed"), "cache");
}

/** Get the on-demand fastembed runtime install root (~/.omp/cache/fastembed-runtime). */
export function getFastembedRuntimeDir(): string {
	return dirs.rootSubdir(path.join("cache", "fastembed-runtime"), "cache");
}

/** Get the natives directory (~/.omp/natives). */
export function getNativesDir(): string {
	return dirs.rootSubdir("natives", "cache");
}

/** Get the stats database path (~/.omp/stats.db). */
export function getStatsDbPath(): string {
	return dirs.rootSubdir("stats.db", "data");
}

/** Get the autoresearch state directory (~/.omp/autoresearch). */
export function getAutoresearchDir(): string {
	return dirs.rootSubdir("autoresearch", "state");
}

/** Get the per-project autoresearch state directory (~/.omp/autoresearch/<encoded-project>). */
export function getAutoresearchProjectDir(encodedProject: string): string {
	return path.join(getAutoresearchDir(), encodedProject);
}

/** Get the per-project autoresearch SQLite database path (~/.omp/autoresearch/<encoded-project>.db). */
export function getAutoresearchDbPath(encodedProject: string): string {
	return path.join(getAutoresearchDir(), `${encodedProject}.db`);
}

/** Get the per-run artifact directory (~/.omp/autoresearch/<encoded-project>/runs/<runId>). */
export function getAutoresearchRunDir(encodedProject: string, runId: number): string {
	return path.join(getAutoresearchProjectDir(encodedProject), "runs", String(runId).padStart(4, "0"));
}

/** Get the security-analysis state directory (~/.omp/security). */
export function getSecurityDir(): string {
	return dirs.rootSubdir("security", "state");
}

/** Get one project's security-analysis state directory (~/.omp/security/<project-key>). */
export function getSecurityProjectDir(projectKey: string): string {
	return path.join(getSecurityDir(), projectKey);
}

// =============================================================================
// Agent subdirectories (~/.omp/agent/*)
// =============================================================================

/** Get the path to agent.db (SQLite database for settings and auth storage). */
export function getAgentDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "agent.db", "data");
}

/** Get the last-seen-changelog-version marker file (~/.omp/agent/last-changelog-version). */
export function getLastChangelogVersionPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "last-changelog-version", "state");
}

/** Get the path to history.db (SQLite database for session history). */
export function getHistoryDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "history.db", "data");
}

/** Get the path to models.db (model cache database). */
export function getModelDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "models.db", "data");
}

/** Get the tiny title model cache directory (~/.omp/agent/cache/tiny-models). */
export function getTinyModelsCacheDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, path.join("cache", "tiny-models"), "cache");
}

/** Get the document conversion cache directory (~/.omp/agent/cache/document-conversions; XDG default: $XDG_CACHE_HOME/omp/cache/document-conversions). */
export function getDocumentConversionCacheDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, path.join("cache", "document-conversions"), "cache");
}
/** Get the per-project composer speculative cache directory (~/.omp/agent/cache/composer; XDG default: $XDG_CACHE_HOME/omp/cache/composer). */
export function getComposerCacheDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, path.join("cache", "composer"), "cache");
}

/** Get the sessions directory (~/.omp/agent/sessions). */
export function getSessionsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "sessions", "data");
}

/** Get the content-addressed blob store directory (~/.omp/agent/blobs). */
export function getBlobsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "blobs", "data");
}

/** Get the custom themes directory (~/.omp/agent/themes). */
export function getCustomThemesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "themes");
}

/** Get the tools directory (~/.omp/agent/tools). */
export function getToolsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "tools");
}

/** Get the slash commands directory (~/.omp/agent/commands). */
export function getCommandsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "commands");
}

/** Get the prompts directory (~/.omp/agent/prompts). */
export function getPromptsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "prompts");
}

/** Get the user-level Python modules directory (~/.omp/agent/modules). */
export function getAgentModulesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "modules");
}

/** Get the memories directory (~/.omp/agent/memories). */
export function getMemoriesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "memories", "state");
}

/** Get the terminal sessions directory (~/.omp/agent/terminal-sessions). */
export function getTerminalSessionsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "terminal-sessions", "state");
}

/** Get the crash log path (~/.omp/agent/omp-crash.log). */
export function getCrashLogPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "omp-crash.log", "state");
}

/** Get the debug log path (~/.omp/agent/omp-debug.log). */
export function getDebugLogPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, `${APP_NAME}-debug.log`, "state");
}

/**
 * Best-effort one-time copy of a legacy config-root file to its redirected XDG
 * location. Existing installs that enable XDG after the file was created keep
 * their data (e.g. a placeholder key whose loss would break deobfuscation of
 * persisted transcripts). The legacy file is left in place for older omp
 * versions sharing the profile.
 */
function adoptLegacyFile(legacyPath: string, targetPath: string): void {
	if (targetPath === legacyPath) return;
	try {
		if (fs.existsSync(targetPath) || !fs.existsSync(legacyPath)) return;
		fs.mkdirSync(path.dirname(targetPath), { recursive: true });
		fs.copyFileSync(legacyPath, targetPath, fs.constants.COPYFILE_EXCL);
	} catch {
		// Opportunistic: a copy race or unwritable XDG dir falls back to a fresh
		// file at the new path — the pre-adoption behavior.
	}
}

/** Get the secret placeholder key path (~/.omp/agent/secret-placeholder.key; XDG default: $XDG_STATE_HOME/omp/secret-placeholder.key). Adopts a legacy key on first XDG resolution. */
export function getSecretPlaceholderKeyPath(): string {
	const keyPath = dirs.agentSubdir(undefined, "secret-placeholder.key", "state");
	adoptLegacyFile(path.join(dirs.agentDir, "secret-placeholder.key"), keyPath);
	return keyPath;
}

/** Root directory containing every per-project daemon runtime scope (~/.omp/run/daemons; XDG default: $XDG_STATE_HOME/omp/run/daemons). */
export function getDaemonRuntimeRoot(): string {
	return dirs.rootSubdir(path.join("run", "daemons"), "state");
}

/** Get the daemon runtime directory for a project (~/.omp/run/daemons/<hash>; XDG default: $XDG_STATE_HOME/omp/run/daemons/<hash>). */
export function getDaemonRuntimeDir(projectDir: string): string {
	const key = Bun.hash.wyhash(path.resolve(projectDir)).toString(16).padStart(16, "0");
	return path.join(getDaemonRuntimeRoot(), key);
}

/** Root directory containing every machine-global daemon service scope. */
export function getGlobalDaemonRuntimeRoot(): string {
	return path.join(getBaseConfigRoot(), "run", "daemons", "global");
}

/** Get a profile-independent runtime directory for a machine-global daemon service. */
export function getGlobalDaemonRuntimeDir(service: string): string {
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(service)) {
		throw new Error(`Invalid global daemon service name: ${JSON.stringify(service)}`);
	}
	return path.join(getGlobalDaemonRuntimeRoot(), service);
}

/** Get the provider in-flight root directory (~/.omp/run/provider-inflight; XDG default: $XDG_STATE_HOME/omp/run/provider-inflight). */
export function getProviderInFlightRoot(): string {
	return dirs.rootSubdir(path.join("run", "provider-inflight"), "state");
}

/** Get the marketplaces registry path (~/.omp/marketplaces.json; XDG default: $XDG_DATA_HOME/omp/marketplaces.json). Adopts a legacy registry on first XDG resolution. */
export function getMarketplacesRegistryPath(): string {
	const registryPath = dirs.rootSubdir("marketplaces.json", "data");
	adoptLegacyFile(path.join(dirs.configRoot, "marketplaces.json"), registryPath);
	return registryPath;
}

// =============================================================================
// Project subdirectories (.omp/*)
// =============================================================================

/** Get the project-level Python modules directory (.omp/modules). */
export function getProjectModulesDir(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "modules");
}

/** Get the project-level prompts directory (.omp/prompts). */
export function getProjectPromptsDir(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "prompts");
}

/** Get the project-level plugin overrides path (.omp/plugin-overrides.json). */
export function getProjectPluginOverridesPath(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "plugin-overrides.json");
}

// =============================================================================
// MCP config paths
// =============================================================================

/** Get the primary MCP config file path (first candidate). */
export function getMCPConfigPath(scope: "user" | "project", cwd: string = getProjectDir()): string {
	if (scope === "user") {
		return path.join(getAgentDir(), "mcp.json");
	}
	return path.join(getProjectAgentDir(cwd), "mcp.json");
}

/** Get the SSH config file path. */
export function getSSHConfigPath(scope: "user" | "project", cwd: string = getProjectDir()): string {
	if (scope === "user") {
		return path.join(getAgentDir(), "ssh.json");
	}
	return path.join(getProjectAgentDir(cwd), "ssh.json");
}

// =============================================================================
// Install identity
// =============================================================================

let cachedInstallId: string | null = null;

const INSTALL_ID_FILE = "install-id";
/**
 * Application label for usage attribution (`OMP_APP_NAME`), defaulting to
 * `omp`. Embedders that drive omp programmatically (robomp, CI bots, …) set
 * the env var so broker-side per-client burn tracking can answer "what did
 * app X use" instead of folding everything into one install-wide bucket.
 */
export function getAppName(): string {
	const value = process.env.OMP_APP_NAME?.trim();
	return value ? value : "omp";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Persistent per-install UUID stored at `~/.omp/install-id`.
 *
 * Generated lazily on first call and persisted with `O_CREAT|O_EXCL` so
 * concurrent first-call races don't clobber each other (loser re-reads the
 * winner's id). Survives independently of agent state: deleting
 * `~/.omp/agent/` does not regenerate it. Server-side dedup for grievance
 * pushes (and similar telemetry) keys on this id.
 *
 * Anchored to the base config root (`~/.omp/install-id`) regardless of the
 * active profile: install identity is per-install, not per-profile, so every
 * profile shares one id and the global cache stays correct no matter the
 * profile / `getInstallId` call order.
 */
export function getInstallId(): string {
	if (cachedInstallId) return cachedInstallId;
	const filePath = path.join(getBaseConfigRoot(), INSTALL_ID_FILE);

	let observedInvalid = false;
	try {
		const existing = fs.readFileSync(filePath, "utf8").trim();
		if (UUID_RE.test(existing)) {
			cachedInstallId = existing;
			return existing;
		}
		// File present but unparseable — fall through and overwrite below.
		observedInvalid = existing.length > 0;
	} catch {}

	const next = crypto.randomUUID();
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		// If we already saw garbage in the file, unlink first so O_EXCL doesn't
		// trip on it. Ignored if the unlink races against another writer.
		if (observedInvalid) {
			try {
				fs.unlinkSync(filePath);
			} catch {}
		}
		const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
		try {
			fs.writeSync(fd, `${next}\n`);
		} finally {
			fs.closeSync(fd);
		}
	} catch (err) {
		// Lost the create race — re-read whatever the winner wrote.
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			try {
				const existing = fs.readFileSync(filePath, "utf8").trim();
				if (UUID_RE.test(existing)) {
					cachedInstallId = existing;
					return existing;
				}
			} catch {}
		}
		// Any other failure: keep the generated id in-memory so the rest of
		// this process has a stable value; future processes will retry.
	}

	cachedInstallId = next;
	return next;
}

/** Test-only: clear cached install id. Never call from production code. */
export function __resetInstallIdCacheForTests(): void {
	cachedInstallId = null;
}
