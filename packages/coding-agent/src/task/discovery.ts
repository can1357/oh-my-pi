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
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import { isProviderEnabled } from "../capability";
import type { EffectiveExtensionRoots } from "../capability/types";
import { findAllNearestProjectConfigDirs } from "../config";
import { pluginUsesClaudeModelDialect } from "../discovery/agent-plugin-format";
import { listClaudePluginRoots } from "../discovery/helpers";
import { listOmpExtensionRoots } from "../discovery/omp-extension-roots";
import { substitutePluginRoot } from "../discovery/substitute-plugin-root";
import { normalizeClaudeCodeToolName, normalizeToolNames } from "../tools/builtin-names";
import { loadBundledAgents } from "./agents";
import { type AgentFileCache, createAgentFileCache } from "./discovery-cache";
import type { AgentSource } from "./task-details";
import type { AgentDefinition } from "./types";

const enum PluginAgentSources {
	None = 0,
	OmpPackages = 1,
	ClaudeMarketplace = 2,
}

/** Snapshot the provider switches that affect the task agent roster. */
export function getAgentDiscoverySources(): PluginAgentSources {
	return (
		(isProviderEnabled("omp-plugins") ? PluginAgentSources.OmpPackages : PluginAgentSources.None) |
		(isProviderEnabled("claude-plugins") ? PluginAgentSources.ClaudeMarketplace : PluginAgentSources.None)
	);
}

/** Result of agent discovery */
export interface DiscoveryResult {
	agents: AgentDefinition[];
	projectAgentsDir: string | null;
	/** Agent directories searched, in precedence order (for "unknown agent" diagnostics). */
	searchedDirs?: string[];
}

interface AgentDirectory {
	dir: string;
	source: AgentSource;
	/**
	 * Plugin install path supplying these agents. `${CLAUDE_PLUGIN_ROOT}` /
	 * `${OMP_PLUGIN_ROOT}` in the agent Markdown body are substituted with it
	 * when the definition is loaded, not in bash (#20165).
	 */
	pluginRoot?: string;
}

/**
 * Load agents from a directory.
 */
async function loadAgentsFromDir(
	{ dir, source, pluginRoot }: AgentDirectory,
	cache: AgentFileCache,
): Promise<{ dir: string; agents: AgentDefinition[] }> {
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	const files = entries
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.sort((a, b) => a.name.localeCompare(b.name));
	if (files.length === 0) return { dir, agents: [] };

	// The manifest, not the registry, determines the model and tools dialect.
	// Do not wait for another plugin's manifest (or probe roots with no agents).
	const [claudeDialect, loaded] = await Promise.all([
		pluginRoot === undefined ? false : pluginUsesClaudeModelDialect(pluginRoot),
		Promise.all(
			files.map(async file => {
				const filePath = path.join(dir, file.name);
				try {
					return await cache.load(filePath, source);
				} catch (error) {
					logger.warn("Failed to read agent file", { filePath, error });
					return null;
				}
			}),
		),
	]);
	const agents: AgentDefinition[] = [];
	for (const parsed of loaded) {
		if (!parsed) continue;
		if (pluginRoot === undefined) {
			agents.push(parsed.source === source ? parsed : { ...parsed, source });
			continue;
		}
		// The cache is independent of plugin context; don't mutate the parsed entry.
		const agent = { ...parsed, source, systemPrompt: substitutePluginRoot(parsed.systemPrompt, pluginRoot) };
		if (claudeDialect) {
			agent.model = undefined;
			if (agent.tools) agent.tools = normalizeToolNames(agent.tools.map(normalizeClaudeCodeToolName));
			// `parseAgent` inferred spawns before `Agent` was translated to `task`.
			if (agent.spawns === undefined && agent.tools?.includes("task")) agent.spawns = "*";
		}
		agents.push(agent);
	}
	return { dir, agents };
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
 * @param sources - Provider switches captured by the caller when keying a shared scan
 */
export async function discoverAgents(
	cwd: string,
	home: string = os.homedir(),
	extensionRoots?: EffectiveExtensionRoots,
	sources = getAgentDiscoverySources(),
): Promise<DiscoveryResult> {
	const resolvedCwd = path.resolve(cwd);

	const agentDir = getAgentDir();
	const cache = createAgentFileCache(isBunTestRuntime() ? undefined : path.join(agentDir, "cache", "task-agents.bin"));

	const project = findAllNearestProjectConfigDirs("agents", resolvedCwd)[0];
	const nativeDirs: AgentDirectory[] = [];
	if (project) nativeDirs.push({ dir: project.path, source: "project" });
	nativeDirs.push({ dir: path.resolve(agentDir, "agents"), source: "user" });
	const load = (dir: AgentDirectory) => loadAgentsFromDir(dir, cache);

	// Start each lane independently; concatenate their results in precedence order
	// regardless of which provider or directory finishes first.
	const [native, packages, marketplace] = await Promise.all([
		Promise.all(nativeDirs.map(load)),
		sources & PluginAgentSources.OmpPackages
			? listOmpExtensionRoots({ cwd: resolvedCwd, home, repoRoot: null, extensionRoots }).then(roots =>
					Promise.all(roots.map(root => load({ dir: path.join(root.path, "agents"), source: root.level }))),
				)
			: [],
		sources & PluginAgentSources.ClaudeMarketplace
			? listClaudePluginRoots(home, resolvedCwd).then(({ roots }) =>
					Promise.all(
						roots
							.toSorted((a, b) => Number(b.scope === "project") - Number(a.scope === "project"))
							.map(plugin =>
								load({
									dir: path.join(plugin.path, "agents"),
									source: plugin.scope === "project" ? "project" : "user",
									pluginRoot: plugin.path,
								}),
							),
					),
				)
			: [],
	]);
	void cache.save();

	const directories = [...native, ...packages, ...marketplace];
	const seen = new Set<string>();
	const loadedAgents: AgentDefinition[] = [];
	for (const { agents } of directories) {
		for (const agent of agents) {
			if (seen.has(agent.name)) continue;
			seen.add(agent.name);
			loadedAgents.push(agent);
		}
	}

	const bundledAgents = loadBundledAgents().filter(agent => {
		if (seen.has(agent.name)) return false;
		seen.add(agent.name);
		return true;
	});

	return {
		agents: [...loadedAgents, ...bundledAgents],
		projectAgentsDir: project?.path ?? null,
		searchedDirs: directories.map(entry => entry.dir),
	};
}

/**
 * Get an agent by name from discovered agents.
 */
export function getAgent(agents: AgentDefinition[], name: string): AgentDefinition | undefined {
	return agents.find(a => a.name === name);
}
