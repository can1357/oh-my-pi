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
import { logger } from "@oh-my-pi/pi-utils";
import { isProviderEnabled } from "../capability";
import type { EffectiveExtensionRoots } from "../capability/types";
import { findAllNearestProjectConfigDirs, getConfigDirs } from "../config";
import { pluginUsesClaudeModelDialect } from "../discovery/agent-plugin-format";
import { listClaudePluginRoots } from "../discovery/helpers";
import { listOmpExtensionRoots } from "../discovery/omp-extension-roots";
import { substitutePluginRoot } from "../discovery/substitute-plugin-root";
import { normalizeClaudeCodeToolName, normalizeToolNames } from "../tools/builtin-names";
import { loadBundledAgents, parseAgent } from "./agents";
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
	/** Frontmatter is the Claude Code dialect: drop `model:` and translate `tools:`. */
	claudeDialect?: boolean;
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
async function loadAgentsFromDir({
	dir,
	source,
	claudeDialect,
	pluginRoot,
}: AgentDirectory): Promise<AgentDefinition[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	const files = entries
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(file => {
			const filePath = path.join(dir, file.name);
			return fs
				.readFile(filePath, "utf-8")
				.then(content => {
					const agent = parseAgent(filePath, content, source, "warn");
					// Claude Code parity (#20165): plugin agents resolve
					// ${CLAUDE_PLUGIN_ROOT} / ${OMP_PLUGIN_ROOT} in the Markdown
					// body when the definition is loaded, not in bash.
					if (pluginRoot !== undefined) agent.systemPrompt = substitutePluginRoot(agent.systemPrompt, pluginRoot);
					if (claudeDialect) {
						// Claude-format frontmatter: `model:` is a Claude alias, not an
						// OMP selector, and `tools:` uses Claude names (#7966).
						agent.model = undefined;
						if (agent.tools) agent.tools = normalizeToolNames(agent.tools.map(normalizeClaudeCodeToolName));
						// `parseAgent` inferred spawns from the untranslated names, so `Agent`
						// (→ task) missed it; re-apply the same rule to the result.
						if (agent.spawns === undefined && agent.tools?.includes("task")) agent.spawns = "*";
					}
					return agent;
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
 * @param sources - Provider switches captured by the caller when keying a shared scan
 */
export async function discoverAgents(
	cwd: string,
	home: string = os.homedir(),
	extensionRoots?: EffectiveExtensionRoots,
	sources = getAgentDiscoverySources(),
): Promise<DiscoveryResult> {
	const resolvedCwd = path.resolve(cwd);

	const userDirs = getConfigDirs("agents", { project: false }).map(entry => ({
		...entry,
		path: path.resolve(entry.path),
	}));

	const projectDirs = findAllNearestProjectConfigDirs("agents", resolvedCwd).map(entry => ({
		...entry,
		path: path.resolve(entry.path),
	}));

	const orderedDirs: AgentDirectory[] = [];
	const project = projectDirs[0];
	if (project) orderedDirs.push({ dir: project.path, source: "project" });
	const user = userDirs[0];
	if (user) orderedDirs.push({ dir: user.path, source: "user" });

	// Extension-package agents use the same effective root set as sibling
	// skills/hooks/tools, threaded whole so explicit roots and mode survive.
	const packageRoots = sources & PluginAgentSources.OmpPackages
		? await listOmpExtensionRoots({ cwd: resolvedCwd, home, repoRoot: null, extensionRoots })
		: [];
	for (const root of packageRoots) {
		orderedDirs.push({ dir: path.join(root.path, "agents"), source: root.level });
	}

	// Load agents from marketplace plugins (respects disabledProviders).
	const { roots: pluginRoots } = sources & PluginAgentSources.ClaudeMarketplace
		? await listClaudePluginRoots(home, resolvedCwd)
		: { roots: [] };
	const sortedPluginRoots = [...pluginRoots].sort((a, b) => {
		if (a.scope === b.scope) return 0;
		return a.scope === "project" ? -1 : 1;
	});
	const pluginClaudeDialect = await Promise.all(
		// The `model:` and `tools:` dialect follows the plugin's declared manifest,
		// not the registry that supplied it: an omp-installed or --plugin-dir root can
		// ship a `.claude-plugin` package. Claude-dialect frontmatter is translated so
		// its aliases and tool names are not misread as OMP ones (#7966); OMP-native
		// and Agent-Plugins-standard plugin agents keep theirs (#12028).
		sortedPluginRoots.map(plugin => pluginUsesClaudeModelDialect(plugin.path)),
	);
	sortedPluginRoots.forEach((plugin, index) => {
		orderedDirs.push({
			dir: path.join(plugin.path, "agents"),
			source: plugin.scope === "project" ? "project" : "user",
			claudeDialect: pluginClaudeDialect[index],
			pluginRoot: plugin.path,
		});
	});

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

	return {
		agents: [...loadedAgents, ...bundledAgents],
		projectAgentsDir,
		searchedDirs: orderedDirs.map(entry => entry.dir),
	};
}

/**
 * Get an agent by name from discovered agents.
 */
export function getAgent(agents: AgentDefinition[], name: string): AgentDefinition | undefined {
	return agents.find(a => a.name === name);
}
