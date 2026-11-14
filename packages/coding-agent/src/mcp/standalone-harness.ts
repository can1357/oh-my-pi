/**
 * Dependency-free harness implementation for the OhMyPi MCP server.
 *
 * The full OhMyPi tool registry depends on workspace packages that require
 * `bun install` (native addon + third-party modules). This module provides a
 * self-contained, real workspace tool set built only on Bun/Node builtins so
 * the MCP server can run and operate the workspace without that dependency
 * chain. Plugin/custom tools are discovered best-effort from trusted local
 * directories and registered alongside the built-ins.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
	HarnessSessionInterface,
	ToolDescriptor,
	ToolInvocationRequest,
	ToolInvocationResult,
	WorkspacePolicy,
} from "../harness/types";

export interface StandaloneToolContext {
	readonly cwd: string;
	readonly signal?: AbortSignal;
}

export interface StandaloneToolResult {
	readonly text: string;
	readonly isError?: boolean;
}

export interface StandaloneTool {
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
	/** Marks a tool that mutates the workspace (gated by allowWrite). */
	readonly write?: boolean;
	/** Marks a tool that executes arbitrary commands (gated by allowExecution). */
	readonly execution?: boolean;
	run(args: Record<string, unknown>, ctx: StandaloneToolContext): Promise<StandaloneToolResult>;
}

/** Resolve a path and reject anything that escapes the workspace root. */
export function resolveWithin(cwd: string, target: string): string {
	const abs = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
	const rel = relative(cwd, abs);
	if (rel === "") return abs;
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`WORKSPACE_ESCAPE: path "${target}" resolves outside workspace root`);
	}
	return abs;
}

function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function createStandaloneTools(): StandaloneTool[] {
	return [
		{
			name: "read",
			description: "Read a UTF-8 text file within the workspace. Returns numbered lines.",
			parameters: {
				type: "object",
				properties: {
					filePath: { type: "string", description: "Path to the file, relative to the workspace root." },
					offset: { type: "number", description: "Zero-based line offset to start reading from." },
					limit: { type: "number", description: "Maximum number of lines to return." },
				},
				required: ["filePath"],
			},
			async run(args, ctx) {
				const target = asString(args.filePath ?? args.path);
				const filePath = resolveWithin(ctx.cwd, target);
				const content = await readFile(filePath, "utf8");
				const lines = content.split("\n");
				const offset = asNumber(args.offset) ?? 0;
				const limit = asNumber(args.limit) ?? lines.length;
				const slice = lines.slice(offset, offset + limit);
				return { text: slice.map((line, i) => `${offset + i + 1}\t${line}`).join("\n") };
			},
		},
		{
			name: "write",
			description: "Write a UTF-8 text file within the workspace, creating parent directories.",
			parameters: {
				type: "object",
				properties: {
					filePath: { type: "string", description: "Path to the file, relative to the workspace root." },
					content: { type: "string", description: "Full file content to write." },
				},
				required: ["filePath", "content"],
			},
			write: true,
			async run(args, ctx) {
				const filePath = resolveWithin(ctx.cwd, asString(args.filePath ?? args.path));
				await mkdir(dirname(filePath), { recursive: true });
				await writeFile(filePath, asString(args.content), "utf8");
				return { text: `Wrote ${filePath}` };
			},
		},
		{
			name: "edit",
			description: "Replace an exact string in a workspace file. Fails if the old string is absent or ambiguous.",
			parameters: {
				type: "object",
				properties: {
					filePath: { type: "string", description: "Path to the file, relative to the workspace root." },
					oldString: { type: "string", description: "Exact text to replace." },
					newString: { type: "string", description: "Replacement text." },
				},
				required: ["filePath", "oldString", "newString"],
			},
			write: true,
			async run(args, ctx) {
				const filePath = resolveWithin(ctx.cwd, asString(args.filePath ?? args.path));
				const content = await readFile(filePath, "utf8");
				const oldString = asString(args.oldString);
				const newString = asString(args.newString);
				const first = content.indexOf(oldString);
				if (first === -1) {
					return { text: `oldString not found in ${filePath}`, isError: true };
				}
				if (content.indexOf(oldString, first + oldString.length) !== -1) {
					return { text: `oldString is ambiguous in ${filePath}; provide more context`, isError: true };
				}
				await writeFile(filePath, content.replace(oldString, newString), "utf8");
				return { text: `Edited ${filePath}` };
			},
		},
		{
			name: "glob",
			description: "Find files by glob pattern within the workspace.",
			parameters: {
				type: "object",
				properties: {
					pattern: { type: "string", description: "Glob pattern, e.g. '**/*.ts'." },
				},
				required: ["pattern"],
			},
			async run(args, ctx) {
				const pattern = asString(args.pattern);
				const glob = new Bun.Glob(pattern);
				const matches: string[] = [];
				for await (const file of glob.scan({ cwd: ctx.cwd, dot: false })) {
					matches.push(file);
					if (matches.length >= 500) break;
				}
				return { text: matches.join("\n") || "(no matches)" };
			},
		},
		{
			name: "grep",
			description: "Search file contents by regular expression within the workspace.",
			parameters: {
				type: "object",
				properties: {
					pattern: { type: "string", description: "Regular expression to search for." },
					glob: { type: "string", description: "Optional file glob filter, e.g. '**/*.ts'." },
				},
				required: ["pattern"],
			},
			async run(args, ctx) {
				const regex = new RegExp(asString(args.pattern));
				const glob = new Bun.Glob(asString(args.glob, "**/*"));
				const matches: string[] = [];
				for await (const file of glob.scan({ cwd: ctx.cwd, dot: false })) {
					if (matches.length >= 200) break;
					try {
						const content = await readFile(resolve(ctx.cwd, file), "utf8");
						const lines = content.split("\n");
						for (let i = 0; i < lines.length; i++) {
							if (regex.test(lines[i])) {
								matches.push(`${file}:${i + 1}:${lines[i]}`);
								if (matches.length >= 200) break;
							}
						}
					} catch {
						// Skip unreadable/binary files.
					}
				}
				return { text: matches.join("\n") || "(no matches)" };
			},
		},
		{
			name: "list_dir",
			description: "List directory entries within the workspace.",
			parameters: {
				type: "object",
				properties: {
					dirPath: { type: "string", description: "Directory path relative to the workspace root. Defaults to '.'." },
				},
			},
			async run(args, ctx) {
				const dirPath = resolveWithin(ctx.cwd, asString(args.dirPath ?? args.path, "."));
				const entries = await readdir(dirPath, { withFileTypes: true });
				const rendered = entries.map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name));
				return { text: rendered.join("\n") || "(empty)" };
			},
		},
		{
			name: "bash",
			description: "Execute a shell command in the workspace root and return combined output.",
			parameters: {
				type: "object",
				properties: {
					command: { type: "string", description: "Shell command to execute." },
				},
				required: ["command"],
			},
			execution: true,
			async run(args, ctx) {
				const command = asString(args.command);
				const proc = Bun.spawn(["bash", "-lc", command], {
					cwd: ctx.cwd,
					stdout: "pipe",
					stderr: "pipe",
				});
				const [stdout, stderr] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
				]);
				const exitCode = await proc.exited;
				const combined = [stdout, stderr].filter(part => part.length > 0).join("\n").trim();
				return {
					text: combined || `(exit ${exitCode})`,
					isError: exitCode !== 0,
				};
			},
		},
	];
}

export class StandaloneHarness implements HarnessSessionInterface {
	readonly sessionId: string;
	readonly workspacePolicy: WorkspacePolicy;
	readonly #tools = new Map<string, StandaloneTool>();

	constructor(cwd: string, tools: StandaloneTool[] = []) {
		this.sessionId = `standalone_${Date.now()}`;
		this.workspacePolicy = {
			cwd,
			readOnly: false,
			allowNetwork: true,
		};
		for (const tool of tools) {
			this.#tools.set(tool.name, tool);
		}
	}

	registerTool(tool: StandaloneTool): void {
		this.#tools.set(tool.name, tool);
	}

	#toDescriptor(tool: StandaloneTool): ToolDescriptor {
		return {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		};
	}

	getTools(): readonly ToolDescriptor[] {
		return Array.from(this.#tools.values(), tool => this.#toDescriptor(tool));
	}

	getTool(name: string): ToolDescriptor | undefined {
		const tool = this.#tools.get(name);
		return tool ? this.#toDescriptor(tool) : undefined;
	}

	hasTool(name: string): boolean {
		return this.#tools.has(name);
	}

	async invokeTool(request: ToolInvocationRequest): Promise<ToolInvocationResult> {
		const tool = this.#tools.get(request.toolName);
		if (!tool) {
			return {
				callId: request.callId,
				toolName: request.toolName,
				content: [{ type: "text", text: `Tool not found: "${request.toolName}"` }],
				isError: true,
			};
		}
		try {
			const result = await tool.run(request.arguments, {
				cwd: this.workspacePolicy.cwd,
				signal: request.signal,
			});
			return {
				callId: request.callId,
				toolName: request.toolName,
				content: [{ type: "text", text: result.text }],
				isError: result.isError,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				callId: request.callId,
				toolName: request.toolName,
				content: [{ type: "text", text: `Error executing ${request.toolName}: ${message}` }],
				isError: true,
			};
		}
	}
}

/**
 * Best-effort discovery of custom/plugin tools from trusted local directories.
 * Plugin modules are imported directly; failures are reported, never fatal.
 */
export async function discoverStandalonePlugins(
	cwd: string,
): Promise<{ tools: StandaloneTool[]; errors: string[] }> {
	const directories = [join(cwd, ".omp", "tools"), join(cwd, ".claude", "tools")];
	const tools: StandaloneTool[] = [];
	const errors: string[] = [];

	for (const directory of directories) {
		let entries: string[];
		try {
			entries = await readdir(directory);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!/\.(ts|js|mjs)$/.test(entry)) continue;
			try {
				const module = await import(join(directory, entry));
				const candidates: unknown[] = [module.default, ...Object.values(module)];
				for (const candidate of candidates) {
					if (
						candidate &&
						typeof candidate === "object" &&
						typeof (candidate as StandaloneTool).name === "string" &&
						typeof (candidate as StandaloneTool).run === "function"
					) {
						tools.push(candidate as StandaloneTool);
					}
				}
			} catch (error) {
				errors.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	return { tools, errors };
}
