/**
 * Where an environment value came from: the launch environment, or a project's dotenv files that
 * Bun autoloaded (repository content). A leaf module with no `dirs` import, so `dirs.ts` loads it
 * first and the operator-only scrub below runs before any directory or profile is resolved.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseEnv } from "node:util";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Strict shell-identifier shape. Used for dotenv keys we accept into
 * `Bun.env` — those should be referenceable as `$NAME` from POSIX shells,
 * so we reject anything outside `[A-Za-z_][A-Za-z0-9_]*`.
 */
export function isValidEnvName(name: string): boolean {
	return ENV_NAME_RE.test(name);
}

/**
 * The only names that are genuinely unsafe to forward to a native `execve`
 * spawn: empty, containing `=` (would corrupt the `KEY=VALUE` framing) or
 * NUL (terminates the C string mid-entry). Windows ships standard variables
 * whose names contain parentheses (e.g. `ProgramFiles(x86)`, `CommonProgramFiles(x86)`)
 * — those MUST survive the scrub so downstream resolvers (Git Bash discovery
 * in `procmgr.ts`, etc.) can still read them.
 */
export function isSafeEnvName(name: string): boolean {
	return name.length > 0 && !name.includes("=") && !name.includes("\0");
}

export function isSafeEnvValue(value: string): boolean {
	return !value.includes("\0");
}

export function isMacosMallocStackLoggingEnvName(name: string): boolean {
	return name === "MallocStackLogging" || name === "MallocStackLoggingNoCompact";
}

export function filterProcessEnv(env: Record<string, string | undefined>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key in env) {
		const value = env[key];
		if (
			!isSafeEnvName(key) ||
			isMacosMallocStackLoggingEnvName(key) ||
			value === undefined ||
			!isSafeEnvValue(value)
		) {
			continue;
		}
		result[key] = value;
	}
	return result;
}
/**
 * Git variables that pin a repository location. They describe the checkout the
 * agent process itself was launched from (git hooks, `git --git-dir` wrappers),
 * so forwarding them to a child shell makes `git` ignore the command's `cwd`
 * and mutate the wrong worktree or index. Stripped from child shell envs so git
 * rediscovers the repository from the working directory. Mirrors the
 * `env_remove` list in `crates/vcs/src/git/cli.rs`.
 */
const GIT_REPO_LOCATION_ENV_NAMES = [
	"GIT_DIR",
	"GIT_COMMON_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
] as const;

/**
 * Removes {@link GIT_REPO_LOCATION_ENV_NAMES} from a copied child env in place.
 *
 * Windows environment lookups are case-insensitive, so a block that spells a
 * variable `git_dir` is just as binding there; match case-insensitively on
 * win32 and exactly elsewhere (POSIX env names are case-sensitive).
 */
export function stripGitRepoLocationEnv(
	env: Record<string, string>,
	platform: NodeJS.Platform = process.platform,
): void {
	if (platform !== "win32") {
		for (const name of GIT_REPO_LOCATION_ENV_NAMES) {
			delete env[name];
		}
		return;
	}
	const folded = new Set<string>(GIT_REPO_LOCATION_ENV_NAMES.map(name => name.toLowerCase()));
	for (const key of Object.keys(env)) {
		if (folded.has(key.toLowerCase())) {
			delete env[key];
		}
	}
}

// Bun autoloads the project's dotenv files into `process.env` before user code
// runs — including inside `bun build --compile` binaries — so a snapshot of
// `Bun.env` is only pre-dotenv when autoloading was explicitly disabled. Linux
// keeps the original exec environment in procfs, which is authoritative.
function readLaunchEnv(): ReadonlyMap<string, string> | undefined {
	if (process.platform === "linux") {
		try {
			const values = new Map<string, string>();
			for (const entry of fs.readFileSync("/proc/self/environ", "utf8").split("\0")) {
				const separator = entry.indexOf("=");
				if (separator > 0) values.set(entry.slice(0, separator), entry.slice(separator + 1));
			}
			return values;
		} catch {}
	}
	if (!process.execArgv.includes("--no-env-file")) return undefined;
	const values = new Map<string, string>();
	for (const key in Bun.env) {
		const value = Bun.env[key];
		if (value !== undefined) values.set(key, value);
	}
	return values;
}

const launchEnvValues = readLaunchEnv();
const projectEnvNamesLoadedByOmp = new Set<string>();

/** Record that OMP itself copied `name` into the process env from the project's `.env`. */
export function markProjectEnvNameLoadedByOmp(name: string): void {
	projectEnvNamesLoadedByOmp.add(name);
}

function expandDotenvValues(values: Record<string, string>, env: Record<string, string>): Record<string, string> {
	const expanded: Record<string, string> = {};
	for (const key in values) {
		expanded[key] = values[key].replace(
			/(\\)?\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
			(match, escaped: string | undefined, braced: string | undefined, bare: string | undefined) => {
				if (escaped) return match.slice(1);
				const name = braced ?? bare;
				if (!name) return match;
				return env[name] ?? expanded[name] ?? "";
			},
		);
	}
	return expanded;
}

/**
 * `env` without the values `cwd`'s dotenv files supplied (launch-environment values win), calling
 * `onDotenvValue` with every dotenv-sourced value. Backs `filterChildShellEnv` and the
 * operator-only scrub.
 */
export function filterChildShellEnvInternal(
	env: Record<string, string | undefined>,
	cwd: string,
	onDotenvValue?: (value: string) => void,
): Record<string, string> {
	const runtimeLaunchEnvValues = env === Bun.env || env === process.env ? launchEnvValues : undefined;
	const result = filterProcessEnv(env);
	const projectEnv = parseEnvFile(path.join(cwd, ".env"));
	const launchNodeEnv = runtimeLaunchEnvValues ? runtimeLaunchEnvValues.get("NODE_ENV") : env.NODE_ENV;
	const nodeEnvName = `.env.${launchNodeEnv || "development"}`;
	const modeEnv = parseEnvFile(path.join(cwd, nodeEnvName));
	const localEnv = parseEnvFile(path.join(cwd, ".env.local"));
	const modeLocalEnv = parseEnvFile(path.join(cwd, `${nodeEnvName}.local`));
	const launchEnv = { ...projectEnv, ...modeEnv, ...localEnv, ...modeLocalEnv };
	const expandedLaunchEnv = {
		...expandDotenvValues(projectEnv, result),
		...expandDotenvValues(modeEnv, result),
		...expandDotenvValues(localEnv, result),
		...expandDotenvValues(modeLocalEnv, result),
	};
	let fallbackLaunchEnv: Record<string, string> | undefined;
	let expandedFallbackLaunchEnv: Record<string, string> | undefined;
	if (!runtimeLaunchEnvValues && nodeEnvName !== ".env.development") {
		const fallbackModeEnv = parseEnvFile(path.join(cwd, ".env.development"));
		const fallbackModeLocalEnv = parseEnvFile(path.join(cwd, ".env.development.local"));
		const candidate = { ...projectEnv, ...fallbackModeEnv, ...localEnv, ...fallbackModeLocalEnv };
		const expandedCandidate = {
			...expandDotenvValues(projectEnv, result),
			...expandDotenvValues(fallbackModeEnv, result),
			...expandDotenvValues(localEnv, result),
			...expandDotenvValues(fallbackModeLocalEnv, result),
		};
		if (candidate.NODE_ENV === env.NODE_ENV || expandedCandidate.NODE_ENV === env.NODE_ENV) {
			// Without a launch snapshot, NODE_ENV may itself have come from dotenv.
			// Bun chose the default mode before loading it, so retain both candidates.
			fallbackLaunchEnv = candidate;
			expandedFallbackLaunchEnv = expandedCandidate;
		}
	}
	const allLaunchEnv = fallbackLaunchEnv ? { ...launchEnv, ...fallbackLaunchEnv } : launchEnv;
	if (onDotenvValue) {
		// Every value the project's dotenv files define is dotenv-sourced, whether
		// or not this process loaded it (a `--cwd` launch never did).
		for (const key in allLaunchEnv) onDotenvValue(allLaunchEnv[key]!);
		for (const key in expandedLaunchEnv) onDotenvValue(expandedLaunchEnv[key]!);
	}
	for (const key in allLaunchEnv) {
		const launchValue = runtimeLaunchEnvValues?.get(key);
		if (launchValue !== undefined) {
			// Launcher-owned name: it keeps the launcher's own value. Bun overwrites
			// an empty launcher value with the dotenv one, so restore the launcher
			// value whenever what survived is exactly what the dotenv file defines.
			if (
				result[key] !== launchValue &&
				(result[key] === launchEnv[key] ||
					result[key] === expandedLaunchEnv[key] ||
					result[key] === fallbackLaunchEnv?.[key] ||
					result[key] === expandedFallbackLaunchEnv?.[key])
			) {
				result[key] = launchValue;
			}
			continue;
		}
		if (runtimeLaunchEnvValues || projectEnvNamesLoadedByOmp.has(key)) {
			// Strong provenance: the launch environment is known and this name is
			// absent from it, or OMP itself injected the value — either way it came
			// from a project dotenv file, not the parent shell.
			const value = result[key];
			if (value !== undefined) onDotenvValue?.(value);
			delete result[key];
		} else if (
			result[key] === launchEnv[key] ||
			result[key] === expandedLaunchEnv[key] ||
			result[key] === fallbackLaunchEnv?.[key] ||
			result[key] === expandedFallbackLaunchEnv?.[key]
		) {
			// No launch-env snapshot (dotenv autoloaded without procfs): best-effort
			// value match against the Bun-parsed dotenv.
			const value = result[key];
			if (value !== undefined) onDotenvValue?.(value);
			delete result[key];
		}
	}
	// Last, after dotenv merging: no source (inherited, launcher, or dotenv) may
	// pin the child shell to the agent's own repository.
	stripGitRepoLocationEnv(result);
	return result;
}

/**
 * Parses a complete .env file with the runtime's dotenv grammar, then retains
 * only shell-identifier names and spawn-safe values before mirroring valid
 * `OMP_` variables to their `PI_` aliases.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
	const result: Record<string, string> = {};
	try {
		const parsed = parseEnv(fs.readFileSync(filePath, "utf-8"));
		for (const key in parsed) {
			const value = parsed[key];
			if (value !== undefined && isValidEnvName(key) && isSafeEnvValue(value)) result[key] = value;
		}
	} catch {
		// File doesn't exist or can't be read - return empty result
	}

	// OMP_ overrides PI_
	for (const k in result) {
		if (k.startsWith("OMP_")) {
			result[`PI_${k.slice(4)}`] = result[k];
		}
	}

	return result;
}

/**
 * Names a project's dotenv files (repository content) must never set: they make OMP load config
 * with operator authority (`--config` overlays) or choose which directories hold OMP's own config,
 * `.env` files, plugins and native addon (agent dir, config root, profile, XDG data/state/cache
 * roots, natives dir). A repository value there could swap in a `config.yml` that turns the
 * sandbox off.
 */
export const OPERATOR_ONLY_ENV_NAMES: Readonly<Record<string, true>> = {
	PI_CONFIG_FILES: true,
	OMP_CONFIG_FILES: true,
	PI_CODING_AGENT_DIR: true,
	OMP_CODING_AGENT_DIR: true,
	PI_CONFIG_DIR: true,
	OMP_CONFIG_DIR: true,
	PI_PROFILE: true,
	OMP_PROFILE: true,
	XDG_DATA_HOME: true,
	XDG_STATE_HOME: true,
	XDG_CACHE_HOME: true,
	PI_NATIVES_DIR: true,
	OMP_NATIVES_DIR: true,
};

/** The directory Bun autoloaded dotenv files from; `PWD` when the cwd no longer exists. */
function launchCwd(): string {
	try {
		return process.cwd();
	} catch {
		return process.env.PWD ?? "";
	}
}

// Bun may already have autoloaded the project's dotenv files (from the launch cwd): an
// operator-only name keeps only the value the launch environment gave it (same provenance rules as
// child shells). Runs at module load, before `dirs` resolves the profile and directories and before
// anything (the CLI's `--profile`, `setProfile`) writes these names in-process. Worker threads run it
// too, by value only: a worker inherits the main thread's live env (with its in-process values such
// as `--profile`, which procfs's launch snapshot would wrongly flag), or without options Bun starts it
// from a fresh dotenv autoload; either way a value equal to what the dotenv files define is dropped.
if (Object.keys(OPERATOR_ONLY_ENV_NAMES).some(name => Bun.env[name] !== undefined)) {
	// A copy is not `Bun.env`, so the launch snapshot is not consulted: value matching only.
	const launchOwnedEnv = filterChildShellEnvInternal(Bun.isMainThread ? Bun.env : { ...Bun.env }, launchCwd());
	for (const name in OPERATOR_ONLY_ENV_NAMES) {
		const kept = launchOwnedEnv[name];
		if (kept === undefined) delete Bun.env[name];
		else if (Bun.env[name] !== kept) Bun.env[name] = kept;
	}
}
