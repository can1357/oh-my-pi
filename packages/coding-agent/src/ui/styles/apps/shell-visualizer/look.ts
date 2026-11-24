/**
 * `omp.app.shell` (`term.role` of the inspector's `shell` or notice `canvas`
 * node): the bash visualizer inspector in the terminal (`term.inspector`).
 * Five header rows (title, view, layer states, key help, playback with the
 * replay clock), the presentation rows scrolled into the space left, then —
 * when a node is selected — a dim `Selected details a–b/n` line over a
 * scrolling pane at most a third of the screen tall. Every row is cut at the
 * width. Without a presentation: the notice.
 */
import { type Block, defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { truncate, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { formatDuration } from "@oh-my-pi/pi-utils";
import type { ShellVizPresentation } from "@oh-my-pi/pi-wire";
import { SHELL_VIZ_LAYERS, type ShellVisualizerModel } from "../../../apps/shell-visualizer/model";
import { shellVizRows, shellVizText } from "../../tools/shell-viz";

/** Terminal role of the inspector node. */
export const INSPECTOR_ROLE = "omp.app.shell";

/** What the inspector shows without a presentation. */
export const NO_PRESENTATION: readonly string[] = ["No complete bash command available", "Escape closes"];

/** The selected node's detail lines: row detail, segment tips and expansions, variables, effects. */
function detailLines(presentation: ShellVizPresentation): string[] {
	const prefs = presentation.preferences;
	const selected = presentation.rows.find(
		row => row.node === prefs.selectedNode || row.segments.some(segment => segment.node === prefs.selectedNode),
	);
	if (!selected) return [];
	const lines: string[] = [];
	if (selected.detail) lines.push(shellVizText(selected.detail));
	for (const segment of selected.segments) {
		if (segment.tip) lines.push(shellVizText(segment.tip));
		const node = segment.node ?? selected.node;
		if (segment.expanded && node !== undefined && prefs.expandedNodes.includes(node)) {
			lines.push(...segment.expanded.split("\n").map(shellVizText));
		}
	}
	for (const variable of selected.annotations ?? []) {
		const truncated =
			variable.fullLength !== undefined && variable.fullLength > Buffer.byteLength(variable.value, "utf8")
				? ` [${variable.fullLength} bytes; retained value truncated]`
				: "";
		lines.push(
			`${shellVizText(variable.name)} = ${shellVizText(JSON.stringify(variable.value))}${variable.scope ? ` (${shellVizText(variable.scope)})` : ""}${truncated}`,
		);
	}
	for (const effect of selected.effects) lines.push(`${shellVizText(effect.label)}: ${shellVizText(effect.why)}`);
	return lines;
}

/** The inspector's rows at `width` (clamps the model's scroll positions). */
export function inspectorRows(model: ShellVisualizerModel, theme: Theme, width: number): string[] {
	const presentation = model.presentation();
	if (!presentation) return NO_PRESENTATION.map(line => truncate(line, width));
	const prefs = presentation.preferences;
	const timeline = presentation.timeline;
	const header = [
		theme.style("strong", "Bash visualizer  ·  Escape closes"),
		`v  Raw ↔ Pseudo  ·  ${prefs.view === "pseudo" ? "Pseudo" : "Raw"}`,
		SHELL_VIZ_LAYERS.map(layer => `${layer}:${prefs.layers[layer] ? "on" : "off"}`).join("  "),
		`c/i/d/e/u layers · s split:${prefs.split ? "on" : "off"} · ↑↓/Tab select · Enter details · PgUp/PgDn scroll`,
		`Space ${prefs.playing ? "pause" : "play"} · ←/→ step · r reset · l live · Home/End seek · −/+ speed ${prefs.speed}× · ${formatDuration(timeline.elapsedNs / 1_000_000)} / ${formatDuration(timeline.durationNs / 1_000_000)}`,
	];
	const body = shellVizRows(presentation, theme, width);
	const detail = detailLines(presentation).flatMap(line => wrap(line, Math.max(1, width)));
	const height = Math.max(8, model.host.height());
	const detailHeight = Math.min(detail.length, Math.floor(height / 3));
	model.detailScroll = Math.max(0, Math.min(model.detailScroll, detail.length - detailHeight));
	const available = Math.max(1, height - header.length - detailHeight - (detailHeight ? 1 : 0));
	model.scroll = Math.max(0, Math.min(model.scroll, body.length - available));
	const rows = [...header, ...body.slice(model.scroll, model.scroll + available)];
	if (detailHeight > 0) {
		const from = model.detailScroll;
		rows.push(
			theme.fg("dim", `Selected details ${from + 1}–${from + detailHeight}/${detail.length} · [/] scroll`),
			...detail.slice(from, from + detailHeight),
		);
	}
	return rows.map(line => truncate(line, width));
}

function paintInspector(node: { props(): unknown }, cx: { theme: Theme; width: number }): Block {
	const model = (node.props() as { term?: { inspector?: ShellVisualizerModel } }).term?.inspector;
	return { rows: model ? inspectorRows(model, cx.theme, cx.width) : [] };
}

defineRolePainter("shell", INSPECTOR_ROLE, paintInspector);
defineRolePainter("canvas", INSPECTOR_ROLE, paintInspector);
