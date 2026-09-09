/**
 * Agent Plugins discovery provider (https://agent-plugins.org).
 *
 * Loads the two portable component types defined by Agent Plugins 1.0.0 from
 * plugin roots whose root `plugin.json` targets the standard:
 *
 * - Skills: immediate children of `skills/` containing a regular `SKILL.md`
 *   (spec §7.1), validated against the Agent Skills conventions.
 * - MCP servers: the closed `mcp.json` document at the plugin root (spec §7.2),
 *   with `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` expansion and reserved subprocess
 *   environment variables (spec §9).
 *
 * Roots come from the shared plugin registries (marketplace installs,
 * `--plugin-dir`) and from configured extension packages. Legacy providers
 * skip roots governed by this standard via `legacyProviderAllowed`.
 */
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getPluginsDir, isEnoent, normalizeFrontmatterKeys, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Skill, type SkillFrontmatter, skillCapability } from "../capability/skill";
import type { LoadContext, LoadResult } from "../capability/types";
import {
	type AgentPluginManifest,
	classifyAgentPluginRoot,
	parseAgentPluginMcp,
	validateAgentSkillFrontmatter,
} from "./agent-plugin-format";
import { resolveContainedPath } from "./contained-path";
import { compareSkillOrder, createSourceMeta, listClaudePluginRoots } from "./helpers";
import { listOmpExtensionRoots } from "./omp-extension-roots";

const PROVIDER_ID = "agent-plugins";
const DISPLAY_NAME = "Agent Plugins";
const DESCRIPTION = "Portable Agent Plugins packages (plugin.json, skills/, mcp.json) per agent-plugins.org";
// Above claude-plugins (70) so the standard's semantics win for packages that
// declare it; below claude.ts (80) so user-level .claude/ overrides still apply.
const PRIORITY = 75;

interface CandidateRoot {
	path: string;
	level: "user" | "project";
	/**
	 * Stable identity of this installed plugin instance (§9.1). Registry
	 * installs key on plugin id + scope so the persistent data directory
	 * survives version-path changes across updates; local `--plugin-dir` and
	 * configured extension roots key on their configured directory.
	 */
	instanceKey: string;
}

/**
 * Every directory that may contain an Agent Plugin: marketplace and
 * `--plugin-dir` roots from the shared registries, plus configured extension
 * package roots. First occurrence wins on duplicates.
 */
async function listCandidateRoots(ctx: LoadContext): Promise<CandidateRoot[]> {
	const [marketplace, extensionRoots] = await Promise.all([
		listClaudePluginRoots(ctx.home, ctx.cwd),
		listOmpExtensionRoots(ctx),
	]);
	const seen = new Set<string>();
	const candidates: CandidateRoot[] = [];
	for (const root of marketplace.roots) {
		if (seen.has(root.path)) continue;
		seen.add(root.path);
		candidates.push({
			path: root.path,
			level: root.scope,
			instanceKey: root.marketplace === "__local__" ? `dir:${root.path}` : `${root.id}#${root.scope}`,
		});
	}
	for (const root of extensionRoots) {
		if (seen.has(root.path)) continue;
		seen.add(root.path);
		candidates.push({ path: root.path, level: root.level, instanceKey: `ext:${root.path}` });
	}
	return candidates;
}

/**
 * Client-managed persistent data directory dedicated to one installed plugin
 * instance (§9.1). The manifest name keeps it readable; the SHA-256 digest of
 * the instance identity keeps same-name installs (different marketplaces,
 * scopes, or local directories) from aliasing each other's state.
 */
function pluginDataDir(home: string, manifestName: string, instanceKey: string): string {
	const digest = new Bun.CryptoHasher("sha256").update(instanceKey).digest("hex").slice(0, 16);
	return path.join(getPluginsDir(home), "data", `${manifestName}-${digest}`);
}

// =============================================================================
// Skills
// =============================================================================

/**
 * Discover skills per spec §7.1: each immediate child of `skills/` whose
 * `SKILL.md` resolves to a regular file inside the plugin root is one skill;
 * deeper descendants are never searched. Invalid skills are skipped with a
 * warning while the rest keep loading.
 */
async function scanStandardSkills(realRoot: string, level: "user" | "project"): Promise<LoadResult<Skill>> {
	const items: Skill[] = [];
	const warnings: string[] = [];

	// §4.1: resolve the fixed location and prove containment BEFORE listing it,
	// so a symlinked skills/ can never lead the scan outside the package.
	const skillsDir = await resolveContainedPath(realRoot, path.join(realRoot, "skills"));
	// §6.2: an absent fixed location is not an error.
	if (skillsDir.status === "missing") return { items, warnings };
	if (skillsDir.status === "outside") {
		warnings.push(`skills/ resolves outside the plugin root`);
		return { items, warnings };
	}

	let entries: Dirent[];
	try {
		entries = await fs.readdir(skillsDir.realPath, { withFileTypes: true });
	} catch {
		// §6.2: a present location of the wrong filesystem kind invalidates only
		// this component type.
		warnings.push(`skills/ does not resolve to a directory`);
		return { items, warnings };
	}

	await Promise.all(
		entries.map(async entry => {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) return;
			// Resolve and contain each SKILL.md before any stat/read can follow a
			// symlink out of the package (§4.1 failure boundary 3).
			const resolved = await resolveContainedPath(realRoot, path.join(skillsDir.realPath, entry.name, "SKILL.md"));
			if (resolved.status === "missing") return; // no SKILL.md → not a skill directory
			if (resolved.status === "outside") {
				warnings.push(`Skipping skill "${entry.name}": SKILL.md resolves outside the plugin root`);
				return;
			}
			const skillPath = resolved.realPath;
			let stat: Stats;
			try {
				stat = await fs.stat(skillPath);
			} catch {
				return;
			}
			if (!stat.isFile()) return;
			const content = await readFile(skillPath);
			if (content === null) {
				warnings.push(`Skipping skill "${entry.name}": failed to read SKILL.md`);
				return;
			}
			// Strict parse: malformed YAML must be rejected, not repaired — no
			// scalar quoting, tab replacement, comment stripping, or key aliasing.
			let rawFrontmatter: Record<string, unknown>;
			let body: string;
			try {
				({ frontmatter: rawFrontmatter, body } = parseFrontmatter(content, {
					source: skillPath,
					level: "fatal",
					repair: false,
					rawKeys: true,
				}));
			} catch {
				warnings.push(`Skipping skill "${entry.name}": malformed YAML frontmatter`);
				return;
			}
			// §7.1: the Agent Skills specification is the source of truth for skill
			// validity; the frontmatter schema is closed per skills-ref, so client
			// conventions like `enabled` reject the skill as an unexpected field.
			// Non-conforming skills are skipped without affecting other components.
			const violation = validateAgentSkillFrontmatter(rawFrontmatter, entry.name);
			if (violation !== null) {
				warnings.push(`Skipping skill "${entry.name}": ${violation}`);
				return;
			}
			// Validation guarantees the frontmatter name matches the directory
			// (NFKC-normalized), so the on-disk directory name is the identity.
			// Store with the codebase's camelCase key convention (skill:// consumers,
			// prompt hiding via disableModelInvocation, …).
			const frontmatter = normalizeFrontmatterKeys(rawFrontmatter) as SkillFrontmatter;
			items.push({
				name: entry.name,
				containRoot: realRoot,
				path: skillPath,
				content: body,
				frontmatter,
				level,
				_source: createSourceMeta(PROVIDER_ID, skillPath, level),
			});
		}),
	);

	items.sort((a, b) => compareSkillOrder(a.name, a.path, b.name, b.path));
	return { items, warnings };
}

async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const candidates = await listCandidateRoots(ctx);
	const results = await Promise.all(
		candidates.map(async (candidate): Promise<LoadResult<Skill>> => {
			const status = await classifyAgentPluginRoot(candidate.path);
			if (status.kind === "none") return { items: [] };
			if (status.kind === "invalid") {
				// Fatal manifest violations reject the whole plugin (spec §5.2);
				// reported once here rather than from every capability loader.
				return { items: [], warnings: [`[agent-plugins] Rejected plugin at ${candidate.path}: ${status.reason}`] };
			}
			const scan = await scanStandardSkills(status.realRoot, candidate.level);
			return {
				items: scan.items,
				warnings: [...status.warnings, ...(scan.warnings ?? [])].map(
					warning => `[agent-plugins] ${status.manifest.name}: ${warning}`,
				),
			};
		}),
	);
	return {
		items: results.flatMap(result => result.items),
		warnings: results.flatMap(result => result.warnings ?? []),
	};
}

// =============================================================================
// MCP Servers
// =============================================================================

async function loadPluginMCPServers(
	realRoot: string,
	manifest: AgentPluginManifest,
	candidate: CandidateRoot,
	home: string,
): Promise<LoadResult<MCPServer>> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];
	// §4.1: resolve and contain mcp.json before any stat/read can follow a
	// symlink out of the package (failure boundary 2).
	const resolved = await resolveContainedPath(realRoot, path.join(realRoot, "mcp.json"));
	if (resolved.status === "missing") return { items, warnings };
	if (resolved.status === "outside") {
		warnings.push(`mcp.json resolves outside the plugin root`);
		return { items, warnings };
	}
	const mcpPath = resolved.realPath;

	let stat: Stats;
	try {
		stat = await fs.stat(mcpPath);
	} catch (err) {
		if (!isEnoent(err)) warnings.push(`Failed to read mcp.json: ${String(err)}`);
		return { items, warnings };
	}
	if (!stat.isFile()) {
		warnings.push(`mcp.json does not resolve to a regular file`);
		return { items, warnings };
	}
	const raw = await readFile(mcpPath);
	if (raw === null) {
		warnings.push(`Failed to read mcp.json`);
		return { items, warnings };
	}

	// Client-managed persistent data directory dedicated to this installed
	// plugin instance; contents survive plugin updates (spec §9.1).
	const pluginData = pluginDataDir(home, manifest.name, candidate.instanceKey);
	const result = await parseAgentPluginMcp(raw, { pluginRoot: realRoot, pluginData });
	if (result.status === "disabled") {
		warnings.push(`MCP disabled: ${result.reason}`);
		return { items, warnings };
	}
	warnings.push(...result.warnings);

	if (result.servers.some(server => server.transport === "stdio")) {
		// §9.1: the data directory must exist and be writable before any plugin
		// subprocess launches.
		await fs.mkdir(pluginData, { recursive: true });
	}

	for (const server of result.servers) {
		items.push({
			// Namespace by plugin name so servers from different plugins cannot
			// collide in the capability registry (matches claude-plugins).
			name: `${manifest.name}:${server.name}`,
			transport: server.transport,
			...(server.command !== undefined && { command: server.command }),
			...(server.args !== undefined && { args: server.args }),
			...(server.env !== undefined && { env: server.env }),
			// §9.2: env values are literal after the provider's ${PLUGIN_ROOT} /
			// ${PLUGIN_DATA} expansion — exempt from any further resolution.
			...(server.command !== undefined && { envPolicy: "literal" as const }),
			...(server.cwd !== undefined && { cwd: server.cwd }),
			...(server.url !== undefined && { url: server.url }),
			...(server.headers !== undefined && { headers: server.headers }),
			// §7.2.1: configured headers are literal, origin-locked package data —
			// never expanded and never forwarded to a different origin.
			...(server.url !== undefined && { headerPolicy: "origin-locked" as const }),
			_source: createSourceMeta(PROVIDER_ID, mcpPath, candidate.level),
		});
	}
	return { items, warnings };
}

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const candidates = await listCandidateRoots(ctx);
	const results = await Promise.all(
		candidates.map(async (candidate): Promise<LoadResult<MCPServer>> => {
			const status = await classifyAgentPluginRoot(candidate.path);
			// Invalid roots are rejected and reported by the skills loader.
			if (status.kind !== "standard") return { items: [] };
			const loaded = await loadPluginMCPServers(status.realRoot, status.manifest, candidate, ctx.home);
			return {
				items: loaded.items,
				warnings: (loaded.warnings ?? []).map(warning => `[agent-plugins] ${status.manifest.name}: ${warning}`),
			};
		}),
	);
	return {
		items: results.flatMap(result => result.items),
		warnings: results.flatMap(result => result.warnings ?? []),
	};
}

// =============================================================================
// Provider Registration
// =============================================================================

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadSkills,
});

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadMCPServers,
});
