/**
 * `xd://` virtual tool devices.
 *
 * Discoverable built-ins and custom tools are unmounted from the request's
 * tools array and exposed as internal URLs driven through the `read`/`write`
 * tools the model already has:
 *
 *   read  xd://          → mounted tool listing (discovery)
 *   read  xd://<tool>    → tool docs + JSON parameter schema
 *   write xd://<tool>    → execute: `content` is the JSON args object
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
import { schemaDeclaresIntentField } from "../utils/tool-schema";
import { stripXdUrlPrefix, XD_URL_PREFIX } from "@oh-my-pi/pi-tui/tools/xd-url";
import { truncateHeadBytes } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { resolveToolTier, type ToolTier } from "./approval";
import type { Tool } from "./index";
import { renderError, ToolAbortError } from "./tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/**
 * Discoverable built-ins that must stay top-level even when xdev mounting is
 * active: `todo` feeds the todo prelude/prewalk machinery, `ask` is the
 * model's user-interaction affordance, `grep` is the redirect target of the
 * bash interceptor rules, and `web_search` is invoked directly by most models
 * (which have no notion of the `xd://` protocol) so hiding it behind dispatch
 * makes it unreachable in practice (issue #5973). `yield` terminates structured
 * subagent runs and must stay directly callable — each loses its harness
 * integration or usability if hidden behind dispatch.
 */
export const XDEV_KEEP_TOP_LEVEL: Record<string, true> = {
	todo: true,
	yield: true,
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
 * Whether an enabled tool is presented under `xd://` (rather than top-level)
 * while the `xd://` transport is active. Discoverable tools mount unless they
 * are pinned top-level by {@link XDEV_KEEP_TOP_LEVEL} or carry the transport
 * itself ({@link XDEV_TRANSPORT_TOOLS}); essential tools never do. The caller
 * gates this on the transport being active.
 */
export function isMountableUnderXdev(tool: { name: string; loadMode?: ToolLoadMode }): boolean {
	if (tool.name in XDEV_TRANSPORT_TOOLS || tool.name in XDEV_KEEP_TOP_LEVEL) return false;
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

function renderDocs(inst: Tool, heading = "#", descriptionCap?: number): string {
	const schema = jsonSchemaToTypeScript(toolWireSchema(inst as AiTool));
	let description = inst.description ?? "";
	if (descriptionCap !== undefined && description.length > descriptionCap) {
		description = `${description.slice(0, descriptionCap).trimEnd()}… (full docs: read ${XD_URL_PREFIX}${inst.name})`;
	}
	return [
		`${heading} ${inst.name}${inst.label ? ` — ${inst.label}` : ""}`,
		"",
		description,
		"",
		`${heading}# Schema`,
		"```ts",
		`type Args = ${schema};`,
		"```",
		`Execute by writing JSON to ${XD_URL_PREFIX}${inst.name}.`,
	].join("\n");
}

/**
 * Parse and validate a device write's JSON `content` against the wrapped
 * tool's wire schema. Strips a habitual top-level `i` (intent) unless the
 * schema declares one. Throws ToolError; schema-mismatch errors carry `docs()`
 * for repair. A device with `lenientArgValidation` receives the raw args on a
 * schema mismatch instead — the same contract the agent loop and the eval
 * tool bridge honor — so a tool that owns its own refusal (the Dispatch tools
 * re-validate with a strict schema and name the precise problem) is never
 * pre-empted by the host's generic wording plus the full docs.
 */
function parseDeviceArgs(
	device: Tool,
	content: string,
	toolCallId: string,
	docs: () => string,
): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new ToolError(
			`${XD_URL_PREFIX}${device.name} expects a JSON args object as content (${error instanceof Error ? error.message : String(error)}). Write \`?\` for docs.`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ToolError(
			`${XD_URL_PREFIX}${device.name} content must be a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}.`,
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
		if (device.lenientArgValidation) {
			const fallback = { ...args };
			delete fallback.__parseError;
			delete fallback.__rawJson;
			return fallback;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new ToolError(`Invalid args for ${XD_URL_PREFIX}${device.name}: ${message}\n\n${docs()}`);
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

/** Compile the `tools.xdevInlineDevices` allowlist once per render, dropping
 *  non-string entries so malformed user config cannot break prompt builds. */
function compileInlineGlobs(patterns: readonly string[]): Bun.Glob[] {
	if (!Array.isArray(patterns)) return [];
	const globs: Bun.Glob[] = [];
	for (const pattern of patterns) {
		if (typeof pattern !== "string" || pattern.length === 0) continue;
		globs.push(new Bun.Glob(pattern));
	}
	return globs;
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

/** Resolve any enabled tool through the canonical session map. */
export function resolveXdevTool(state: XdevState, name: string): Tool | undefined {
	if (!state.mountedNames.has(name) && !state.isActive(name)) return undefined;
	return state.tools.get(name);
}

/**
 * Resolve a mounted tool by name. Presentation-only: `xd://` docs and renderer
 * lookup ask for names they already hold in canonical form.
 */
export function resolveMountedXdevTool(state: XdevState, name: string): Tool | undefined {
	const canonicalName = stripXdUrlPrefix(name);
	return state.mountedNames.has(canonicalName) ? state.tools.get(canonicalName) : undefined;
}

/**
 * Resolve a mounted tool with its execution-only permission decorator.
 *
 * Mounted-only, matching {@link resolveMountedXdevTool}, and a published export
 * under `@oh-my-pi/pi-coding-agent/tools/xdev`, so its semantics must not
 * drift. `sdk.ts` composes this with the calling agent's advertised tools to
 * recover a Claude Code-spelled MCP name: the union has to be resolved in one
 * pass for the ambiguity rule to hold, so that composition lives with the
 * caller that knows both presentation sets rather than here.
 */
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

/** `read xd://` listing with one device per line. */
export function xdevListing(state: XdevState): string {
	const rows = xdevEntries(state).map(({ name, summary }) => `${XD_URL_PREFIX}${name.padEnd(14)} ${summary}`);
	return [
		`${XD_URL_PREFIX} ${state.mountedNames.size} mounted tool devices.`,
		...rows,
		"",
		`Read ${XD_URL_PREFIX}<tool> for docs + JSON schema; write the JSON args object to ${XD_URL_PREFIX}<tool> to execute. Active top-level tools accept the same dispatch.`,
	].join("\n");
}

/** Docs + schema for any enabled tool. */
export function xdevDocs(state: XdevState, name: string): string {
	return renderDocs(resolveRequiredXdevTool(state, name));
}

/** Docs + schema for mounted devices under the configured prompt-doc policy. */
export function xdevDocsAll(
	state: XdevState,
	mode: XdevDocsMode = "inline",
	inlinePatterns: readonly string[] = [],
): string {
	const sections: string[] = [];
	const overflow: Tool[] = [];
	const inlineGlobs = compileInlineGlobs(inlinePatterns);
	let used = 0;
	for (const tool of listXdevTools(state)) {
		if (!shouldInlineXdevTool(state, tool, mode, inlineGlobs)) {
			overflow.push(tool);
			continue;
		}
		const descriptionCap = state.builtInNames.has(tool.name) ? undefined : XDEV_EXTERNAL_DESCRIPTION_CAP;
		const docs = renderDocs(tool, "##", descriptionCap);
		if (docs.length > XDEV_DOCS_PER_DEVICE_CAP || used + docs.length > XDEV_DOCS_TOTAL_BUDGET) {
			overflow.push(tool);
			continue;
		}
		used += docs.length;
		sections.push(docs);
	}
	if (overflow.length > 0) {
		sections.push(
			[
				"## Additional devices (docs on demand)",
				...overflow.map(tool => {
					const maxBytes = state.builtInNames.has(tool.name) ? undefined : XDEV_EXTERNAL_DESCRIPTION_CAP;
					return `- ${XD_URL_PREFIX}${tool.name} — ${promptCatalogSummary(tool, maxBytes)}`;
				}),
				"",
				`Read ${XD_URL_PREFIX}<tool> for full docs + JSON schema before first use.`,
			].join("\n"),
		);
	}
	return sections.join("\n\n");
}

/** Docs for selected mounted devices under the configured prompt-doc policy. */
export function xdevDocsFor(
	state: XdevState,
	names: Iterable<string>,
	mode: XdevDocsMode,
	inlinePatterns: readonly string[] = [],
): string {
	const sections: string[] = [];
	const inlineGlobs = compileInlineGlobs(inlinePatterns);
	let used = 0;
	for (const name of names) {
		const tool = resolveMountedXdevTool(state, name);
		if (!tool || !shouldInlineXdevTool(state, tool, mode, inlineGlobs)) continue;
		const descriptionCap = state.builtInNames.has(tool.name) ? undefined : XDEV_EXTERNAL_DESCRIPTION_CAP;
		const docs = renderDocs(tool, "##", descriptionCap);
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
			`No such tool: ${XD_URL_PREFIX}${name}. Mounted devices: ${[...state.mountedNames].join(", ")}. Active top-level tools are also dispatchable via ${XD_URL_PREFIX}<tool>.`,
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

		if (HELP_CONTENT_RE.test(content)) {
			return {
				result: { content: [{ type: "text", text: renderDocs(canonical) }] },
				xdev: { tool: name, mode: "help" },
			};
		}

		const validated = parseDeviceArgs(canonical, content, toolCallId, () => renderDocs(canonical));
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
