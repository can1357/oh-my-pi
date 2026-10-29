/**
 * Agents CLI command handlers.
 *
 * Handles `omp agents unpack` for writing bundled agent definitions to disk,
 * and `omp agents show <name>` for what one agent runs with.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { formatDuration, getAgentDir, getProjectDir, isEnoent, sanitizeText } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { CliUsageError } from "@oh-my-pi/pi-utils/cli";
import { YAML } from "bun";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { cfgExtensions } from "../extensibility/settings";
import { initializeWithSettings } from "../discovery";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { loadBundledAgents } from "../task/agents";
import { discoverAgents, getAgent } from "../task/discovery";
import {
	type AgentConfigEntry,
	type AgentConfigField,
	type AgentConfigSource,
	type EffectiveAgentConfig,
	resolveEffectiveAgentConfig,
} from "../task/effective-config";
import type { AgentDefinition } from "../task/types";

export type AgentsAction = "unpack" | "show";

export interface AgentsCommandArgs {
	action: AgentsAction;
	/** Agent to show. */
	name?: string;
	flags: {
		force?: boolean;
		json?: boolean;
		dir?: string;
		user?: boolean;
		project?: boolean;
	};
}

interface UnpackResult {
	targetDir: string;
	total: number;
	written: string[];
	skipped: string[];
}

function writeStdout(line: string): void {
	process.stdout.write(`${line}\n`);
}

function resolveTargetDir(flags: AgentsCommandArgs["flags"]): string {
	if (flags.dir && flags.dir.trim().length > 0) {
		return path.resolve(getProjectDir(), flags.dir.trim());
	}

	if (flags.user && flags.project) {
		throw new Error("Choose either --user or --project, not both.");
	}

	if (flags.project) {
		return path.resolve(getProjectDir(), ".omp", "agents");
	}

	return path.join(getAgentDir(), "agents");
}

function toFrontmatter(agent: AgentDefinition): Record<string, unknown> {
	const frontmatter: Record<string, unknown> = {
		name: agent.name,
		description: agent.description,
	};

	if (agent.tools !== undefined) frontmatter.tools = agent.tools;
	if (agent.spawns !== undefined) frontmatter.spawns = agent.spawns;
	if (agent.model && agent.model.length > 0) frontmatter.model = agent.model;
	if (agent.thinkingLevel) frontmatter.thinkingLevel = agent.thinkingLevel;
	if (agent.output !== undefined) frontmatter.output = agent.output;
	if (agent.blocking) frontmatter.blocking = true;
	if (agent.structured) frontmatter.structured = true;

	return frontmatter;
}

function serializeAgent(agent: AgentDefinition): string {
	const frontmatter = YAML.stringify(toFrontmatter(agent), null, 2).trimEnd();
	const body = agent.systemPrompt.trim();
	return `---\n${frontmatter}\n---\n\n${body}\n`;
}

async function unpackBundledAgents(flags: AgentsCommandArgs["flags"]): Promise<UnpackResult> {
	const targetDir = resolveTargetDir(flags);
	await fs.mkdir(targetDir, { recursive: true });

	const bundledAgents = [...loadBundledAgents()].sort((a, b) => a.name.localeCompare(b.name));
	const written: string[] = [];
	const skipped: string[] = [];

	for (const agent of bundledAgents) {
		const filePath = path.join(targetDir, `${agent.name}.md`);
		if (!flags.force) {
			try {
				await fs.stat(filePath);
				skipped.push(filePath);
				continue;
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}

		await Bun.write(filePath, serializeAgent(agent));
		written.push(filePath);
	}

	return {
		targetDir,
		total: bundledAgents.length,
		written,
		skipped,
	};
}

/** Rows of `omp agents show`, with how each renders a null (off or unresolved) value. */
const SHOW_ROWS: ReadonlyArray<{ field: AgentConfigField; label: string; none: string }> = [
	{ field: "model", label: "model", none: "unresolved" },
	{ field: "thinking", label: "thinking", none: "default" },
	{ field: "serviceTier", label: "service tier", none: "none" },
	{ field: "compaction", label: "compaction", none: "none" },
	{ field: "requestBudget", label: "request budget", none: "off" },
	{ field: "tools", label: "tools", none: "default set" },
	{ field: "prewalk", label: "prewalk", none: "off" },
	{ field: "advisor", label: "advisor", none: "off" },
	{ field: "accountPools", label: "account pool", none: "all accounts" },
	{ field: "idleTtlMs", label: "idle TTL", none: "never parked" },
];

const MAX_SHOW_VALUE_WIDTH = 40;

function formatEntryValue(field: AgentConfigField, value: AgentConfigEntry["value"], none: string): string {
	if (value === null || (typeof value === "number" && value <= 0)) return none;
	if (typeof value === "number") {
		if (field === "idleTtlMs") return formatDuration(value);
		return field === "compaction" ? `${value.toLocaleString("en-US")} tokens` : `${value} requests`;
	}
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.join(", ");
	return Object.entries(value)
		.map(([provider, keys]) => `${provider}: ${keys.join(", ")}`)
		.join("; ");
}

function formatSource(source: AgentConfigSource): string {
	switch (source.layer) {
		case "agent-entry":
			return source.key ?? "agent entry";
		case "frontmatter":
			return `frontmatter ${source.key}`;
		case "setting":
			return `${source.key} (${source.scope})`;
		case "default":
			return source.key ? `${source.key} (default)` : "default";
		case "session":
			return source.key ? `session (${source.key})` : "session";
	}
}

/** Agent files are repository content: strip ANSI/control characters and newlines before they reach the terminal. */
function terminalSafe(text: string): string {
	return sanitizeText(text).replace(/[\r\n]+/g, " ");
}

async function showAgent(name: string | undefined, json: boolean | undefined): Promise<void> {
	const cwd = getProjectDir();
	// Read-only: showing an agent must not migrate or write any settings file.
	const settings = await Settings.loadReadOnly({ cwd });
	initializeWithSettings(settings);
	// The effective extension roots, as session startup passes them, so extension agents resolve the same.
	const { agents } = await discoverAgents(cwd, undefined, {
		explicit: [],
		mode: "merge",
		configured: cfgExtensions.get(settings),
		configuredLevel: settings.extensionsSourceLevel(),
	});
	const agent = name ? getAgent(agents, name) : undefined;
	if (!agent) {
		const available = agents.map(candidate => terminalSafe(candidate.name)).join(", ");
		throw new CliUsageError(
			name
				? `Unknown agent "${terminalSafe(name)}". Available: ${available}`
				: `Usage: omp agents show <name>. Available: ${available}`,
		);
	}
	const authStorage = await discoverAuthStorage(undefined, { settings });
	let config: EffectiveAgentConfig;
	try {
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
		await modelRegistry.hydrateCredentialScopedModelCaches();
		await loadCliExtensionProviders(modelRegistry, settings, cwd);
		config = await resolveEffectiveAgentConfig(agent, settings, modelRegistry, cwd);
	} finally {
		authStorage.close();
	}
	if (json) {
		writeStdout(JSON.stringify(config, null, 2));
		return;
	}

	for (const line of formatAgentConfig(config)) writeStdout(line);
}

/** Terminal lines of `omp agents show`: a header, then one aligned row per spawn-time value. */
export function formatAgentConfig(config: EffectiveAgentConfig): string[] {
	const definedIn = config.filePath ? `${config.definedIn}: ${shortenPath(config.filePath)}` : config.definedIn;
	const lines = [`${chalk.bold(terminalSafe(config.name))} ${chalk.dim(`(${terminalSafe(definedIn)})`)}`];
	if (config.disabled) {
		lines.push(chalk.yellow(`${theme.status.warning} Disabled by task.disabledAgents: spawns are refused.`));
	}
	const rows = SHOW_ROWS.map(({ field, label, none }) => {
		const value = terminalSafe(formatEntryValue(field, config[field].value, none));
		// Terminal cells, not UTF-16 units: account identities and advisor names may be CJK or emoji.
		return { label, value, width: Bun.stringWidth(value), entry: config[field] };
	});
	const labelWidth = Math.max(...rows.map(row => row.label.length));
	// Long tool lists and account pools overflow instead of pushing every source column right.
	const valueWidth = Math.max(...rows.map(row => row.width).filter(width => width <= MAX_SHOW_VALUE_WIDTH));
	for (const { label, value, width, entry } of rows) {
		const note = entry.note ? chalk.dim(` · ${terminalSafe(entry.note)}`) : "";
		const padding = " ".repeat(Math.max(0, valueWidth - width));
		lines.push(
			`  ${label.padEnd(labelWidth)}  ${value}${padding}  ${chalk.dim(terminalSafe(formatSource(entry.source)))}${note}`,
		);
	}
	return lines;
}

export async function runAgentsCommand(cmd: AgentsCommandArgs): Promise<void> {
	switch (cmd.action) {
		case "show":
			await showAgent(cmd.name, cmd.flags.json);
			return;
		case "unpack": {
			const result = await unpackBundledAgents(cmd.flags);
			if (cmd.flags.json) {
				writeStdout(JSON.stringify(result, null, 2));
				return;
			}

			writeStdout(chalk.bold(`Bundled agents: ${result.total}`));
			writeStdout(chalk.dim(`Target directory: ${result.targetDir}`));
			writeStdout(chalk.green(`${theme.status.success} Written: ${result.written.length}`));
			if (result.skipped.length > 0) {
				writeStdout(
					chalk.yellow(
						`${theme.status.warning} Skipped existing: ${result.skipped.length} (use --force to overwrite)`,
					),
				);
			}

			for (const filePath of result.written) {
				writeStdout(chalk.dim(`  + ${filePath}`));
			}
			for (const filePath of result.skipped) {
				writeStdout(chalk.dim(`  = ${filePath}`));
			}
			return;
		}
	}
}
