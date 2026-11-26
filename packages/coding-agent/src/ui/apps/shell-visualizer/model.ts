/**
 * The bash visualizer's inspector: keys and native events turned into the
 * shared shell-viz action vocabulary (`view:raw`, `layer:color`, `select:<node>`,
 * `seek:3`, …) for the host that owns the presentation and replay, plus the
 * terminal's own scroll positions (body and selected-details pane).
 */
import { signal } from "@oh-my-pi/pi-tui";
import type { UiEvent } from "@oh-my-pi/pi-tui";
import type { ShellVizLayer, ShellVizPreferences, ShellVizPresentation, ShellVizView } from "@oh-my-pi/pi-wire";
import { isShellVizNode } from "../../../tools/shell-viz";

/** Views in key order (`1`, `2`). */
export const SHELL_VIZ_VIEWS: readonly ShellVizView[] = ["raw", "pseudo"];
/** Toggleable semantic layers in display order. */
export const SHELL_VIZ_LAYERS: readonly ShellVizLayer[] = ["color", "inline", "idioms", "effects", "unwrap"];
const SPEEDS = [0.5, 1, 2, 4];

/** What the tool call that owns the presentation gives its inspector (state and replay stay the call's). */
export interface ShellInspectorSource {
	presentation(): ShellVizPresentation | undefined;
	replayEpoch(): number;
	liveOrigin(): boolean;
	/** Apply a shell-viz action to the presentation. */
	action(value: string): void;
	close(): void;
}

/** What the inspector needs: its source and the screen it fills. */
export interface ShellVisualizerHost extends ShellInspectorSource {
	/** Screen rows the inspector fills. */
	height(): number;
}

/** A native shell-node event as a shell-viz action (undefined: nothing to do). */
export function shellVizEventAction(event: UiEvent, preferences: ShellVizPreferences): string | undefined {
	if (event.type === "action") return event.act === "shell-viz" ? event.value : undefined;
	if (event.type === "select") return event.item.startsWith("select:") ? event.item : `select:${event.item}`;
	if (event.type !== "change" || !("item" in event)) return undefined;
	const { item, value } = event;
	if ((item === "select" || item === "expand") && isShellVizNode(value)) return `${item}:${value}`;
	if (typeof value === "string" && value.includes(":")) return value;
	if (item === "shell-viz" && typeof value === "string") return value;
	if (item === "split" && typeof value === "boolean") return value === preferences.split ? undefined : "split";
	const layer = SHELL_VIZ_LAYERS.find(name => item === name || item === `layer:${name}`);
	if (layer && typeof value === "boolean") return value === preferences.layers[layer] ? undefined : `layer:${layer}`;
	if (item.startsWith("view:") && value === true) return item;
	if (item === "cursor" || item === "seek") return `seek:${String(value)}`;
	return `${item}:${String(value)}`;
}

/** Preferences after a shell-viz action over a timeline `length` steps long (unknown actions change nothing). */
export function applyShellVizAction(
	preferences: ShellVizPreferences,
	action: string,
	length: number,
): ShellVizPreferences {
	const next: ShellVizPreferences = {
		...preferences,
		layers: { ...preferences.layers },
		expandedNodes: [...preferences.expandedNodes],
	};
	const separator = action.indexOf(":");
	const verb = separator < 0 ? action : action.slice(0, separator);
	const arg = separator < 0 ? "" : action.slice(separator + 1);
	switch (verb) {
		case "view": {
			const view = SHELL_VIZ_VIEWS.find(name => name === arg);
			if (view) next.view = view;
			return next;
		}
		case "layer": {
			const layer = SHELL_VIZ_LAYERS.find(name => name === arg);
			if (layer) next.layers[layer] = !next.layers[layer];
			return next;
		}
		case "split":
			next.split = !next.split;
			return next;
		case "play":
			next.playing = length > 0;
			if (next.cursor === undefined || next.cursor >= length) next.cursor = 0;
			return next;
		case "pause":
			next.playing = false;
			return next;
		case "step":
			next.playing = false;
			next.cursor = Math.min(length, (next.cursor ?? length) + 1);
			return next;
		case "reset":
			next.playing = false;
			next.cursor = 0;
			return next;
		case "live":
			next.playing = false;
			delete next.cursor;
			return next;
		case "select":
		case "expand":
			if (!isShellVizNode(arg)) return preferences;
			if (verb === "select") next.selectedNode = arg;
			else {
				next.expandedNodes = next.expandedNodes.includes(arg)
					? next.expandedNodes.filter(node => node !== arg)
					: [...next.expandedNodes, arg];
			}
			return next;
		case "speed":
		case "seek": {
			if (!/^[0-9]+(?:\.[0-9]+)?$/.test(arg)) return preferences;
			const value = Number(arg);
			if (verb === "speed") {
				if (!SPEEDS.includes(value)) return preferences;
				next.speed = value;
			} else {
				if (!Number.isSafeInteger(value)) return preferences;
				next.cursor = Math.max(0, Math.min(length, value));
				next.playing = false;
			}
			return next;
		}
	}
	return preferences;
}

/** Nodes a selection steps through: each row's node, then its segments', first occurrence only. */
function selectableNodes(presentation: ShellVizPresentation): string[] {
	const nodes = new Set<string>();
	for (const row of presentation.rows) {
		if (row.node !== undefined) nodes.add(row.node);
		for (const segment of row.segments) if (segment.node !== undefined) nodes.add(segment.node);
	}
	return [...nodes];
}

export class ShellVisualizerModel {
	readonly host: ShellVisualizerHost;
	/** First body row the terminal shows (clamped while painting). */
	scroll = 0;
	/** First selected-details row the terminal shows (clamped while painting). */
	detailScroll = 0;
	readonly #version = signal(0);

	constructor(host: ShellVisualizerHost) {
		this.host = host;
	}

	/** The host's presentation, re-read after every action. */
	presentation(): ShellVizPresentation | undefined {
		this.#version();
		return this.host.presentation();
	}

	#changed(): void {
		this.#version.update(n => n + 1);
	}

	key(id: string): boolean {
		if (id === "escape" || id === "q") {
			this.host.close();
			return true;
		}
		const presentation = this.host.presentation();
		if (!presentation) return false;
		const prefs = presentation.preferences;
		const act = (value: string) => this.host.action(value);
		const page = Math.max(1, this.host.height() - 8);
		switch (id) {
			case "v":
				this.scroll = 0;
				act(`view:${prefs.view === "raw" ? "pseudo" : "raw"}`);
				break;
			case "1":
			case "2":
				this.scroll = 0;
				act(`view:${SHELL_VIZ_VIEWS[Number(id) - 1]}`);
				break;
			case "c":
			case "i":
			case "d":
			case "e":
			case "u":
				act(`layer:${{ c: "color", i: "inline", d: "idioms", e: "effects", u: "unwrap" }[id]}`);
				break;
			case "s":
				act("split");
				break;
			case "space":
				act(prefs.playing ? "pause" : "play");
				break;
			case ".":
			case "right":
				act("step");
				break;
			case "left":
				act(`seek:${Math.max(0, presentation.timeline.cursor - 1)}`);
				break;
			case "r":
				act("reset");
				break;
			case "l":
				act("live");
				break;
			case "+":
			case "=":
				act(`speed:${prefs.speed < 1 ? 1 : prefs.speed < 2 ? 2 : 4}`);
				break;
			case "-":
				act(`speed:${prefs.speed > 2 ? 2 : prefs.speed > 1 ? 1 : 0.5}`);
				break;
			case "home":
				act("seek:0");
				break;
			case "end":
				act(`seek:${presentation.timeline.length}`);
				break;
			case "[":
				this.detailScroll = Math.max(0, this.detailScroll - 1);
				break;
			case "]":
				this.detailScroll++;
				break;
			case "pageDown":
				this.scroll += page;
				break;
			case "pageUp":
				this.scroll = Math.max(0, this.scroll - page);
				break;
			case "up":
			case "k":
			case "down":
			case "j":
			case "tab": {
				const nodes = selectableNodes(presentation);
				const index = nodes.indexOf(prefs.selectedNode ?? "");
				const step = id === "up" || id === "k" ? -1 : 1;
				const selected = nodes[(index + step + nodes.length) % nodes.length];
				if (selected !== undefined) {
					this.detailScroll = 0;
					act(`select:${selected}`);
				}
				break;
			}
			case "enter":
				if (prefs.selectedNode !== undefined) {
					this.detailScroll = 0;
					act(`expand:${prefs.selectedNode}`);
				}
				break;
			default:
				return false;
		}
		this.#changed();
		return true;
	}

	/** A native event: the close button, else a shell-viz action. */
	event(event: UiEvent): void {
		if (event.type === "action" && event.act === "close") {
			this.host.close();
			return;
		}
		const presentation = this.host.presentation();
		const action = presentation && shellVizEventAction(event, presentation.preferences);
		if (action) this.host.action(action);
		this.#changed();
	}
}
