import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { sanitizeDisplayField, sanitizeDisplayText } from "./display-text";
import { type Extension } from "./types";

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

export interface CommandPreview {
	description?: string;
	body: string;
	argumentHint?: string;
	usesArguments: boolean;
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

export interface ExtensionInspectorSource {
	readToolHeader?(filePath: string): string | undefined;
	/** Optional application parser for raw frontmatter; otherwise fields must already be normalized. */
	parseRule?(raw: Record<string, unknown>): {
		condition?: string[];
		astCondition?: string[];
		scope?: string[];
		agents?: string[];
	};
}

function optionalTrimmedString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** Display fields already parsed from command frontmatter. */
export function slashCommandFrontmatterDisplay(frontmatter: Record<string, unknown>): {
	description?: string;
	argumentHint?: string;
} {
	return {
		description: optionalTrimmedString(frontmatter.description),
		argumentHint: optionalTrimmedString(
			frontmatter.argumentHint ?? ("argument-hint" in frontmatter ? frontmatter["argument-hint"] : undefined),
		),
	};
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
