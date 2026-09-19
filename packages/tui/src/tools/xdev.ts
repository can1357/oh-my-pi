import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import { parseStreamingJson } from "@oh-my-pi/pi-utils";
import { type Component, Container, Text } from "../index";
import type { Theme } from "../theme/theme";
import { replaceTabs } from "../render/render-utils";
import type { RenderResultOptions, ToolActivitySummary, ToolRenderer } from "./renderer";
import { renderDefaultToolExecution } from "./default-renderer";
import { parseMCPToolName } from "./mcp";

/** Mounted device display callbacks, independent of tool execution state. */
export interface XdevMountedRenderer {
	label?: string;
	renderCall?(...args: Parameters<ToolRenderer["renderCall"]>): unknown;
	renderResult?(...args: Parameters<ToolRenderer["renderResult"]>): unknown;
	mergeCallAndResult?: boolean;
}

/** Mounted tool presentation state supplied by the host's canonical tool map. */
export interface XdevMountedState {
	readonly mountedNames: ReadonlySet<string>;
	readonly tools: ReadonlyMap<string, XdevMountedRenderer>;
}

function isComponent(value: unknown): value is Component {
	return typeof value === "object" && value !== null && "render" in value && typeof value.render === "function";
}

/** Result metadata consumed by delegated device rendering. */
export interface XdevRenderDispatch {
	tool: string;
	mode: "help" | "execute";
	args?: Record<string, unknown>;
	tier?: ToolTier;
	inner?: unknown;
}

let rendererLookup: ((name: string) => ToolRenderer | undefined) | undefined;

/** Wire the wrapped-renderer lookup. Called once by `renderers.ts`. */
export function setXdevRendererLookup(lookup: (name: string) => ToolRenderer | undefined): void {
	rendererLookup = lookup;
}

/** Decode the (possibly partially streamed) inner args JSON string into display args. */
function decodeInnerArgs(raw: unknown): Record<string, unknown> {
	if (typeof raw !== "string" || raw.length === 0) return {};
	const parsed = parseStreamingJson<Record<string, unknown>>(raw);
	const args: Record<string, unknown> = parsed && typeof parsed === "object" ? { ...parsed } : {};
	args.__partialJson = raw;
	return args;
}

/** Renderer for a mounted device: the live mounted tool's own render callbacks
 *  (custom/MCP/image tools carry them) first, then the static built-in renderer
 *  map keyed by name. */
function resolveDeviceRenderer(
	name: string,
	mounted: XdevMountedRenderer | undefined,
): XdevMountedRenderer | undefined {
	if (mounted && (mounted.renderCall || mounted.renderResult)) {
		return mounted;
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
	resolveMounted?: (name: string) => XdevMountedRenderer | undefined,
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
	resolveMounted?: (name: string) => XdevMountedRenderer | undefined,
): Component | undefined {
	const mounted = resolveMounted?.(name);
	const args = decodeInnerArgs(content);
	if (!options.executionStarted) {
		return renderQueuedXdevCall(displayDeviceLabel(name, mounted), args, options, theme);
	}
	const renderer = resolveDeviceRenderer(name, mounted);
	if (renderer?.renderCall) {
		const rendered = renderer.renderCall(args, options, theme);
		return isComponent(rendered) ? rendered : undefined;
	}
	return renderDefaultToolExecution({ label: mounted?.label ?? name, args, options }, theme);
}

/** Forward an `xd://` dispatch result to the mounted tool's renderer. */
export function renderXdevResult(
	dispatch: XdevRenderDispatch,
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	options: RenderResultOptions,
	theme: Theme,
	resolveMounted?: (name: string) => XdevMountedRenderer | undefined,
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
			if (isComponent(call)) parts.push(call);
		}
		const rendered = renderer.renderResult(innerResult, options, theme, dispatch.args ?? {});
		if (isComponent(rendered)) parts.push(rendered);
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
