/**
 * The JSX factory.
 *
 * - A lowercase tag is a node kind (a TSP kind or `canvas`): it builds a
 *   {@link UiNode} whose props and children stay reactive.
 * - Any other function is a component: called once, untracked, with its props
 *   as given (accessors stay accessors, so forwarding keeps them reactive).
 *
 * There is no compiler: children are evaluated before their parent, and an
 * expression is reactive only when it is a function. `{count}` and
 * `{() => count() + 1}` update; `{count()}` is read once.
 */
import { UiNode, type UiKind } from "./node";
import { untrack } from "./reactive";
import type { JSXNode } from "./types";

/** `<>…</>`: its children, as a list. */
export function Fragment(props: { children?: JSXNode }): JSXNode {
	return props.children;
}

type Props = Readonly<Record<string, unknown>>;
type FunctionComponent = (props: Props) => JSXNode;

/** Automatic-runtime entry: one element. `key` is the attribute when written before a spread. */
export function jsx(type: unknown, props: Props, key?: string): JSXNode {
	if (typeof type === "string") return new UiNode(type as UiKind, props, key);
	if (typeof type !== "function") throw new TypeError(`JSX: invalid element type ${String(type)}`);
	if (type === Fragment) return props.children as JSXNode;
	const component = type as FunctionComponent;
	return untrack(() => component(props));
}

/** Automatic-runtime entry for elements with static child arrays. */
export const jsxs = jsx;
