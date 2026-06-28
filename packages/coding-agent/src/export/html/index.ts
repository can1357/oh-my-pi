import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentState } from "@pk-nerdsaver-ai/pi-agent-core";
import { APP_NAME, isEnoent } from "@pk-nerdsaver-ai/pi-utils";
import { getResolvedThemeColors, getThemeExportColors } from "../../modes/theme/theme";
import type { SessionEntry, SessionHeader } from "../../session/session-entries";
import { loadEntriesFromFile } from "../../session/session-loader";
import { SessionManager } from "../../session/session-manager";
import templateCss from "./template.css" with { type: "text" };
import templateHtml from "./template.html" with { type: "text" };
import templateJs from "./template.js" with { type: "text" };
// Pre-built React tool renderers: built by `gen:tool-views` (`bun run gen:tool-views`),
// run automatically by root `prepare` on install and by `prepack` at publish.
import toolViewsJs from "./tool-views.generated.js" with { type: "text" };
import { webExportThemeVars } from "./web-palette";

let cachedTemplate: string | undefined;

/** Compose the standalone export template: minified CSS, tool renderers, and viewer JS inlined. */
export function getTemplate(): string {
	if (cachedTemplate) return cachedTemplate;
	const minifiedCss = templateCss
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\s+/g, " ")
		.replace(/\s*([{}:;,])\s*/g, "$1")
		.trim();
	// Function replacements so `$'`, `$&`, `$$`, etc. inside the embedded
	// CSS/JS are not interpreted as substitution patterns. The cast is safe:
	// `with { type: "text" }` yields a string at runtime; bun-types just types
	// every *.html import as HTMLBundle (TS can't vary types by import attribute).
	cachedTemplate = (templateHtml as unknown as string)
		.replace("<template-css/>", () => `<style>${minifiedCss}</style>`)
		.replace("<template-tool-views/>", () => `<script>${toolViewsJs}</script>`)
		.replace("<template-js/>", () => `<script>${templateJs}</script>`);
	return cachedTemplate;
}

export interface ExportOptions {
	outputPath?: string;
	/**
	 * Which color palette the export ships with.
	 * - `"web"` (default) — the omp brand identity (collab-web pink/purple),
	 *   so public HTML exports and the `/s/<id>` share viewer match the live
	 *   `my.omp.sh` client. See `web-palette.ts`.
	 * - `"theme"` — derive from `themeName` (or the active TUI theme), preserving
	 *   the pre-15.12 behavior where an export mirrored the user's terminal.
	 */
	palette?: "web" | "theme";
	/**
	 * TUI theme to derive colors from when `palette: "theme"`. Ignored for the
	 * default `"web"` palette. Resolves to the active TUI theme when omitted.
	 */
	themeName?: string;
	/** Embed subagent session transcripts found next to the session file (default true). */
	includeSubSessions?: boolean;
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
 * Generate CSS custom properties for the export `:root`.
 *
 * Two call shapes:
 *   • `generateThemeVars("web" | "theme", themeName?)` — explicit palette.
 *     `"web"` (the default for public artifacts) returns the fixed omp brand
 *     palette from `web-palette.ts` — collab-web pink/purple identity, shared
 *     with the live `my.omp.sh` client, so exports and the share viewer render
 *     identically to it. `"theme"` derives from the TUI theme via
 *     `getResolvedThemeColors(themeName)` plus the three
 *     `export.{pageBg,cardBg,infoBg}` surface overrides.
 *   • `generateThemeVars(themeName)` — legacy single-arg form: derive from the
 *     named TUI theme. Kept so existing callers (and the theme-islight test)
 *     keep working; equivalent to `generateThemeVars("theme", themeName)`.
 *
 * Exported for the share-viewer build script.
 */
export async function generateThemeVars(
	palette: "web" | "theme" | (string & {}) = "web",
	themeName?: string,
): Promise<string> {
	// Legacy single-arg form: `generateThemeVars("my-theme")` — the first arg
	// is a theme name, not a palette. Route it to the themed path.
	if (palette !== "web" && palette !== "theme") {
		return generateThemeVars("theme", palette);
	}
	if (palette === "web") return webExportThemeVars();

	const colors = await getResolvedThemeColors(themeName);
	const lines: string[] = [];
	for (const key in colors) {
		lines.push(`--${key}: ${colors[key]};`);
	}

	const themeExport = await getThemeExportColors(themeName);
	const userMessageBg = colors.userMessageBg || "#343541";
	const derived = deriveExportColors(userMessageBg);

	lines.push(`--body-bg: ${themeExport.pageBg ?? derived.pageBg};`);
	lines.push(`--container-bg: ${themeExport.cardBg ?? derived.cardBg};`);
	lines.push(`--info-bg: ${themeExport.infoBg ?? derived.infoBg};`);

	return lines.join(" ");
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

/** Snapshot the session (plus optional agent state) into the JSON shape the viewer renders. */
export function buildSessionData(sm: SessionManager, state?: AgentState): SessionData {
	return {
		header: sm.getHeader(),
		entries: sm.getEntries(),
		leafId: sm.getLeafId(),
		systemPrompt: state?.systemPrompt.join("\n\n"),
		tools: state?.tools?.map(t => ({ name: t.name, description: t.description })),
	};
}

/**
 * Collect subagent session transcripts stored next to a session file.
 *
 * A session at `<dir>/<name>.jsonl` keeps its subagent sessions at `<dir>/<name>/<AgentId>.jsonl`;
 * each subagent's own children nest the same way under `<dir>/<name>/<AgentId>/`. Keys in the
 * returned record are slash-joined ids relative to the main session ("ToolAsk", "ToolAsk/Helper").
 * Corrupt or empty files are skipped silently.
 */
export async function collectSubSessions(sessionFile: string): Promise<Record<string, SubSession>> {
	const result: Record<string, SubSession> = {};
	if (!sessionFile.endsWith(".jsonl")) return result;
	await collectSubSessionsFromDir(sessionFile.slice(0, -6), null, result);
	return result;
}

async function collectSubSessionsFromDir(
	dir: string,
	parentKey: string | null,
	out: Record<string, SubSession>,
): Promise<void> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
	for (const name of names) {
		if (!name.endsWith(".jsonl") || name.includes(".bak")) continue;
		const agentId = name.slice(0, -6);
		const key = parentKey ? `${parentKey}/${agentId}` : agentId;
		const fileEntries = await loadEntriesFromFile(path.join(dir, name));
		// Empty/corrupt files (no valid session header) load as [] — skip silently.
		if (fileEntries.length > 0) {
			const header = (fileEntries.find(e => e.type === "session") as SessionHeader | undefined) ?? null;
			const entries = fileEntries.filter((e): e is SessionEntry => e.type !== "session");
			out[key] = {
				agentId,
				parent: parentKey,
				header,
				entries,
				leafId: entries.length > 0 ? entries[entries.length - 1].id : null,
			};
		}
		await collectSubSessionsFromDir(path.join(dir, agentId), key, out);
	}
}

/** Generate HTML from bundled template with runtime substitutions. */
async function generateHtml(sessionData: SessionData, palette: "web" | "theme", themeName?: string): Promise<string> {
	const themeVars = await generateThemeVars(palette, themeName);
	const sessionDataBase64 = Buffer.from(JSON.stringify(sessionData)).toBase64();

	// Use function replacements so `$'`, `$&`, `$$`, `$n`, etc. in the
	// substituted CSS/base64 are not interpreted as substitution patterns
	// (see https://mdn.io/String.replace).
	return getTemplate()
		.replace("<theme-vars/>", () => `<style>:root { ${themeVars} }</style>`)
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

	const sessionData = buildSessionData(sm, state);
	if (opts.includeSubSessions !== false) {
		const subSessions = await collectSubSessions(sessionFile);
		if (Object.keys(subSessions).length > 0) sessionData.subSessions = subSessions;
	}

	const palette = opts.palette ?? (opts.themeName ? "theme" : "web");
	const html = await generateHtml(sessionData, palette, opts.themeName);
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

	const sessionData: SessionData = {
		header: sm.getHeader(),
		entries: sm.getEntries(),
		leafId: sm.getLeafId(),
	};
	if (opts.includeSubSessions !== false) {
		const subSessions = await collectSubSessions(inputPath);
		if (Object.keys(subSessions).length > 0) sessionData.subSessions = subSessions;
	}

	const palette = opts.palette ?? (opts.themeName ? "theme" : "web");
	const html = await generateHtml(sessionData, palette, opts.themeName);
	const outputPath = opts.outputPath || `${APP_NAME}-session-${path.basename(inputPath, ".jsonl")}.html`;

	await Bun.write(outputPath, html);
	return outputPath;
}
