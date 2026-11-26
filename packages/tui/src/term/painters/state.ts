/** Per-node terminal state shared by a kind's painter and widget. */
import type { UiNode } from "../../node";
import { type Signal, signal } from "../../reactive";
import { widgetState } from "../widgets";

/** The node's state `name`, created on first use (so a painter reading it subscribes before the widget writes it). */
export function nodeState<T>(node: UiNode, name: string, init: () => T): Signal<T> {
	const map = widgetState(node);
	let value = map.get(name) as Signal<T> | undefined;
	if (!value) {
		value = signal(init());
		map.set(name, value as Signal<unknown>);
	}
	return value;
}
