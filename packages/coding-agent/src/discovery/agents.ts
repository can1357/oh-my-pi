/**
 * Agent Dirs (.agent/.agents) Provider
 *
 * Loads skills, rules, prompts, commands, context files, and system prompts
 * from .agent/ and .agents/ directories at both user (~/) and project levels.
 * Project-level discovery walks up from cwd to repoRoot.
 */
import * as path from "node:path";
import { isWsl, ptree, windowsPathToWslMount } from "@oh-my-pi/pi-utils";
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
	discoverRuleFromMarkdown,
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

/**
 * Hard cap for best-effort host-discovery probes.
 *
 * WSL→Windows interop can wedge indefinitely (issue #8402). The probe result
 * only ever augments discovery with an extra host-home candidate, so a few
 * hundred milliseconds is a generous ceiling — past it we treat the host as
 * unavailable.
 */
const HOST_PROBE_TIMEOUT_MS = 500;

/**
 * Run a best-effort discovery probe and return its trimmed stdout, or
 * `undefined` when the command fails, produces no output, or exceeds the
 * timeout.
 *
 * `ptree.exec` owns the wall-clock bound: at the deadline it kills the whole
 * process group and cancels the pending pipe readers, so neither a wedged interop
 * pipe nor a descendant that inherited stdout can hold the read open past
 * `timeoutMs` (issue #8402). The killed/non-zero/blank outcomes all report
 * "unavailable", and discovery falls back to the Linux `$HOME`/`~/.omp`
 * candidates.
 */
export async function runHostProbe(cmd: string[], timeoutMs = HOST_PROBE_TIMEOUT_MS): Promise<string | undefined> {
	try {
		const result = await ptree.exec(cmd, {
			timeout: timeoutMs,
			allowNonZero: true,
			allowAbort: true,
			detached: true,
		});
		if (!result.ok || result.exitError?.aborted) return undefined;
		const resolved = result.stdout.trim();
		return resolved.length > 0 ? resolved : undefined;
	} catch {
		return undefined;
	}
}

async function resolveWithWslPath(windowsPath: string): Promise<string | undefined> {
	return runHostProbe(["wslpath", "-u", windowsPath]);
}

async function resolveWindowsUserProfile(): Promise<string | undefined> {
	const resolved = await runHostProbe(["cmd.exe", "/d", "/c", "echo", "%USERPROFILE%"]);
	return resolved && resolved !== "%USERPROFILE%" ? resolved : undefined;
}

/** Resolve the Windows host profile home exposed to WSL, if available. */
export async function getWslWindowsHomeCandidate(options: UserPathCandidateOptions = {}): Promise<string | undefined> {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	if (!isWsl(platform, env)) return undefined;
	const userProfile = env.USERPROFILE ?? (await (options.windowsUserProfile ?? resolveWindowsUserProfile)());
	if (!userProfile) return undefined;
	const interopPath = await (options.wslPath ?? resolveWithWslPath)(userProfile);
	if (interopPath !== undefined) return interopPath;
	const trimmed = userProfile.trim();
	return path.posix.isAbsolute(trimmed) ? path.posix.normalize(trimmed) : windowsPathToWslMount(trimmed);
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
const wslHomeMemo = new Map<string, Promise<string | undefined>>();

async function getUserHomeCandidates(ctx: LoadContext): Promise<string[]> {
	const homes = [ctx.home];
	const env = process.env;
	const key = `${process.platform}\0${env.WSL_DISTRO_NAME ?? ""}\0${env.WSL_INTEROP ?? ""}\0${env.USERPROFILE ?? ""}`;
	let wslHome: Promise<string | undefined> | undefined;
	if (wslHomeMemo.has(key)) {
		wslHome = wslHomeMemo.get(key);
	} else {
		wslHome = getWslWindowsHomeCandidate();
		wslHomeMemo.set(key, wslHome);
		// A rejection must not poison the memo: the old synchronous helper only
		// cached settled answers, so drop the entry and let a later call retry.
		wslHome.catch(() => wslHomeMemo.delete(key));
	}
	const resolved = await wslHome;
	if (resolved && !homes.includes(resolved)) homes.push(resolved);
	return homes;
}

/** User-level paths: ~/.agent[s]/<segments>, plus the Windows host profile under WSL. */
export async function getUserPathCandidates(ctx: LoadContext, ...segments: string[]): Promise<string[]> {
	const homes = await getUserHomeCandidates(ctx);
	return homes.flatMap(home => AGENT_DIR_CANDIDATES.map(baseDir => path.join(home, baseDir, ...segments)));
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
	const userScans = (await getUserPathCandidates(ctx, "skills")).map(dir =>
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
				discoverRuleFromMarkdown(name, content, filePath, source, { stripNamePattern: /\.(md|mdc)$/ }),
		});

	const results = await Promise.all([
		...getProjectPathCandidates(ctx, "rules").map(dir => load(dir, "project")),
		...(await getUserPathCandidates(ctx, "rules")).map(dir => load(dir, "user")),
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
		...(await getUserPathCandidates(ctx, "prompts")).map(dir => load(dir, "user")),
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
		...(await getUserPathCandidates(ctx, "commands")).map(dir => load(dir, "user")),
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
		...(await getUserPathCandidates(ctx, "AGENTS.md")).map(p => load(p, "user")),
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

// System Prompt (SYSTEM.md, SYSTEM_TEMPLATE.md)
async function loadSystemPrompt(ctx: LoadContext): Promise<LoadResult<SystemPrompt>> {
	const load = async (
		filePath: string,
		level: "user" | "project",
		kind: "text" | "template",
	): Promise<SystemPrompt | null> => {
		const content = await readFile(filePath);
		if (!content) return null;
		return { path: filePath, content, kind, level, _source: createSourceMeta(PROVIDER_ID, filePath, level) };
	};

	const results = await Promise.all([
		...getProjectPathCandidates(ctx, "SYSTEM.md").map(p => load(p, "project", "text")),
		...getProjectPathCandidates(ctx, "SYSTEM_TEMPLATE.md").map(p => load(p, "project", "template")),
		...(await getUserPathCandidates(ctx, "SYSTEM.md")).map(p => load(p, "user", "text")),
		...(await getUserPathCandidates(ctx, "SYSTEM_TEMPLATE.md")).map(p => load(p, "user", "template")),
	]);

	return { items: results.filter((r): r is SystemPrompt => r !== null), warnings: [] };
}

registerProvider<SystemPrompt>(systemPromptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load SYSTEM.md and SYSTEM_TEMPLATE.md from .agent and .agents (project walk-up + user home)",
	priority: PRIORITY,
	load: loadSystemPrompt,
});
