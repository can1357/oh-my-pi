/**
 * One-time offer to keep the `~/` config omp used to inherit from other agents.
 *
 * omp used to read the user-level config of Claude Code, Codex, OpenCode, Cursor, Windsurf
 * and Copilot once `enabledProviders` (or a legacy `skills|commands.enable*User` toggle, or
 * `CLAUDE_CONFIG_DIR`) opted in; it reads only their project-level config now. On the first
 * interactive launch after that change, a user who had opted in sees, per tool, what they
 * were inheriting and may symlink or copy it into the agent dir. A marker file in the agent
 * dir records that the offer ran; users who never opted in never see it.
 *
 * @example
 * const tools = await pendingForeignConfigMigration([settings.getGlobalSettings(), settings.getProjectSettings()]);
 * if (tools.length > 0) await offerForeignConfigMigration(mode, tools);
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { errorMessage, getAgentDir, getMCPConfigPath, isEnoent, isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import { JSONC } from "bun";
import { resolveClaudePaths } from "../config/claude-paths";
import type { RawSettings } from "../config/settings";
import { addMCPServer, readMCPConfigFile } from "../mcp/config-writer";
import type { MCPServerConfig } from "../mcp/types";
import { shortenPath } from "../utils/render-utils";
import { replaceTabs } from "../utils/text-width";
import type { InteractiveModeContext } from "./types";

/** Agent-dir marker: the offer ran, whatever the answers were. */
const MARKER_FILE = "foreign-config-reviewed";

/** Provider ids whose `~/` config `enabledProviders` opted into; `*` and `all` meant every one. */
const FOREIGN_PROVIDERS = ["claude", "claude-plugins", "codex", "opencode", "cursor", "windsurf", "github"];

/** Legacy toggles that admitted one capability of one tool's `~/` config on their own. */
const LEGACY_TOGGLES = [
	"skills.enableClaudeUser",
	"skills.enableCodexUser",
	"commands.enableClaudeUser",
	"commands.enableOpencodeUser",
];

<<<<<<< HEAD
/** Names listed per kind before the offer collapses the rest into a count. */
const MAX_LISTED = 8;

/** Heading of each kind in the offer, in listing order. */
const KIND_HEADINGS: ReadonlyArray<readonly [InheritedItem["kind"], string]> = [
	["context", "Context"],
	["skill", "Skills"],
	["command", "Commands"],
	["prompt", "Prompts"],
	["rule", "Rules"],
	["mcp", "MCP servers"],
];
=======
/** Rows listed per tool before the offer collapses the rest into a count. */
const MAX_LISTED = 12;
>>>>>>> c14ad6c5db (refactor(discovery): pruned foreign user-level config and minor providers)

type Env = Readonly<Record<string, string | undefined>>;

/** What an inherited file is to omp. */
type FileKind = "context" | "skill" | "command" | "prompt" | "rule";

/** Inherited config that cannot be carried over; the offer only names it. */
type NoteKind = "codex-mcp" | "opencode-mcp" | "claude-plugins";

/** A file or directory the user inherited, and the agent-dir path omp reads its equivalent from. */
export interface InheritedFile {
	kind: FileKind;
	name: string;
	source: string;
	target: string;
}

/** An MCP server from a standard `mcpServers` JSON file; kept by copying it into the user `mcp.json`. */
export interface InheritedServer {
	kind: "mcp";
	name: string;
	source: string;
	config: MCPServerConfig;
}

/** One thing the user can keep. */
export type InheritedItem = InheritedFile | InheritedServer;

/** One kind of config a foreign tool kept under its `~/` root. */
interface Source {
	kind: FileKind | "mcp" | NoteKind;
	/** A file for context, mcp and notes; a directory for skill, command, prompt and rule. */
	path: string;
	/** Provider id, when it differs from the tool's (Claude Code plugins). */
	provider?: string;
	/** Legacy toggles that admitted this source without the provider opt-in. */
	toggles?: readonly string[];
}

/** A foreign tool's `~/` config, limited to the sources the user had opted into. */
export interface ForeignTool {
	label: string;
	/** `~/` config root, for display. */
	root: string;
	sources: Source[];
}

/** What one tool left behind: items the user can keep, and notes on config that cannot be kept. */
export interface InheritedConfig {
	tool: ForeignTool;
	items: InheritedItem[];
	notes: string[];
}

/** How kept files land in the agent dir; MCP servers are copied either way. */
export type KeepMode = "symlink" | "copy";

/** Outcome of keeping one tool's items. */
export interface KeepResult {
	kept: number;
	/** One line per item that was not kept, naming why. */
	skipped: string[];
}

interface ToolLayout extends ForeignTool {
	provider: string;
}

/** Every foreign tool's `~/` layout as omp used to read it, minus formats omp never understood. */
function toolLayouts(home: string, env: Env): ToolLayout[] {
	const { configDir: claude, configFile: claudeJson } = resolveClaudePaths(home, env);
	const codex = path.join(home, ".codex");
	const opencode = path.join(home, ".config", "opencode");
	const cursor = path.join(home, ".cursor");
	const windsurf = path.join(home, ".codeium", "windsurf");
	const copilot = env.COPILOT_HOME?.trim() || path.join(home, ".copilot");
	return [
		{
			label: "Claude Code",
			provider: "claude",
			root: claude,
			sources: [
				{ kind: "context", path: path.join(claude, "CLAUDE.md") },
				{ kind: "skill", path: path.join(claude, "skills"), toggles: ["skills.enableClaudeUser"] },
				{ kind: "command", path: path.join(claude, "commands"), toggles: ["commands.enableClaudeUser"] },
				{ kind: "mcp", path: claudeJson },
				{ kind: "mcp", path: path.join(claude, "mcp.json") },
				{
					kind: "claude-plugins",
					path: path.join(claude, "plugins", "installed_plugins.json"),
					provider: "claude-plugins",
					toggles: ["claude"],
				},
			],
		},
		{
			label: "Codex",
			provider: "codex",
			root: codex,
			sources: [
				{ kind: "context", path: path.join(codex, "AGENTS.md") },
				{ kind: "skill", path: path.join(codex, "skills"), toggles: ["skills.enableCodexUser"] },
				{ kind: "prompt", path: path.join(codex, "prompts") },
				{ kind: "codex-mcp", path: path.join(codex, "config.toml") },
			],
		},
		{
			label: "OpenCode",
			provider: "opencode",
			root: opencode,
			sources: [
				{ kind: "context", path: path.join(opencode, "AGENTS.md") },
				{ kind: "skill", path: path.join(opencode, "skills") },
				{ kind: "command", path: path.join(opencode, "commands"), toggles: ["commands.enableOpencodeUser"] },
				{ kind: "opencode-mcp", path: path.join(opencode, "opencode.json") },
				{ kind: "opencode-mcp", path: path.join(opencode, "opencode.jsonc") },
			],
		},
		{
			label: "Cursor",
			provider: "cursor",
			root: cursor,
			sources: [
				{ kind: "rule", path: path.join(cursor, "rules") },
				{ kind: "mcp", path: path.join(cursor, "mcp.json") },
			],
		},
		{
			label: "Windsurf",
			provider: "windsurf",
			root: windsurf,
			sources: [
				{ kind: "rule", path: path.join(windsurf, "memories", "global_rules.md") },
				{ kind: "mcp", path: path.join(windsurf, "mcp_config.json") },
			],
		},
		{
			label: "GitHub Copilot",
			provider: "github",
			root: copilot,
			sources: [{ kind: "context", path: path.join(copilot, "copilot-instructions.md") }],
		},
	];
}

/** A raw setting by dotted id, nested (`skills: { enableClaudeUser }`) or flat (`"skills.enableClaudeUser"`). */
function rawSetting(layer: RawSettings, id: string): unknown {
	if (id in layer) return layer[id];
	let value: unknown = layer;
	for (const segment of id.split(".")) {
		if (!isRecord(value)) return undefined;
		value = value[segment];
	}
	return value;
}

/** Provider ids a path-scoped provider list names, whatever paths its entries are scoped to. */
function providerIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap(entry => {
		if (typeof entry === "string") return [entry];
		if (isRecord(entry) && Array.isArray(entry.providers)) {
			return entry.providers.filter((id): id is string => typeof id === "string");
		}
		return [];
	});
}

/**
 * The foreign tools whose `~/` config these settings layers had omp read, limited to the
 * sources they admitted; empty once the offer ran (marker present) or when nothing was
 * opted into. Called at interactive startup with the raw global and project layers.
 */
export async function pendingForeignConfigMigration(
	layers: readonly RawSettings[],
	where: { home?: string; env?: Env; agentDir?: string } = {},
): Promise<ForeignTool[]> {
	const env = where.env ?? process.env;
	const optIns = new Set<string>();
	const disabled = new Set<string>();
	for (const layer of layers) {
		for (const id of providerIds(layer.enabledProviders)) {
			if (id === "*" || id === "all") for (const provider of FOREIGN_PROVIDERS) optIns.add(provider);
			else optIns.add(id);
		}
		for (const id of providerIds(layer.disabledProviders)) disabled.add(id);
		for (const toggle of LEGACY_TOGGLES) if (rawSetting(layer, toggle) === true) optIns.add(toggle);
	}
	if (env.CLAUDE_CONFIG_DIR?.trim()) optIns.add("claude");
	// A disabled provider read nothing, and its opt-in admitted nothing else (Claude Code plugins).
	for (const id of disabled) optIns.delete(id);

	const tools: ForeignTool[] = [];
	for (const layout of toolLayouts(where.home ?? os.homedir(), env)) {
		const sources = layout.sources.filter(source => {
			const provider = source.provider ?? layout.provider;
			if (disabled.has(provider)) return false;
			return optIns.has(provider) || (source.toggles?.some(toggle => optIns.has(toggle)) ?? false);
		});
		if (sources.length > 0) tools.push({ label: layout.label, root: layout.root, sources });
	}
	if (tools.length === 0) return tools;
	return (await Bun.file(path.join(where.agentDir ?? getAgentDir(), MARKER_FILE)).exists()) ? [] : tools;
}

async function isFile(filePath: string): Promise<boolean> {
	try {
		return (await fs.stat(filePath)).isFile();
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.lstat(filePath);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

/** Relative paths of the files under `dir` that match `pattern`; none when `dir` is missing. */
async function listFiles(dir: string, pattern: string): Promise<string[]> {
	try {
		if (!(await fs.stat(dir)).isDirectory()) return [];
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const files: string[] = [];
	for await (const file of new Bun.Glob(pattern).scan({ cwd: dir, onlyFiles: true, followSymlinks: true })) {
		files.push(file);
	}
	return files.sort();
}

/** Names of the MCP servers a parsed config keeps under `mcp` (OpenCode v2 nests them under `mcp.servers`). */
function openCodeServerNames(config: unknown): string[] {
	if (!isRecord(config) || !isRecord(config.mcp)) return [];
	const servers = config.mcp.servers;
	const nested = isRecord(servers) && servers.command === undefined && servers.url === undefined;
	return Object.keys(nested ? servers : config.mcp);
}

/** Note on MCP servers whose format does not map onto `mcp.json` (secrets resolved from env at load). */
function mcpNote(names: readonly string[], file: string): string | null {
	if (names.length === 0) return null;
	return `MCP servers in ${shortenPath(file)} are not copied: ${names.join(", ")}. Add them again with /mcp add.`;
}

async function scanSource(source: Source, agentDir: string, found: InheritedConfig): Promise<void> {
	switch (source.kind) {
		case "context":
			if (await isFile(source.path)) {
				const target = path.join(agentDir, "AGENTS.md");
				found.items.push({ kind: "context", name: path.basename(source.path), source: source.path, target });
			}
			return;
		case "skill":
			for (const manifest of await listFiles(source.path, "*/SKILL.md")) {
				const name = path.dirname(manifest);
				const target = path.join(agentDir, "skills", name);
				found.items.push({ kind: "skill", name, source: path.join(source.path, name), target });
			}
			return;
		case "command":
			for (const file of await listFiles(source.path, "**/*.md")) {
				// Nested commands were namespaced (`ns/review.md` → `/ns:review`); the agent dir reads one level.
				const name = file.slice(0, -".md".length).split(path.sep).join(":");
				if (process.platform === "win32" && name.includes(":")) {
					found.notes.push(`Namespaced command ${file} is not copied: Windows file names cannot hold ":".`);
					continue;
				}
				const target = path.join(agentDir, "commands", `${name}.md`);
				found.items.push({ kind: "command", name, source: path.join(source.path, file), target });
			}
			return;
		case "prompt":
			for (const file of await listFiles(source.path, "*.md")) {
				const target = path.join(agentDir, "prompts", file);
				found.items.push({ kind: "prompt", name: file, source: path.join(source.path, file), target });
			}
			return;
		case "rule": {
			const single = await isFile(source.path);
			const files = single ? [path.basename(source.path)] : await listFiles(source.path, "*.{md,mdc}");
			const dir = single ? path.dirname(source.path) : source.path;
			for (const file of files) {
				const target = path.join(agentDir, "rules", file);
				found.items.push({ kind: "rule", name: file, source: path.join(dir, file), target });
			}
			return;
		}
		case "mcp": {
			const servers = (await readMCPConfigFile(source.path)).mcpServers ?? {};
			const taken = new Set(found.items.filter(item => item.kind === "mcp").map(item => item.name));
			for (const name in servers) {
				if (!taken.has(name)) found.items.push({ kind: "mcp", name, source: source.path, config: servers[name] });
			}
			return;
		}
		case "codex-mcp": {
			if (!(await isFile(source.path))) return;
			const config: unknown = Bun.TOML.parse(await Bun.file(source.path).text());
			const servers = isRecord(config) && isRecord(config.mcp_servers) ? Object.keys(config.mcp_servers) : [];
			const note = mcpNote(servers, source.path);
			if (note) found.notes.push(note);
			return;
		}
		case "opencode-mcp": {
			if (!(await isFile(source.path))) return;
			const note = mcpNote(openCodeServerNames(JSONC.parse(await Bun.file(source.path).text())), source.path);
			if (note) found.notes.push(note);
			return;
		}
		case "claude-plugins": {
			if (!(await isFile(source.path))) return;
			const registry: unknown = JSON.parse(await Bun.file(source.path).text());
			const plugins = isRecord(registry) && isRecord(registry.plugins) ? Object.keys(registry.plugins) : [];
			if (plugins.length > 0) {
				found.notes.push(
					`Claude Code plugins are not loaded anymore: ${plugins.join(", ")}. Install them again with /marketplace install.`,
				);
			}
			return;
		}
	}
}

/** What each tool left behind under its `~/` root; tools with nothing to keep or note are omitted. */
export async function findInheritedConfig(tools: readonly ForeignTool[], agentDir: string): Promise<InheritedConfig[]> {
	const results: InheritedConfig[] = [];
	for (const tool of tools) {
		const found: InheritedConfig = { tool, items: [], notes: [] };
		for (const source of tool.sources) {
			try {
				await scanSource(source, agentDir, found);
			} catch (error) {
				found.notes.push(`Could not read ${shortenPath(source.path)}: ${errorMessage(error)}`);
			}
		}
		if (found.items.length > 0 || found.notes.length > 0) results.push(found);
	}
	return results;
}

/**
 * Keep `items`: files are symlinked or copied to their agent-dir target, MCP servers are copied
 * into `mcpConfigPath`. An item whose target (or server name) is already taken is left alone.
 */
export async function keepInheritedConfig(
	items: readonly InheritedItem[],
	mode: KeepMode,
	mcpConfigPath: string,
): Promise<KeepResult> {
	const result: KeepResult = { kept: 0, skipped: [] };
	for (const item of items) {
		try {
			if (item.kind === "mcp") {
				await addMCPServer(mcpConfigPath, item.name, item.config);
			} else if (await pathExists(item.target)) {
				result.skipped.push(`${shortenPath(item.target)} already exists`);
				continue;
			} else {
				await fs.mkdir(path.dirname(item.target), { recursive: true });
				if (mode === "copy") {
					await fs.cp(item.source, item.target, {
						recursive: true,
						dereference: true,
						errorOnExist: true,
						force: false,
					});
				} else {
					const directory = (await fs.stat(item.source)).isDirectory();
					await fs.symlink(item.source, item.target, directory ? "junction" : "file");
				}
			}
			result.kept++;
		} catch (error) {
			result.skipped.push(
				`${item.kind === "mcp" ? `MCP server ${item.name}` : shortenPath(item.source)}: ${errorMessage(error)}`,
			);
		}
	}
	return result;
}

const KEEP_SYMLINK = { label: "Keep, symlinked", description: "Link each file; MCP servers are copied into mcp.json" };
const KEEP_COPY = { label: "Keep, copied", description: "Copy each file and MCP server" };
const DISCARD = { label: "Don't keep", description: "Leave them where they are" };

function display(text: string): string {
	return replaceTabs(sanitizeText(text));
}

/** The offer for one tool: what it held, what cannot be kept, and the question. */
function describe(found: InheritedConfig, agentDir: string): string {
	const lines = [`omp no longer reads ${found.tool.label} config from ${shortenPath(found.tool.root)}.`];
	if (found.items.length > 0) {
<<<<<<< HEAD
		// One line per kind: column padding only lines up in monospace, and Tern draws dialogs proportionally.
		lines.push("You were inheriting:");
		for (const [kind, heading] of KIND_HEADINGS) {
			const names = found.items.filter(item => item.kind === kind).map(item => display(item.name));
			if (names.length === 0) continue;
			const more = names.length > MAX_LISTED ? `, … and ${names.length - MAX_LISTED} more` : "";
			lines.push(`• ${heading}: ${names.slice(0, MAX_LISTED).join(", ")}${more}`);
		}
=======
		lines.push("You were inheriting:");
		for (const item of found.items.slice(0, MAX_LISTED)) lines.push(`  ${item.kind.padEnd(8)} ${display(item.name)}`);
		if (found.items.length > MAX_LISTED) lines.push(`  … and ${found.items.length - MAX_LISTED} more`);
>>>>>>> c14ad6c5db (refactor(discovery): pruned foreign user-level config and minor providers)
	}
	for (const note of found.notes) lines.push(display(note));
	if (found.items.length > 0) lines.push(`Keep them in ${shortenPath(agentDir)}?`);
	return lines.join("\n");
}

/**
 * Ask, per tool in `tools`, whether to keep what the user inherited from it; keep the answers,
 * report them, and record that the offer ran. Skills and commands kept are live at once; MCP
 * servers connect on `/mcp reload`; context files and rules apply from the next session.
 */
export async function offerForeignConfigMigration(
	ctx: InteractiveModeContext,
	tools: readonly ForeignTool[],
): Promise<void> {
	const agentDir = getAgentDir();
	let keptFiles = false;
	for (const found of await findInheritedConfig(tools, agentDir)) {
		if (found.items.length === 0) {
			ctx.showWarning(describe(found, agentDir));
			continue;
		}
		const choice = await ctx.showHookSelector(describe(found, agentDir), [KEEP_SYMLINK, KEEP_COPY, DISCARD]);
		if (choice !== KEEP_SYMLINK.label && choice !== KEEP_COPY.label) continue;
		const mode: KeepMode = choice === KEEP_SYMLINK.label ? "symlink" : "copy";
		const result = await keepInheritedConfig(found.items, mode, getMCPConfigPath("user"));
		keptFiles ||= found.items.some(item => item.kind !== "mcp");
		const reload = found.items.some(item => item.kind === "mcp")
			? " Run /mcp reload to connect its MCP servers."
			: "";
		ctx.showStatus(`Kept ${result.kept} of ${found.items.length} from ${found.tool.label}.${reload}`);
		if (result.skipped.length > 0) {
			ctx.showWarning(`Not kept from ${found.tool.label}:\n${result.skipped.map(display).join("\n")}`);
		}
	}
	await Bun.write(path.join(agentDir, MARKER_FILE), `${new Date().toISOString()}\n`);
	if (keptFiles) await ctx.session.refreshSkillsAndCommands();
}
