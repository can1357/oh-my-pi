/**
 * Auto-generated file detection guard.
 *
 * Prevents editing of files that appear to be automatically generated
 * by code generation tools (protoc, sqlc, buf, swagger, etc.).
 */
import * as path from "node:path";
import { isEnoent, peekFile } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { settings as globalSettings, isSettingsInitialized, type Settings } from "../config/settings";
import { getDefault } from "../config/settings-schema";
import { ToolError } from "./tool-errors";

/**
 * Number of bytes to read from the start of a file for auto-generated detection.
 */
const CHECK_BYTE_COUNT = 1024;
const HEADER_LINE_LIMIT = 40;

const KNOWN_GENERATOR_PATTERN =
	"(?:protoc(?:-gen-[\\w-]+)?|sqlc|buf|swagger(?:-codegen)?|openapi(?:-generator)?|grpc-gateway|mockery|stringer|easyjson|deepcopy-gen|defaulter-gen|conversion-gen|client-gen|lister-gen|informer-gen|kysely-codegen|napi-rs)";

/**
 * Strong marker patterns for generated-file headers.
 *
 * Keep these strict: broad patterns like /auto-generated/ cause false positives
 * in normal hand-written files (including this guard implementation itself).
 */
const AUTO_GENERATED_HEADER_MARKERS: readonly RegExp[] = [
	/@generated\b/i,
	/\bcode\s+generated\s+by\s+[a-z0-9_.-]+/i,
	/\bthis\s+file\s+was\s+automatically\s+generated\b/i,
	new RegExp(`\\bgenerated\\s+by\\s+${KNOWN_GENERATOR_PATTERN}\\b`, "i"),
];

type CommentStyle = "slash" | "hash" | "sql" | "html";

const COMMENT_STYLES_BY_EXTENSION = new Map<string, readonly CommentStyle[]>([
	[".c", ["slash"]],
	[".cc", ["slash"]],
	[".cpp", ["slash"]],
	[".cs", ["slash"]],
	[".dart", ["slash"]],
	[".go", ["slash"]],
	[".h", ["slash"]],
	[".hpp", ["slash"]],
	[".java", ["slash"]],
	[".js", ["slash"]],
	[".jsx", ["slash"]],
	[".kt", ["slash"]],
	[".kts", ["slash"]],
	[".mjs", ["slash"]],
	[".cjs", ["slash"]],
	[".php", ["slash"]],
	[".rs", ["slash"]],
	[".scala", ["slash"]],
	[".swift", ["slash"]],
	[".ts", ["slash"]],
	[".tsx", ["slash"]],
	[".py", ["hash"]],
	[".rb", ["hash"]],
	[".sh", ["hash"]],
	[".bash", ["hash"]],
	[".zsh", ["hash"]],
	[".yml", ["hash"]],
	[".yaml", ["hash"]],
	[".toml", ["hash"]],
	[".ini", ["hash"]],
	[".cfg", ["hash"]],
	[".conf", ["hash"]],
	[".env", ["hash"]],
	[".pl", ["hash"]],
	[".r", ["hash"]],
	[".sql", ["sql"]],
	[".html", ["html"]],
	[".htm", ["html"]],
	[".xml", ["html"]],
	[".svg", ["html"]],
	[".xhtml", ["html"]],
]);

const COMMENT_STYLES_BY_BASENAME = new Map<string, readonly CommentStyle[]>([
	["dockerfile", ["hash"]],
	["makefile", ["hash"]],
	["justfile", ["hash"]],
]);

/**
 * File name patterns that strongly indicate auto-generated files.
 * These are checked against the file name (not content).
 */
const AUTO_GENERATED_FILENAME_PATTERNS = [
	/^zz_generated\./,
	/\.pb\.(go|cc|h|c|js|ts)$/,
	/_pb2\.py$/,
	/_pb2_grpc\.py$/,
	/\.gen\.(go|ts|js|py)$/,
	/^generated\.(go|ts|js|py)$/,
	/\.swagger\.json$/,
	/\.openapi\.json$/,
	/\.mock\.(go|ts)$/,
	/\.mocks?\.(go|ts|js)$/,
];

function stripBom(content: string): string {
	if (content.charCodeAt(0) === 0xfeff) {
		return content.slice(1);
	}
	return content;
}

function getCommentStylesForPath(filePath: string): readonly CommentStyle[] {
	const normalizedPath = filePath.toLowerCase();
	const fileName = path.basename(normalizedPath);
	const stylesByName = COMMENT_STYLES_BY_BASENAME.get(fileName);
	if (stylesByName) return stylesByName;

	const ext = path.extname(fileName);
	const stylesByExt = COMMENT_STYLES_BY_EXTENSION.get(ext);
	return stylesByExt ?? [];
}

function extractLeadingHeaderCommentText(content: string, commentStyles: readonly CommentStyle[]): string {
	if (commentStyles.length === 0) return "";

	const includeSlash = commentStyles.includes("slash");
	const includeHash = commentStyles.includes("hash");
	const includeSql = commentStyles.includes("sql");
	const includeHtml = commentStyles.includes("html");

	const lines = stripBom(content).split(/\r?\n/);
	const headerLines: string[] = [];
	let started = false;
	let inSlashBlock = false;
	let inHtmlBlock = false;

	for (let lineIndex = 0; lineIndex < lines.length && lineIndex < HEADER_LINE_LIMIT; lineIndex += 1) {
		const trimmed = lines[lineIndex]?.trim() ?? "";
		if (lineIndex === 0 && trimmed.startsWith("#!")) {
			continue;
		}

		if (inSlashBlock) {
			headerLines.push(trimmed);
			if (trimmed.includes("*/")) inSlashBlock = false;
			continue;
		}

		if (inHtmlBlock) {
			headerLines.push(trimmed);
			if (trimmed.includes("-->")) inHtmlBlock = false;
			continue;
		}

		if (trimmed.length === 0) {
			if (started) headerLines.push("");
			continue;
		}

		if (includeSlash && trimmed.startsWith("//")) {
			started = true;
			headerLines.push(trimmed);
			continue;
		}

		if (includeSlash && trimmed.startsWith("/*")) {
			started = true;
			headerLines.push(trimmed);
			if (!trimmed.includes("*/")) {
				inSlashBlock = true;
			}
			continue;
		}

		if (includeHash && trimmed.startsWith("#")) {
			started = true;
			headerLines.push(trimmed);
			continue;
		}

		if (includeSql && trimmed.startsWith("--")) {
			started = true;
			headerLines.push(trimmed);
			continue;
		}

		if (includeHtml && trimmed.startsWith("<!--")) {
			started = true;
			headerLines.push(trimmed);
			if (!trimmed.includes("-->")) {
				inHtmlBlock = true;
			}
			continue;
		}

		if (started) break;
		break;
	}

	return headerLines.join("\n");
}

/**
 * Check if a file name indicates it might be auto-generated.
 * This is a quick pre-check before reading file content.
 */
function isAutoGeneratedFileName(filePath: string): boolean {
	const fileName = filePath.split("/").pop() ?? "";
	return AUTO_GENERATED_FILENAME_PATTERNS.some(pattern => pattern.test(fileName));
}

/**
 * Check if leading header comments contain auto-generated markers.
 * Returns the matched marker text if found, undefined otherwise.
 */
function detectAutoGeneratedMarker(content: string, filePath: string): string | undefined {
	const commentStyles = getCommentStylesForPath(filePath);
	const headerCommentText = extractLeadingHeaderCommentText(content, commentStyles);
	if (!headerCommentText) return undefined;

	for (const markerPattern of AUTO_GENERATED_HEADER_MARKERS) {
		const match = markerPattern.exec(headerCommentText);
		if (match?.[0]) return match[0];
	}

	return undefined;
}

/**
 * Build the error message for an auto-generated file.
 */
function buildAutoGeneratedError(displayPath: string, detected: string): ToolError {
	return new ToolError(
		`Cannot modify auto-generated file: ${displayPath}\n\n` +
			`This file appears to be automatically generated (detected marker: "${detected}").\n` +
			`Auto-generated files should not be edited directly. Instead:\n` +
			`1. Find the source file or generator configuration\n` +
			`2. Make changes to the source\n` +
			`3. Regenerate the file`,
	);
}

const decoder = new TextDecoder("utf-8");

const autoGeneratedMap = new LRUCache<string, { mtimeMs: number; size: number; marker: string | undefined }>({
	max: 10,
});

async function getAutoGeneratedMarker(filePath: string): Promise<string | undefined> {
	if (isAutoGeneratedFileName(filePath)) {
		return filePath.split("/").pop() ?? "";
	}

	// Key the cache on (mtime, size) so a file rewritten after the first
	// check (generator added/removed) is re-scanned instead of served stale.
	let mtimeMs: number;
	let size: number;
	try {
		const stat = await Bun.file(filePath).stat();
		mtimeMs = stat.mtimeMs;
		size = stat.size;
	} catch (err) {
		if (isEnoent(err)) {
			return undefined;
		}
		throw err;
	}

	const cached = autoGeneratedMap.get(filePath);
	if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.marker;

	let marker: string | undefined;
	try {
		const content = await peekFile(filePath, CHECK_BYTE_COUNT, header => decoder.decode(header));
		marker = detectAutoGeneratedMarker(content, filePath);
	} catch (err) {
		if (isEnoent(err)) {
			return undefined;
		}
		throw err;
	}

	autoGeneratedMap.set(filePath, { mtimeMs, size, marker });
	return marker;
}

function shouldBlockAutoGeneratedFiles(activeSettings?: Settings): boolean {
	if (activeSettings) return activeSettings.get("edit.blockAutoGenerated");
	if (isSettingsInitialized()) return globalSettings.get("edit.blockAutoGenerated");
	return getDefault("edit.blockAutoGenerated");
}

/**
 * Check if a file is auto-generated by examining its content.
 * Throws ToolError if the file appears to be auto-generated.
 *
 * @param absolutePath - Absolute path to the file
 * @param displayPath - Path to show in error messages (relative or as provided)
 * @param activeSettings - Session settings; falls back to global settings or the schema default
 */
export async function assertEditableFile(
	absolutePath: string,
	displayPath?: string,
	activeSettings?: Settings,
): Promise<void> {
	if (!shouldBlockAutoGeneratedFiles(activeSettings)) {
		return;
	}
	const pathForDisplay = displayPath ?? absolutePath;
	const marker = await getAutoGeneratedMarker(absolutePath);
	if (marker) {
		throw buildAutoGeneratedError(pathForDisplay, marker);
	}
}

/**
 * Check if file content is auto-generated.
 * Uses only the first CHECK_BYTE_COUNT characters of the content.
 * Throws ToolError if the content appears to be auto-generated.
 *
 * @param content - File content to check (can be full content or prefix)
 * @param displayPath - Path to show in error messages
 * @param activeSettings - Session settings; falls back to global settings or the schema default
 */
export function assertEditableFileContent(content: string, displayPath: string, activeSettings?: Settings): void {
	if (!shouldBlockAutoGeneratedFiles(activeSettings)) {
		return;
	}

	const prefix = content.slice(0, CHECK_BYTE_COUNT);
	const marker = detectAutoGeneratedMarker(prefix, displayPath);
	if (marker) {
		throw buildAutoGeneratedError(displayPath, marker);
	}
}
