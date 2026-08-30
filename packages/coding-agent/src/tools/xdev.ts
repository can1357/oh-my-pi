/**
 * `xd://` virtual tool devices.
 *
 * Discoverable built-ins and custom tools are unmounted from the request's
 * tools array and exposed as internal URLs driven through the `read`/`write`
 * tools the model already has:
 *
 *   read  xd://           → bounded mounted tool listing (discovery)
 *   read  xd://?q=<term>  → bounded name and summary/description search
 *   read  xd://<tool>     → tool docs + JSON parameter schema
 *   write xd://<tool>     → execute: `content` is the JSON args object
 *
 * Direct and device dispatch share one canonical tool map. The mounted-name
 * set controls presentation only; dispatch accepts the enabled union of
 * top-level active and mounted names. Listing and prompt docs stay
 * mounted-only because top-level tools already ship their schemas.
 *
 * Args go through the same machinery as native tool calls: validated with
 * pi-ai's `validateToolArguments` (the schema is returned on mismatch, so a
 * malformed call self-corrects without a round trip) and streamed through
 * the write tool's existing incremental `content` decoding for live render
 * previews. Compared to a dispatcher def this still costs zero *schema
 * duplication* — one wire schema per tool instead of one per dispatcher
 * branch — but full docs + schema for every mounted device can be inlined
 * into the system prompt, so no discovery read is needed before first use;
 * `read xd://<tool>` remains for on-demand re-fetch.
 *
 * Rendering: the write renderer draws NOTHING until the streamed `path` is
 * known and provably does not target `xd://`. Device writes then show as
 * queued/planning until `tool_execution_start`, and only then delegate to the
 * wrapped tool's own renderer with the decoded inner args.
 */
import type { AgentToolContext, AgentToolResult, AgentToolUpdateCallback, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import { type Tool as AiTool, jsonSchemaToTypeScript, toolWireSchema, validateToolArguments } from "@oh-my-pi/pi-ai";
import { type Component, Container, Text } from "@oh-my-pi/pi-tui";
import { parseStreamingJson, truncate } from "@oh-my-pi/pi-utils";
import type { ContextProfile } from "../config/settings";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import {
	parseXdUrl,
	sanitizeDiscoveryLine,
	XD_URL_PREFIX,
	xdevAliasId,
	xdevAliasIdFromReference,
	xdevToolUrl,
} from "../internal-urls/xd-protocol";
import { parseMCPToolName } from "../mcp/tool-bridge";
import type { Theme } from "../modes/theme/theme";
import { truncateHeadBytes } from "../session/streaming-output";
import { resolveToolTier, type ToolTier } from "./approval";
import { renderDefaultToolExecution } from "./default-renderer";
import type { Tool } from "./index";
import { replaceTabs } from "./render-utils";
import type { ToolActivitySummary, ToolRenderer } from "./renderers";
import { renderError, ToolAbortError, ToolError } from "./tool-errors";

/**
 * Discoverable built-ins that must stay top-level even when xdev mounting is
 * active: `todo` feeds the todo prelude/prewalk machinery, `ask` is the
 * model's user-interaction affordance, `grep` is the redirect target of the
 * bash interceptor rules, and `web_search` is invoked directly by most models
 * (which have no notion of the `xd://` protocol) so hiding it behind dispatch
 * makes it unreachable in practice (issue #5973) — each loses its harness
 * integration or usability if hidden behind dispatch.
 */
export const XDEV_KEEP_TOP_LEVEL: Record<string, true> = {
	todo: true,
	ask: true,
	grep: true,
	web_search: true,
};

/**
 * Tools that carry the `xd://` transport itself and therefore can never be
 * mounted as devices: `read xd://` lists/documents devices and
 * `write xd://<tool>` executes them. Demoting either leaves every mounted
 * device unreachable (issue #5764), so they stay top-level regardless of a
 * declared `loadMode`.
 */
export const XDEV_TRANSPORT_TOOLS: Record<string, true> = { read: true, write: true };

/** Controls which mounted-device docs are inlined into the system prompt. */
export type XdevDocsMode = "inline" | "builtins" | "catalog";

/**
 * These tools have harness integrations keyed to their native tool name.
 * Mounting them preserves execution but loses todo tracking, interactive
 * question handling, or provider hard tool choices, so every profile keeps
 * them native when enabled.
 */
const XDEV_INTEGRATED_TOP_LEVEL: Record<string, true> = { todo: true, ask: true, think: true };

const BALANCED_DIRECT_TOOLS: Record<string, true> = {
	read: true,
	write: true,
	bash: true,
	edit: true,
	grep: true,
	glob: true,
};
const AGGRESSIVE_DIRECT_TOOLS: Record<string, true> = { read: true, write: true, bash: true };

/**
 * Whether an enabled tool is presented under `xd://` while the transport is
 * active. `full` preserves the existing load-mode and pinned-tool behavior.
 * Reduced profiles keep a small native set plus tools whose harness integration
 * depends on their native identity, and mount every other enabled tool,
 * including tools that normally declare themselves essential. Callers still
 * keep explicitly requested tools top-level.
 */
export function isMountableUnderXdev(
	tool: { name: string; loadMode?: ToolLoadMode },
	contextProfile: ContextProfile = "full",
): boolean {
	if (tool.name in XDEV_TRANSPORT_TOOLS) return false;
	if (tool.name in XDEV_INTEGRATED_TOP_LEVEL) return false;
	if (contextProfile === "balanced") return !(tool.name in BALANCED_DIRECT_TOOLS);
	if (contextProfile === "aggressive") return !(tool.name in AGGRESSIVE_DIRECT_TOOLS);
	if (tool.name in XDEV_KEEP_TOP_LEVEL) return false;
	return tool.loadMode === "discoverable";
}

/** Dispatch metadata carried on write-tool details for renderer delegation. */
export interface XdevDispatch {
	tool: string;
	mode: "help" | "execute";
	/** Validated inner args, kept for renderer delegation on result rebuilds. */
	args?: Record<string, unknown>;
	/**
	 * Approval tier of the wrapped tool for {@link args} (`read` = no workspace
	 * mutation). Absent for `help` dispatches and calls whose tier could not be
	 * resolved. Consumed by the prewalk coordinator to skip read-only device
	 * calls when deciding the model hand-off (issue #7312).
	 */
	tier?: ToolTier;
	/** Details object returned by the wrapped tool, when executed. */
	inner?: unknown;
}

/**
 * Renderer lookup injected by `renderers.ts` at module init. Kept as a setter
 * to avoid the xdev → renderers → tool modules → sdk → tools/index → xdev
 * import cycle.
 */
let rendererLookup: ((name: string) => ToolRenderer | undefined) | undefined;

/** Wire the wrapped-renderer lookup. Called once by `renderers.ts`. */
export function setXdevRendererLookup(lookup: (name: string) => ToolRenderer | undefined): void {
	rendererLookup = lookup;
}

/** Whether a wire JSON schema declares a top-level `i` (intent) property. */
function schemaDeclaresIntentField(schema: unknown): boolean {
	if (!schema || typeof schema !== "object" || !("properties" in schema)) return false;
	const props = schema.properties;
	return !!props && typeof props === "object" && "i" in props;
}

function renderDocs(inst: Tool, heading = "#", descriptionCap?: number, includeExample = false): string {
	const schema = jsonSchemaToTypeScript(toolWireSchema(inst as AiTool));
	let description = inst.description ?? "";
	if (descriptionCap !== undefined && description.length > descriptionCap) {
		description = `${description.slice(0, descriptionCap).trimEnd()}… (full docs: read ${xdevToolUrl(inst.name)})`;
	}
	const lines = [
		`${heading} ${inst.name}${inst.label ? ` — ${inst.label}` : ""}`,
		"",
		description,
		"",
		`${heading}# Schema`,
		"```ts",
		`type Args = ${schema};`,
		"```",
		`Execute by writing JSON to ${xdevToolUrl(inst.name)}.`,
	];
	const example = includeExample ? exampleArgs(inst) : undefined;
	if (example) {
		lines.push(
			`Example: write(path="${xdevToolUrl(inst.name)}", content=${JSON.stringify(JSON.stringify(example))}) — one JSON object, newlines inside strings as \\n.`,
		);
	}
	return lines.join("\n");
}

/** First authored call that validates against the live mounted-tool schema. */
function exampleArgs(inst: Tool): Record<string, unknown> | undefined {
	for (const example of inst.examples ?? []) {
		const authored = "call" in example ? example.call : "good" in example ? example.good : undefined;
		if (!authored || typeof authored !== "object" || Array.isArray(authored)) continue;
		const args = { ...authored } as Record<string, unknown>;
		if (schemaDeclaresIntentField(toolWireSchema(inst as AiTool)) && !("i" in args)) args.i = "…";
		try {
			return validateToolArguments(inst as AiTool, {
				type: "toolCall",
				id: "xdev-doc-example",
				name: inst.name,
				arguments: args,
			});
		} catch {
			// Ignore stale or provider-specific authored examples.
		}
	}
	return undefined;
}

/**
 * Parse and validate a device write's JSON `content` against the wrapped
 * tool's wire schema. Strips a habitual top-level `i` (intent) unless the
 * schema declares one. Throws ToolError; schema-mismatch errors carry `docs()`
 * for repair.
 */
function parseDeviceArgs(
	device: AiTool,
	content: string,
	toolCallId: string,
	docs: () => string,
): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new ToolError(
			`${xdevToolUrl(device.name)} expects a JSON args object as content (${error instanceof Error ? error.message : String(error)}). Write \`?\` for docs.`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ToolError(
			`${xdevToolUrl(device.name)} content must be a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}.`,
		);
	}
	// The harness only injects the intent field into top-level schemas; strip a
	// habitual `i` from inner args unless the wrapped schema really declares it.
	const args: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
	if ("i" in args && !schemaDeclaresIntentField(toolWireSchema(device))) delete args.i;
	try {
		return validateToolArguments(device, {
			type: "toolCall",
			id: toolCallId,
			name: device.name,
			arguments: args,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ToolError(`Invalid args for ${xdevToolUrl(device.name)}: ${message}\n\n${docs()}`);
	}
}

/** One-line catalog summary for a mounted tool: `summary`, else first description line. */
function toolSummary(inst: Tool): string {
	if (inst.summary) return inst.summary;
	const firstLine = (inst.description ?? "").split("\n").find(line => line.trim().length > 0);
	return firstLine?.trim() ?? inst.label ?? inst.name;
}

/** C0/C1 controls and Unicode line/paragraph separators; summaries must remain one line. */
const SUMMARY_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const SUMMARY_ELLIPSIS = "…";
const SUMMARY_ELLIPSIS_BYTES = Buffer.byteLength(SUMMARY_ELLIPSIS, "utf-8");

/**
 * Bound a catalog summary for prompt rendering. External summaries are
 * third-party metadata inlined verbatim, so control characters are stripped
 * first, then the result is bounded in UTF-8 BYTES rather than characters (a
 * character bound is not a byte bound for multi-byte scripts). The cut lands
 * on a code point boundary, so the prompt never carries a partial code point.
 */
function sanitizeCatalogSummary(summary: string, maxBytes?: number): string {
	const cleaned = summary.replace(SUMMARY_CONTROL_CHARS, " ").trim();
	if (maxBytes === undefined || Buffer.byteLength(cleaned, "utf-8") <= maxBytes) return cleaned;
	if (maxBytes <= 0) return "";
	if (maxBytes < SUMMARY_ELLIPSIS_BYTES) return truncateHeadBytes(cleaned, maxBytes).text;
	const body = truncateHeadBytes(cleaned, maxBytes - SUMMARY_ELLIPSIS_BYTES).text.trimEnd();
	return `${body}${SUMMARY_ELLIPSIS}`;
}

function promptCatalogSummary(inst: Tool, maxBytes?: number): string {
	const summary =
		toolSummary(inst)
			.split("\n")
			.find(line => line.trim().length > 0)
			?.trim() ?? inst.name;
	return sanitizeCatalogSummary(summary, maxBytes) || inst.name;
}

/** Compile `tools.xdevInlineDevices` globs once per use, dropping malformed
 * entries so user config cannot break prompt builds. */
export function compileToolNameGlobs(patterns: readonly string[]): Bun.Glob[] {
	if (!Array.isArray(patterns)) return [];
	const globs: Bun.Glob[] = [];
	for (const pattern of patterns) {
		if (typeof pattern !== "string" || pattern.length === 0) continue;
		globs.push(new Bun.Glob(pattern));
	}
	return globs;
}

/** Decode the (possibly partially streamed) inner args JSON string into display args. */
function decodeInnerArgs(raw: unknown): Record<string, unknown> {
	if (typeof raw !== "string" || raw.length === 0) return {};
	const parsed = parseStreamingJson<Record<string, unknown>>(raw);
	const args: Record<string, unknown> = parsed && typeof parsed === "object" ? { ...parsed } : {};
	args.__partialJson = raw;
	return args;
}

/** Device-write content that requests docs instead of executing: empty, `?`, or `help`. */
const HELP_CONTENT_RE = /^\s*(\?|help)?\s*$/i;

/** Shared tool state consumed by the `xd://` presentation layer. */
export interface XdevState {
	/** Canonical session tool map; direct and device dispatch read the same instances. */
	readonly tools: Map<string, Tool>;
	/** Ordered names currently presented as mounted devices. */
	readonly mountedNames: Set<string>;
	/** Names originating from built-in factories, used only for prompt presentation. */
	readonly builtInNames: Set<string>;
	/** Whether a name is active at the top level. */
	readonly isActive: (name: string) => boolean;
	/** Optional execution-only decorator, such as the ACP permission gate. */
	decorateExecution?(tool: Tool): Tool;
}

/** Full-doc character budget for system-prompt mounted-device sections. */
export const XDEV_DOCS_TOTAL_BUDGET = 48_000;
/** Per-device cap preventing one pathological description from starving later devices. */
export const XDEV_DOCS_PER_DEVICE_CAP = 10_000;
/** Description cap for external mounted tools; their full docs remain readable on demand. */
export const XDEV_EXTERNAL_DESCRIPTION_CAP = 200;
/**
 * Catalog-row cap in "catalog" mode, where a row exists to say the device is
 * there and roughly what it does; `read xd://<tool>` carries the rest. A first
 * clause is enough for that, and the uncapped built-in summaries were the
 * largest block left in a small-context prompt.
 */
export const XDEV_CATALOG_DESCRIPTION_CAP = 90;
/** Maximum rows returned by `read xd://` and `read xd://?q=<term>`. */
export const XDEV_DISCOVERY_LIMIT = 50;
/** Character cap for descriptions returned by xd catalog discovery. */
export const XDEV_DISCOVERY_DESCRIPTION_LIMIT = 200;
const XDEV_DISCOVERY_QUERY_DISPLAY_LIMIT = 100;

/** Resolve any enabled tool through the canonical session map. */
export function resolveXdevTool(state: XdevState, name: string): Tool | undefined {
	if (state.mountedNames.has(name) || state.isActive(name)) return state.tools.get(name);
	const aliasId = xdevAliasIdFromReference(name);
	if (!aliasId) return undefined;
	for (const tool of state.tools.values()) {
		if (!state.mountedNames.has(tool.name) && !state.isActive(tool.name)) continue;
		try {
			encodeURIComponent(tool.name);
		} catch {
			if (xdevAliasId(tool.name) === aliasId) return tool;
		}
	}
	return undefined;
}

/**
 * A tool call named after a device path. The compact profile refers to mounted
 * tools as `xd://grep`, and a local model then calls `xd://grep` as if it were
 * a tool name (five "Tool not found" results in one benchmark run). The device
 * is the intended target, so the prefix is accepted here.
 */
function stripXdevPrefix(name: string): string {
	if (!name.startsWith(XD_URL_PREFIX)) return name;
	const target = parseXdUrl(name);
	return target?.query === null ? (target.name ?? "") : "";
}

/** Resolve a mounted tool for top-level fallback execution; accepts `xd://<tool>` as the name. */
export function resolveMountedXdevTool(state: XdevState, name: string): Tool | undefined {
	const tool = resolveXdevTool(state, stripXdevPrefix(name));
	return tool && state.mountedNames.has(tool.name) ? tool : undefined;
}

/** Resolve a mounted tool with its execution-only permission decorator. */
export function resolveMountedXdevExecutable(state: XdevState, name: string): Tool | undefined {
	const tool = resolveMountedXdevTool(state, name);
	return tool && state.decorateExecution ? state.decorateExecution(tool) : tool;
}
/** Mounted tools in presentation order, resolved from the canonical map. */
export function listXdevTools(state: XdevState): Tool[] {
	return [...state.mountedNames].flatMap(name => {
		const tool = state.tools.get(name);
		return tool ? [tool] : [];
	});
}

/** `{name, summary, dynamic}` triples for prompt templates and `/tools` display. */
export function xdevEntries(state: XdevState): Array<{ name: string; summary: string; dynamic: boolean }> {
	return listXdevTools(state).map(tool => {
		// Built-ins are first-party; anything else carries third-party metadata. One
		// boolean drives both the description cap and the flag callers present, so
		// the two can never disagree about which summaries are untrusted.
		const dynamic = !state.builtInNames.has(tool.name);
		return {
			name: tool.name,
			summary: promptCatalogSummary(tool, dynamic ? XDEV_EXTERNAL_DESCRIPTION_CAP : undefined),
			dynamic,
		};
	});
}

function discoveryCatalogSummary(tool: Tool): string {
	return truncate(sanitizeDiscoveryLine(toolSummary(tool)), XDEV_DISCOVERY_DESCRIPTION_LIMIT);
}

/** Bounded, deterministic `read xd://` catalog and `read xd://?q=<term>` search. */
export function xdevListing(state: XdevState, query?: string): string {
	const normalizedQuery = query?.trim().toLowerCase();
	const matches = listXdevTools(state)
		.filter(tool => {
			if (!normalizedQuery) return true;
			return (
				tool.name.toLowerCase().includes(normalizedQuery) ||
				(tool.summary ?? "").toLowerCase().includes(normalizedQuery) ||
				(tool.description ?? "").toLowerCase().includes(normalizedQuery)
			);
		})
		.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
	const shown = matches.slice(0, XDEV_DISCOVERY_LIMIT);
	const lines =
		normalizedQuery === undefined
			? [`Mounted tool devices (${shown.length} of ${matches.length})`, `Search with ${XD_URL_PREFIX}?q=<term>.`]
			: [
					`Mounted tool devices matching "${truncate(
						sanitizeDiscoveryLine(query ?? ""),
						XDEV_DISCOVERY_QUERY_DISPLAY_LIMIT,
					)}" (${shown.length} of ${matches.length})`,
				];

	if (shown.length > 0) {
		lines.push(
			"",
			...shown.map(tool => {
				const summary = discoveryCatalogSummary(tool);
				return summary ? `${xdevToolUrl(tool.name)} — ${summary}` : xdevToolUrl(tool.name);
			}),
		);
	} else {
		lines.push("", `No mounted tools matched. Try a different term with ${XD_URL_PREFIX}?q=<term>.`);
	}

	const omitted = matches.length - shown.length;
	if (omitted > 0) {
		lines.push(
			"",
			`Results truncated at ${XDEV_DISCOVERY_LIMIT}; ${omitted} omitted. Refine with a narrower ${XD_URL_PREFIX}?q=<term> search.`,
		);
	}
	lines.push(
		"",
		`Read ${XD_URL_PREFIX}<tool> for docs + JSON schema; write the JSON args object to ${XD_URL_PREFIX}<tool> to execute. Active top-level tools accept the same dispatch.`,
	);
	return lines.join("\n");
}

/** Docs + schema for any enabled tool. */
export function xdevDocs(state: XdevState, name: string): string {
	return renderDocs(resolveRequiredXdevTool(state, name), "#", undefined, true);
}

/** Docs + schema for mounted devices under the configured prompt-doc policy. */
export function xdevDocsAll(
	state: XdevState,
	mode: XdevDocsMode = "inline",
	inlinePatterns: readonly string[] = [],
	compactPresentation = false,
): string {
	const sections: string[] = [];
	const overflow: Tool[] = [];
	const inlineGlobs = compileToolNameGlobs(inlinePatterns);
	let used = 0;
	for (const tool of listXdevTools(state)) {
		if (!shouldInlineXdevTool(state, tool, mode, inlineGlobs)) {
			overflow.push(tool);
			continue;
		}
		const descriptionCap = state.builtInNames.has(tool.name) ? undefined : XDEV_EXTERNAL_DESCRIPTION_CAP;
		const docs = renderDocs(tool, "##", descriptionCap, compactPresentation);
		if (docs.length > XDEV_DOCS_PER_DEVICE_CAP || used + docs.length > XDEV_DOCS_TOTAL_BUDGET) {
			overflow.push(tool);
			continue;
		}
		used += docs.length;
		sections.push(docs);
	}
	if (overflow.length > 0) {
		const boundedCatalog = compactPresentation && mode === "catalog";
		const visibleOverflow = boundedCatalog ? overflow.slice(0, XDEV_DISCOVERY_LIMIT) : overflow;
		const catalog = renderOverflowCatalog(state, visibleOverflow, mode, compactPresentation);
		if (boundedCatalog && overflow.length > visibleOverflow.length) {
			catalog.push(
				`- Static catalog truncated at ${XDEV_DISCOVERY_LIMIT} devices; ${overflow.length - visibleOverflow.length} omitted. Search with ${XD_URL_PREFIX}?q=<term>.`,
			);
		}
		sections.push(
			[
				"## Additional devices (docs on demand)",
				...catalog,
				"",
				`Read ${XD_URL_PREFIX}<tool> for full docs + JSON schema before first use.`,
			].join("\n"),
		);
	}
	return sections.join("\n\n");
}

/**
 * Catalog rows for devices whose docs are not inlined.
 *
 * Compact catalog mode lists a bounded device sample and fetches all docs on
 * demand. It groups an MCP server's visible tools by name under one heading
 * instead of spending a summary line on each tool. Built-in devices keep their
 * one-line summary because there are few of them and names such as `xd://hub`
 * do not explain their purpose. Full-profile rendering preserves the previous
 * per-device catalog.
 */
/** Shortest mounted-name prefix worth factoring out of an MCP catalog row. */
const XD_MCP_PREFIX_MIN = "mcp__".length + 1;

function commonPrefix(names: readonly string[]): string {
	let prefix = names[0] ?? "";
	for (const name of names.slice(1)) {
		let k = 0;
		while (k < prefix.length && k < name.length && prefix[k] === name[k]) k++;
		prefix = prefix.slice(0, k);
	}
	// Cut at the last underscore so the brace list starts on a name boundary.
	const cut = prefix.lastIndexOf("_");
	return cut > 0 ? prefix.slice(0, cut + 1) : "";
}

function renderOverflowCatalog(
	state: XdevState,
	overflow: readonly Tool[],
	mode: XdevDocsMode,
	compactPresentation: boolean,
): string[] {
	const summaryRow = (tool: Tool): string => {
		const externalCap = state.builtInNames.has(tool.name) ? undefined : XDEV_EXTERNAL_DESCRIPTION_CAP;
		const maxBytes =
			compactPresentation && mode === "catalog"
				? Math.min(externalCap ?? Infinity, XDEV_CATALOG_DESCRIPTION_CAP)
				: externalCap;
		return `- ${xdevToolUrl(tool.name)} — ${promptCatalogSummary(tool, maxBytes)}`;
	};
	if (mode !== "catalog" || !compactPresentation) return overflow.map(summaryRow);

	const rows: string[] = [];
	const byServer = new Map<string, string[]>();
	for (const tool of overflow) {
		const parsed = state.builtInNames.has(tool.name) ? null : parseMCPToolName(tool.name);
		if (!parsed) {
			rows.push(summaryRow(tool));
			continue;
		}
		const names = byServer.get(parsed.serverName);
		if (names) names.push(tool.name);
		else byServer.set(parsed.serverName, [tool.name]);
	}
	for (const [serverName, names] of byServer) {
		// One prefix + a brace list instead of the full mounted name per tool:
		// with a 21-tool server that is ~420 fewer characters on every request.
		const routes = names.map(xdevToolUrl);
		const prefix = commonPrefix(names);
		const canFactor =
			names.length > 1 &&
			prefix.length > XD_MCP_PREFIX_MIN &&
			routes.every((route, index) => route === `${XD_URL_PREFIX}${names[index]}`);
		const body = canFactor
			? `${XD_URL_PREFIX}${prefix}{${names.map(name => name.slice(prefix.length)).join("|")}}`
			: routes.join(", ");
		rows.push(`- MCP server \`${serverName}\` (${names.length}): ${body}`);
	}
	return rows;
}

/** Docs for selected mounted devices under the configured prompt-doc policy. */
export function xdevDocsFor(
	state: XdevState,
	names: Iterable<string>,
	mode: XdevDocsMode,
	inlinePatterns: readonly string[] = [],
	compactPresentation = false,
): string {
	const sections: string[] = [];
	const inlineGlobs = compileToolNameGlobs(inlinePatterns);
	let used = 0;
	for (const name of names) {
		const tool = resolveMountedXdevTool(state, name);
		if (!tool || !shouldInlineXdevTool(state, tool, mode, inlineGlobs)) continue;
		const descriptionCap = state.builtInNames.has(tool.name) ? undefined : XDEV_EXTERNAL_DESCRIPTION_CAP;
		const docs = renderDocs(tool, "##", descriptionCap, compactPresentation);
		if (docs.length > XDEV_DOCS_PER_DEVICE_CAP || used + docs.length > XDEV_DOCS_TOTAL_BUDGET) continue;
		used += docs.length;
		sections.push(docs);
	}
	return sections.join("\n\n");
}

function shouldInlineXdevTool(
	state: XdevState,
	tool: Tool,
	mode: XdevDocsMode,
	inlineGlobs: readonly Bun.Glob[],
): boolean {
	return (
		mode !== "catalog" &&
		(mode === "inline" || state.builtInNames.has(tool.name) || inlineGlobs.some(glob => glob.match(tool.name)))
	);
}

function resolveRequiredXdevTool(state: XdevState, name: string): Tool {
	const inst = resolveXdevTool(state, name);
	if (!inst) {
		throw new ToolError(
			`No such tool: ${xdevToolUrl(name)}. Search mounted devices with ${XD_URL_PREFIX}?q=<term>. Active top-level tools are also dispatchable via ${XD_URL_PREFIX}<tool>.`,
		);
	}
	return inst;
}

/** Execute an enabled canonical tool through `write xd://<tool>`. */
export async function dispatchXdevTool(
	state: XdevState,
	name: string,
	content: string,
	toolCallId: string,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback,
	context?: AgentToolContext,
): Promise<{ result: AgentToolResult<unknown>; xdev: XdevDispatch }> {
	let xdev: XdevDispatch = { tool: name, mode: "execute" };
	try {
		const canonical = resolveRequiredXdevTool(state, name);
		xdev = { tool: canonical.name, mode: "execute" };

		if (HELP_CONTENT_RE.test(content)) {
			return {
				result: { content: [{ type: "text", text: renderDocs(canonical, "#", undefined, true) }] },
				xdev: { tool: canonical.name, mode: "help" },
			};
		}

		const validated = parseDeviceArgs(canonical as AiTool, content, toolCallId, () =>
			renderDocs(canonical, "#", undefined, true),
		);
		// Record the wrapped tool's approval tier so the prewalk coordinator can
		// tell a read-only device call (e.g. `lsp` navigation) from a real
		// workspace mutation without re-decoding the payload. Best-effort: a
		// throwing approval leaves the tier absent (prewalk then declines to
		// switch), unlike the write gate which fails closed to `exec`.
		let tier: ToolTier | undefined;
		try {
			tier = resolveToolTier(canonical, validated);
		} catch {
			tier = undefined;
		}
		xdev = { ...xdev, args: validated, tier };
		const innerOnUpdate: AgentToolUpdateCallback | undefined = onUpdate
			? partial =>
					onUpdate({
						content: partial.content,
						details: { xdev: { ...xdev, inner: partial.details } },
						isError: partial.isError,
					})
			: undefined;
		const executable = state.decorateExecution?.(canonical) ?? canonical;
		const executionContext = context
			? {
					...context,
					xdevTierResolved: (effectiveTier: ToolTier) => {
						xdev = { ...xdev, tier: effectiveTier };
					},
				}
			: undefined;
		const result = await executable.execute(toolCallId, validated as never, signal, innerOnUpdate, executionContext);
		return { result, xdev: { ...xdev, inner: result.details } };
	} catch (error) {
		if (
			error instanceof ToolAbortError ||
			signal?.aborted ||
			(error instanceof Error && error.name === "AbortError")
		) {
			throw error;
		}
		return {
			result: {
				content: [{ type: "text", text: renderError(error) }],
				isError: true,
			},
			xdev,
		};
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Render delegation (consumed by the write renderer)
// ═══════════════════════════════════════════════════════════════════════════

/** Renderer for a mounted device: the live mounted tool's own render callbacks
 *  (custom/MCP/image tools carry them) first, then the static built-in renderer
 *  map keyed by name. */
function resolveDeviceRenderer(
	name: string,
	mounted: Tool | undefined,
): Pick<ToolRenderer, "renderCall" | "renderResult" | "mergeCallAndResult"> | undefined {
	if (mounted && (mounted.renderCall || mounted.renderResult)) {
		// A mounted AgentTool exposes the same renderCall/renderResult/mergeCallAndResult
		// surface as a static ToolRenderer; only the parameter generics differ, so unify
		// through a single cast rather than fabricating a per-field shape.
		return mounted as unknown as Pick<ToolRenderer, "renderCall" | "renderResult" | "mergeCallAndResult">;
	}
	return rendererLookup?.(name);
}

/** Human label for a device write: mounted tool label, else `server/tool` for MCP names. */
function displayDeviceLabel(name: string, mounted?: { label?: string }): string {
	if (mounted?.label) return mounted.label;
	const parsed = parseMCPToolName(name);
	if (parsed) return `${parsed.serverName}/${parsed.toolName}`;
	return name;
}
/** Salient inner-arg keys for the compact activity line: the verb first, then its object. */
const ACTIVITY_VERB_KEYS = ["action", "op", "command"] as const;
const ACTIVITY_OBJECT_KEYS = ["query", "symbol", "path", "file", "pattern", "url", "name"] as const;

/**
 * Compact `label · verb object` activity summary for a device write, so a
 * squeezed transcript row reads `LSP · references foo` instead of
 * `Write · xd://lsp`. Prose payloads (resolution devices, report_issue)
 * surface their first line instead.
 */
export function xdevActivitySummary(
	name: string,
	content: unknown,
	resolveMounted?: (name: string) => Tool | undefined,
): ToolActivitySummary {
	const mounted = resolveMounted?.(name);
	const args = decodeInnerArgs(content);
	const pick = (keys: readonly string[]): string | undefined => {
		for (const key of keys) {
			const value = args[key];
			if (typeof value === "string" && value.length > 0) return value.split("\n", 1)[0];
		}
		return undefined;
	};
	let detail = [pick(ACTIVITY_VERB_KEYS), pick(ACTIVITY_OBJECT_KEYS)].filter(Boolean).join(" ");
	if (!detail && typeof content === "string" && !content.trimStart().startsWith("{")) {
		detail = content.trim().split("\n", 1)[0];
	}
	return { label: displayDeviceLabel(name, mounted), detail: detail || undefined };
}

/** Drop the streaming-decode bookkeeping key before showing inner args. */
function displayDeviceArgs(args: Record<string, unknown>): Record<string, unknown> {
	const { __partialJson: _partial, ...rest } = args;
	return rest;
}

/** Pre-execution card so a streamed `xd://` write does not look like a hung MCP call. */
function renderQueuedXdevCall(
	label: string,
	args: Record<string, unknown>,
	options: RenderResultOptions,
	theme: Theme,
): Component {
	return renderDefaultToolExecution(
		{
			label: `queued ${label}`,
			args: displayDeviceArgs(args),
			options: { ...options, isPartial: true, spinnerFrame: undefined },
		},
		theme,
	);
}

/**
 * Streaming-safe call preview for an `xd://` write. Until the write actually
 * executes (`executionStarted` / `tool_execution_start`), show a queued/planning
 * card so Grok-style think-after-toolcall stalls do not look like a hung
 * inner tool. `argsComplete` alone is not enough: exclusive writes can sit
 * complete at `message_end` while an earlier call still runs. Once execution
 * starts, forward the decoded inner args to the mounted tool's renderer
 * (session instance first, then the static map). Returns `undefined` (render
 * nothing) when no renderer produces output.
 */
export function renderXdevCall(
	name: string,
	content: unknown,
	options: RenderResultOptions,
	theme: Theme,
	resolveMounted?: (name: string) => Tool | undefined,
): Component | undefined {
	const mounted = resolveMounted?.(name);
	const args = decodeInnerArgs(content);
	if (!options.executionStarted) {
		return renderQueuedXdevCall(displayDeviceLabel(name, mounted), args, options, theme);
	}
	const renderer = resolveDeviceRenderer(name, mounted);
	if (renderer?.renderCall) {
		return renderer.renderCall(args, options, theme);
	}
	return renderDefaultToolExecution({ label: mounted?.label ?? name, args, options }, theme);
}

/** Forward an `xd://` dispatch result to the mounted tool's renderer. */
export function renderXdevResult(
	dispatch: XdevDispatch,
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	options: RenderResultOptions,
	theme: Theme,
	resolveMounted?: (name: string) => Tool | undefined,
): Component | undefined {
	const text = result.content
		.map(block => (block.type === "text" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
	if (dispatch.mode === "help") {
		return text ? new Text(theme.fg("toolOutput", replaceTabs(text)), 0, 0) : undefined;
	}
	const mounted = resolveMounted?.(dispatch.tool);
	const renderer = resolveDeviceRenderer(dispatch.tool, mounted);
	const innerResult = { content: result.content, details: dispatch.inner, isError: result.isError };
	if (renderer?.renderResult) {
		const parts: Component[] = [];
		// Emulate the unmerged call+result topology inside the write block for
		// renderers that expect a separate call header.
		if (!renderer.mergeCallAndResult && renderer.renderCall) {
			const call = renderer.renderCall(dispatch.args ?? {}, { ...options, isPartial: false }, theme);
			if (call) parts.push(call);
		}
		const rendered = renderer.renderResult(innerResult, options, theme, dispatch.args ?? {});
		if (rendered) parts.push(rendered);
		if (parts.length === 1) return parts[0];
		if (parts.length > 1) {
			const box = new Container();
			for (const part of parts) box.addChild(part);
			return box;
		}
	}
	return renderDefaultToolExecution(
		{
			label: mounted?.label ?? dispatch.tool,
			args: dispatch.args ?? {},
			result: { output: text, isError: result.isError },
			options,
		},
		theme,
	);
}
