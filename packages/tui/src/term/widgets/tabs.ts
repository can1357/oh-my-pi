/**
 * `tabs` input: ←/→ and Tab/Shift+Tab step to the neighbouring tab (wrapping,
 * skipping muted ones) and send `select` with its id, as a click on it does.
 */
import type { TspTabsProps } from "@oh-my-pi/pi-wire";
import type { UiNode } from "../../node";
import { defineWidget, type WidgetContext } from "../widgets";

function isMuted(label: TspTabsProps["items"][number]["label"]): boolean {
	return typeof label !== "string" && label.some(span => span.s?.split(" ").includes("muted"));
}

function step(node: UiNode, delta: -1 | 1, cx: WidgetContext): boolean {
	const props = node.props() as TspTabsProps;
	const items = props.items;
	if (items.length === 0) return false;
	const at = Math.max(
		0,
		items.findIndex(item => item.id === props.active),
	);
	for (let n = 1; n <= items.length; n++) {
		const item = items[(((at + delta * n) % items.length) + items.length) % items.length]!;
		if (isMuted(item.label)) continue;
		if (item.id !== props.active) cx.emit({ type: "select", key: cx.keypath, item: item.id });
		return true;
	}
	return true;
}

defineWidget("tabs", {
	key(node, key, cx) {
		if (key.kind === "release") return false;
		if (key.id === "right" || key.id === "tab") return step(node, 1, cx);
		if (key.id === "left" || key.id === "shift+tab") return step(node, -1, cx);
		return false;
	},
});
