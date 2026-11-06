import { RunTrace, ShellVisualization, type ShellVizOptions } from "@oh-my-pi/pi-natives";
import type {
	ShellTrace,
	ShellVizPreferences,
	ShellVizPresentation,
	ShellVizRow,
	ShellVizSegment,
	ShellVizWatch,
} from "@oh-my-pi/pi-wire";

/** Native live-run or restored-trace owner; the UI never holds shell syntax. */
export type ShellVisualizationSource = RunTrace | ShellVisualization;
const visualizations = new WeakMap<ShellTrace, ShellVisualizationSource>();

/** Bind the immutable snapshot before publishing it; live paints borrow the actual run. */
export function attachShellTrace(snapshot: ShellTrace, trace: RunTrace): void {
	visualizations.set(snapshot, trace);
}

/** Historical traces restore their canonical native archive only once per snapshot. */
export function shellVisualization(snapshot: ShellTrace): ShellVisualizationSource {
	let visualization = visualizations.get(snapshot);
	if (!visualization) {
		visualization = new ShellVisualization(JSON.stringify(snapshot));
		visualizations.set(snapshot, visualization);
	}
	return visualization;
}

/** Python-like Pseudo, all layers enabled, one pane, live, paused, normal speed. */
export function defaultShellVizPreferences(): ShellVizPreferences {
	return {
		view: "pseudo",
		layers: { color: true, inline: true, idioms: true, effects: true, unwrap: true },
		split: false,
		playing: false,
		speed: 1,
		expandedNodes: [],
	};
}

/** Render through native ownership; an explicit replay cursor never uses the normal output sink. */
export function readShellPresentation(
	source: ShellVisualizationSource,
	preferences: ShellVizPreferences,
	snapshot?: ShellTrace,
	output?: string,
): ShellVizPresentation {
	const options: ShellVizOptions = {
		...preferences,
		cursorSeq: preferences.cursor === undefined ? undefined : snapshot?.history?.[preferences.cursor - 1]?.seq,
	};
	const presentation = decodeShellPresentation(source.present(options));
	if (preferences.cursor === undefined && output !== undefined) presentation.output = output;
	return presentation;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
function string(value: unknown): value is string {
	return typeof value === "string";
}
function boolean(value: unknown): value is boolean {
	return typeof value === "boolean";
}
/** Node keys are opaque; validation must never invent or reinterpret engine identity. */
export function isShellVizNode(value: unknown): value is string {
	return typeof value === "string" && /^(0|[1-9][0-9]*):(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.test(value);
}
function optional(value: Record<string, unknown>, key: string, valid: (value: unknown) => boolean): boolean {
	return value[key] === undefined || valid(value[key]);
}
function range(value: unknown): boolean {
	return Array.isArray(value) && value.length === 2 && value.every(finite) && value[0] >= 0 && value[1] >= value[0];
}
function state(value: unknown): boolean {
	return value === "pending" || value === "running" || value === "ok" || value === "fail" || value === "skipped";
}
function preferences(value: unknown): value is ShellVizPreferences {
	if (!record(value) || !record(value.layers)) return false;
	const layers = value.layers;
	return (
		(value.view === "raw" || value.view === "pseudo") &&
		["color", "inline", "idioms", "effects", "unwrap"].every(key => boolean(layers[key])) &&
		boolean(value.split) &&
		boolean(value.playing) &&
		finite(value.speed) &&
		optional(value, "cursor", finite) &&
		optional(value, "selectedNode", isShellVizNode) &&
		Array.isArray(value.expandedNodes) &&
		value.expandedNodes.every(isShellVizNode)
	);
}
function watch(value: unknown): value is ShellVizWatch {
	return (
		record(value) &&
		string(value.name) &&
		string(value.value) &&
		optional(value, "fullLength", finite) &&
		optional(value, "scope", string) &&
		optional(value, "scopeId", string) &&
		optional(value, "node", isShellVizNode) &&
		optional(value, "range", range) &&
		optional(value, "setterSeq", finite)
	);
}
function segment(value: unknown): value is ShellVizSegment {
	return (
		record(value) &&
		string(value.text) &&
		optional(value, "active", boolean) &&
		optional(value, "state", state) &&
		optional(value, "executedAtNs", finite) &&
		optional(value, "executionSeq", finite) &&
		optional(value, "style", string) &&
		optional(value, "node", isShellVizNode) &&
		optional(value, "executionNode", isShellVizNode) &&
		optional(value, "range", range) &&
		optional(value, "tip", string) &&
		optional(value, "expanded", string) &&
		optional(value, "language", string)
	);
}
function row(value: unknown): value is ShellVizRow {
	return (
		record(value) &&
		string(value.id) &&
		finite(value.depth) &&
		optional(value, "node", isShellVizNode) &&
		optional(value, "range", range) &&
		optional(value, "active", boolean) &&
		optional(value, "state", state) &&
		optional(value, "role", role => ["stmt", "head", "mid", "tail", "raw", "document"].includes(String(role))) &&
		Array.isArray(value.segments) &&
		value.segments.every(segment) &&
		Array.isArray(value.effects) &&
		value.effects.every(
			effect =>
				record(effect) &&
				["network", "write", "destructive", "secret", "privilege", "background"].includes(String(effect.kind)) &&
				string(effect.glyph) &&
				string(effect.label) &&
				string(effect.why),
		) &&
		optional(value, "executedAtNs", finite) &&
		optional(value, "executionSeq", finite) &&
		optional(value, "meta", string) &&
		optional(value, "detail", string) &&
		optional(value, "annotations", annotations => Array.isArray(annotations) && annotations.every(watch))
	);
}
function presentation(value: unknown): value is ShellVizPresentation {
	if (!record(value) || !record(value.timeline)) return false;
	const timeline = value.timeline;
	return (
		preferences(value.preferences) &&
		Array.isArray(value.rows) &&
		value.rows.every(row) &&
		Array.isArray(value.original) &&
		value.original.every(row) &&
		string(value.output) &&
		optional(value, "running", boolean) &&
		boolean(value.executing) &&
		Array.isArray(value.watches) &&
		value.watches.every(watch) &&
		["length", "cursor", "elapsedNs", "durationNs"].every(key => finite(timeline[key])) &&
		optional(timeline, "trimmed", boolean) &&
		optional(value, "message", string)
	);
}

/** Decode semantic display data, never shell syntax or execution state. */
export function decodeShellPresentation(json: string): ShellVizPresentation {
	const value: unknown = JSON.parse(json);
	if (!presentation(value)) throw new Error("Native shell returned an invalid visualization presentation");
	return value;
}
