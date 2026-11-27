/**
 * What the extension control center shows of the inventory: provider tabs,
 * kind groups, row hints (MCP health, live tool facts, trigger), and each
 * kind's inspector facts. Pure functions of the inventory and the live
 * sources (MCP manager, session tools).
 */
import * as path from "node:path";
import { arkToWireSchema, isArkSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { normalizePathForComparison } from "@oh-my-pi/pi-utils";
import {
	sanitizeDisplayField,
	sanitizeDisplayLine,
	sanitizeDisplayLineField,
	sanitizeDisplayText,
} from "../../../extensibility/inventory/display-text";
import {
	commandPreview,
	type ExtensionInspectorSource,
	type LiveToolRecord,
} from "../../../extensibility/inventory/inspector-model";
import type {
	MCPConnectionHealth,
	MCPRuntimeCatalogItem,
	MCPRuntimeSnapshot,
	MCPServerDisplay,
} from "../../../extensibility/inventory/mcp-runtime";
import {
	type DisabledReason,
	type Extension,
	type ExtensionKind,
	type ExtensionProvider,
	type ExtensionState,
	isShadowedExtension,
} from "../../../extensibility/inventory/types";

export type { ExtensionInspectorSource, LiveToolRecord };

/** The session's live tools, joined with discovered tool files. */
export interface ToolRuntimeSource {
	getLiveTool(name: string): LiveToolRecord | undefined;
	listLiveTools?(): LiveToolRecord[];
}

/** Lines of prose/content shown before an expand. */
export const PREVIEW_LINES = 12;
/** Catalog entries (MCP tools, resources) shown before an expand. */
export const CATALOG_ITEMS = 8;
/** Patterns of a rule condition list shown before an expand. */
export const LIST_ITEMS = 3;
/** Arguments shown inline per catalog tool before an expand. */
export const INLINE_ARGS = 3;
/** Description lines shown before an expand. */
export const DESCRIPTION_LINES = 3;

// ─── Kinds ──────────────────────────────────────────────────────────────────

export const KIND_ORDER: readonly ExtensionKind[] = [
	"extension-module",
	"skill",
	"tool",
	"slash-command",
	"rule",
	"mcp",
	"hook",
	"prompt",
	"context-file",
	"instruction",
];

const KIND_LABELS: Record<ExtensionKind, string> = {
	"extension-module": "Extension Modules",
	skill: "Skills",
	tool: "Tools",
	"slash-command": "Commands",
	rule: "Rules",
	mcp: "MCP Servers",
	hook: "Hooks",
	prompt: "Prompts",
	"context-file": "Context",
	instruction: "Instructions",
};

const KIND_ICONS: Record<ExtensionKind, string> = {
	"extension-module": "icon.extensionTool",
	skill: "icon.extensionSkill",
	tool: "icon.extensionTool",
	"slash-command": "icon.extensionSlashCommand",
	rule: "icon.extensionRule",
	mcp: "icon.extensionMcp",
	hook: "icon.extensionHook",
	prompt: "icon.extensionPrompt",
	"context-file": "icon.extensionContextFile",
	instruction: "icon.extensionInstruction",
};

export function kindLabel(kind: ExtensionKind): string {
	return KIND_LABELS[kind] ?? kind;
}

/** The symbol key of a kind's icon. */
export function kindIcon(kind: ExtensionKind): string {
	return KIND_ICONS[kind] ?? "format.bullet";
}

// ─── Provider tabs and dashboard state ──────────────────────────────────────

export interface ProviderTab {
	readonly id: string;
	readonly label: string;
	readonly enabled: boolean;
	readonly count: number;
}

/** ALL, then providers: enabled with items by count, disabled by count, empty enabled ones last. */
export function providerTabs(extensions: readonly Extension[], providers: readonly ExtensionProvider[]): ProviderTab[] {
	const counts = new Map<string, number>();
	for (const ext of extensions) counts.set(ext.source.provider, (counts.get(ext.source.provider) ?? 0) + 1);
	const category = (tab: ProviderTab) => (tab.count === 0 && tab.enabled ? 2 : tab.enabled ? 0 : 1);
	const tabs = providers
		.filter(provider => provider.id !== "native")
		.map(provider => ({
			id: provider.id,
			label: provider.displayName,
			enabled: provider.enabled,
			count: counts.get(provider.id) ?? 0,
		}))
		.sort((a, b) => category(a) - category(b) || b.count - a.count);
	return [{ id: "all", label: "ALL", enabled: true, count: extensions.length }, ...tabs];
}

export function filterByProvider(extensions: Extension[], providerId: string): Extension[] {
	return providerId === "all" ? extensions : extensions.filter(ext => ext.source.provider === providerId);
}

/** An item's state from its source: disabled by the user, shadowed, or provider off. */
export function resolveExtensionState(
	source: { provider: string },
	disabled: boolean,
	shadowed: boolean,
	providers: readonly ExtensionProvider[],
): { state: ExtensionState; disabledReason?: DisabledReason } {
	if (disabled) return { state: "disabled", disabledReason: "item-disabled" };
	if (shadowed) return { state: "shadowed", disabledReason: "shadowed" };
	const provider = providers.find(entry => entry.id === source.provider);
	if (provider?.enabled === false) return { state: "disabled", disabledReason: "provider-disabled" };
	return { state: "active" };
}

/** `ext` with the user's disable list applied (immediate feedback before a refresh). */
export function withDisabledIds(
	ext: Extension,
	disabled: ReadonlySet<string>,
	providers: readonly ExtensionProvider[],
): Extension {
	if (disabled.has(ext.id)) {
		if (ext.state === "disabled" && ext.disabledReason === "item-disabled") return ext;
		return { ...ext, state: "disabled", disabledReason: "item-disabled" };
	}
	if (ext.state !== "disabled" || ext.disabledReason !== "item-disabled") return ext;
	const resolved = resolveExtensionState(ext.source, false, isShadowedExtension(ext), providers);
	const next: Extension = { ...ext, state: resolved.state };
	if (resolved.disabledReason) next.disabledReason = resolved.disabledReason;
	else delete next.disabledReason;
	return next;
}

// ─── Live sources ───────────────────────────────────────────────────────────

/** One listing of the live tools for a draw (the session is asked once). */
export function snapshotTools(source: ToolRuntimeSource | undefined): ToolRuntimeSource | undefined {
	if (!source?.listLiveTools) return source;
	const listed = source.listLiveTools();
	const byName = new Map(listed.map(entry => [entry.name, entry]));
	return { getLiveTool: name => byName.get(name), listLiveTools: () => listed };
}

export function isDiscoveredMcpServer(raw: unknown): raw is MCPServerDisplay {
	return (
		!!raw &&
		typeof raw === "object" &&
		"name" in raw &&
		typeof raw.name === "string" &&
		"_source" in raw &&
		raw._source !== undefined
	);
}

function isFilesystemPath(value: string): boolean {
	return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

/** The live tools a discovered tool file registered (a factory may register several). */
export function liveToolsFor(ext: Extension, source: ToolRuntimeSource | undefined): LiveToolRecord[] {
	if (!source || isShadowedExtension(ext)) return [];
	const listed = source.listLiveTools?.();
	const exact =
		listed?.find(tool => tool.name === ext.name) ??
		(listed === undefined || listed.length === 0 ? source.getLiveTool(ext.name) : undefined);
	const seen = new Set<string>();
	const candidates: LiveToolRecord[] = [];
	for (const tool of exact ? [exact, ...(listed ?? [])] : (listed ?? [])) {
		if (seen.has(tool.name)) continue;
		seen.add(tool.name);
		candidates.push(tool);
	}
	const fromFile = candidates.filter(
		tool =>
			tool.sourcePath &&
			isFilesystemPath(tool.sourcePath) &&
			normalizePathForComparison(tool.sourcePath) === normalizePathForComparison(ext.path),
	);
	if (fromFile.length > 0) return fromFile;
	if (candidates.some(tool => tool.sourcePath && isFilesystemPath(tool.sourcePath))) return [];
	return exact && exact.source !== "builtin" && exact.source !== "mcp" && exact.source !== "sdk" ? [exact] : [];
}

// ─── Row hints ──────────────────────────────────────────────────────────────

function pathParts(filePath: string): string[] {
	const windows = filePath.includes("\\") || /^[A-Za-z]:/.test(filePath);
	const flavor = windows ? path.win32 : path.posix;
	return (windows ? filePath.replaceAll("/", flavor.sep) : filePath)
		.split(flavor.sep)
		.filter(part => part.length > 0 && part !== ".");
}

/** For project items: the directory holding their `.omp`. */
function projectHint(ext: Extension): string | undefined {
	if (ext.source.level !== "project") return undefined;
	const parts = pathParts(ext.path);
	const omp = parts.lastIndexOf(".omp");
	const parent = omp > 0 ? parts[omp - 1] : undefined;
	return parent && parent !== "." ? parent : undefined;
}

function joinHints(...parts: (string | undefined)[]): string | undefined {
	const hints = parts.filter((part): part is string => !!part);
	return hints.length > 0 ? hints.join(" · ") : undefined;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function mcpListHint(snapshot: MCPRuntimeSnapshot): string {
	switch (snapshot.health) {
		case "inactive":
			return "inactive";
		case "connecting":
			return "connecting…";
		case "disconnected":
			return "unavailable";
		case "connected": {
			const parts = [plural(snapshot.tools.length, "tool")];
			if (snapshot.resources.length > 0) parts.push(plural(snapshot.resources.length, "resource"));
			if (snapshot.prompts.length > 0) parts.push(plural(snapshot.prompts.length, "prompt"));
			return parts.join(" · ");
		}
	}
}

/** A row's trailing hint: MCP health, live tool facts, the trigger, and the project. */
export function rowHint(
	ext: Extension,
	mcp: MCPRuntimeSnapshot | undefined,
	tools: ToolRuntimeSource | undefined,
): string | undefined {
	if (mcp) return joinHints(mcpListHint(mcp), projectHint(ext));
	let detail: string | undefined;
	switch (ext.kind) {
		case "tool": {
			const lives = liveToolsFor(ext, tools);
			if (lives.length > 1) {
				detail = plural(lives.length, "tool");
				if (lives.every(tool => tool.hidden)) detail = `hidden · ${detail}`;
			} else if (lives[0]?.hidden) detail = "hidden";
			break;
		}
		case "skill":
			detail = skillData(ext).hidden ? "hidden" : undefined;
			break;
		case "slash-command":
			detail = ext.trigger ?? `/${ext.name}`;
			break;
		case "context-file":
			break;
		default:
			detail = ext.trigger;
	}
	return joinHints(detail, projectHint(ext));
}

export function mcpHealthLabel(health: MCPConnectionHealth): string {
	return { connected: "Connected", connecting: "Connecting", disconnected: "Not connected", inactive: "Inactive" }[
		health
	];
}

/** The first `limit` catalog entries, and how many are left out. */
export function catalogWindow(
	entries: MCPRuntimeCatalogItem[],
	limit: number,
): { shown: MCPRuntimeCatalogItem[]; hidden: number } {
	return entries.length <= limit
		? { shown: entries, hidden: 0 }
		: { shown: entries.slice(0, limit), hidden: entries.length - limit };
}

// ─── Inspector facts ────────────────────────────────────────────────────────

export interface ToolParam {
	readonly name: string;
	readonly type: string;
	readonly required: boolean;
	/** `Required`, `Default: …` or `Optional`. */
	readonly flag: string;
	readonly description?: string;
}

function record(raw: unknown): Record<string, unknown> | null {
	return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

function field(raw: Record<string, unknown>, key: string): string | undefined {
	const value = raw[key];
	return typeof value === "string" && value.length > 0 ? sanitizeDisplayField(value) : undefined;
}

function strings(value: unknown): string[] | undefined {
	if (typeof value === "string") {
		const token = sanitizeDisplayField(value.trim());
		return token ? [token] : undefined;
	}
	if (!Array.isArray(value)) return undefined;
	const items = value
		.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
		.map(entry => sanitizeDisplayText(entry))
		.filter(entry => entry.length > 0);
	return items.length > 0 ? items : undefined;
}

function jsonSchema(schema: unknown): Record<string, unknown> | undefined {
	if (!schema) return undefined;
	try {
		if (isArkSchema(schema)) return arkToWireSchema(schema);
	} catch {
		// A schema that cannot convert is read as plain JSON below.
	}
	if (typeof schema === "object" && schema !== null && "toJsonSchema" in schema) {
		const convert = schema.toJsonSchema;
		if (typeof convert === "function") {
			try {
				const json: unknown = convert.call(schema);
				if (json && typeof json === "object") return json as Record<string, unknown>;
			} catch {
				// Fall back to the object itself.
			}
		}
	}
	return typeof schema === "object" && schema !== null ? (schema as Record<string, unknown>) : undefined;
}

/** A tool's arguments from its JSON schema. */
export function toolParams(schema: unknown): ToolParam[] {
	const wire = jsonSchema(schema);
	const properties = wire?.properties;
	if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
	const required = new Set(Array.isArray(wire?.required) ? wire.required.filter(v => typeof v === "string") : []);
	const params: ToolParam[] = [];
	const specs = properties as Record<string, unknown>;
	for (const name in specs) {
		const entry = record(specs[name]) ?? {};
		const isRequired = required.has(name);
		const type =
			typeof entry.type === "string" && entry.type.length > 0
				? sanitizeDisplayLine(entry.type)
				: Array.isArray(entry.enum) && entry.enum.length > 0
					? "enum"
					: entry.anyOf || entry.oneOf
						? "union"
						: "any";
		params.push({
			name: sanitizeDisplayLine(name),
			type,
			required: isRequired,
			flag: isRequired
				? "Required"
				: entry.default !== undefined
					? `Default: ${sanitizeDisplayLine(String(entry.default))}`
					: "Optional",
			description: typeof entry.description === "string" ? sanitizeDisplayField(entry.description) : undefined,
		});
	}
	return params;
}

function placeholderDescription(name: string, description: string | undefined): boolean {
	return !description || description.trim().length === 0 || description === `${name} custom tool`;
}

export function toolData(
	ext: Extension,
	lives: LiveToolRecord[],
	source?: ExtensionInspectorSource,
): { label?: string; description?: string; params: ToolParam[]; factory: LiveToolRecord[] } {
	const raw = record(ext.raw);
	const discovered = raw ? field(raw, "description") : ext.description;
	if (lives.length > 1) {
		const description = placeholderDescription(ext.name, discovered)
			? source?.readToolHeader?.(ext.path)
			: discovered;
		return {
			description: sanitizeDisplayField(description),
			params: [],
			factory: lives.map(live => ({
				...live,
				name: sanitizeDisplayLine(live.name),
				label: sanitizeDisplayLineField(live.label),
				description: sanitizeDisplayField(live.description),
			})),
		};
	}
	const live = lives[0];
	const description =
		live?.description && (placeholderDescription(ext.name, discovered) || !discovered)
			? live.description
			: (discovered ?? live?.description ?? source?.readToolHeader?.(ext.path));
	return {
		label: live?.label && live.label !== ext.displayName ? sanitizeDisplayField(live.label) : undefined,
		description: sanitizeDisplayField(description),
		params: toolParams(live?.parameters ?? raw?.parameters ?? raw?.inputSchema),
		factory: lives,
	};
}

export function ruleData(
	ext: Extension,
	source?: ExtensionInspectorSource,
): {
	description?: string;
	alwaysApply: boolean;
	globs?: string[];
	condition?: string[];
	astCondition?: string[];
	scope?: string[];
	agents?: string[];
	interruptMode?: string;
	content: string;
} {
	const raw = record(ext.raw) ?? {};
	const parsed = source?.parseRule?.(raw) ?? raw;
	return {
		description: field(raw, "description") ?? sanitizeDisplayField(ext.description),
		alwaysApply: raw.alwaysApply === true,
		globs: strings(raw.globs),
		condition: strings(parsed.condition),
		astCondition: strings(parsed.astCondition),
		scope: strings(parsed.scope),
		agents: strings(parsed.agents),
		interruptMode: field(raw, "interruptMode"),
		content: field(raw, "content") ?? "",
	};
}

export function skillData(ext: Extension): {
	description?: string;
	content: string;
	globs?: string[];
	alwaysApply: boolean;
	hidden: boolean;
} {
	const raw = record(ext.raw) ?? {};
	const frontmatter = record(raw.frontmatter) ?? {};
	return {
		description: field(frontmatter, "description") ?? sanitizeDisplayField(ext.description),
		content: field(raw, "content") ?? "",
		globs: strings(frontmatter.globs) ?? strings(raw.globs),
		alwaysApply: frontmatter.alwaysApply === true,
		hidden: frontmatter.hide === true || frontmatter.disableModelInvocation === true,
	};
}

export function commandData(ext: Extension): {
	description?: string;
	body: string;
	argumentHint?: string;
	usesArguments: boolean;
} {
	const raw = record(ext.raw) ?? {};
	const preview = commandPreview(typeof raw.content === "string" ? raw.content : undefined);
	return {
		...preview,
		description: field(raw, "description") ?? preview.description ?? sanitizeDisplayField(ext.description),
		argumentHint: field(raw, "argumentHint") ?? field(raw, "argument-hint") ?? preview.argumentHint,
	};
}

export function hookData(ext: Extension): { hookType?: string; tool?: string } {
	const raw = record(ext.raw) ?? {};
	return { hookType: field(raw, "type"), tool: field(raw, "tool") };
}

/** A prompt, context file or instruction's text (and an instruction's `applyTo`). */
export function contentData(ext: Extension): { content: string; applyTo?: string } {
	const raw = record(ext.raw) ?? {};
	return { content: field(raw, "content") ?? "", applyTo: field(raw, "applyTo") };
}

/** `Active`, `Disabled (why)`, `Shadowed by …`. */
export function enablementLabel(state: ExtensionState, reason?: string, shadowedBy?: string): string {
	switch (state) {
		case "active":
			return "Active";
		case "disabled":
			return `Disabled (${
				reason === "provider-disabled"
					? "provider disabled"
					: reason === "item-disabled"
						? "manually disabled"
						: "unknown"
			})`;
		case "shadowed":
			return `Shadowed${shadowedBy ? ` by ${sanitizeDisplayText(shadowedBy)}` : ""}`;
	}
}

/** The inspector's identity for expand state: kind, id and path. */
export function inspectorKey(ext: Extension | null): string | null {
	return ext ? `${ext.kind}:${ext.id}:${ext.path}` : null;
}
