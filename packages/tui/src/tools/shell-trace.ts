import type { ShellVizLayer, ShellVizPreferences, ShellVizView } from "@oh-my-pi/pi-wire";
import type { NativeUiEvent } from "../native/node";
import { isShellVizNode } from "./shell-viz";

/** Canonical ordered views used by the inspector and native event adapter. */
export const SHELL_VIZ_VIEWS: readonly ShellVizView[] = ["raw", "pseudo"];
/** Canonical toggleable semantic layers. */
export const SHELL_VIZ_LAYERS: readonly ShellVizLayer[] = ["color", "inline", "idioms", "effects", "unwrap"];

/** Normalize action/change/selection events to the shared action vocabulary. */
export function shellVizEventAction(event: NativeUiEvent, preferences: ShellVizPreferences): string | undefined {
	if (event.type === "action") return event.act === "shell-viz" ? event.value : undefined;
	if (event.type === "select") return event.item.startsWith("select:") ? event.item : `select:${event.item}`;
	if (event.type !== "change") return undefined;
	const { item, value } = event;
	if ((item === "select" || item === "expand") && isShellVizNode(value)) return `${item}:${value}`;
	if (typeof value === "string" && value.includes(":")) return value;
	if (item === "shell-viz" && typeof value === "string") return value;
	if (item === "split" && typeof value === "boolean") return value === preferences.split ? undefined : "split";
	const layer = SHELL_VIZ_LAYERS.find(layer => item === layer || item === `layer:${layer}`);
	if (layer && typeof value === "boolean") return value === preferences.layers[layer] ? undefined : `layer:${layer}`;
	if (item.startsWith("view:") && value === true) return item;
	if (item === "cursor" || item === "seek") return `seek:${String(value)}`;
	return `${item}:${String(value)}`;
}

/** Apply shared actions; node keys remain opaque and playback values remain numeric. */
export function changeShellVizPreferences(
	preferences: ShellVizPreferences,
	action: string,
	length: number,
): ShellVizPreferences {
	const next = { ...preferences, layers: { ...preferences.layers }, expandedNodes: [...preferences.expandedNodes] };
	if (action.startsWith("view:")) {
		const view = SHELL_VIZ_VIEWS.find(item => action === `view:${item}`);
		if (view) next.view = view;
	} else if (action.startsWith("layer:")) {
		const layer = SHELL_VIZ_LAYERS.find(item => action === `layer:${item}`);
		if (layer) next.layers[layer] = !next.layers[layer];
	} else if (action === "split") next.split = !next.split;
	else if (action === "play") {
		next.playing = length > 0;
		if (next.cursor === undefined || next.cursor >= length) next.cursor = 0;
	} else if (action === "pause") next.playing = false;
	else if (action === "step") {
		next.playing = false;
		next.cursor = Math.min(length, (next.cursor ?? length) + 1);
	} else if (action === "reset") {
		next.playing = false;
		next.cursor = 0;
	} else if (action === "live") {
		next.playing = false;
		delete next.cursor;
	} else if (action.startsWith("select:") || action.startsWith("expand:")) {
		const separator = action.indexOf(":");
		const key = action.slice(separator + 1);
		if (!isShellVizNode(key)) return preferences;
		if (action.startsWith("select:")) next.selectedNode = key;
		else
			next.expandedNodes = next.expandedNodes.includes(key)
				? next.expandedNodes.filter(node => node !== key)
				: [...next.expandedNodes, key];
	} else {
		const match = /^(speed|seek):([0-9]+(?:\.[0-9]+)?)$/.exec(action);
		if (!match) return preferences;
		const value = Number(match[2]);
		if (!Number.isFinite(value)) return preferences;
		if (match[1] === "speed") {
			if (![0.5, 1, 2, 4].includes(value)) return preferences;
			next.speed = value;
		} else {
			if (!Number.isSafeInteger(value)) return preferences;
			if (match[1] === "seek") {
				next.cursor = Math.max(0, Math.min(length, value));
				next.playing = false;
			}
		}
	}
	return next;
}
