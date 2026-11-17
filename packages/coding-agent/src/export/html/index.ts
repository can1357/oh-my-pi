import * as fs from "node:fs";
import * as path from "node:path";
import { buildSessionTraceFromSnapshots } from "@oh-my-pi/omp-stats/trace";
import type { SessionTrace } from "@oh-my-pi/omp-stats/types";
import type { AgentState } from "@oh-my-pi/pi-agent-core";
import { APP_NAME, isCompiledBinary, isEnoent, VERSION } from "@oh-my-pi/pi-utils";
import { getResolvedThemeColors, getThemeExportColors } from "@oh-my-pi/pi-tui/theme";
import type { SessionEntry, SessionHeader } from "../../session/session-entries";
import { SessionManager } from "../../session/session-manager";
import { collectSubSessions, type SubSession } from "../../session/sub-sessions";
import type { ExportThemeNames } from "./args";
import { writeBase64Json } from "./payload";
import templateHtml from "./template.html.txt" with { type: "text" };
import viewerAsset from "./viewer.generated.json" with { type: "json" };
import { exportThemeStyles, webExportThemeVars } from "./web-palette";

export { type ExportThemeNames, parseExportArgs } from "./args";

let cachedTemplate: string | undefined;
const SESSION_DATA_MARKER = "{{SESSION_DATA}}";

/** Create an export document with a checkout viewer or an integrity-pinned release viewer. */
export function getTemplate(): string {
	if (cachedTemplate) return cachedTemplate;
	const sourceCheckout =
		!isCompiledBinary() &&
		!process.env.PI_BUNDLED &&
		!import.meta.dir.split(/[\\/]/).includes("node_modules") &&
		fs.existsSync(path.join(import.meta.dir, "shell.html"));
	let viewerScript: string;
	if (sourceCheckout) {
		const viewerPath = path.resolve(import.meta.dir, "../../../export-assets", viewerAsset.file);
		let viewer: string;
		try {
			viewer = fs.readFileSync(viewerPath, "utf8");
		} catch (err) {
			if (isEnoent(err)) {
				throw new Error(
					`Development export viewer not found: ${viewerPath}. Run bun gen:export-viewer (packages/collab-web/scripts/build-export-viewer.ts).`,
				);
			}
			throw err;
		}
		// Inline classic scripts run before deferred external scripts. Wait for
		// both shared libraries, and prevent embedded text from closing the tag.
		const escaped = viewer.replace(/<\/script/gi, match => `<\\/${match.slice(2)}`);
		viewerScript = `<script>window.addEventListener("DOMContentLoaded",function(){\n${escaped}\n});</script>`;
	} else {
		const viewerUrl = `https://build.stencil.so/web/omp/${encodeURIComponent(VERSION)}/${viewerAsset.file}`;
		viewerScript = `<script defer src="${viewerUrl}" integrity="${viewerAsset.integrity}" crossorigin="anonymous" onerror="document.getElementById('viewer-status').textContent='Could not load the session viewer. Connect to the internet and reload this file.'"></script>`;
	}
	cachedTemplate = templateHtml
		.replace("{{MARKED_URL}}", () => "https://stencil.so/assets/omp/marked.333561b9.js")
		.replace("{{MARKED_INTEGRITY}}", () => "sha256-MzVhuUicTTOmBQF03OgI9HBhlGcICMhDRSPIdD9aYmM=")
		.replace("{{HIGHLIGHT_URL}}", () => "https://stencil.so/assets/omp/highlight.837a6fa5.js")
		.replace("{{HIGHLIGHT_INTEGRITY}}", () => "sha256-g3pvpbDHNrUrveKythkPMF2j/J7UFoHbUyFQcFe1yEY=")
		.replace("<viewer-script/>", () => viewerScript);
	return cachedTemplate;
}

export interface ExportOptions {
	outputPath?: string;
	/** `"web"` uses the hosted web themes; `"theme"` embeds TUI theme overrides. */
	palette?: "web" | "theme";
	/** Legacy single TUI theme name. Prefer `themeNames` for dual-theme exports. */
	themeName?: string;
	/** Dark and light TUI themes to bundle when `palette` is `"theme"`. */
	themeNames?: ExportThemeNames;
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
	return exportThemeStyles(dark, light);
}

export interface SessionData {
	header: SessionHeader | null;
	entries: SessionEntry[];
	leafId: string | null;
	systemPrompt?: string;
	tools?: { name: string; description: string }[];
	subSessions?: Record<string, SubSession>;
	/** Offline trace for the embedded transcripts; absent in older share snapshots. */
	trace?: SessionTrace;
}

function sessionHeaderForExport(header: SessionHeader | null): SessionHeader | null {
	if (!header) return null;
	const exported = { ...header };
	delete exported.previousSessionFiles;
	delete exported.providerPromptCacheKey;
	delete exported.taskPromptCacheKey;
	return exported;
}

/** Snapshot the session (plus optional agent state) into the JSON shape the viewer renders. */
export function buildSessionData(sm: SessionManager, state?: AgentState): SessionData {
	return {
		header: sessionHeaderForExport(sm.getHeader()),
		entries: sm.getEntries(),
		leafId: sm.getLeafId(),
		systemPrompt: state?.systemPrompt.join("\n\n"),
		tools: state?.tools?.map(t => ({ name: t.name, description: t.description })),
	};
}

/** All trace transcripts next to `sessionFile`, with export-only header fields stripped. */
async function collectExportSubSessions(sessionFile: string): Promise<Record<string, SubSession>> {
	const subSessions = await collectSubSessions(sessionFile, { includeAdvisors: true, includeCompressed: true });
	for (const sub of Object.values(subSessions)) sub.header = sessionHeaderForExport(sub.header);
	return subSessions;
}

/**
 * Write the export document for `sessionData` to `outputPath`, streaming the
 * base64 payload so no string ever holds the whole session (#17741). A failed
 * write removes the partial file.
 */
async function writeExportHtml(sessionData: SessionData, outputPath: string, opts: ExportOptions): Promise<void> {
	const palette = opts.palette ?? (opts.themeName ? "theme" : "web");
	const themeStyles = palette === "theme" ? await generateThemeStyles(palette, opts.themeNames, opts.themeName) : "";
	// Function replacement so `$'`, `$&`, `$$`, `$n` in the CSS are not substitution patterns.
	const page = getTemplate().replace("<theme-vars/>", () => (themeStyles ? `<style>${themeStyles}</style>` : ""));
	const marker = page.indexOf(SESSION_DATA_MARKER);

	// Unlike `Bun.write`, a `FileSink` does not create missing parent directories.
	await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
	const writer = Bun.file(outputPath).writer();
	try {
		writer.write(page.slice(0, marker));
		await writeBase64Json(sessionData, writer);
		writer.write(page.slice(marker + SESSION_DATA_MARKER.length));
		await writer.end();
	} catch (err) {
		// Close the handle so the partial file can be removed; the original failure is the one to report.
		await Promise.try(() => writer.end()).catch(() => undefined);
		await fs.promises.rm(outputPath, { force: true });
		throw err;
	}
}

/** Attach sub-sessions and the trace, then write the export; returns the output path. */
async function exportSessionData(sessionData: SessionData, sessionFile: string, opts: ExportOptions): Promise<string> {
	if (opts.includeSubSessions !== false) {
		const subSessions = await collectExportSubSessions(sessionFile);
		if (Object.keys(subSessions).length > 0) sessionData.subSessions = subSessions;
	}
	sessionData.trace = buildSessionTraceFromSnapshots(sessionData, sessionData.subSessions);

	// Resolve once: Bun on Windows fails to mkdir relative paths that normalize to cwd (oven-sh/bun#45059).
	const outputPath = path.resolve(
		opts.outputPath || `${APP_NAME}-session-${path.basename(sessionFile, ".jsonl")}.html`,
	);
	await writeExportHtml(sessionData, outputPath, opts);
	return outputPath;
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

	return exportSessionData(buildSessionData(sm, state), sessionFile, opts);
}

/** Export session file to HTML (standalone). */
export async function exportFromFile(inputPath: string, options?: ExportOptions | string): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};

	let sm: SessionManager;
	try {
		sm = await SessionManager.open(inputPath, undefined, undefined, {
			suppressBreadcrumb: true,
			throwIfMissing: true,
		});
	} catch (err) {
		if (isEnoent(err)) throw new Error(`File not found: ${inputPath}`);
		throw err;
	}

	return exportSessionData(buildSessionData(sm), inputPath, opts);
}
