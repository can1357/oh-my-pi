import type { ShellVizPresentation } from "@oh-my-pi/pi-wire";
import { matchesKey } from "../keys";
import { node } from "../native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { formatDuration } from "../render/render-utils";
import { theme } from "../theme/theme";
import type { Component } from "../tui";
import { truncateToWidth, wrapTextWithAnsi } from "../utils";
import { SHELL_VIZ_LAYERS, SHELL_VIZ_VIEWS, shellVizEventAction } from "../tools/shell-trace";
import { renderShellVisualization, shellVizText } from "../tools/shell-viz-render";

/** Focused inspector host; state and replay timers remain owned by the transcript tool call. */
export interface ShellVisualizerHost {
	presentation(): ShellVizPresentation | undefined;
	replayEpoch(): number;
	liveOrigin(): boolean;
	action(value: string): void;
	close(): void;
	requestRender(): void;
	height(): number;
}

/** Keyboard and native inspector for the exact presentation shown in the transcript. */
export class ShellVisualizer implements Component {
	#scroll = 0;
	#detailScroll = 0;
	constructor(readonly host: ShellVisualizerHost) {}
	invalidate(): void {}
	handleInput(data: string): void {
		const presentation = this.host.presentation();
		if (matchesKey(data, "escape") || data === "q") {
			this.host.close();
			return;
		}
		if (!presentation) return;
		const prefs = presentation.preferences;
		const view = Number(data) - 1;
		if (data === "v") {
			this.#scroll = 0;
			this.host.action(`view:${prefs.view === "raw" ? "pseudo" : "raw"}`);
		} else if (/^[1-2]$/.test(data) && SHELL_VIZ_VIEWS[view]) {
			this.#scroll = 0;
			this.host.action(`view:${SHELL_VIZ_VIEWS[view]}`);
		} else if (data === "c") this.host.action("layer:color");
		else if (data === "i") this.host.action("layer:inline");
		else if (data === "d") this.host.action("layer:idioms");
		else if (data === "e") this.host.action("layer:effects");
		else if (data === "u") this.host.action("layer:unwrap");
		else if (data === "s") this.host.action("split");
		else if (data === " ") this.host.action(prefs.playing ? "pause" : "play");
		else if (data === "." || matchesKey(data, "right")) this.host.action("step");
		else if (matchesKey(data, "left")) this.host.action(`seek:${Math.max(0, presentation.timeline.cursor - 1)}`);
		else if (data === "r") this.host.action("reset");
		else if (data === "l") this.host.action("live");
		else if (data === "+" || data === "=") this.host.action(`speed:${prefs.speed < 1 ? 1 : prefs.speed < 2 ? 2 : 4}`);
		else if (data === "-") this.host.action(`speed:${prefs.speed > 2 ? 2 : prefs.speed > 1 ? 1 : 0.5}`);
		else if (matchesKey(data, "home")) this.host.action("seek:0");
		else if (matchesKey(data, "end")) this.host.action(`seek:${presentation.timeline.length}`);
		else if (data === "[") this.#detailScroll = Math.max(0, this.#detailScroll - 1);
		else if (data === "]") this.#detailScroll++;
		else if (matchesKey(data, "pageDown")) this.#scroll += Math.max(1, this.host.height() - 8);
		else if (matchesKey(data, "pageUp"))
			this.#scroll = Math.max(0, this.#scroll - Math.max(1, this.host.height() - 8));
		else if (
			matchesKey(data, "up") ||
			data === "k" ||
			matchesKey(data, "down") ||
			data === "j" ||
			matchesKey(data, "tab")
		) {
			const nodes = [
				...new Set(
					presentation.rows.flatMap(row => [
						...(row.node === undefined ? [] : [row.node]),
						...row.segments.flatMap(segment => (segment.node === undefined ? [] : [segment.node])),
					]),
				),
			];
			const index = nodes.findIndex(node => node === prefs.selectedNode);
			const direction = matchesKey(data, "up") || data === "k" ? -1 : 1;
			const selected = nodes[(index + direction + nodes.length) % nodes.length];
			if (selected !== undefined) {
				this.#detailScroll = 0;
				this.host.action(`select:${selected}`);
			}
		} else if (matchesKey(data, "enter") && prefs.selectedNode !== undefined) {
			this.#detailScroll = 0;
			this.host.action(`expand:${prefs.selectedNode}`);
		}
		this.host.requestRender();
	}
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.act === "close") {
			this.host.close();
			return;
		}
		const presentation = this.host.presentation();
		const action = presentation && shellVizEventAction(event, presentation.preferences);
		if (action) this.host.action(action);
	}
	describe(cx: DescribeContext): NativeNode {
		const presentation = this.host.presentation();
		if (presentation && cx.supports("shell"))
			return node("shell", {
				presentation,
				lang: "bash",
				inspector: true,
				replayEpoch: this.host.replayEpoch(),
				liveOrigin: this.host.liveOrigin(),
			});
		return node("rows", { cols: cx.cols, lines: this.render(cx.cols) });
	}
	render(width: number): string[] {
		const presentation = this.host.presentation();
		if (!presentation) return ["No complete bash command available", "Escape closes"];
		const prefs = presentation.preferences;
		const headings = `v  Raw ↔ Pseudo  ·  ${prefs.view === "pseudo" ? "Pseudo" : "Raw"}`;
		const layers = SHELL_VIZ_LAYERS.map(layer => `${layer}:${prefs.layers[layer] ? "on" : "off"}`).join("  ");
		const header = [
			theme.bold("Bash visualizer  ·  Escape closes"),
			headings,
			layers,
			`c/i/d/e/u layers · s split:${prefs.split ? "on" : "off"} · ↑↓/Tab select · Enter details · PgUp/PgDn scroll`,
			`Space ${prefs.playing ? "pause" : "play"} · ←/→ step · r reset · l live · Home/End seek · −/+ speed ${prefs.speed}× · ${formatDuration(presentation.timeline.elapsedNs / 1_000_000)} / ${formatDuration(presentation.timeline.durationNs / 1_000_000)}`,
		];
		const body = renderShellVisualization(presentation, theme, width);
		const selected = presentation.rows.find(
			row => row.node === prefs.selectedNode || row.segments.some(segment => segment.node === prefs.selectedNode),
		);
		const detail: string[] = [];
		if (selected) {
			if (selected.detail) detail.push(shellVizText(selected.detail));
			for (const segment of selected.segments) {
				if (segment.tip) detail.push(shellVizText(segment.tip));
				const node = segment.node ?? selected.node;
				if (segment.expanded && node !== undefined && prefs.expandedNodes.includes(node))
					detail.push(...segment.expanded.split("\n").map(shellVizText));
			}
			for (const variable of selected.annotations ?? []) {
				detail.push(
					`${shellVizText(variable.name)} = ${shellVizText(JSON.stringify(variable.value))}${variable.scope ? ` (${shellVizText(variable.scope)})` : ""}${variable.fullLength !== undefined && variable.fullLength > Buffer.byteLength(variable.value, "utf8") ? ` [${variable.fullLength} bytes; retained value truncated]` : ""}`,
				);
			}
			for (const effect of selected.effects)
				detail.push(`${shellVizText(effect.label)}: ${shellVizText(effect.why)}`);
		}
		const height = Math.max(8, this.host.height());
		const wrappedDetail = detail.flatMap(line => wrapTextWithAnsi(line, Math.max(1, width)));
		const detailHeight = Math.min(wrappedDetail.length, Math.floor(height / 3));
		this.#detailScroll = Math.max(0, Math.min(this.#detailScroll, wrappedDetail.length - detailHeight));
		const available = Math.max(1, height - header.length - detailHeight - (detailHeight ? 1 : 0));
		this.#scroll = Math.max(0, Math.min(this.#scroll, body.length - available));
		return [
			...header,
			...body.slice(this.#scroll, this.#scroll + available),
			...(detailHeight
				? [
						theme.fg(
							"dim",
							`Selected details ${this.#detailScroll + 1}–${this.#detailScroll + detailHeight}/${wrappedDetail.length} · [/] scroll`,
						),
						...wrappedDetail.slice(this.#detailScroll, this.#detailScroll + detailHeight),
					]
				: []),
		].map(line => truncateToWidth(line, width));
	}
}
