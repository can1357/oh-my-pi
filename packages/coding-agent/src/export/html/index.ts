import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentState } from "@oh-my-pi/pi-agent-core";
import { APP_NAME, isEnoent } from "@oh-my-pi/pi-utils";
import { getResolvedThemeColors, getThemeExportColors } from "../../modes/theme/theme";
import type { SessionEntry, SessionHeader } from "../../session/session-entries";
import { loadSessionFile } from "../../session/session-loader";
import { SessionManager } from "../../session/session-manager";
import { isTaskToolDetails } from "../../task/tool-details";
import type { ExportThemeNames } from "./args";
import templateCssPath from "./template.css" with { type: "file" };
import templateHtmlPath from "./template.html" with { type: "file" };
import templateJsPath from "./template.js" with { type: "file" };
// Pre-built React tool renderers: built by `gen:tool-views` (`bun run gen:tool-views`),
// run automatically by root `prepare` on install and by `prepack` at publish.
import toolViewsJsPath from "./tool-views.generated.js" with { type: "file" };
import { webExportThemeVars } from "./web-palette";

export { type ExportThemeNames, parseExportArgs } from "./args";

let cachedTemplate: string | undefined;
/** Resolve a Bun file-loader value without parsing Windows drive letters as URL schemes. */
export function resolveBundledHtmlAssetPath(assetPath: string, moduleDir: string = import.meta.dir): string {
	if (path.isAbsolute(assetPath) || path.win32.isAbsolute(assetPath)) return assetPath;
	return path.resolve(moduleDir, assetPath);
}

/** Compose the standalone export template: minified CSS, tool renderers, and viewer JS inlined. */
export function getTemplate(): string {
	if (cachedTemplate) return cachedTemplate;
	const templateCss = fs.readFileSync(resolveBundledHtmlAssetPath(templateCssPath), "utf8");
	const templateHtml = fs.readFileSync(resolveBundledHtmlAssetPath(templateHtmlPath as unknown as string), "utf8");
	const templateJs = fs.readFileSync(resolveBundledHtmlAssetPath(templateJsPath), "utf8");
	const toolViewsJs = fs.readFileSync(resolveBundledHtmlAssetPath(toolViewsJsPath), "utf8");
	const minifiedCss = templateCss
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\s+/g, " ")
		.replace(/\s*([{}:;,])\s*/g, "$1")
		.trim();
	// Function replacements so `$'`, `$&`, `$$`, etc. inside the embedded
	// CSS/JS are not interpreted as substitution patterns.
	cachedTemplate = templateHtml
		.replace("<template-css/>", () => `<style>${minifiedCss}</style>`)
		.replace("<template-tool-views/>", () => `<script>${toolViewsJs}</script>`)
		.replace("<template-js/>", () => `<script>${templateJs}</script>`);
	return cachedTemplate;
}

export interface ExportOptions {
	outputPath?: string;
	/** `"web"` bundles the omp web themes; `"theme"` bundles TUI themes. */
	palette?: "web" | "theme";
	/** Legacy single TUI theme name. Prefer `themeNames` for dual-theme exports. */
	themeName?: string;
	/** Dark and light TUI themes to bundle when `palette` is `"theme"`. */
	themeNames?: ExportThemeNames;
	/** Embed subagent session transcripts found next to the session file (default true). */
	includeSubSessions?: boolean;
	/** Include archived branches, hidden by default so a shared page never leaks them. */
	includeArchived?: boolean;
}

/** Parse a color string to RGB values. */
function parseColor(color: string): { r: number; g: number; b: number } | undefined {
	const hexMatch = color.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
	if (hexMatch) {
		return {
			r: Number.parseInt(hexMatch[1], 16),
			g: Number.parseInt(hexMatch[2], 16),
			b: Number.parseInt(hexMatch[3], 16),
		};
	}
	const rgbMatch = color.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
	if (rgbMatch) {
		return {
			r: Number.parseInt(rgbMatch[1], 10),
			g: Number.parseInt(rgbMatch[2], 10),
			b: Number.parseInt(rgbMatch[3], 10),
		};
	}
	return undefined;
}

/** Calculate relative luminance of a color (0-1, higher = lighter). */
function getLuminance(r: number, g: number, b: number): number {
	const toLinear = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Adjust color brightness. */
function adjustBrightness(color: string, factor: number): string {
	const parsed = parseColor(color);
	if (!parsed) return color;
	const adjust = (c: number) => Math.min(255, Math.max(0, Math.round(c * factor)));
	return `rgb(${adjust(parsed.r)}, ${adjust(parsed.g)}, ${adjust(parsed.b)})`;
}

/** Derive export background colors from a base color. */
function deriveExportColors(baseColor: string): { pageBg: string; cardBg: string; infoBg: string } {
	const parsed = parseColor(baseColor);
	if (!parsed) {
		return { pageBg: "rgb(24, 24, 30)", cardBg: "rgb(30, 30, 36)", infoBg: "rgb(60, 55, 40)" };
	}

	const luminance = getLuminance(parsed.r, parsed.g, parsed.b);
	if (luminance > 0.5) {
		return {
			pageBg: adjustBrightness(baseColor, 0.96),
			cardBg: baseColor,
			infoBg: `rgb(${Math.min(255, parsed.r + 10)}, ${Math.min(255, parsed.g + 5)}, ${Math.max(0, parsed.b - 20)})`,
		};
	}
	return {
		pageBg: adjustBrightness(baseColor, 0.7),
		cardBg: adjustBrightness(baseColor, 0.85),
		infoBg: `rgb(${Math.min(255, parsed.r + 20)}, ${Math.min(255, parsed.g + 15)}, ${parsed.b})`,
	};
}

/**
 * Generate CSS custom properties for one export theme.
 *
 * The single-argument theme-name form remains available to callers that need
 * one TUI palette. Standalone HTML uses `generateThemeStyles()` below.
 */
export async function generateThemeVars(
	palette: "web" | "theme" | (string & {}) = "web",
	themeName?: string,
): Promise<string> {
	if (palette !== "web" && palette !== "theme") return generateThemeVars("theme", palette);
	if (palette === "web") return webExportThemeVars("dark");

	const colors = await getResolvedThemeColors(themeName);
	const lines = Object.entries(colors).map(([key, value]) => `--${key}: ${value};`);
	const themeExport = await getThemeExportColors(themeName);
	const derived = deriveExportColors(colors.userMessageBg || "#343541");

	lines.push(`--body-bg: ${themeExport.pageBg ?? derived.pageBg};`);
	lines.push(`--container-bg: ${themeExport.cardBg ?? derived.cardBg};`);
	lines.push(`--info-bg: ${themeExport.infoBg ?? derived.infoBg};`);
	return lines.join(" ");
}

/** Generate dark, light, and auto-following CSS rules for a standalone viewer. */
export async function generateThemeStyles(
	palette: "web" | "theme",
	themeNames?: ExportThemeNames,
	legacyThemeName?: string,
): Promise<string> {
	const [dark, light] =
		palette === "web"
			? [webExportThemeVars("dark"), webExportThemeVars("light")]
			: await Promise.all([
					generateThemeVars("theme", themeNames?.dark ?? legacyThemeName ?? "dark"),
					generateThemeVars("theme", themeNames?.light ?? legacyThemeName ?? "light"),
				]);
	return [
		`:root, :root[data-theme="dark"] { color-scheme: dark; ${dark} }`,
		`:root[data-theme="light"] { color-scheme: light; ${light} }`,
		`@media (prefers-color-scheme: light) { :root:not([data-theme]) { color-scheme: light; ${light} } }`,
	].join("\n");
}

/** Embedded subagent session transcript, keyed by slash-joined agent path in `SessionData.subSessions`. */
export interface SubSession {
	/** Bare agent id (session file stem), e.g. "ToolAsk". */
	agentId: string;
	/** Key of the parent sub-session, or null when spawned by the main session. */
	parent: string | null;
	header: SessionHeader | null;
	entries: SessionEntry[];
	leafId: string | null;
}

export interface SessionData {
	header: SessionHeader | null;
	entries: SessionEntry[];
	leafId: string | null;
	systemPrompt?: string;
	tools?: { name: string; description: string }[];
	subSessions?: Record<string, SubSession>;
}

function sessionHeaderForExport(header: SessionHeader | null): SessionHeader | null {
	if (!header) return null;
	const exported = { ...header };
	delete exported.previousSessionFiles;
	return exported;
}

/**
 * Entries the exported page may render. Archived subtrees stay out unless asked
 * for — an export is what gets shared, so a branch hidden in the TUI leaking
 * into it defeats the point. The `archive` bookkeeping records go regardless:
 * they carry no message content and would render as blank rows in the tree.
 *
 * The leaf comes back with them because dropping entries can strand it.
 * `archiveEmptyBranches()` appends its records like any other entry, so the
 * last one is the session leaf until the next turn; an export taken in between
 * would otherwise name an entry the page does not have. Falls back to the
 * nearest surviving ancestor, or null when nothing survives.
 */
function visibleForExport(sm: SessionManager, includeArchived: boolean): Pick<SessionData, "entries" | "leafId"> {
	const all = sm.getEntries();
	const hidden = includeArchived ? undefined : sm.getArchivedEntryIds();
	const retained = all.filter(
		entry =>
			entry.type !== "archive" && !hidden?.has(entry.id) && !(entry.type === "label" && hidden?.has(entry.targetId)),
	);
	if (retained.length === all.length) return { entries: retained, leafId: sm.getLeafId() };
	const visible = new Set(retained.map(entry => entry.id));
	const parentOf = new Map(all.map(entry => [entry.id, entry.parentId]));
	const nearestVisibleAncestor = (start: string | null): string | null => {
		let cursor = start;
		const seen = new Set<string>();
		while (cursor !== null && !visible.has(cursor) && !seen.has(cursor)) {
			seen.add(cursor);
			cursor = parentOf.get(cursor) ?? null;
		}
		return cursor !== null && visible.has(cursor) ? cursor : null;
	};
	const entries = retained.map(entry => {
		const parentId = nearestVisibleAncestor(entry.parentId);
		return parentId === entry.parentId ? entry : { ...entry, parentId };
	});

	const leafId = nearestVisibleAncestor(sm.getLeafId());
	return { entries, leafId };
}

/** Snapshot the session (plus optional agent state) into the JSON shape the viewer renders. */
export function buildSessionData(
	sm: SessionManager,
	state?: AgentState,
	options?: { includeArchived?: boolean },
): SessionData {
	return {
		header: sessionHeaderForExport(sm.getHeader()),
		...visibleForExport(sm, options?.includeArchived === true),
		systemPrompt: state?.systemPrompt.join("\n\n"),
		tools: state?.tools?.map(t => ({ name: t.name, description: t.description })),
	};
}

function referencedSubagentIds(entries: SessionEntry[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "task")
			continue;
		if (!isTaskToolDetails(entry.message.details)) continue;
		for (const result of entry.message.details.results) ids.add(result.id);
		for (const progress of entry.message.details.progress ?? []) ids.add(progress.id);
	}
	return ids;
}

/**
 * Collect subagent session transcripts stored next to a session file.
 *
 * A session at `<dir>/<name>.jsonl` keeps its subagent sessions at `<dir>/<name>/<AgentId>.jsonl`;
 * each subagent's own children nest the same way under `<dir>/<name>/<AgentId>/`. Keys in the
 * returned record are slash-joined ids relative to the main session ("ToolAsk", "ToolAsk/Helper").
 * Corrupt or empty files are skipped silently.
 */
export async function collectSubSessions(
	sessionFile: string,
	options?: { includeArchived?: boolean; referencedAgentIds?: ReadonlySet<string> },
): Promise<Record<string, SubSession>> {
	const result: Record<string, SubSession> = {};
	if (!sessionFile.endsWith(".jsonl")) return result;
	await collectSubSessionsFromDir(
		sessionFile.slice(0, -6),
		null,
		result,
		options?.includeArchived === true,
		options?.referencedAgentIds,
	);
	return result;
}

async function collectSubSessionsFromDir(
	dir: string,
	parentKey: string | null,
	out: Record<string, SubSession>,
	includeArchived: boolean,
	referencedAgentIds: ReadonlySet<string> | undefined,
): Promise<void> {
	let names: string[];
	try {
		names = await fs.promises.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
	for (const name of names) {
		if (!name.endsWith(".jsonl") || name.includes(".bak")) continue;
		const agentId = name.slice(0, -6);
		if (referencedAgentIds && !referencedAgentIds.has(agentId)) continue;
		const key = parentKey ? `${parentKey}/${agentId}` : agentId;
		const sessionPath = path.join(dir, name);
		const loaded = await loadSessionFile(sessionPath);
		// Empty/corrupt files (no valid session header) load as [] — skip silently.
		if (loaded.entries.length > 0) {
			const subSession = await SessionManager.open(sessionPath, undefined, undefined, {
				suppressBreadcrumb: true,
				loadedSession: loaded,
			});
			try {
				const data = buildSessionData(subSession, undefined, { includeArchived });
				out[key] = { agentId, parent: parentKey, ...data };
			} finally {
				await subSession.close();
			}
		}
		const childAgentIds = referencedAgentIds ? referencedSubagentIds(out[key]?.entries ?? []) : undefined;
		await collectSubSessionsFromDir(path.join(dir, agentId), key, out, includeArchived, childAgentIds);
	}
}

/** Generate HTML from bundled template with runtime substitutions. */
async function generateHtml(
	sessionData: SessionData,
	palette: "web" | "theme",
	themeNames?: ExportThemeNames,
	themeName?: string,
): Promise<string> {
	const themeStyles = await generateThemeStyles(palette, themeNames, themeName);
	const sessionDataBase64 = Buffer.from(JSON.stringify(sessionData)).toBase64();

	// Use function replacements so `$'`, `$&`, `$$`, `$n`, etc. in the
	// substituted CSS/base64 are not interpreted as substitution patterns.
	return getTemplate()
		.replace("<theme-vars/>", () => `<style>${themeStyles}</style>`)
		.replace("{{SESSION_DATA}}", () => sessionDataBase64);
}

/** Export session to HTML using SessionManager and AgentState. */
export async function exportSessionToHtml(
	sm: SessionManager,
	state?: AgentState,
	options?: ExportOptions | string,
): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};

	const sessionFile = sm.getSessionFile();
	if (!sessionFile) throw new Error("Cannot export in-memory session to HTML");

	const sessionData = buildSessionData(sm, state, opts);
	if (opts.includeSubSessions !== false) {
		const subSessions = await collectSubSessions(sessionFile, {
			includeArchived: opts.includeArchived,
			referencedAgentIds: referencedSubagentIds(sessionData.entries),
		});
		if (Object.keys(subSessions).length > 0) sessionData.subSessions = subSessions;
	}

	const palette = opts.palette ?? (opts.themeName ? "theme" : "web");
	const html = await generateHtml(sessionData, palette, opts.themeNames, opts.themeName);
	const outputPath = opts.outputPath || `${APP_NAME}-session-${path.basename(sessionFile, ".jsonl")}.html`;

	await Bun.write(outputPath, html);
	return outputPath;
}

/** Export session file to HTML (standalone). */
export async function exportFromFile(inputPath: string, options?: ExportOptions | string): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};

	let sm: SessionManager;
	try {
		sm = await SessionManager.open(inputPath, undefined, undefined, { suppressBreadcrumb: true });
	} catch (err) {
		if (isEnoent(err)) throw new Error(`File not found: ${inputPath}`);
		throw err;
	}

	const sessionData = buildSessionData(sm, undefined, opts);
	if (opts.includeSubSessions !== false) {
		const subSessions = await collectSubSessions(inputPath, {
			includeArchived: opts.includeArchived,
			referencedAgentIds: referencedSubagentIds(sessionData.entries),
		});
		if (Object.keys(subSessions).length > 0) sessionData.subSessions = subSessions;
	}

	const palette = opts.palette ?? (opts.themeName ? "theme" : "web");
	const html = await generateHtml(sessionData, palette, opts.themeNames, opts.themeName);
	const outputPath = opts.outputPath || `${APP_NAME}-session-${path.basename(inputPath, ".jsonl")}.html`;

	await Bun.write(outputPath, html);
	return outputPath;
}
