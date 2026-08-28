/**
 * Agent Dirs (.agent/.agents) Provider
 *
 * Loads skills, rules, prompts, commands, context files, and system prompts
 * from .agent/ and .agents/ directories at both user (~/) and project levels.
 * Project-level discovery walks up from cwd to repoRoot.
 */
import * as path from "node:path";
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { readFile } from "../capability/fs";
import { type Prompt, promptCapability } from "../capability/prompt";
import { type Rule, ruleCapability } from "../capability/rule";
import { type Skill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import { type SystemPrompt, systemPromptCapability } from "../capability/system-prompt";
import type { LoadContext, LoadResult } from "../capability/types";
import {
	buildRuleFromMarkdown,
	calculateDepth,
	createSourceMeta,
	loadFilesFromDir,
	scanSkillsFromDir,
} from "./helpers";

const PROVIDER_ID = "agents";
const DISPLAY_NAME = "Agent Dirs (.agent/.agents)";
const PRIORITY = 70;
const AGENT_DIR_CANDIDATES = [".agent", ".agents"] as const;

interface UserPathCandidateOptions {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	windowsUserProfile?: () => string | undefined;
	wslPath?: (windowsPath: string) => string | undefined;
}

const WINDOWS_DRIVE_PROFILE_PATTERN = /^([A-Za-z]):[\\/](.*)$/;

function isWsl(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
	return platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

function convertWindowsPathToDefaultWslMount(windowsPath: string): string | undefined {
	const trimmed = windowsPath.trim();
	if (trimmed.length === 0) return undefined;
	// The result is always a WSL (POSIX) path, so build it with posix
	// semantics regardless of the host platform.
	if (path.posix.isAbsolute(trimmed)) return path.posix.normalize(trimmed);
	const match = WINDOWS_DRIVE_PROFILE_PATTERN.exec(trimmed);
	if (!match) return undefined;
	const [, drive, rest] = match;
	const segments = rest.replace(/\\/g, "/").split("/").filter(Boolean);
	return path.posix.join("/mnt", drive.toLowerCase(), ...segments);
}

/**
 * Hard cap for best-effort host-discovery probes.
 *
 * WSL→Windows interop can wedge indefinitely (issue #8402): a synchronous
 * spawn with no timeout blocks the whole startup thread before the TUI paints
 * or any log file is created. The probe result only ever augments discovery
 * with an extra host-home candidate, so a few hundred milliseconds is a
 * generous ceiling — past it we treat the host as unavailable.
 */
const HOST_PROBE_TIMEOUT_MS = 500;

/**
 * Run a best-effort discovery probe and return its trimmed stdout, or
 * `undefined` when the command fails, produces no output, or exceeds the
 * timeout. On timeout the child is killed with SIGKILL so a wedged interop pipe
 * cannot hang startup; the killed/non-zero exit is then reported as
 * "unavailable" and discovery falls back to the Linux `$HOME`/`~/.omp`
 * candidates.
 */
export function runHostProbe(cmd: string[], timeoutMs = HOST_PROBE_TIMEOUT_MS): string | undefined {
	try {
		const result = Bun.spawnSync(cmd, {
			stdout: "pipe",
			stderr: "ignore",
			timeout: timeoutMs,
			killSignal: "SIGKILL",
		});
		if (result.exitCode !== 0) return undefined;
		const resolved = result.stdout.toString().trim();
		return resolved.length > 0 ? resolved : undefined;
	} catch {
		return undefined;
	}
}

function resolveWithWslPath(windowsPath: string): string | undefined {
	return runHostProbe(["wslpath", "-u", windowsPath]);
}

function resolveWindowsUserProfile(): string | undefined {
	const resolved = runHostProbe(["cmd.exe", "/d", "/c", "echo", "%USERPROFILE%"]);
	return resolved && resolved !== "%USERPROFILE%" ? resolved : undefined;
}

/** Resolve the Windows host profile home exposed to WSL, if available. */
export function getWslWindowsHomeCandidate(options: UserPathCandidateOptions = {}): string | undefined {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	if (!isWsl(platform, env)) return undefined;
	const userProfile = env.USERPROFILE ?? (options.windowsUserProfile ?? resolveWindowsUserProfile)();
	if (!userProfile) return undefined;
	return (options.wslPath ?? resolveWithWslPath)(userProfile) ?? convertWindowsPathToDefaultWslMount(userProfile);
}

/**
 * Memo for the default-probe WSL home resolution, keyed by the inputs that
 * decide it (platform + WSL markers + `USERPROFILE`). Discovery calls
 * {@link getUserPathCandidates} from every loader (skills, rules, prompts,
 * commands, AGENTS.md, SYSTEM.md); the host-home probe spawns `cmd.exe` over
 * the WSL interop pipe, so without the memo a wedged pipe costs one
 * {@link HOST_PROBE_TIMEOUT_MS} stall per loader. Keying by inputs keeps
 * test/SDK environment changes visible instead of pinning the first answer
 * for the process lifetime.
 */
const wslHomeMemo = new Map<string, string | undefined>();

function getUserHomeCandidates(ctx: LoadContext): string[] {
	const homes = [ctx.home];
	const env = process.env;
	const key = `${process.platform}\0${env.WSL_DISTRO_NAME ?? ""}\0${env.WSL_INTEROP ?? ""}\0${env.USERPROFILE ?? ""}`;
	let wslHome: string | undefined;
	if (wslHomeMemo.has(key)) {
		wslHome = wslHomeMemo.get(key);
	} else {
		wslHome = getWslWindowsHomeCandidate();
		wslHomeMemo.set(key, wslHome);
	}
	if (wslHome && !homes.includes(wslHome)) homes.push(wslHome);
	return homes;
}

/** User-level paths: ~/.agent[s]/<segments>, plus the Windows host profile under WSL. */
export function getUserPathCandidates(ctx: LoadContext, ...segments: string[]): string[] {
	return getUserHomeCandidates(ctx).flatMap(home =>
		AGENT_DIR_CANDIDATES.map(baseDir => path.join(home, baseDir, ...segments)),
	);
}

/**
 * Project-level paths: walk up from cwd to repoRoot, returning `.agent/<segments>`
 * and `.agents/<segments>` at each ancestor.
 *
 * The user home directory is skipped: `~/.agent[s]/` is by definition
 * user-level config and is already enumerated by {@link getUserPathCandidates}.
 * Without this guard, any cwd under `$HOME` (with no closer git repoRoot) would
 * walk up to home and yield duplicate project+user entries for the same
 * directory — see https://github.com/can1357/oh-my-pi/issues/1116.
 */
export function getProjectPathCandidates(ctx: LoadContext, ...segments: string[]): string[] {
	const paths: string[] = [];
	let current = ctx.cwd;
	while (true) {
		if (current !== ctx.home) {
			for (const baseDir of AGENT_DIR_CANDIDATES) {
				paths.push(path.join(current, baseDir, ...segments));
			}
		}
		if (current === (ctx.repoRoot ?? ctx.home)) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return paths;
}

// Skills
async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const projectScans = getProjectPathCandidates(ctx, "skills").map(dir =>
		scanSkillsFromDir(ctx, { dir, providerId: PROVIDER_ID, level: "project" }),
	);
	const userScans = getUserPathCandidates(ctx, "skills").map(dir =>
		scanSkillsFromDir(ctx, { dir, providerId: PROVIDER_ID, level: "user" }),
	);

	const results = await Promise.all([...projectScans, ...userScans]);

	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load skills from .agent/skills and .agents/skills (project walk-up + user home)",
	priority: PRIORITY,
	load: loadSkills,
});

// Rules
async function loadRules(ctx: LoadContext): Promise<LoadResult<Rule>> {
	const load = (dir: string, level: "user" | "project") =>
		loadFilesFromDir<Rule>(ctx, dir, PROVIDER_ID, level, {
			extensions: ["md", "mdc"],
			transform: (name, content, filePath, source) =>
				buildRuleFromMarkdown(name, content, filePath, source, { stripNamePattern: /\.(md|mdc)$/ }),
		});

	const results = await Promise.all([
		...getProjectPathCandidates(ctx, "rules").map(dir => load(dir, "project")),
		...getUserPathCandidates(ctx, "rules").map(dir => load(dir, "user")),
	]);

	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

registerProvider<Rule>(ruleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load rules from .agent/rules and .agents/rules (project walk-up + user home)",
	priority: PRIORITY,
	load: loadRules,
});

// Prompts
async function loadPrompts(ctx: LoadContext): Promise<LoadResult<Prompt>> {
	const load = (dir: string, level: "user" | "project") =>
		loadFilesFromDir<Prompt>(ctx, dir, PROVIDER_ID, level, {
			extensions: ["md"],
			transform: (name, content, filePath, source) => ({
				name: name.replace(/\.md$/, ""),
				path: filePath,
				content,
				_source: source,
			}),
		});

	const results = await Promise.all([
		...getProjectPathCandidates(ctx, "prompts").map(dir => load(dir, "project")),
		...getUserPathCandidates(ctx, "prompts").map(dir => load(dir, "user")),
	]);

	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

registerProvider<Prompt>(promptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load prompts from .agent/prompts and .agents/prompts (project walk-up + user home)",
	priority: PRIORITY,
	load: loadPrompts,
});

// Slash Commands
async function loadSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	const load = (dir: string, level: "user" | "project") =>
		loadFilesFromDir<SlashCommand>(ctx, dir, PROVIDER_ID, level, {
			extensions: ["md"],
			transform: (name, content, filePath, source) => ({
				name: name.replace(/\.md$/, ""),
				path: filePath,
				content,
				level,
				_source: source,
			}),
		});

	const results = await Promise.all([
		...getProjectPathCandidates(ctx, "commands").map(dir => load(dir, "project")),
		...getUserPathCandidates(ctx, "commands").map(dir => load(dir, "user")),
	]);

	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

registerProvider<SlashCommand>(slashCommandCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load commands from .agent/commands and .agents/commands (project walk-up + user home)",
	priority: PRIORITY,
	load: loadSlashCommands,
});

// Context Files (AGENTS.md)
async function loadContextFiles(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const load = async (filePath: string, level: "user" | "project"): Promise<ContextFile | null> => {
		const content = await readFile(filePath);
		if (!content) return null;
		// filePath is <ancestor>/.agent(s)/AGENTS.md — go up past the config dir to the ancestor
		const ancestorDir = path.dirname(path.dirname(filePath));
		const depth = level === "project" ? calculateDepth(ctx.cwd, ancestorDir, path.sep) : undefined;
		return { path: filePath, content, level, depth, _source: createSourceMeta(PROVIDER_ID, filePath, level) };
	};

	const results = await Promise.all([
		...getProjectPathCandidates(ctx, "AGENTS.md").map(p => load(p, "project")),
		...getUserPathCandidates(ctx, "AGENTS.md").map(p => load(p, "user")),
	]);

	return { items: results.filter((r): r is ContextFile => r !== null), warnings: [] };
}

registerProvider<ContextFile>(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load AGENTS.md from .agent and .agents (project walk-up + user home)",
	priority: PRIORITY,
	load: loadContextFiles,
});

// System Prompt (SYSTEM.md)
async function loadSystemPrompt(ctx: LoadContext): Promise<LoadResult<SystemPrompt>> {
	const load = async (filePath: string, level: "user" | "project"): Promise<SystemPrompt | null> => {
		const content = await readFile(filePath);
		if (!content) return null;
		return { path: filePath, content, level, _source: createSourceMeta(PROVIDER_ID, filePath, level) };
	};

	const results = await Promise.all([
		...getProjectPathCandidates(ctx, "SYSTEM.md").map(p => load(p, "project")),
		...getUserPathCandidates(ctx, "SYSTEM.md").map(p => load(p, "user")),
	]);

	return { items: results.filter((r): r is SystemPrompt => r !== null), warnings: [] };
}

registerProvider<SystemPrompt>(systemPromptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load SYSTEM.md from .agent and .agents (project walk-up + user home)",
	priority: PRIORITY,
	load: loadSystemPrompt,
});
