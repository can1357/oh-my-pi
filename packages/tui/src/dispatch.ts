/**
 * Event delivery shared by both backends: locating a node in a surface and
 * bubbling events up from it.
 */
import type { KeyEvent, PasteEvent, UiEvent } from "./events";
import type { UiNode } from "./node";

/**
 * The nodes from a region root down to `target` (inclusive), searching
 * `roots` depth-first; empty when `target` is not in the tree.
 */
export function pathTo(roots: readonly UiNode[], target: UiNode): UiNode[] {
	const path: UiNode[] = [];
	const visit = (node: UiNode): boolean => {
		path.push(node);
		if (node === target) return true;
		for (const child of node.children()) if (visit(child)) return true;
		path.pop();
		return false;
	};
	for (const root of roots) if (visit(root)) return path;
	return [];
}

/** `node`'s keypath below the first node of `path` (`key` or child index per level, joined by `/`). */
export function keypathOf(path: readonly UiNode[]): string {
	const segments: string[] = [];
	for (let i = 1; i < path.length; i++) {
		const node = path[i]!;
		const key = node.key();
		segments.push(key ?? String(path[i - 1]!.children().indexOf(node)));
	}
	return segments.join("/");
}

/** Call `node`'s handler for `event`; true when it had one. */
function deliver(node: UiNode, event: UiEvent): boolean {
	const h = node.handlers;
	switch (event.type) {
		case "toggle":
			if (h.onToggle) return (h.onToggle(event.collapsed, event), true);
			break;
		case "select":
			if (h.onSelect) return (h.onSelect(event.item, event), true);
			break;
		case "activate":
			if (h.onActivate) return (h.onActivate(event.item, event), true);
			break;
		case "action":
			if (h.onAction) return (h.onAction(event.act, event), true);
			break;
		case "change":
			if (h.onChange) return (h.onChange(event), true);
			break;
		case "edit":
			if (h.onEdit) return (h.onEdit(event), true);
			break;
		case "undo":
			if (h.onUndo) return (h.onUndo(event), true);
			break;
		case "send":
			if (h.onSend) return (h.onSend(event.text, event), true);
			break;
		case "focus":
			if (h.onFocus) return (h.onFocus(event), true);
			break;
	}
	if (h.onEvent) return (h.onEvent(event), true);
	return false;
}

/**
 * Deliver `event` to the last node of `path` or, DOM-style, the nearest
 * ancestor with a handler for its type. Returns whether a node handled it.
 */
export function bubbleEvent(path: readonly UiNode[], event: UiEvent): boolean {
	for (let i = path.length - 1; i >= 0; i--) if (deliver(path[i]!, event)) return true;
	return false;
}

/** Offer `key` to `onKey` handlers from the last node of `path` upward; true once one returns true. */
export function bubbleKey(path: readonly UiNode[], key: KeyEvent): boolean {
	for (let i = path.length - 1; i >= 0; i--) if (path[i]!.handlers.onKey?.(key) === true) return true;
	return false;
}

/** Offer `paste` to `onPaste` handlers from the last node of `path` upward; true once one returns true. */
export function bubblePaste(path: readonly UiNode[], paste: PasteEvent): boolean {
	for (let i = path.length - 1; i >= 0; i--) if (path[i]!.handlers.onPaste?.(paste) === true) return true;
	return false;
}
