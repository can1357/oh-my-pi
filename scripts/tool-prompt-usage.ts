#!/usr/bin/env bun
/**
 * Estimate token usage for rendered coding-agent tool prompt templates.
 *
 * Usage:
 *   bun scripts/tool-prompt-usage.ts
 *   bun scripts/tool-prompt-usage.ts --json
 *   bun scripts/tool-prompt-usage.ts --encoding cl100k_base
 *   bun scripts/tool-prompt-usage.ts packages/coding-agent/src/prompts/tools/read.md
 *
 * The renderer uses representative default settings for conditional templates.
 * Dynamic runtime payloads (background job output, late diagnostics, task result
 * previews, MCP server lists, SSH hosts, custom agents) are sample-sized unless
 * they are bundled static data.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { countTokens, Encoding } from "@oh-my-pi/pi-natives";
import { prompt } from "@oh-my-pi/pi-utils";
import { loadBundledAgents } from "../packages/coding-agent/src/task/agents";
import { isReadOnlyAgent } from "../packages/coding-agent/src/task/read-only-policy";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const TOOL_PROMPT_DIR = path.join(REPO_ROOT, "packages/coding-agent/src/prompts/tools");
const DEFAULT_READ_LIMIT = "300";
const DEFAULT_MAX_LINES = "3000";
const DEFAULT_MAX_CONCURRENCY = 32;

interface AgentPromptRow {
	name: string;
	description: string;
	readOnly: boolean;
}

interface PromptEstimate {
	path: string;
	name: string;
	tokens: number;
	chars: number;
	lines: number;
}

interface CliOptions {
	encoding: Encoding;
	json: boolean;
	paths: string[];
}

const USAGE = [
	"Usage: bun scripts/tool-prompt-usage.ts [options] [prompt.md ...]",
	"",
	"Options:",
	"  --encoding <name>  o200k_base (default) or cl100k_base",
	"  --json             print machine-readable JSON",
	"  --help             show this help",
].join("\n");

function parseEncoding(value: string | undefined): Encoding {
	if (!value) return Encoding.O200kBase;
	const normalized = value.toLowerCase().replace(/-/g, "_");
	if (normalized === "o200k" || normalized === "o200k_base") return Encoding.O200kBase;
	if (normalized === "cl100k" || normalized === "cl100k_base") return Encoding.Cl100kBase;
	throw new Error(`Unknown encoding "${value}". Expected o200k_base or cl100k_base.`);
}

function parseCli(): CliOptions | null {
	const parsed = parseArgs({
		args: Bun.argv.slice(2),
		allowPositionals: true,
		options: {
			encoding: { type: "string" },
			help: { type: "boolean", short: "h" },
			json: { type: "boolean" },
		},
	});
	if (parsed.values.help === true) {
		console.log(USAGE);
		return null;
	}
	return {
		encoding: parseEncoding(parsed.values.encoding),
		json: parsed.values.json === true,
		paths: parsed.positionals,
	};
}

function relativePath(filePath: string): string {
	return path.relative(REPO_ROOT, filePath).split(path.sep).join("/");
}

async function collectPromptPaths(positionals: readonly string[]): Promise<string[]> {
	if (positionals.length === 0) {
		const files = await Array.fromAsync(
			new Bun.Glob("*.md").scan({ cwd: TOOL_PROMPT_DIR, absolute: true, onlyFiles: true }),
		);
		return files.sort((a, b) => relativePath(a).localeCompare(relativePath(b)));
	}

	const files: string[] = [];
	for (const positional of positionals) {
		const resolved = path.resolve(REPO_ROOT, positional);
		const stat = await fs.stat(resolved);
		if (stat.isDirectory()) {
			for await (const entry of new Bun.Glob("*.md").scan({ cwd: resolved, absolute: true, onlyFiles: true })) {
				files.push(entry);
			}
		} else if (stat.isFile()) {
			files.push(resolved);
		} else {
			throw new Error(`${positional} is neither a file nor a directory.`);
		}
	}
	return Array.from(new Set(files)).sort((a, b) => relativePath(a).localeCompare(relativePath(b)));
}

function bundledAgents(): AgentPromptRow[] {
	return loadBundledAgents().map(agent => ({
		name: agent.name,
		description: agent.description,
		readOnly: isReadOnlyAgent(agent),
	}));
}

function renderContext(): Record<string, unknown> {
	return {
		DEFAULT_LIMIT: DEFAULT_READ_LIMIT,
		DEFAULT_MAX_LINES,
		INSPECT_IMAGE_ENABLED: false,
		IS_HL_MODE: true,
		IS_LINE_NUMBER_MODE: false,
		MAX_CONCURRENCY: DEFAULT_MAX_CONCURRENCY,
		agentName: "task",
		agents: bundledAgents(),
		asyncEnabled: true,
		autoBackgroundEnabled: false,
		autoBackgroundThresholdSeconds: 60,
		batchEnabled: true,
		discoverableBuiltinToolNames: [],
		discoverableMCPServerSummaries: [],
		discoverableToolCount: 0,
		duration: "1s",
		files: [
			{
				messages: ["1:1 Example diagnostic"],
				path: "src/example.ts",
				summary: "1 diagnostic",
			},
		],
		hasAstEdit: true,
		hasAstGrep: true,
		hasDiscoverableBuiltinTools: false,
		hasDiscoverableMCPServers: false,
		hasFind: true,
		hasSearch: true,
		id: "ExampleAgent",
		ircEnabled: true,
		isolationEnabled: false,
		jobs: [
			{
				jobId: "job_1",
				label: "sample",
				result: "(sample background result omitted for token estimate)",
			},
		],
		js: true,
		mergeSummary: "",
		meta: { charSize: 120, lineCount: 4 },
		multiple: false,
		preview: "(sample task output omitted for token estimate)",
		py: true,
		spawningDisabled: false,
		spawns: true,
		status: "completed",
		truncated: false,
	};
}

async function estimatePrompt(filePath: string, encoding: Encoding): Promise<PromptEstimate> {
	const template = await Bun.file(filePath).text();
	const rendered = prompt.render(template, renderContext());
	return {
		path: relativePath(filePath),
		name: path.basename(filePath, ".md"),
		tokens: countTokens(rendered, encoding),
		chars: rendered.length,
		lines: rendered.length === 0 ? 0 : rendered.split("\n").length,
	};
}

function printTable(estimates: PromptEstimate[], encoding: Encoding): void {
	const rows = [...estimates].sort((a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path));
	const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
	const totalChars = rows.reduce((sum, row) => sum + row.chars, 0);
	const totalLines = rows.reduce((sum, row) => sum + row.lines, 0);
	const tokenWidth = Math.max(
		"tokens".length,
		String(totalTokens).length,
		...rows.map(row => String(row.tokens).length),
	);
	const charWidth = Math.max("chars".length, String(totalChars).length, ...rows.map(row => String(row.chars).length));
	const lineWidth = Math.max("lines".length, String(totalLines).length, ...rows.map(row => String(row.lines).length));

	const encodingName = encoding === Encoding.Cl100kBase ? "cl100k_base" : "o200k_base";
	console.log(`Tool prompt token estimates (${encodingName})`);
	console.log(
		`${"tokens".padStart(tokenWidth)}  ${"chars".padStart(charWidth)}  ${"lines".padStart(lineWidth)}  prompt`,
	);
	console.log(`${"-".repeat(tokenWidth)}  ${"-".repeat(charWidth)}  ${"-".repeat(lineWidth)}  ${"-".repeat(6)}`);
	for (const row of rows) {
		console.log(
			`${String(row.tokens).padStart(tokenWidth)}  ${String(row.chars).padStart(charWidth)}  ${String(row.lines).padStart(lineWidth)}  ${row.path}`,
		);
	}
	console.log(`${"-".repeat(tokenWidth)}  ${"-".repeat(charWidth)}  ${"-".repeat(lineWidth)}  ${"-".repeat(6)}`);
	console.log(
		`${String(totalTokens).padStart(tokenWidth)}  ${String(totalChars).padStart(charWidth)}  ${String(totalLines).padStart(lineWidth)}  TOTAL (${rows.length} prompts)`,
	);
}

async function run(): Promise<void> {
	const options = parseCli();
	if (!options) return;
	const paths = await collectPromptPaths(options.paths);
	if (paths.length === 0) {
		throw new Error("No prompt files matched.");
	}
	const estimates = await Promise.all(paths.map(filePath => estimatePrompt(filePath, options.encoding)));
	if (options.json) {
		const totals = estimates.reduce(
			(acc, row) => ({
				chars: acc.chars + row.chars,
				lines: acc.lines + row.lines,
				tokens: acc.tokens + row.tokens,
			}),
			{ chars: 0, lines: 0, tokens: 0 },
		);
		const encodingName = options.encoding === Encoding.Cl100kBase ? "cl100k_base" : "o200k_base";
		console.log(JSON.stringify({ encoding: encodingName, prompts: estimates, totals }, null, 2));
		return;
	}
	printTable(estimates, options.encoding);
}

run().catch(error => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exit(1);
});
