/**
 * Compatibility shim for legacy extensions importing the package root of
 * `@oh-my-pi/pi-coding-agent` (or one of its aliased scopes like
 * `@earendil-works/pi-coding-agent` or `@mariozechner/pi-coding-agent`).
 *
 * The coding-agent package's own barrel (`./src/index.ts`) cannot be listed
 * as a `bun --compile` extra entrypoint alongside the CLI entry without
 * silently breaking the main binary's startup (see issue #1474 follow-up).
 * Routing legacy plugin imports through this sibling shim sidesteps that
 * conflict: bun bundles a distinct entry whose path differs from the CLI
 * entry, while still re-exporting the canonical surface so plugins observe
 * the same module identity as a direct `@oh-my-pi/pi-coding-agent` import.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type AgentMessage,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type MessageCountOptions,
	Tokenizer,
} from "@oh-my-pi/pi-agent-core";
import { type AuthCredential, SqliteAuthCredentialStore, type TSchema } from "@oh-my-pi/pi-ai";
import { piEscapeRegexLiteral, piJoinPath } from "@oh-my-pi/pi-ai/providers/cursor-pi-args";
import { getKeybindings, type Keybinding, Text } from "@oh-my-pi/pi-tui";
import {
	getAgentDbPath,
	getAgentDir,
	getProjectDir,
	isCompiledBinary,
	parseFrontmatter as parseOmpFrontmatter,
} from "@oh-my-pi/pi-utils";
import { getPackageDir as getOmpPackageDir } from "../config";
import { formatKeyHints } from "../config/keybindings";
import type { PromptTemplate } from "../config/prompt-templates";
import { findScopedSettings, type SettingPath, Settings } from "../config/settings";
import { EditTool } from "../edit";
import type { CreateAgentSessionOptions, CreateAgentSessionResult, LoadExtensionsResult } from "../sdk";
import {
	discoverContextFiles,
	discoverPromptTemplates,
	discoverSessionExtensionPaths,
	discoverSkills,
	createAgentSession as ompCreateAgentSession,
} from "../sdk";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateHead,
	truncateTail,
} from "../session/streaming-output";
import type { Tool, ToolSession } from "../tools";
import { BashTool } from "../tools/bash";
import { GlobTool } from "../tools/glob";
import { GrepTool } from "../tools/grep";
import { ReadTool } from "../tools/read";
import { formatBytes } from "../tools/render-utils";
import { WriteTool } from "../tools/write";
import { EventBus } from "../utils/event-bus";
import { convertImageToPng } from "../utils/image-loading";
import { discoverExtensionPaths, loadExtensionFromFactory, loadExtensions } from "./extensions";
import { ExtensionRuntime } from "./extensions/loader";
import type {
	BashToolResultEvent,
	EditToolResultEvent,
	ExtensionFactory,
	GrepToolResultEvent,
	ReadToolResultEvent,
	ToolDefinition,
	ToolResultEvent,
	ToolShellEnvironmentContext,
	WriteToolResultEvent,
} from "./extensions/types";
import { Type } from "./legacy-typebox";
import { getEnabledPlugins, resolvePluginExtensionPaths, type ScopedInstalledPlugin } from "./plugins/loader";
import type { Skill } from "./skills";
import { loadSkillsFromDir } from "./skills";

const TOOL_DEFINITION_MARKER = "__isToolDefinition";
const LEGACY_BUILTIN_TOOL_MARKER = "__ompLegacyBuiltinTool";
const LEGACY_CODING_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;
const LEGACY_READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

type LegacyCodingToolName = (typeof LEGACY_CODING_TOOL_NAMES)[number];
type LegacyRegistryToolName = LegacyCodingToolName | "grep" | "glob";
type LegacyBuiltinToolDefinition = ToolDefinition & { [LEGACY_BUILTIN_TOOL_MARKER]: true };

type LegacySettingOverrides = Partial<Record<SettingPath, unknown>>;

interface LegacyThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export type BashSpawnContext = ToolShellEnvironmentContext;

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

export interface BashOperations {
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

export interface BashToolOptions {
	operations?: BashOperations;
	commandPrefix?: string;
	spawnHook?: BashSpawnHook;
}

export interface ReadToolOptions {
	/** Auto-resize large images; maps onto the `images.autoResize` setting. Default: true. */
	autoResizeImages?: boolean;
}

export interface GrepToolOptions {
	/**
	 * Unsupported. The historical grep operations seam (isDirectory/readFile for
	 * context lines) never delegated the search itself — ripgrep always ran
	 * locally — and the built-in native grep tool exposes no filesystem seam at
	 * all. Supplying operations throws at tool creation instead of silently
	 * searching the local filesystem.
	 */
	operations?: unknown;
}

export interface FindOperations {
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

export interface FindToolOptions {
	operations?: FindOperations;
}

export interface LsOperations {
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	stat: (absolutePath: string) => Promise<{ isDirectory(): boolean }> | { isDirectory(): boolean };
	readdir: (absolutePath: string) => Promise<string[]> | string[];
}

export interface LsToolOptions {
	operations?: LsOperations;
}

export interface EditOperations {
	readFile: (absolutePath: string) => Promise<Buffer>;
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	access: (absolutePath: string) => Promise<void>;
}

export interface EditToolOptions {
	operations?: EditOperations;
}

export interface WriteOperations {
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	mkdir: (dir: string) => Promise<void>;
}

export interface WriteToolOptions {
	operations?: WriteOperations;
}

const legacyBashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});

const legacyReadSchema = Type.Object({
	path: Type.String({ description: "Path to read" }),
	offset: Type.Optional(Type.Number({ description: "1-based line offset" })),
	limit: Type.Optional(Type.Number({ description: "Maximum lines to read" })),
});

const legacyGrepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search" })),
	glob: Type.Optional(Type.String({ description: "Glob filter" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string" })),
	context: Type.Optional(Type.Number({ description: "Context lines" })),
});

const legacyFindSchema = Type.Object({
	pattern: Type.String({ description: "Glob pattern to match files" }),
	path: Type.Optional(Type.String({ description: "Directory to search" })),
	limit: Type.Optional(Type.Number({ description: "Maximum results" })),
});

const legacyLsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list" })),
	limit: Type.Optional(Type.Number({ description: "Maximum entries" })),
});

function markToolDefinition<TParams extends TSchema, TDetails>(
	tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
	Object.defineProperty(tool, TOOL_DEFINITION_MARKER, {
		value: true,
		enumerable: false,
		writable: false,
		configurable: true,
	});
	return tool;
}

function legacyToolSession(cwd: string, settingOverrides?: LegacySettingOverrides): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(settingOverrides),
	};
}

function createRegistryTool(
	cwd: string,
	name: LegacyRegistryToolName,
	settingOverrides?: LegacySettingOverrides,
): Tool {
	const session = legacyToolSession(cwd, settingOverrides);
	switch (name) {
		case "bash":
			return new BashTool(session);
		case "edit":
			return new EditTool(session);
		case "glob":
			return new GlobTool(session);
		case "grep":
			return new GrepTool(session);
		case "read":
			return new ReadTool(session);
		case "write":
			return new WriteTool(session);
	}
}

async function executeBuiltinTool(
	cwd: string,
	name: LegacyCodingToolName,
	toolCallId: string,
	params: unknown,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
) {
	const tool = createRegistryTool(cwd, name);
	return tool.execute(toolCallId, params, signal, onUpdate);
}

function legacyBuiltinTool(cwd: string, name: LegacyCodingToolName): ToolDefinition {
	const tool = createRegistryTool(cwd, name);
	const definition: LegacyBuiltinToolDefinition = {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		hidden: tool.hidden,
		deferrable: tool.deferrable,
		approval: tool.approval,
		execute: (toolCallId, params, signal, onUpdate) =>
			executeBuiltinTool(cwd, name, toolCallId, params, signal, onUpdate),
		[LEGACY_BUILTIN_TOOL_MARKER]: true,
	};
	return markToolDefinition(definition);
}

function stringField(value: unknown, key: string): string | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const field = Reflect.get(value, key);
	return typeof field === "string" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const field = Reflect.get(value, key);
	return typeof field === "number" ? field : undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const field = Reflect.get(value, key);
	return typeof field === "boolean" ? field : undefined;
}

function isLegacyThemeLike(value: unknown): value is LegacyThemeLike {
	if (value === null || typeof value !== "object") return false;
	return typeof Reflect.get(value, "fg") === "function" && typeof Reflect.get(value, "bold") === "function";
}

function renderTheme(second: unknown, third: unknown): LegacyThemeLike | undefined {
	if (isLegacyThemeLike(second)) return second;
	if (isLegacyThemeLike(third)) return third;
	return undefined;
}

function themedTitle(theme: LegacyThemeLike | undefined, title: string): string {
	return theme ? theme.fg("toolTitle", theme.bold(title)) : title;
}

function themedMuted(theme: LegacyThemeLike | undefined, text: string): string {
	return theme ? theme.fg("toolOutput", text) : text;
}

function textResult(result: AgentToolResult<unknown> | undefined): string {
	return result?.content.find(block => block.type === "text")?.text ?? "";
}

function legacyRenderResult(result: AgentToolResult<unknown>, _options: unknown, themeArg: unknown): Text {
	const theme = renderTheme(themeArg, undefined);
	const output = textResult(result);
	return new Text(output ? `\n${themedMuted(theme, output)}` : "", 0, 0);
}

function lineRangePath(readPath: string, offset: number | undefined, limit: number | undefined): string {
	if (offset === undefined && limit === undefined) return readPath;
	const start = Math.max(1, Math.floor(offset ?? 1));
	if (limit === undefined) return `${readPath}:${start}`;
	const end = Math.max(start, start + Math.max(1, Math.floor(limit)) - 1);
	return `${readPath}:${start}-${end}`;
}

function normalizeLegacyLimit(limit: number | undefined, fallback: number): number {
	if (limit === undefined || !Number.isFinite(limit)) return fallback;
	return Math.max(1, Math.floor(limit));
}

function appendStatus(text: string, status: string): string {
	return text ? `${text}\n\n${status}` : status;
}

function legacyBashSnapshot(output: string): { text: string; details?: { truncation: TruncationResult } } {
	const truncation = truncateTail(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) {
		return { text: truncation.content };
	}
	const startLine = truncation.totalLines - (truncation.outputLines ?? 0) + 1;
	const note =
		truncation.truncatedBy === "lines"
			? `Showing lines ${startLine}-${truncation.totalLines} of ${truncation.totalLines}`
			: `Showing lines ${startLine}-${truncation.totalLines} of ${truncation.totalLines} (${formatBytes(DEFAULT_MAX_BYTES)} limit)`;
	return {
		text: `${truncation.content}\n\n[${note}]`,
		details: { truncation },
	};
}

async function executeLegacyBashOperations(
	operations: BashOperations,
	spawn: BashSpawnContext,
	timeout: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
): Promise<AgentToolResult> {
	let output = "";
	const onData = (data: Buffer) => {
		output += data.toString("utf8");
		if (onUpdate) {
			const snapshot = legacyBashSnapshot(output);
			onUpdate({ content: [{ type: "text", text: snapshot.text }], details: snapshot.details });
		}
	};
	try {
		const result = await operations.exec(spawn.command, spawn.cwd, {
			onData,
			signal,
			timeout,
			env: spawn.env,
		});
		const snapshot = legacyBashSnapshot(output);
		const text = snapshot.text || "(no output)";
		if (result.exitCode !== 0 && result.exitCode !== null) {
			throw new Error(appendStatus(text, `Command exited with code ${result.exitCode}`));
		}
		return { content: [{ type: "text", text }], details: snapshot.details };
	} catch (err) {
		const snapshot = legacyBashSnapshot(output);
		const text = snapshot.text;
		if (err instanceof Error && err.message === "aborted") {
			throw new Error(appendStatus(text, "Command aborted"));
		}
		if (err instanceof Error && err.message.startsWith("timeout:")) {
			throw new Error(appendStatus(text, `Command timed out after ${err.message.slice("timeout:".length)} seconds`));
		}
		throw err;
	}
}

/**
 * Convert an image attachment to PNG using the legacy package-root contract.
 *
 * Invalid or unsupported image data returns `null`, matching Pi's historical
 * helper instead of surfacing Bun's decoder error to extensions.
 */
export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	if (mimeType === "image/png") {
		return { data: base64Data, mimeType };
	}

	try {
		const converted = await convertImageToPng({ type: "image", data: base64Data, mimeType });
		return { data: converted.data, mimeType: converted.mimeType };
	} catch {
		return null;
	}
}

/** Format the active shortcut for legacy extensions that render keybinding hints. */
export function keyText(action: Keybinding): string {
	return formatKeyHints(getKeybindings().getKeys(action));
}

/** Parse frontmatter using the historical Pi package-root helper. */
export interface ParsedFrontmatter<T extends Record<string, unknown> = Record<string, unknown>> {
	frontmatter: T;
	body: string;
}

/** Parse YAML frontmatter and throw on invalid metadata. */
export function parseFrontmatter<T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> {
	const { frontmatter, body } = parseOmpFrontmatter(content, { level: "fatal" });
	return { frontmatter: frontmatter as T, body };
}

/** Return content without YAML frontmatter. */
export function stripFrontmatter(content: string): string {
	return parseFrontmatter(content).body;
}

/** Mark an extension-authored tool as a Pi-compatible tool definition. */
export function defineTool<TParams extends TSchema = TSchema, TDetails = unknown>(
	tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
	return markToolDefinition(tool);
}

/** Create the legacy read tool definition. */
export function createReadToolDefinition(cwd: string, options?: ReadToolOptions): ToolDefinition {
	const tool = createRegistryTool(
		cwd,
		"read",
		options?.autoResizeImages === undefined ? undefined : { "images.autoResize": options.autoResizeImages },
	);
	return markToolDefinition({
		name: "read",
		label: "Read",
		description: tool.description,
		parameters: legacyReadSchema,
		approval: "read",
		renderCall: (params, options, themeArg) => {
			const theme = renderTheme(options, themeArg);
			const readPath = stringField(params, "path") ?? "";
			return new Text(`${themedTitle(theme, "read")} ${themedMuted(theme, readPath)}`, 0, 0);
		},
		renderResult: legacyRenderResult,
		execute: (toolCallId, params, signal, onUpdate) => {
			const readPath = stringField(params, "path") ?? "";
			const pathWithRange = lineRangePath(readPath, numberField(params, "offset"), numberField(params, "limit"));
			return tool.execute(toolCallId, { path: pathWithRange }, signal, onUpdate);
		},
	});
}

/** Create the legacy read tool. */
export function createReadTool(cwd: string, options?: ReadToolOptions): ToolDefinition {
	return createReadToolDefinition(cwd, options);
}

/** Create the legacy bash tool definition. */
export function createBashToolDefinition(cwd: string, options?: BashToolOptions): ToolDefinition {
	const tool = createRegistryTool(cwd, "bash");
	const spawnHook = options?.spawnHook;
	const shellEnv = spawnHook
		? (spawn: ToolShellEnvironmentContext): Record<string, string> => {
				const baseline = { ...spawn.env };
				const result = spawnHook(spawn);
				// Legacy hooks conventionally return `{ ...context.env, EXTRA }`.
				// The consumer applies this as per-command overrides on an already
				// filtered base env, so forwarding the whole object would reintroduce
				// everything filterChildShellEnv removed. Forward only entries the
				// hook added or changed relative to the env it was handed.
				return Object.fromEntries(
					Object.entries(result.env).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string" && baseline[entry[0]] !== entry[1],
					),
				);
			}
		: undefined;
	return markToolDefinition({
		name: "bash",
		label: "Bash",
		description: tool.description,
		parameters: legacyBashSchema,
		approval: "exec",
		...(shellEnv ? { shellEnv } : {}),
		renderCall: (params, optionsArg, themeArg) => {
			const theme = renderTheme(optionsArg, themeArg);
			const command = stringField(params, "command") ?? "";
			return new Text(`${themedTitle(theme, "bash")} ${themedMuted(theme, command)}`, 0, 0);
		},
		renderResult: legacyRenderResult,
		execute: (toolCallId, params, signal, onUpdate) => {
			const rawCommand = stringField(params, "command") ?? "";
			const command = options?.commandPrefix ? `${options.commandPrefix}\n${rawCommand}` : rawCommand;
			const timeout = numberField(params, "timeout");
			const spawn = options?.spawnHook?.({ command, cwd, env: process.env });
			if (options?.operations) {
				return executeLegacyBashOperations(
					options.operations,
					{ command: spawn?.command ?? command, cwd: spawn?.cwd ?? cwd, env: spawn?.env ?? process.env },
					timeout,
					signal,
					onUpdate,
				);
			}
			return tool.execute(
				toolCallId,
				{
					command: spawn?.command ?? command,
					cwd: spawn?.cwd ?? cwd,
					env: spawn?.env,
					timeout,
				},
				signal,
				onUpdate,
			);
		},
	});
}

/** Create the legacy bash tool. */
export function createBashTool(cwd: string, options?: BashToolOptions): ToolDefinition {
	return createBashToolDefinition(cwd, options);
}

/** Create the legacy grep tool definition. */
export function createGrepToolDefinition(cwd: string, options?: GrepToolOptions): ToolDefinition {
	if (options?.operations) {
		throw new Error(
			"Legacy GrepToolOptions.operations is not supported: the built-in grep tool searches the local " +
				"filesystem natively and exposes no pluggable filesystem seam (the historical seam only customized " +
				"context-line reads; the search itself always ran locally). Register a custom grep tool via " +
				"defineTool() instead of passing operations to createGrepTool()/createGrepToolDefinition().",
		);
	}
	const tool = createRegistryTool(cwd, "grep");
	return markToolDefinition({
		name: "grep",
		label: "grep",
		description: "Search file contents for a pattern.",
		parameters: legacyGrepSchema,
		approval: "read",
		renderCall: (params, optionsArg, themeArg) => {
			const theme = renderTheme(optionsArg, themeArg);
			const pattern = stringField(params, "pattern") ?? "";
			const searchPath = stringField(params, "path") ?? ".";
			return new Text(`${themedTitle(theme, "grep")} ${themedMuted(theme, `/${pattern}/ in ${searchPath}`)}`, 0, 0);
		},
		renderResult: legacyRenderResult,
		execute: (toolCallId, params, signal, onUpdate) => {
			const rawPattern = stringField(params, "pattern") ?? "";
			const pattern = booleanField(params, "literal") ? piEscapeRegexLiteral(rawPattern) : rawPattern;
			const searchPath = stringField(params, "path") ?? ".";
			const glob = stringField(params, "glob");
			const context = numberField(params, "context");
			// The new grep reads context from settings fixed at construction; build a
			// per-call tool when the model passes an explicit legacy `context`.
			const grepTool =
				context === undefined
					? tool
					: createRegistryTool(cwd, "grep", {
							"grep.contextBefore": Math.max(0, Math.floor(context)),
							"grep.contextAfter": Math.max(0, Math.floor(context)),
						});
			return grepTool.execute(
				toolCallId,
				{
					pattern,
					path: glob ? piJoinPath(searchPath, glob) : searchPath,
					case: booleanField(params, "ignoreCase") ? false : undefined,
				},
				signal,
				onUpdate,
			);
		},
	});
}

/** Create the legacy grep tool. */
export function createGrepTool(cwd: string, options?: GrepToolOptions): ToolDefinition {
	return createGrepToolDefinition(cwd, options);
}

/** Create the legacy find tool definition. */
export function createFindToolDefinition(cwd: string, options?: FindToolOptions): ToolDefinition {
	const tool = createRegistryTool(cwd, "glob");
	return markToolDefinition({
		name: "find",
		label: "find",
		description: "Find files by glob pattern.",
		parameters: legacyFindSchema,
		approval: "read",
		renderCall: (params, optionsArg, themeArg) => {
			const theme = renderTheme(optionsArg, themeArg);
			const pattern = stringField(params, "pattern") ?? "";
			const searchPath = stringField(params, "path") ?? ".";
			return new Text(`${themedTitle(theme, "find")} ${themedMuted(theme, `${pattern} in ${searchPath}`)}`, 0, 0);
		},
		renderResult: legacyRenderResult,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const pattern = stringField(params, "pattern") ?? "*";
			const searchPath = stringField(params, "path") ?? ".";
			const limit = normalizeLegacyLimit(numberField(params, "limit"), 1000);
			const absolutePath = path.resolve(cwd, searchPath);
			if (options?.operations) {
				if (!(await options.operations.exists(absolutePath))) {
					throw new Error(`Path not found: ${absolutePath}`);
				}
				const matches = await options.operations.glob(pattern, absolutePath, {
					ignore: ["**/node_modules/**", "**/.git/**"],
					limit,
				});
				const output = matches
					.map(match => {
						const rel = path.isAbsolute(match) ? path.relative(absolutePath, match) : match;
						return rel.split(path.sep).join("/");
					})
					.join("\n");
				const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
				return {
					content: [{ type: "text", text: truncation.content || "No files found matching pattern" }],
					details: truncation.truncated ? { truncation } : undefined,
				};
			}
			return tool.execute(
				toolCallId,
				{ path: piJoinPath(searchPath, pattern), hidden: true, gitignore: true, limit },
				signal,
				onUpdate,
			);
		},
	});
}

/** Create the legacy find tool. */
export function createFindTool(cwd: string, options?: FindToolOptions): ToolDefinition {
	return createFindToolDefinition(cwd, options);
}

/** Create the legacy ls tool definition. */
export function createLsToolDefinition(cwd: string, options?: LsToolOptions): ToolDefinition {
	return markToolDefinition({
		name: "ls",
		label: "ls",
		description: "List directory entries.",
		parameters: legacyLsSchema,
		approval: "read",
		renderCall: (params, optionsArg, themeArg) => {
			const theme = renderTheme(optionsArg, themeArg);
			return new Text(`${themedTitle(theme, "ls")} ${themedMuted(theme, stringField(params, "path") ?? ".")}`, 0, 0);
		},
		renderResult: legacyRenderResult,
		execute: async (_toolCallId, params, _signal, _onUpdate) => {
			const rawPath = stringField(params, "path") ?? ".";
			const limit = normalizeLegacyLimit(numberField(params, "limit"), 500);
			const absolutePath = path.resolve(cwd, rawPath);
			const ops = options?.operations;
			const exists = ops
				? await ops.exists(absolutePath)
				: await fs.promises.stat(absolutePath).then(
						() => true,
						() => false,
					);
			if (!exists) throw new Error(`Path not found: ${absolutePath}`);
			const stat = ops ? await ops.stat(absolutePath) : await fs.promises.stat(absolutePath);
			if (!stat.isDirectory()) {
				return { content: [{ type: "text", text: rawPath }] };
			}
			const entries = ops ? await ops.readdir(absolutePath) : await fs.promises.readdir(absolutePath);
			const sorted = [...entries].sort((a, b) => a.localeCompare(b));
			const limited = sorted.slice(0, limit);
			const output = limited.join("\n");
			const details = sorted.length > limited.length ? { entryLimitReached: limit } : undefined;
			const suffix = details ? `\n\n[${limit} entries limit reached]` : "";
			return { content: [{ type: "text", text: `${output}${suffix}` }], details };
		},
	});
}

/** Create the legacy ls tool. */
export function createLsTool(cwd: string, options?: LsToolOptions): ToolDefinition {
	return createLsToolDefinition(cwd, options);
}

/** Create the legacy edit tool definition. */
export function createEditToolDefinition(cwd: string, options?: EditToolOptions): ToolDefinition {
	if (options?.operations) {
		throw new Error(
			"Legacy EditToolOptions.operations is not supported: OMP's built-in edit tool writes the local " +
				"filesystem natively and exposes no pluggable operations seam. Register a custom edit tool via " +
				"defineTool() instead of passing operations to createEditTool()/createEditToolDefinition().",
		);
	}
	return legacyBuiltinTool(cwd, "edit");
}

/** Create the legacy edit tool. */
export function createEditTool(cwd: string, options?: EditToolOptions): ToolDefinition {
	return createEditToolDefinition(cwd, options);
}

/** Create the legacy write tool definition. */
export function createWriteToolDefinition(cwd: string, options?: WriteToolOptions): ToolDefinition {
	if (options?.operations) {
		throw new Error(
			"Legacy WriteToolOptions.operations is not supported: OMP's built-in write tool writes the local " +
				"filesystem natively and exposes no pluggable operations seam. Register a custom write tool via " +
				"defineTool() instead of passing operations to createWriteTool()/createWriteToolDefinition().",
		);
	}
	return legacyBuiltinTool(cwd, "write");
}

/** Create the legacy write tool. */
export function createWriteTool(cwd: string, options?: WriteToolOptions): ToolDefinition {
	return createWriteToolDefinition(cwd, options);
}

/** Create legacy read, bash, edit, and write tools. */
export function createCodingTools(cwd: string): ToolDefinition[] {
	return LEGACY_CODING_TOOL_NAMES.map(name => legacyBuiltinTool(cwd, name));
}

/** Create legacy read, grep, find, and ls tools. */
export function createReadOnlyTools(cwd: string): ToolDefinition[] {
	return LEGACY_READ_ONLY_TOOL_NAMES.map(name => {
		if (name === "read") return createReadTool(cwd);
		if (name === "grep") return createGrepTool(cwd);
		if (name === "find") return createFindTool(cwd);
		return createLsTool(cwd);
	});
}

/**
 * Legacy pi `SettingsManager` shim.
 *
 * Upstream Pi's `SettingsManager.create(cwd)` is **synchronous** and returns a
 * manager exposing `getGlobalSettings()`/`getProjectSettings()` (plus the typed
 * `get(path)`). OMP's `Settings` is that manager, so the shim resolves the
 * active extension session's instance first, then falls back to a live instance
 * matching the requested `cwd`/`agentDir`, or an isolated instance when nothing
 * matches. Returning the promise from `Settings.init()` here broke every pi
 * extension that read settings synchronously — e.g. pi-vim's `session_start`
 * handler (#10397); selecting a process-global instance would leak one session's
 * settings into another.
 */
export const SettingsManager = {
	create(cwd?: string, agentDir?: string): Settings {
		return findScopedSettings(cwd, agentDir) ?? Settings.isolated();
	},

	inMemory(): Settings {
		return Settings.isolated();
	},
} as const;

/** Scope used by the legacy package manager for discovered resources. */
export type SourceScope = "user" | "project" | "temporary";

/** Discovery metadata exposed alongside a legacy package resource path. */
export interface PathMetadata {
	source: string;
	scope: SourceScope;
	origin: "package" | "top-level";
	baseDir?: string;
}

/** One extension, skill, prompt, or theme resolved by the legacy package manager. */
export interface ResolvedResource {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
}

/** Resource groups returned by {@link DefaultPackageManager.resolve}. */
export interface ResolvedPaths {
	extensions: ResolvedResource[];
	skills: ResolvedResource[];
	prompts: ResolvedResource[];
	themes: ResolvedResource[];
}

/** Action a legacy caller requests when a configured package is unavailable. */
export type MissingSourceAction = "install" | "skip" | "error";

/** Construction inputs accepted by the legacy package manager. */
export interface DefaultPackageManagerOptions {
	cwd: string;
	agentDir: string;
	settingsManager: Settings | Promise<Settings>;
}

/**
 * Enumerates the extensions OMP would load through the historical package
 * manager surface used by legacy extensions.
 */
export class DefaultPackageManager {
	#cwd: string;
	#agentDir: string;
	#settingsManager: Settings | Promise<Settings>;

	constructor(options: DefaultPackageManagerOptions) {
		this.#cwd = options.cwd;
		this.#agentDir = options.agentDir;
		this.#settingsManager = options.settingsManager;
	}

	/** Resolve enabled extension paths with their OMP plugin provenance. */
	async resolve(_onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths> {
		const settings = await this.#settingsManager;
		const configuredPaths = settings.get("extensions") ?? [];
		const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
		const [extensionPaths, plugins] = await Promise.all([
			discoverExtensionPaths(configuredPaths, this.#cwd, disabledExtensionIds),
			getEnabledPlugins(this.#cwd),
		]);
		const pluginByExtensionPath = new Map<string, ScopedInstalledPlugin>();
		for (const plugin of plugins) {
			for (const extensionPath of resolvePluginExtensionPaths(plugin)) {
				pluginByExtensionPath.set(path.resolve(extensionPath), plugin);
			}
		}

		const extensions = extensionPaths.map(extensionPath => {
			const resolvedPath = path.resolve(extensionPath);
			const plugin = pluginByExtensionPath.get(resolvedPath);
			const agentDirRelative = path.relative(path.resolve(this.#agentDir), resolvedPath);
			const metadata: PathMetadata = plugin
				? {
						source: `npm:${plugin.name}`,
						scope: plugin.scope,
						origin: "package",
						baseDir: plugin.path,
					}
				: {
						source: "auto",
						scope:
							agentDirRelative === "" ||
							(!agentDirRelative.startsWith("..") && !path.isAbsolute(agentDirRelative))
								? "user"
								: "project",
						origin: "top-level",
					};
			return { path: resolvedPath, enabled: true, metadata };
		});

		return { extensions, skills: [], prompts: [], themes: [] };
	}
}

/**
 * Resource-loader compatibility layer for legacy pi extensions.
 *
 * Upstream `@earendil-works/pi-coding-agent` centralizes extension / skill /
 * prompt / theme / AGENTS.md discovery inside a `DefaultResourceLoader`
 * instance that the caller constructs, `reload()`s, and hands to
 * `createAgentSession({ resourceLoader })`. Every published version of
 * pi-schedule-prompt (≥0.2.0) and other pi extensions that spawn subagents
 * import the class at module scope; a missing export takes the whole
 * extension down at parse time (issue #4567).
 *
 * OMP does the same discovery inline inside `createAgentSession()`, so this
 * shim intentionally does NOT re-implement pi's ResourceLoader plumbing.
 * Instead the loader captures the caller's intent (`no*` flags, `*Override`
 * callbacks, `additional*Paths`, `extensionFactories`, `settingsManager`,
 * `eventBus`) plus the discovery results, and the sibling `createAgentSession`
 * override below translates them into OMP's native session options
 * (`disableExtensionDiscovery`, prepared/path extension preloads, `extensions`,
 * `skills`, `promptTemplates`, `contextFiles`, `settings`, `eventBus`,
 * `systemPrompt`) before delegating to `../sdk`.
 *
 * The pi surface it emulates is the intersection actually used by real
 * extensions in the wild — themes are silently dropped (OMP has no
 * session-level themes surface); `extendResources`, `loadProjectTrustExtensions`,
 * and provider-trust hooks are omitted.
 */

export type ResourceDiagnostic = {
	type: "error" | "warning" | "info";
	message: string;
	path?: string;
};

export interface AgentsFile {
	path: string;
	content: string;
}

/** Marker interface preserved for pi extensions that type against upstream. */
export interface Theme {
	name: string;
}

export interface DefaultResourceLoaderOptions {
	cwd?: string;
	agentDir?: string;
	settingsManager?: Settings | Promise<Settings>;
	eventBus?: EventBus;
	additionalExtensionPaths?: string[];
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	additionalThemePaths?: string[];
	extensionFactories?: ExtensionFactory[];
	noExtensions?: boolean;
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string | string[];
	extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	agentsFilesOverride?: (base: { agentsFiles: AgentsFile[] }) => { agentsFiles: AgentsFile[] };
	systemPromptOverride?: (base: string | undefined) => string | undefined;
	appendSystemPromptOverride?: (base: string[]) => string[];
}

/**
 * The subset of {@link DefaultResourceLoader} state consumed by the
 * {@link createAgentSession} adapter. Kept as an explicit interface so tests
 * (and any future third-party ResourceLoader passed to `createAgentSession`)
 * only need to satisfy the read surface — not the reload lifecycle.
 */
export interface ResourceLoader {
	getExtensions(): LoadExtensionsResult;
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
	getAgentsFiles(): { agentsFiles: AgentsFile[] };
	getSystemPrompt(): string | undefined;
	getAppendSystemPrompt(): string[];
	reload(): Promise<void>;
	/** @internal — used by the shim's createAgentSession to detect its own loaders. */
	readonly __ompLegacyPiLoader?: true;
}

/** Create a pre-initialization runtime for legacy extension resource loaders. */
export function createExtensionRuntime(): ExtensionRuntime {
	return new ExtensionRuntime();
}

/**
 * Loader-owned inputs that {@link createAgentSession} needs regardless of
 * whether the caller provided extra options. `cwd`/`agentDir` fall back to
 * `getProjectDir()`/`getAgentDir()` at construction time so subsequent
 * `reload()` and `createAgentSession()` calls read the same directories the
 * caller thought they were configuring.
 */
interface ResolvedLoaderState {
	cwd: string;
	agentDir: string;
	settingsPromise?: Promise<Settings>;
	eventBus: EventBus;
	extensionFactories: ExtensionFactory[];
	noExtensions: boolean;
	additionalExtensionPaths: string[];
	additionalSkillPaths: string[];
	additionalPromptTemplatePaths: string[];
}

interface AdditionalSkillLoadResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

interface AdditionalPromptLoadResult {
	prompts: PromptTemplate[];
	diagnostics: ResourceDiagnostic[];
}

export class DefaultResourceLoader implements ResourceLoader {
	readonly __ompLegacyPiLoader = true as const;
	#state: ResolvedLoaderState;
	#options: DefaultResourceLoaderOptions;
	#extensionsResult: LoadExtensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	#skills: Skill[] = [];
	#skillDiagnostics: ResourceDiagnostic[] = [];
	#prompts: PromptTemplate[] = [];
	#promptDiagnostics: ResourceDiagnostic[] = [];
	#themes: Theme[] = [];
	#themeDiagnostics: ResourceDiagnostic[] = [];
	#agentsFiles: AgentsFile[] = [];
	#systemPrompt: string | undefined;
	#appendSystemPrompt: string[] = [];
	#loaded = false;

	constructor(options: DefaultResourceLoaderOptions = {}) {
		this.#options = options;
		const cwd = options.cwd ?? getProjectDir();
		const agentDir = options.agentDir ?? getAgentDir();
		this.#state = {
			cwd,
			agentDir,
			settingsPromise: options.settingsManager ? Promise.resolve(options.settingsManager) : undefined,
			eventBus: options.eventBus ?? new EventBus(),
			extensionFactories: options.extensionFactories ?? [],
			noExtensions: options.noExtensions ?? false,
			additionalExtensionPaths: options.additionalExtensionPaths ?? [],
			additionalSkillPaths: options.additionalSkillPaths ?? [],
			additionalPromptTemplatePaths: options.additionalPromptTemplatePaths ?? [],
		};
	}

	getExtensions(): LoadExtensionsResult {
		return this.#extensionsResult;
	}

	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		return { skills: this.#skills, diagnostics: this.#skillDiagnostics };
	}

	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		return { prompts: this.#prompts, diagnostics: this.#promptDiagnostics };
	}

	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		return { themes: this.#themes, diagnostics: this.#themeDiagnostics };
	}

	getAgentsFiles(): { agentsFiles: AgentsFile[] } {
		return { agentsFiles: this.#agentsFiles };
	}

	getSystemPrompt(): string | undefined {
		return this.#systemPrompt;
	}

	getAppendSystemPrompt(): string[] {
		return this.#appendSystemPrompt;
	}

	/**
	 * Discovery snapshot used to seed the session. Emulates upstream pi's
	 * `reload()` lifecycle: run every enabled discovery arm against the
	 * resolved cwd/agentDir, then thread each result through the caller's
	 * `*Override` callback. Discovery arms guarded by an `no*` flag start from
	 * an empty base — callers that flipped the flag off still get the override
	 * hook, so overrides can inject synthetic entries without triggering a
	 * filesystem scan they explicitly opted out of.
	 */
	async reload(): Promise<void> {
		const { cwd, agentDir } = this.#state;
		const options = this.#options;

		let settingsPromise = this.#state.settingsPromise;
		if (!settingsPromise) {
			settingsPromise = Settings.init({ cwd, agentDir });
			this.#state.settingsPromise = settingsPromise;
		}
		const settings = await settingsPromise;

		const [extensionsResult, skillsBase, additionalSkills, prompts, additionalPrompts, agentsFiles] =
			await Promise.all([
				this.#loadExtensions(settings),
				options.noSkills
					? Promise.resolve({ skills: [], warnings: [] })
					: discoverSkills(cwd, agentDir, {
							...settings.getGroup("skills"),
							disabledExtensions: settings.get("disabledExtensions") ?? [],
						}),
				this.#loadAdditionalSkills(),
				options.noPromptTemplates ? Promise.resolve([]) : discoverPromptTemplates(cwd, agentDir),
				this.#loadAdditionalPromptTemplates(),
				options.noContextFiles ? Promise.resolve([]) : discoverContextFiles(cwd, agentDir),
			]);

		this.#extensionsResult = options.extensionsOverride
			? options.extensionsOverride(extensionsResult)
			: extensionsResult;

		const skillsBaseResult = {
			skills: [...skillsBase.skills, ...additionalSkills.skills],
			diagnostics: [
				...skillsBase.warnings.map(w => ({
					type: "warning" as const,
					message: w.message,
					path: w.skillPath,
				})),
				...additionalSkills.diagnostics,
			],
		};
		const skillsFinal = options.skillsOverride ? options.skillsOverride(skillsBaseResult) : skillsBaseResult;
		this.#skills = skillsFinal.skills;
		this.#skillDiagnostics = skillsFinal.diagnostics;

		const promptsBase = {
			prompts: [...prompts, ...additionalPrompts.prompts],
			diagnostics: additionalPrompts.diagnostics,
		};
		const promptsFinal = options.promptsOverride ? options.promptsOverride(promptsBase) : promptsBase;
		this.#prompts = promptsFinal.prompts;
		this.#promptDiagnostics = promptsFinal.diagnostics;

		const themesBase = { themes: [] as Theme[], diagnostics: [] as ResourceDiagnostic[] };
		const themesFinal = options.themesOverride ? options.themesOverride(themesBase) : themesBase;
		this.#themes = themesFinal.themes;
		this.#themeDiagnostics = themesFinal.diagnostics;

		const agentsFilesBase = { agentsFiles };
		const agentsFilesFinal = options.agentsFilesOverride
			? options.agentsFilesOverride(agentsFilesBase)
			: agentsFilesBase;
		this.#agentsFiles = agentsFilesFinal.agentsFiles;

		const baseSystemPrompt = options.systemPrompt;
		this.#systemPrompt = options.systemPromptOverride
			? options.systemPromptOverride(baseSystemPrompt)
			: baseSystemPrompt;

		const appendSource = options.appendSystemPrompt;
		const baseAppend =
			typeof appendSource === "string" ? [appendSource] : Array.isArray(appendSource) ? appendSource : [];
		this.#appendSystemPrompt = options.appendSystemPromptOverride
			? options.appendSystemPromptOverride(baseAppend)
			: baseAppend;

		this.#loaded = true;
	}

	async #loadExtensions(settings: Settings): Promise<LoadExtensionsResult> {
		const { cwd, noExtensions, additionalExtensionPaths, extensionFactories, eventBus } = this.#state;

		if (noExtensions && additionalExtensionPaths.length === 0 && extensionFactories.length === 0) {
			return { extensions: [], errors: [], runtime: createExtensionRuntime() };
		}

		const paths = await discoverSessionExtensionPaths(
			{
				disableExtensionDiscovery: noExtensions,
				additionalExtensionPaths,
			},
			cwd,
			settings,
		);

		const result = await loadExtensions(paths, cwd, eventBus);
		for (let i = 0; i < extensionFactories.length; i++) {
			const loaded = await loadExtensionFromFactory(
				extensionFactories[i],
				cwd,
				eventBus,
				result.runtime,
				`<inline-loader-${i}>`,
			);
			result.extensions.push(loaded);
		}
		return result;
	}

	async #loadAdditionalSkills(): Promise<AdditionalSkillLoadResult> {
		const skills: Skill[] = [];
		const diagnostics: ResourceDiagnostic[] = [];

		for (const resourcePath of this.#state.additionalSkillPaths) {
			const resolvedPath = path.isAbsolute(resourcePath)
				? resourcePath
				: path.resolve(this.#state.cwd, resourcePath);
			const skillDir =
				path.basename(resolvedPath).toLowerCase() === "skill.md" ? path.dirname(resolvedPath) : resolvedPath;
			try {
				const result = await loadSkillsFromDir({
					dir: skillDir,
					source: "legacy-resource-loader",
				});
				skills.push(...result.skills);
				diagnostics.push(
					...result.warnings.map(w => ({
						type: "warning" as const,
						message: w.message,
						path: w.skillPath,
					})),
				);
			} catch (err) {
				diagnostics.push({
					type: "warning",
					message: `Failed to load additional skill path: ${err instanceof Error ? err.message : String(err)}`,
					path: resolvedPath,
				});
			}
		}

		return { skills, diagnostics };
	}

	async #loadAdditionalPromptTemplates(): Promise<AdditionalPromptLoadResult> {
		const prompts: PromptTemplate[] = [];
		const diagnostics: ResourceDiagnostic[] = [];

		for (const resourcePath of this.#state.additionalPromptTemplatePaths) {
			const resolvedPath = path.isAbsolute(resourcePath)
				? resourcePath
				: path.resolve(this.#state.cwd, resourcePath);
			const files: string[] = [];
			try {
				const stat = await fs.promises.stat(resolvedPath);
				if (stat.isDirectory()) {
					const glob = new Bun.Glob("**/*.md");
					for await (const entry of glob.scan({ cwd: resolvedPath, absolute: false, onlyFiles: true })) {
						files.push(path.join(resolvedPath, entry));
					}
					files.sort();
				} else if (resolvedPath.toLowerCase().endsWith(".md")) {
					files.push(resolvedPath);
				} else {
					diagnostics.push({
						type: "warning",
						message: "Additional prompt template path is neither a directory nor a Markdown file",
						path: resolvedPath,
					});
				}
			} catch (err) {
				diagnostics.push({
					type: "warning",
					message: `Failed to inspect additional prompt template path: ${err instanceof Error ? err.message : String(err)}`,
					path: resolvedPath,
				});
				continue;
			}

			for (const filePath of files) {
				try {
					const raw = await Bun.file(filePath).text();
					const { frontmatter, body } = parseFrontmatter(raw);
					const rawDescription = frontmatter.description;
					let description = typeof rawDescription === "string" ? rawDescription : "";
					if (!description) {
						const firstLine = body.split("\n").find(line => line.trim());
						if (firstLine) {
							description = firstLine.slice(0, 60);
							if (firstLine.length > 60) {
								description += "...";
							}
						}
					}

					const source = "(legacy-resource-loader)";
					prompts.push({
						name: path.basename(filePath, path.extname(filePath)),
						description: description ? `${description} ${source}` : source,
						content: body,
						source,
					});
				} catch (err) {
					diagnostics.push({
						type: "warning",
						message: `Failed to load additional prompt template: ${err instanceof Error ? err.message : String(err)}`,
						path: filePath,
					});
				}
			}
		}

		return { prompts, diagnostics };
	}

	/** Test seam: whether `reload()` has completed at least once. */
	get loaded(): boolean {
		return this.#loaded;
	}

	/** @internal — used by the shim's createAgentSession to translate options. */
	__getResolverState(): {
		cwd: string;
		agentDir: string;
		settingsPromise?: Promise<Settings>;
		eventBus: EventBus;
		extensionsResult: LoadExtensionsResult;
		skills: Skill[];
		prompts: PromptTemplate[];
		agentsFiles: AgentsFile[];
		systemPrompt: string | undefined;
		appendSystemPrompt: string[];
		extensionFactories: ExtensionFactory[];
	} {
		return {
			cwd: this.#state.cwd,
			agentDir: this.#state.agentDir,
			settingsPromise: this.#state.settingsPromise,
			eventBus: this.#state.eventBus,
			extensionsResult: this.#extensionsResult,
			skills: this.#skills,
			prompts: this.#prompts,
			agentsFiles: this.#agentsFiles,
			systemPrompt: this.#systemPrompt,
			appendSystemPrompt: this.#appendSystemPrompt,
			extensionFactories: this.#state.extensionFactories,
		};
	}
}

/**
 * Legacy pi extensions call `createAgentSession({ resourceLoader })`. OMP's
 * native option surface has no such field — extension / skill / prompt /
 * context-file discovery are configured directly on the session options — so
 * an untranslated call would silently ignore the loader (including its
 * `noExtensions`/`noSkills` opt-outs), re-run OMP's own discovery, and
 * happily re-load the calling extension into the subagent. That's exactly
 * the recursion the caller passed the loader to prevent.
 *
 * Translate the loader's captured state into OMP's option fields, then
 * delegate to the underlying SDK. Explicit fields on `options` override the
 * loader (matches upstream pi semantics — a caller can partially override a
 * shared loader).
 *
 * `resourceLoader` is not part of {@link CreateAgentSessionOptions}, so it's
 * accepted through a widened alias and stripped before the underlying call.
 */
export type LegacyPiCreateAgentSessionOptions = CreateAgentSessionOptions & {
	resourceLoader?: ResourceLoader;
};

export async function createAgentSession(
	options: LegacyPiCreateAgentSessionOptions = {},
): Promise<CreateAgentSessionResult> {
	const loader = options.resourceLoader;
	if (!loader) {
		return ompCreateAgentSession(options);
	}

	if (loader instanceof DefaultResourceLoader && !loader.loaded) {
		await loader.reload();
	}

	const state =
		loader instanceof DefaultResourceLoader
			? loader.__getResolverState()
			: {
					cwd: options.cwd ?? getProjectDir(),
					agentDir: options.agentDir ?? getAgentDir(),
					settingsPromise: undefined,
					eventBus: undefined,
					extensionsResult: loader.getExtensions(),
					skills: loader.getSkills().skills,
					prompts: loader.getPrompts().prompts,
					agentsFiles: loader.getAgentsFiles().agentsFiles,
					systemPrompt: loader.getSystemPrompt(),
					appendSystemPrompt: loader.getAppendSystemPrompt(),
					extensionFactories: [] as ExtensionFactory[],
				};

	const { resourceLoader: _, ...rest } = options;
	const forwarded: CreateAgentSessionOptions = {
		...rest,
		cwd: rest.cwd ?? state.cwd,
		agentDir: rest.agentDir ?? state.agentDir,
	};

	if (rest.eventBus === undefined && state.eventBus !== undefined) {
		forwarded.eventBus = state.eventBus;
	}
	if (rest.settings === undefined && rest.settingsManager === undefined && state.settingsPromise !== undefined) {
		forwarded.settingsManager = state.settingsPromise;
	}

	// Route the loader's already-loaded extension result through the SDK's
	// `preloadedExtensions` seam. Skipping this branch would let
	// `createAgentSession` re-run its own discovery and undo the caller's
	// `noExtensions: true`.
	if (
		rest.preloadedExtensions === undefined &&
		rest.preloadedPreparedExtensions === undefined &&
		rest.preloadedExtensionPaths === undefined
	) {
		forwarded.preloadedExtensions = state.extensionsResult;
	}

	if (rest.skills === undefined) {
		forwarded.skills = state.skills;
	}
	if (rest.promptTemplates === undefined) {
		forwarded.promptTemplates = state.prompts;
	}
	if (rest.contextFiles === undefined) {
		forwarded.contextFiles = state.agentsFiles;
	}

	if (rest.systemPrompt === undefined && state.systemPrompt !== undefined) {
		forwarded.systemPrompt = state.systemPrompt;
	}
	if (rest.appendSystemPrompt === undefined && state.appendSystemPrompt.length > 0) {
		forwarded.appendSystemPrompt = state.appendSystemPrompt.join("\n\n");
	}

	return ompCreateAgentSession(forwarded);
}

/**
 * Synchronous auth storage surface retained for legacy extensions.
 *
 * Modern OMP auth storage is asynchronous, while older provider extensions
 * call `AuthStorage.create().get()` during module initialization.
 */
export class AuthStorage {
	constructor() {
		fs.mkdirSync(path.dirname(getAgentDbPath()), { recursive: true, mode: 0o700 });
	}

	static create(): AuthStorage {
		return new AuthStorage();
	}

	get(provider: string): AuthCredential | undefined {
		const store = new SqliteAuthCredentialStore(new Database(getAgentDbPath()));
		try {
			return store.listAuthCredentials(provider)[0]?.credential;
		} finally {
			store.close();
		}
	}

	set(provider: string, credential: AuthCredential): void {
		const store = new SqliteAuthCredentialStore(new Database(getAgentDbPath()));
		try {
			store.upsertAuthCredentialForProvider(provider, credential);
		} finally {
			store.close();
		}
	}
}

/** Read the first active credential for a legacy extension provider. */
export function readStoredCredential(provider: string): AuthCredential | undefined {
	const storage = AuthStorage.create();
	return storage.get(provider);
}

// Pi SDK path helpers. `export * from "../index"` above only forwards
// `getAgentDir`; `getProjectDir` (a `@oh-my-pi/pi-utils` helper) and
// `getPackageDir` are absent from that barrel, so legacy extensions importing
// either fail Bun's static export check during validation (issue #5968).
export { getProjectDir } from "@oh-my-pi/pi-utils";

/**
 * Coding-agent package install directory, matching pi's string-valued
 * `getPackageDir()` contract (extensions do `path.join(getPackageDir(), ...)`
 * to auto-allow bundled docs/resources).
 *
 * omp's canonical `getPackageDir()` (`../config`) returns `undefined` inside a
 * `bun --compile` binary — `import.meta.dir` is `/$bunfs/root` and no owning
 * `package.json` exists (issue #1423). Returning `undefined` there would crash
 * every legacy `path.join(getPackageDir(), ...)` at runtime in the shipped
 * binary, the primary distribution. So fall back to the executable's own
 * directory in compiled mode, where the binary *is* the install root. The
 * `PI_PACKAGE_DIR` override and dev/source/npm-dist walk-up still win via the
 * canonical helper.
 */
export function getPackageDir(): string {
	return getOmpPackageDir() ?? (isCompiledBinary() ? path.dirname(process.execPath) : process.cwd());
}

// Legacy pi's `@earendil-works/pi-coding-agent` re-exported `estimateTokens`,
// `compact`, `serializeConversation`, and `calculateContextTokens` from its
// package root (via `./core/compaction/index.ts`). In omp these live in
// `@oh-my-pi/pi-agent-core/compaction`, and the coding-agent barrel below does
// not forward them, so legacy extensions importing them fail Bun's static
// export check during validation (issues #6583, #7174, #7403, #10278).
export { calculateContextTokens, compact, serializeConversation } from "@oh-my-pi/pi-agent-core/compaction";

const legacyTokenizer = new Tokenizer();

/**
 * Legacy `estimateTokens(message, tokenizer?, options?)` export. The core API
 * became `Tokenizer.countMessage`, but legacy pi extensions still import this
 * free function by name (issues #6583, #7174, #7403), so the export surface
 * must survive; a shared model-agnostic Tokenizer backs the tokenizer-less
 * legacy call shape.
 */
export function estimateTokens(message: AgentMessage, tokenizer?: Tokenizer, options?: MessageCountOptions): number {
	return (tokenizer ?? legacyTokenizer).countMessage(message, options);
}

// Same barrel gap for two more legacy package-root exports: pi re-exported the
// `CONFIG_DIR_NAME` constant and the CLI parser `parseArgs`. In omp
// `CONFIG_DIR_NAME` lives in `@oh-my-pi/pi-utils` and `parseArgs` in
// `../cli/args`, neither of which the barrel below forwards, so legacy
// extensions importing either fail Bun's static export check during validation.
export { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils";
export { parseArgs } from "../cli/args";

export * from "../index";
export { formatBytes as formatSize } from "../tools/render-utils";
export { copyToClipboard } from "../utils/clipboard";
export { Type } from "./legacy-typebox";

// Legacy pi's `@earendil-works/pi-coding-agent` root exported an `is<Tool>ToolResult`
// family of type guards that narrow a `tool_result` event (`ToolResultEvent`) by
// tool name. omp removed them from the public API in 10.2.3, and the barrel above
// does not forward them, so legacy extensions importing them (e.g.
// `pi-lean-ctx@3.9.18`, which uses `isEditToolResult`/`isWriteToolResult` to
// invalidate its read cache after a native edit/write) fail Bun's static export
// check during validation (issue #8161). Restore the full guard family; legacy
// `find`/`ls` tool results arrive through omp's custom-event branch, so those
// guards narrow the tool name while leaving their details unknown.

/** Narrow a `tool_result` event to the `bash` tool. */
export function isBashToolResult(e: ToolResultEvent): e is BashToolResultEvent {
	return e.toolName === "bash";
}

/** Narrow a `tool_result` event to the `read` tool. */
export function isReadToolResult(e: ToolResultEvent): e is ReadToolResultEvent {
	return e.toolName === "read";
}

/** Narrow a `tool_result` event to the `edit` tool. */
export function isEditToolResult(e: ToolResultEvent): e is EditToolResultEvent {
	return e.toolName === "edit";
}

/** Narrow a `tool_result` event to the `write` tool. */
export function isWriteToolResult(e: ToolResultEvent): e is WriteToolResultEvent {
	return e.toolName === "write";
}

/** Narrow a `tool_result` event to the `grep` tool. */
export function isGrepToolResult(e: ToolResultEvent): e is GrepToolResultEvent {
	return e.toolName === "grep";
}

/** Legacy `find` result event represented by omp's custom-event branch. */
export type FindToolResultEvent = ToolResultEvent & { toolName: "find" };

/** Narrow a `tool_result` event to the legacy `find` tool. */
export function isFindToolResult(e: ToolResultEvent): e is FindToolResultEvent {
	return e.toolName === "find";
}

/** Legacy `ls` result event represented by omp's custom-event branch. */
export type LsToolResultEvent = ToolResultEvent & { toolName: "ls" };

/** Narrow a `tool_result` event to the legacy `ls` tool. */
export function isLsToolResult(e: ToolResultEvent): e is LsToolResultEvent {
	return e.toolName === "ls";
}
