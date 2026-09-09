/**
 * `omp gallery` — render every built-in tool's renderer across its lifecycle.
 *
 * For each tool with a registered renderer, the gallery drives a real
 * {@link ToolExecutionComponent} through four states — streaming arguments,
 * arguments complete (in progress), success, and failure — and prints the
 * rendered output to stdout. It exists for visual QA of tool renderers without
 * having to provoke each state through a live agent session.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { TUI } from "@oh-my-pi/pi-tui";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { ToolExecutionComponent } from "../modes/components/tool-execution";
import { initTheme, theme } from "../modes/theme/theme";
import { toolRenderers } from "../tools/renderers";
import {
	type GalleryFixture,
	type GalleryPreviewEntry,
	type GalleryResult,
	galleryFixtures,
	getComposerGalleryEntries,
	getComposerGalleryInventory,
	getSegmentGalleryEntries,
	getSegmentGalleryInventory,
} from "./gallery-fixtures";
import { captureGalleryScreenshots } from "./gallery-screenshot";

/** Lifecycle states the gallery renders, in display order. */
export const GALLERY_STATES = ["streaming", "progress", "success", "error"] as const;
export type GalleryState = (typeof GALLERY_STATES)[number];

/** User-facing labels printed above each rendered lifecycle state. */
export const GALLERY_STATE_LABELS: Record<GalleryState, string> = {
	streaming: "streaming args",
	progress: "in progress",
	success: "done",
	error: "failed",
};

const GALLERY_STATE_ALIASES: Record<string, GalleryState> = {
	streaming: "streaming",
	"streaming args": "streaming",
	progress: "progress",
	"in progress": "progress",
	success: "success",
	done: "success",
	error: "error",
	failed: "error",
};

/** Accepted `--state` tokens, including legacy lifecycle names and displayed labels. */
export const GALLERY_STATE_TOKENS = Object.keys(GALLERY_STATE_ALIASES);

/** Gallery surfaces in stable product order. */
export const GALLERY_SURFACES = ["tool", "composer", "segment"] as const;
export type GallerySurface = (typeof GALLERY_SURFACES)[number];
export const GALLERY_SURFACE_TOKENS = [...GALLERY_SURFACES, "all"] as const;

/** Expand user-provided surface tokens while preserving product order. */
export function parseGallerySurfaces(surfaces: readonly string[] | undefined): GallerySurface[] | undefined {
	if (!surfaces || surfaces.length === 0) return undefined;
	const requested = new Set<GallerySurface>();
	for (const raw of surfaces) {
		const token = raw.trim().toLowerCase();
		if (token === "all") {
			for (const surface of GALLERY_SURFACES) requested.add(surface);
			continue;
		}
		if (!GALLERY_SURFACES.includes(token as GallerySurface)) {
			throw new Error(`Invalid --surface '${raw}'. Valid values: ${GALLERY_SURFACE_TOKENS.join(", ")}`);
		}
		requested.add(token as GallerySurface);
	}
	return GALLERY_SURFACES.filter(surface => requested.has(surface));
}

/** Normalize user-provided `--state` tokens to the internal gallery lifecycle states. */
export function parseGalleryStates(states: readonly string[] | undefined): GalleryState[] | undefined {
	if (!states || states.length === 0) return undefined;
	const parsed: GalleryState[] = [];
	for (const raw of states) {
		const state = GALLERY_STATE_ALIASES[raw.trim().toLowerCase()];
		if (!state) {
			throw new Error(`Invalid --state '${raw}'. Valid values: ${GALLERY_STATE_TOKENS.join(", ")}`);
		}
		if (!parsed.includes(state)) parsed.push(state);
	}
	return parsed;
}

export interface GalleryCommandArgs {
	/** Render width in columns (defaults to terminal width, clamped). */
	width?: number;
	/** Restrict rendering to selected surface types (defaults to all). */
	surfaces?: GallerySurface[];
	/** Restrict to a single tool name. */
	tool?: string;
	/** Restrict to a single composer shape. */
	composer?: string;
	/** Restrict to a single status-line segment. */
	segment?: string;
	/** Restrict to specific lifecycle states. */
	states?: GalleryState[];
	/** Render the expanded variant of each renderer. */
	expanded?: boolean;
	/** Strip ANSI styling from the output (useful when redirecting to a file). */
	plain?: boolean;
	/** Capture the rendered gallery as PNG screenshot(s) via VHS instead of printing ANSI. */
	screenshot?: boolean;
	/** Screenshot output path (single image) or base path (suffixed when split across images). */
	out?: string;
	/** Font family for screenshots (must be installed; Nerd Font recommended for icon glyphs). */
	font?: string;
	/** Font size in points for screenshots. */
	fontSize?: number;
}

/** One tool's rendered lifecycle, as ANSI lines: a leading blank, the section rule, then each state. */
export interface GallerySection {
	heading: string;
	lines: string[];
}

const GENERIC_ERROR: GalleryResult = {
	content: [{ type: "text", text: "Error: operation failed" }],
	isError: true,
};

/**
 * Build the fake `AgentTool` the component needs for its label, edit mode, and —
 * for `customRendered` fixtures — the renderer functions that route it through
 * the same custom-tool branch production uses (see {@link GalleryFixture}).
 */
function fakeToolFor(name: string, fixture: GalleryFixture | undefined): AgentTool | undefined {
	if (!fixture?.label && !fixture?.editMode && !fixture?.customRendered) return undefined;
	const tool: Record<string, unknown> = { name, label: fixture.label ?? name, mode: fixture.editMode };
	if (fixture.customRendered) {
		const renderer = toolRenderers[fixture.renderer ?? name] as
			| { renderCall?: unknown; renderResult?: unknown; mergeCallAndResult?: unknown; inline?: unknown }
			| undefined;
		if (renderer) {
			tool.renderCall = renderer.renderCall;
			tool.renderResult = renderer.renderResult;
			tool.mergeCallAndResult = renderer.mergeCallAndResult;
			tool.inline = renderer.inline;
		}
	}
	return tool as unknown as AgentTool;
}

/** The curated fixture for a tool, or a generic one for registry tools lacking sample data. */
export function resolveFixture(name: string): GalleryFixture {
	return (
		galleryFixtures[name] ??
		({
			args: { note: `sample ${name} call` },
			result: { content: [{ type: "text", text: `${name} completed` }] },
		} satisfies GalleryFixture)
	);
}

/**
 * Render a single tool/state pair to lines. Builds a fresh component, drives it
 * to the requested state, settles any async edit preview, then snapshots the
 * render and stops all animation timers.
 */
export async function renderGalleryState(
	name: string,
	fixture: GalleryFixture,
	state: GalleryState,
	width: number,
	expanded = false,
): Promise<readonly string[]> {
	if (fixture.renderState) {
		return await fixture.renderState(state, width, expanded);
	}

	// A non-customRendered fixture may borrow another tool's built-in renderer
	// (e.g. `edit_delete` → `edit`): drive the component under that real tool
	// name so the sample exercises the exact production branch, not the
	// custom-tool one (which tints/pads non-framed result rows).
	const componentName = fixture.customRendered ? name : (fixture.renderer ?? name);
	const tool = fakeToolFor(componentName, fixture);
	const streamingArgs = state === "streaming" ? (fixture.streamingArgs ?? fixture.args) : fixture.args;
	// The component only calls `requestRender`/`requestComponentRender` (via
	// its loader) during a static render; `imageBudget` is consulted solely
	// when images render, which the gallery disables. A cast avoids
	// constructing a real terminal.
	const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
	const component = new ToolExecutionComponent(
		componentName,
		streamingArgs,
		{ showImages: false, useBuiltInRenderer: !fixture.customRendered },
		tool,
		ui,
		getProjectDir(),
	);
	component.setExpanded(expanded);

	if (state !== "streaming") {
		component.setArgsComplete();
		component.setExecutionStarted();
	}
	if (state === "success") {
		component.updateResult(fixture.result, false);
	} else if (state === "error") {
		component.updateResult(fixture.errorResult ?? GENERIC_ERROR, false);
	}

	// Edit-like renderers compute their diff preview off the render path; wait
	// for it to settle so the snapshot is deterministic instead of racing a tick.
	// Static fixtures have no live batch source, so bound the wait tightly.
	await component.whenPreviewSettled(50);

	const lines = component.render(width);
	component.stopAnimation();
	return lines;
}

function resolveWidth(requested: number | undefined): number {
	const fallback = process.stdout.columns ?? 100;
	const width = requested ?? fallback;
	return Math.max(40, Math.min(200, width));
}

function sectionRule(label: string, width: number): string {
	const prefix = `── ${label} `;
	const fill = Math.max(0, width - prefix.length);
	return theme.fg("accent", theme.bold(`${prefix}${"─".repeat(fill)}`));
}

/**
 * Render each requested tool's lifecycle into ANSI section blocks. The block
 * layout (leading blank, section rule, then a blank + dim label + body per
 * state) is shared by the stdout and screenshot paths so both stay identical.
 */
async function renderGallerySections(
	names: string[],
	states: GalleryState[],
	width: number,
	expanded: boolean,
): Promise<GallerySection[]> {
	const sections: GallerySection[] = [];
	for (const name of names) {
		const fixture = resolveFixture(name);
		const heading = fixture.label && fixture.label !== name ? `${name} — ${fixture.label}` : name;
		const lines: string[] = ["", sectionRule(heading, width)];
		for (const state of states) {
			lines.push("", theme.fg("dim", `  · ${GALLERY_STATE_LABELS[state]}`));
			try {
				for (const line of await renderGalleryState(name, fixture, state, width, expanded)) lines.push(line);
			} catch (err) {
				lines.push(theme.fg("error", `  render failed: ${String(err)}`));
			}
		}
		sections.push({ heading, lines });
	}
	return sections;
}

function resolveSurfaces(args: GalleryCommandArgs): GallerySurface[] {
	const selected = new Set<GallerySurface>(args.surfaces ?? []);
	if (!args.surfaces || args.surfaces.length === 0) {
		if (!args.tool && !args.composer && !args.segment) return [...GALLERY_SURFACES];
	}
	if (args.tool) selected.add("tool");
	if (args.composer) selected.add("composer");
	if (args.segment) selected.add("segment");
	return GALLERY_SURFACES.filter(surface => selected.has(surface));
}

async function renderPreviewSections(
	entries: readonly GalleryPreviewEntry[],
	width: number,
	expanded: boolean,
): Promise<GallerySection[]> {
	const sections: GallerySection[] = [];
	for (const entry of entries) {
		const lines = ["", sectionRule(entry.heading, width)];
		for (const variant of entry.variants) {
			lines.push("", theme.fg("dim", `  · ${variant.label}`));
			try {
				for (const line of await variant.render(width, expanded)) lines.push(line);
			} catch (err) {
				lines.push(theme.fg("error", `  render failed: ${String(err)}`));
			}
		}
		sections.push({ heading: entry.heading, lines });
	}
	return sections;
}

/** Build requested sections in the fixed tool → composer → segment order. */
export async function renderGallerySurfaceSections(
	args: GalleryCommandArgs,
	width = resolveWidth(args.width),
): Promise<GallerySection[]> {
	const expanded = args.expanded ?? false;
	const states = args.states && args.states.length > 0 ? args.states : [...GALLERY_STATES];
	const surfaces = resolveSurfaces(args);
	const sections: GallerySection[] = [];

	if (surfaces.includes("tool")) {
		const allNames = Array.from(new Set([...Object.keys(toolRenderers), ...Object.keys(galleryFixtures)])).sort();
		const names = args.tool ? allNames.filter(name => name === args.tool) : allNames;
		sections.push(...(await renderGallerySections(names, states, width, expanded)));
	}
	if (surfaces.includes("composer")) {
		const entries = getComposerGalleryEntries().filter(entry => !args.composer || entry.id === args.composer);
		sections.push(...(await renderPreviewSections(entries, width, expanded)));
	}
	if (surfaces.includes("segment")) {
		const entries = getSegmentGalleryEntries().filter(entry => !args.segment || entry.id === args.segment);
		sections.push(...(await renderPreviewSections(entries, width, expanded)));
	}
	return sections;
}

/**
 * Render the gallery. Iterates the renderer registry (or a single tool),
 * printing each requested lifecycle state under a labeled section — or, with
 * `screenshot`, capturing the rendered output as PNG(s) via VHS.
 */
export async function runGalleryCommand(args: GalleryCommandArgs): Promise<void> {
	const settingsInstance = await Settings.init();
	// Screenshots must carry exact theme RGB regardless of how the invoking
	// terminal advertises its color support, so force truecolor before the theme
	// (and therefore every SGR escape it emits) is built.
	if (args.screenshot) process.env.COLORTERM = "truecolor";
	await initTheme(
		false,
		settingsInstance.get("symbolPreset"),
		settingsInstance.get("colorBlindMode"),
		settingsInstance.get("theme.dark"),
		settingsInstance.get("theme.light"),
	);

	const width = resolveWidth(args.width);
	const surfaces = resolveSurfaces(args);
	if (surfaces.includes("tool") && args.tool) {
		const knownTools = Array.from(new Set([...Object.keys(toolRenderers), ...Object.keys(galleryFixtures)])).sort();
		if (!knownTools.includes(args.tool)) {
			process.stdout.write(`Unknown tool '${args.tool}'. Known tools: ${knownTools.join(", ")}\n`);
			return;
		}
	}
	if (surfaces.includes("composer") && args.composer && !getComposerGalleryInventory().includes(args.composer)) {
		process.stdout.write(
			`Unknown composer '${args.composer}'. Known composers: ${getComposerGalleryInventory().join(", ")}\n`,
		);
		return;
	}
	if (surfaces.includes("segment") && args.segment && !getSegmentGalleryInventory().some(id => id === args.segment)) {
		process.stdout.write(
			`Unknown segment '${args.segment}'. Known segments: ${getSegmentGalleryInventory().join(", ")}\n`,
		);
		return;
	}

	const sections = await renderGallerySurfaceSections(args, width);

	if (args.screenshot) {
		const paths = await captureGalleryScreenshots(sections, {
			width,
			font: args.font,
			fontSize: args.fontSize,
			out: args.out,
		});
		process.stdout.write(`${paths.join("\n")}\n`);
		return;
	}

	const lines = sections.flatMap(section => section.lines);
	lines.push("");
	const text = lines.map(line => (args.plain ? Bun.stripANSI(line) : line)).join("\n");
	process.stdout.write(`${text}\n`);
}
