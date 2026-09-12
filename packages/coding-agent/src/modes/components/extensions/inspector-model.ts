/**
 * Kind-specific view-models for `/extensions`.
 *
 * Discovery `Extension.raw` stays the capability record. Live session tools
 * are joined here at render time — the same seam as {@link snapshotMcpRuntime}.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { arkToWireSchema, isArkSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { normalizePathForComparison, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { parseRuleAgents, parseRuleConditionAndScope } from "../../../capability/rule";
import { slashCommandFrontmatterDisplay } from "../../../capability/slash-command";
import { isFilesystemSourcePath } from "../../../tools/path-utils";
import {
	sanitizeDisplayField,
	sanitizeDisplayLine,
	sanitizeDisplayLineField,
	sanitizeDisplayText,
} from "./display-text";
import { type Extension, type ExtensionState, isShadowedExtension } from "./types";

export interface LiveToolRecord {
	name: string;
	label?: string;
	description?: string;
	parameters?: unknown;
	hidden?: boolean;
	loadMode?: "essential" | "discoverable";
	/** Origin class from session `ToolInfo.sourceInfo.source`. */
	source?: "builtin" | "mcp" | "sdk" | "extension";
	/** Originating module path when the session actually has one. */
	sourcePath?: string;
}

export interface ToolRuntimeSource {
	getLiveTool(name: string): LiveToolRecord | undefined;
	listLiveTools?(): LiveToolRecord[];
}

export interface ToolParamView {
	name: string;
	type: string;
	required: boolean;
	flag: string;
	description?: string;
}

export interface CommandPreview {
	description?: string;
	body: string;
	argumentHint?: string;
	usesArguments: boolean;
}

export function isPlaceholderToolDescription(name: string, description: string | undefined): boolean {
	if (!description || description.trim().length === 0) return true;
	return description === `${name} custom tool`;
}

/** First JSDoc on a custom-tool file, minus symlink footnotes. */
export function parseToolFileHeader(source: string): string | undefined {
	const match = source.match(/^\s*\/\*\*([\s\S]*?)\*\//);
	if (!match) return undefined;
	const body = match[1]
		.split("\n")
		.map(line => line.replace(/^\s*\*\s?/, "").trimEnd())
		.join("\n")
		.trim();
	const paragraphs = body
		.split(/\n\s*\n/)
		.map(paragraph => paragraph.trim())
		.filter(paragraph => paragraph.length > 0 && !/^symlink:/i.test(paragraph));
	return paragraphs.length > 0 ? sanitizeDisplayField(paragraphs.join("\n\n")) : undefined;
}

const TOOL_HEADER_BYTES = 4096;
const toolHeaderCache = new Map<string, { mtimeMs: number; description: string | undefined }>();

export function toolFileHeaderDescription(filePath: string | undefined): string | undefined {
	if (!filePath) return undefined;
	try {
		const stat = fs.statSync(filePath);
		const cached = toolHeaderCache.get(filePath);
		if (cached && cached.mtimeMs === stat.mtimeMs) return cached.description;
		const fd = fs.openSync(filePath, "r");
		try {
			const length = Math.min(TOOL_HEADER_BYTES, stat.size);
			const buf = Buffer.alloc(length);
			const n = fs.readSync(fd, buf, 0, length, 0);
			const description = parseToolFileHeader(buf.toString("utf8", 0, n));
			toolHeaderCache.set(filePath, { mtimeMs: stat.mtimeMs, description });
			return description;
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

export function commandPreview(content: string | undefined): CommandPreview {
	if (typeof content !== "string" || content.length === 0) {
		return { body: "", usesArguments: false };
	}
	const { frontmatter, body } = parseFrontmatter(content, { source: "slash-command" });
	const display = slashCommandFrontmatterDisplay(frontmatter);
	return {
		description: sanitizeDisplayField(display.description),
		body: sanitizeDisplayText(body),
		argumentHint: sanitizeDisplayField(display.argumentHint),
		usesArguments: /\$ARGUMENTS\b/.test(body),
	};
}

function asRecord(raw: unknown): Record<string, unknown> | null {
	return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

function stringField(raw: Record<string, unknown>, key: string): string | undefined {
	const value = raw[key];
	return typeof value === "string" && value.length > 0 ? sanitizeDisplayField(value) : undefined;
}

function stringArray(value: unknown): string[] | undefined {
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

function asJsonSchema(schema: unknown): Record<string, unknown> | undefined {
	if (!schema) return undefined;
	try {
		if (isArkSchema(schema)) return arkToWireSchema(schema);
	} catch {
		// fall through
	}
	if (typeof schema === "object" && schema !== null && "toJsonSchema" in schema) {
		const candidate = schema.toJsonSchema;
		if (typeof candidate === "function") {
			try {
				const json: unknown = candidate.call(schema);
				if (json && typeof json === "object") return json as Record<string, unknown>;
			} catch {
				// fall through
			}
		}
	}
	return typeof schema === "object" && schema !== null ? (schema as Record<string, unknown>) : undefined;
}

function propertiesFromSchema(schema: unknown): Record<string, unknown> | undefined {
	const wire = asJsonSchema(schema);
	if (!wire) return undefined;
	const properties = wire.properties;
	if (!properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;
	return properties as Record<string, unknown>;
}

function requiredFromSchema(schema: unknown): Set<string> {
	const wire = asJsonSchema(schema);
	const required = wire?.required;
	return new Set(
		Array.isArray(required) ? required.filter((value): value is string => typeof value === "string") : [],
	);
}

function paramType(spec: Record<string, unknown>): string {
	if (typeof spec.type === "string" && spec.type.length > 0) return sanitizeDisplayLine(spec.type);
	if (Array.isArray(spec.enum) && spec.enum.length > 0) return "enum";
	if (spec.anyOf || spec.oneOf) return "union";
	return "any";
}

export function toolParamsFromSchema(schema: unknown): ToolParamView[] {
	const properties = propertiesFromSchema(schema);
	if (!properties) return [];
	const required = requiredFromSchema(schema);
	const params: ToolParamView[] = [];
	for (const [name, spec] of Object.entries(properties)) {
		const record = spec && typeof spec === "object" ? (spec as Record<string, unknown>) : {};
		const isRequired = required.has(name);
		const defaultVal =
			record.default !== undefined ? `Default: ${sanitizeDisplayLine(String(record.default))}` : null;
		params.push({
			name: sanitizeDisplayLine(name),
			type: paramType(record),
			required: isRequired,
			flag: isRequired ? "Required" : (defaultVal ?? "Optional"),
			description: typeof record.description === "string" ? sanitizeDisplayField(record.description) : undefined,
		});
	}
	return params;
}

function sameToolPath(left: string, right: string): boolean {
	return normalizePathForComparison(left) === normalizePathForComparison(right);
}

export function liveToolsForExtension(ext: Extension, source: ToolRuntimeSource | undefined): LiveToolRecord[] {
	if (!source || isShadowedExtension(ext)) return [];
	const listed = source.listLiveTools?.();
	const fromList = listed?.find(tool => tool.name === ext.name);
	const exact = fromList ?? (listed === undefined || listed.length === 0 ? source.getLiveTool(ext.name) : undefined);
	const pool = listed ?? [];
	const candidates: LiveToolRecord[] = [];
	const seen = new Set<string>();
	for (const tool of exact ? [exact, ...pool] : pool) {
		if (seen.has(tool.name)) continue;
		seen.add(tool.name);
		candidates.push(tool);
	}
	const fromSameFile = candidates.filter(
		tool => tool.sourcePath && isFilesystemSourcePath(tool.sourcePath) && sameToolPath(tool.sourcePath, ext.path),
	);
	if (fromSameFile.length > 0) return fromSameFile;
	if (candidates.some(tool => tool.sourcePath && isFilesystemSourcePath(tool.sourcePath))) {
		return [];
	}
	if (
		exact &&
		exact.name === ext.name &&
		exact.source !== "builtin" &&
		exact.source !== "mcp" &&
		exact.source !== "sdk"
	) {
		return [exact];
	}
	return [];
}

export function liveToolDetail(live: LiveToolRecord | undefined): string | undefined {
	if (!live) return undefined;
	if (live.hidden) return "hidden";
	return undefined;
}

function pathSegments(filePath: string): string[] {
	const winish = filePath.includes("\\") || /^[A-Za-z]:/.test(filePath);
	const flavor = winish ? path.win32 : path.posix;
	const normalized = winish ? filePath.replaceAll("/", flavor.sep) : filePath;
	return normalized.split(flavor.sep).filter(part => part.length > 0 && part !== ".");
}

/** Project-local items only. Uses the directory that contains `.omp`, when present. */
export function projectListHint(ext: Extension): string | undefined {
	if (ext.source.level !== "project") return undefined;
	const parts = pathSegments(ext.path);
	const ompIndex = parts.lastIndexOf(".omp");
	if (ompIndex <= 0) return undefined;
	const parent = parts[ompIndex - 1];
	return parent && parent !== "." ? parent : undefined;
}

export function joinListHints(...parts: Array<string | undefined>): string | undefined {
	const hints = parts.filter((part): part is string => typeof part === "string" && part.length > 0);
	return hints.length > 0 ? hints.join(" · ") : undefined;
}

export function formatExtensionListHint(ext: Extension, lives: LiveToolRecord[] = []): string | undefined {
	let detail: string | undefined;
	switch (ext.kind) {
		case "tool": {
			if (lives.length > 1) {
				detail = `${lives.length} tools`;
				if (lives.every(tool => tool.hidden)) detail = `hidden · ${detail}`;
			} else if (lives[0]?.hidden) {
				detail = "hidden";
			}
			break;
		}
		case "skill":
			detail = skillInspectorData(ext).hidden ? "hidden" : undefined;
			break;
		case "slash-command":
			detail = ext.trigger ?? `/${ext.name}`;
			break;
		case "context-file":
			break;
		default:
			detail = ext.trigger;
	}
	return joinListHints(detail, projectListHint(ext));
}

export function toolInspectorData(
	ext: Extension,
	lives: LiveToolRecord[],
): {
	label?: string;
	description?: string;
	params: ToolParamView[];
	runtimeDetail?: string;
	factory: LiveToolRecord[];
} {
	if (lives.length > 1) {
		const raw = asRecord(ext.raw);
		const discovered = raw ? stringField(raw, "description") : ext.description;
		const description = isPlaceholderToolDescription(ext.name, discovered)
			? toolFileHeaderDescription(ext.path)
			: discovered;
		return {
			description: sanitizeDisplayField(description),
			params: [],
			runtimeDetail: `${lives.length} tools`,
			factory: lives.map(live => ({
				...live,
				name: sanitizeDisplayLine(live.name),
				label: sanitizeDisplayLineField(live.label),
				description: sanitizeDisplayField(live.description),
			})),
		};
	}
	const live = lives[0];
	const raw = asRecord(ext.raw);
	const discovered = raw ? stringField(raw, "description") : ext.description;
	const description =
		live?.description && (isPlaceholderToolDescription(ext.name, discovered) || !discovered)
			? live.description
			: (discovered ?? live?.description ?? toolFileHeaderDescription(ext.path));
	return {
		label: live?.label && live.label !== ext.displayName ? sanitizeDisplayField(live.label) : undefined,
		description: sanitizeDisplayField(description),
		params: toolParamsFromSchema(live?.parameters ?? raw?.parameters ?? raw?.inputSchema),
		runtimeDetail: liveToolDetail(live) ?? ext.trigger,
		factory: lives,
	};
}

export function ruleInspectorData(ext: Extension): {
	description?: string;
	alwaysApply: boolean;
	globs?: string[];
	condition?: string[];
	astCondition?: string[];
	scope?: string[];
	agents?: string[];
	interruptMode?: string;
	content: string;
	runtimeDetail?: string;
} {
	const raw = asRecord(ext.raw) ?? {};
	const alwaysApply = raw.alwaysApply === true;
	const globs = stringArray(raw.globs);
	const parsed = parseRuleConditionAndScope({
		condition: stringArray(raw.condition) ?? stringField(raw, "condition"),
		astCondition: stringArray(raw.astCondition) ?? stringField(raw, "astCondition"),
		scope: stringArray(raw.scope) ?? stringField(raw, "scope"),
	});
	const agents = parseRuleAgents(raw.agents);
	const interruptMode = stringField(raw, "interruptMode");
	const content = stringField(raw, "content") ?? "";
	return {
		description: stringField(raw, "description") ?? sanitizeDisplayField(ext.description),
		alwaysApply,
		globs,
		condition: parsed.condition,
		astCondition: parsed.astCondition,
		scope: parsed.scope,
		agents,
		interruptMode,
		content,
		runtimeDetail: ext.trigger,
	};
}

export function skillInspectorData(ext: Extension): {
	description?: string;
	content: string;
	globs?: string[];
	alwaysApply: boolean;
	hidden: boolean;
	runtimeDetail?: string;
} {
	const raw = asRecord(ext.raw) ?? {};
	const frontmatter = asRecord(raw.frontmatter) ?? {};
	const hidden = frontmatter.hide === true || frontmatter.disableModelInvocation === true;
	const alwaysApply = frontmatter.alwaysApply === true;
	const globs = stringArray(frontmatter.globs) ?? stringArray(raw.globs);
	let runtimeDetail: string | undefined;
	if (hidden) runtimeDetail = "hidden";
	else if (alwaysApply) runtimeDetail = "always";
	else if (globs) runtimeDetail = globs.join(", ");
	return {
		description: stringField(frontmatter, "description") ?? sanitizeDisplayField(ext.description),
		content: stringField(raw, "content") ?? "",
		globs,
		alwaysApply,
		hidden,
		runtimeDetail: runtimeDetail ?? ext.trigger,
	};
}

export function commandInspectorData(ext: Extension): {
	description?: string;
	body: string;
	argumentHint?: string;
	usesArguments: boolean;
	runtimeDetail?: string;
} {
	const raw = asRecord(ext.raw) ?? {};
	const preview = commandPreview(typeof raw.content === "string" ? raw.content : undefined);
	return {
		...preview,
		description: stringField(raw, "description") ?? preview.description ?? sanitizeDisplayField(ext.description),
		argumentHint: stringField(raw, "argumentHint") ?? stringField(raw, "argument-hint") ?? preview.argumentHint,
		runtimeDetail: ext.trigger ?? `/${sanitizeDisplayText(ext.name)}`,
	};
}

export function hookInspectorData(ext: Extension): {
	hookType?: string;
	tool?: string;
	runtimeDetail?: string;
} {
	const raw = asRecord(ext.raw) ?? {};
	const hookType = stringField(raw, "type");
	const tool = stringField(raw, "tool");
	return {
		hookType,
		tool,
		runtimeDetail: ext.trigger ?? (hookType && tool ? `${hookType}:${tool}` : undefined),
	};
}

export function promptInspectorData(ext: Extension): { content: string; runtimeDetail?: string } {
	const raw = asRecord(ext.raw) ?? {};
	return {
		content: stringField(raw, "content") ?? "",
		runtimeDetail: ext.trigger,
	};
}

export function instructionInspectorData(ext: Extension): {
	content: string;
	applyTo?: string;
	runtimeDetail?: string;
} {
	const raw = asRecord(ext.raw) ?? {};
	return {
		content: stringField(raw, "content") ?? "",
		applyTo: stringField(raw, "applyTo"),
		runtimeDetail: ext.trigger,
	};
}

export function contextInspectorData(ext: Extension): { content: string; runtimeDetail?: string } {
	const raw = asRecord(ext.raw) ?? {};
	const content = stringField(raw, "content") ?? "";
	return {
		content,
		runtimeDetail: ext.trigger,
	};
}

export function enablementLabel(state: ExtensionState, reason?: string, shadowedBy?: string): string {
	switch (state) {
		case "active":
			return "Active";
		case "disabled": {
			const reasonText =
				reason === "provider-disabled"
					? "provider disabled"
					: reason === "user-opt-in"
						? "~/ config not enabled"
						: reason === "item-disabled"
							? "manually disabled"
							: "unknown";
			return `Disabled (${reasonText})`;
		}
		case "shadowed":
			return `Shadowed${shadowedBy ? ` by ${sanitizeDisplayText(shadowedBy)}` : ""}`;
	}
}
