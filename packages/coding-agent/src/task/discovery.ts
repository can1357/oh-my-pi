/**
 * Agent discovery from filesystem.
 *
 * Discovers agent definitions from OMP-native task-agent roots:
 *   - ~/.omp/agent/agents/*.md (user-level)
 *   - .omp/agents/*.md (project-level)
 *   - <ext>/agents/*.md for every OMP extension package wired through
 *     `listOmpExtensionRoots` (CLI `--extension` roots, `extensions:` in
 *     settings, and enabled npm/link plugins under `<plugins>/node_modules/`).
 *     Mirrors the same sub-discovery convention applied to `skills/`,
 *     `hooks/`, `tools/`, etc. by `discovery/omp-plugins.ts`.
 *
 * Claude Code marketplace plugin agents are discovered separately via the
 * claude-plugins provider. Direct cross-harness roots such as .claude/agents
 * are intentionally skipped because their frontmatter schema is not the OMP
 * task-agent contract.
 *
 * Agent files use markdown with YAML frontmatter.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigAgentDirName, logger } from "@oh-my-pi/pi-utils";
import { isProviderEnabled } from "../capability";
import type { EffectiveExtensionRoots } from "../capability/types";
import { findAllNearestProjectConfigDirs, getConfigDirs } from "../config";
import { listClaudePluginRoots } from "../discovery/helpers";
import { listOmpExtensionRoots } from "../discovery/omp-extension-roots";
import {
	createAgentDefinitionIdentityFromOrigin,
	createAgentDefinitionOriginIdentity,
} from "./agent-definition-identity";
import { loadBundledAgents, parseAgent } from "./agents";
import type { AgentDefinition, AgentDefinitionIdentity, AgentDefinitionOriginKind, AgentSource } from "./types";

const TASK_AGENT_CONFIG_SOURCE = ".omp";

/** Result of agent discovery */
export interface DiscoveryResult {
	agents: AgentDefinition[];
	projectAgentsDir: string | null;
}

/**
 * Load agents from a directory.
 */
interface AgentDirectory {
	dir: string;
	source: AgentSource;
	originKind: AgentDefinitionOriginKind;
	originRoot: string;
}

async function loadAgentsFromDir(directory: AgentDirectory): Promise<AgentDefinition[]> {
	const { dir, source, originKind, originRoot } = directory;
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	const agentFiles = entries
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.sort((a, b) => a.name.localeCompare(b.name));
	if (agentFiles.length === 0) return [];

	const origin = await createAgentDefinitionOriginIdentity(originKind, originRoot).catch(error => {
		for (const file of agentFiles) {
			logger.warn("Failed to read agent file", { filePath: path.join(dir, file.name), error });
		}
		return null;
	});
	if (!origin) return [];

	const files = agentFiles.map(file => {
		const filePath = path.join(dir, file.name);
		return fs
			.readFile(filePath, "utf-8")
			.then(async content => {
				const identity = await createAgentDefinitionIdentityFromOrigin(origin, filePath, content);
				return parseAgent(filePath, content, source, "warn", identity);
			})
			.catch(error => {
				logger.warn("Failed to read agent file", { filePath, error });
				return null;
			});
	});

	return (await Promise.all(files)).filter(Boolean) as AgentDefinition[];
}

/**
 * Discover agents from filesystem and merge with bundled agents.
 * Precedence (highest wins): project `.omp/agents`, user `.omp/agents`,
 * OMP extension-package agents from the effective `extensions` setting,
 * installed npm/link plugins, Claude marketplace plugin agents (project scope
 * before user), then bundled.
 * @param cwd - Current working directory for project agent discovery
 * @param home - Home directory for user and marketplace discovery
 * @param extensionRoots - Session-local extension roots (explicit + mode + configured)
 */
export async function discoverAgents(
	cwd: string,
	home?: string,
	extensionRoots?: EffectiveExtensionRoots,
): Promise<DiscoveryResult> {
	const resolvedCwd = path.resolve(cwd);
	const resolvedHome = home ?? os.homedir();

	const userDirs = home
		? [
				{
					path: path.resolve(resolvedHome, getConfigAgentDirName(), "agents"),
					source: TASK_AGENT_CONFIG_SOURCE,
					level: "user" as const,
				},
			]
		: getConfigDirs("agents", { project: false })
				.filter(entry => entry.source === TASK_AGENT_CONFIG_SOURCE)
				.map(entry => ({
					...entry,
					path: path.resolve(entry.path),
				}));

	const projectDirs = findAllNearestProjectConfigDirs("agents", resolvedCwd)
		.filter(entry => entry.source === TASK_AGENT_CONFIG_SOURCE)
		.map(entry => ({
			...entry,
			path: path.resolve(entry.path),
		}));

	const orderedDirs: AgentDirectory[] = [];
	const project = projectDirs[0];
	if (project) {
		orderedDirs.push({
			dir: project.path,
			source: "project",
			originKind: "project",
			originRoot: path.dirname(project.path),
		});
	}
	const user = userDirs[0];
	if (user)
		orderedDirs.push({ dir: user.path, source: "user", originKind: "user", originRoot: path.dirname(user.path) });

	// Extension-package agents use the same effective root set as sibling
	// skills/hooks/tools, threaded whole so explicit roots and mode survive.
	const packageRoots = isProviderEnabled("omp-plugins")
		? await listOmpExtensionRoots({ cwd: resolvedCwd, home: resolvedHome, repoRoot: null, extensionRoots })
		: [];
	for (const root of packageRoots) {
		orderedDirs.push({
			dir: path.join(root.path, "agents"),
			source: root.level,
			originKind: "extension",
			originRoot: root.path,
		});
	}

	// Load agents from Claude Code marketplace plugins (respects disabledProviders)
	const { roots: pluginRoots } = isProviderEnabled("claude-plugins")
		? await listClaudePluginRoots(resolvedHome, resolvedCwd)
		: { roots: [] };
	const sortedPluginRoots = [...pluginRoots].sort((a, b) => {
		if (a.scope === b.scope) return 0;
		return a.scope === "project" ? -1 : 1;
	});
	for (const plugin of sortedPluginRoots) {
		const agentsDir = path.join(plugin.path, "agents");
		orderedDirs.push({
			dir: agentsDir,
			source: plugin.scope === "project" ? "project" : "user",
			originKind: "claude-marketplace",
			originRoot: plugin.path,
		});
	}

	const seen = new Set<string>();
	const loadedAgents = (await Promise.all(orderedDirs.map(loadAgentsFromDir))).flat().filter(agent => {
		if (seen.has(agent.name)) return false;
		seen.add(agent.name);
		return true;
	});

	const bundledAgents = loadBundledAgents().filter(agent => {
		if (seen.has(agent.name)) return false;
		seen.add(agent.name);
		return true;
	});

	const projectAgentsDir = projectDirs.length > 0 ? projectDirs[0].path : null;

	return { agents: [...loadedAgents, ...bundledAgents], projectAgentsDir };
}

/**
 * Get an agent by name from discovered agents.
 */
export function getAgent(agents: AgentDefinition[], name: string): AgentDefinition | undefined {
	return agents.find(a => a.name === name);
}

/** Resolve the exact winning definition identity through authoritative host discovery and precedence. */
export async function resolveAgentDefinitionIdentity(
	cwd: string,
	name: string,
	home?: string,
	extensionRoots?: EffectiveExtensionRoots,
): Promise<AgentDefinitionIdentity | undefined> {
	return (await resolveAgentDefinitionIdentities(cwd, [name], home, extensionRoots))[name];
}

/** Resolve multiple winning identities through one authoritative discovery snapshot. */
export async function resolveAgentDefinitionIdentities(
	cwd: string,
	names: readonly string[],
	home?: string,
	extensionRoots?: EffectiveExtensionRoots,
): Promise<Readonly<Record<string, AgentDefinitionIdentity>>> {
	const requested = new Set(names);
	const identities = Object.create(null) as Record<string, AgentDefinitionIdentity>;
	for (const agent of (await discoverAgents(cwd, home, extensionRoots)).agents) {
		if (requested.has(agent.name) && agent.identity) identities[agent.name] = agent.identity;
	}
	return Object.freeze(identities);
}
