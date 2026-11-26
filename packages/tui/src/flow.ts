/**
 * Control flow: conditional and list regions.
 *
 * Each returns a dynamic region (an accessor) the parent resolves in place.
 * Static JSX children are evaluated before the control-flow element runs, so
 * they are created once and kept across toggles; pass a function child to
 * create the branch only while it shows (and afresh each time it shows).
 */
import {
	type Accessor,
	createRoot,
	isAccessor,
	onCleanup,
	type Reactive,
	read,
	signal,
	structural,
	untrack,
} from "./reactive";
import { jsx } from "./element";
import type { JSXNode } from "./types";

/** A child that is either a node, or a function building it from the narrowed value. */
type Branch<T> = JSXNode | ((value: T) => JSXNode);

function isBuilder<T>(branch: Branch<T>): branch is (value: T) => JSXNode {
	return typeof branch === "function" && branch.length > 0;
}

/** `children` while `when` is truthy, else `fallback`. A builder child receives the truthy value. */
export function Show<T>(props: {
	when: Reactive<T | undefined | null | false | 0 | "">;
	fallback?: JSXNode;
	children: Branch<NonNullable<T>>;
}): JSXNode {
	const children = props.children;
	const builder = isBuilder(children);
	const value = structural(() => read(props.when), builder ? undefined : { equals: (a, b) => !a === !b });
	return () => {
		const current = value();
		if (!current) return props.fallback;
		return builder ? untrack(() => children(current as NonNullable<T>)) : children;
	};
}

/** One branch of a {@link Switch}. */
export interface MatchCase {
	readonly when: Accessor<unknown>;
	readonly children: Branch<unknown>;
}

const kMatch = Symbol("jsx.match");

interface MatchElement extends MatchCase {
	readonly [kMatch]: true;
}

/** A {@link Switch} branch: shown when it is the first whose `when` is truthy. */
export function Match<T>(props: {
	when: Reactive<T | undefined | null | false | 0 | "">;
	children: Branch<NonNullable<T>>;
}): JSXNode {
	const element: MatchElement = {
		[kMatch]: true,
		when: () => read(props.when),
		children: props.children as Branch<unknown>,
	};
	// A Match only means something inside a Switch, which reads it as a case.
	return element as unknown as JSXNode;
}

function isMatch(value: unknown): value is MatchElement {
	return typeof value === "object" && value !== null && kMatch in value;
}

/** The first {@link Match} whose `when` is truthy, else `fallback`. */
export function Switch(props: { fallback?: JSXNode; children: JSXNode }): JSXNode {
	const cases = (Array.isArray(props.children) ? props.children.flat(Infinity) : [props.children]).filter(isMatch);
	const selected = structural(
		() => {
			for (let i = 0; i < cases.length; i++) {
				const value = cases[i]!.when();
				if (value) return { index: i, value };
			}
			return { index: -1, value: undefined };
		},
		{
			equals: (a, b) =>
				a.index === b.index && (a.index === -1 || !isBuilder(cases[a.index]!.children) || a.value === b.value),
		},
	);
	return () => {
		const { index, value } = selected();
		if (index === -1) return props.fallback;
		const branch = cases[index]!.children;
		return isBuilder(branch) ? untrack(() => branch(value)) : branch;
	};
}

interface Mapped<T> {
	item: T;
	node: JSXNode;
	index: (value: number) => void;
	dispose: () => void;
}

function stable(node: JSXNode): JSXNode {
	return typeof node === "function" ? structural(node) : node;
}

/**
 * One child per item, keyed by item identity: an item that stays keeps its
 * node (only its index updates), a new item is mapped once, a removed one is
 * disposed.
 */
export function For<T>(props: {
	each: Reactive<readonly T[] | undefined | null>;
	fallback?: JSXNode;
	children: (item: T, index: Accessor<number>) => JSXNode;
}): JSXNode {
	let entries: Mapped<T>[] = [];
	onCleanup(() => {
		for (const entry of entries) entry.dispose();
		entries = [];
	});
	const mapped = structural(() => {
		const items = read(props.each) ?? [];
		return untrack(() => {
			const pool = new Map<T, Mapped<T>[]>();
			for (const entry of entries) {
				const list = pool.get(entry.item);
				if (list) list.push(entry);
				else pool.set(entry.item, [entry]);
			}
			const next: Mapped<T>[] = [];
			for (let i = 0; i < items.length; i++) {
				const item = items[i]!;
				const reused = pool.get(item)?.shift();
				if (reused) {
					reused.index(i);
					next.push(reused);
					continue;
				}
				next.push(
					createRoot(dispose => {
						const index = signal(i);
						return { item, node: stable(props.children(item, index)), index: index.set, dispose };
					}),
				);
			}
			for (const list of pool.values()) for (const entry of list) entry.dispose();
			entries = next;
			return next.map(entry => entry.node);
		});
	});
	return () => {
		const nodes = mapped();
		return nodes.length > 0 ? nodes : props.fallback;
	};
}

/**
 * One child per index: the node at an index stays while the list keeps that
 * length and its item accessor updates in place. For lists of values without
 * stable identity (strings, numbers, rebuilt records).
 */
export function Index<T>(props: {
	each: Reactive<readonly T[] | undefined | null>;
	fallback?: JSXNode;
	children: (item: Accessor<T>, index: number) => JSXNode;
}): JSXNode {
	let entries: { node: JSXNode; item: (value: T) => void; dispose: () => void }[] = [];
	onCleanup(() => {
		for (const entry of entries) entry.dispose();
		entries = [];
	});
	const mapped = structural(() => {
		const items = read(props.each) ?? [];
		return untrack(() => {
			for (let i = 0; i < Math.min(items.length, entries.length); i++) entries[i]!.item(items[i]!);
			for (const entry of entries.splice(items.length)) entry.dispose();
			for (let i = entries.length; i < items.length; i++) {
				entries.push(
					createRoot(dispose => {
						const item = signal<T>(items[i]!);
						return { node: stable(props.children(item, i)), item: item.set, dispose };
					}),
				);
			}
			return entries.map(entry => entry.node);
		});
	});
	return () => {
		const nodes = mapped();
		return nodes.length > 0 ? nodes : props.fallback;
	};
}

/** An element type {@link Dynamic} can build. */
export type DynamicType<P> = ((props: P) => JSXNode) | string;

/**
 * The element `component` names (a component function or a node kind),
 * rebuilt whenever it changes; nothing while it is undefined. A changing
 * `component` must be a branded accessor (`signal`, `computed`, `derived`):
 * a bare function is the component itself.
 */
export function Dynamic<P extends object>(
	props: P & { component: DynamicType<P> | Accessor<DynamicType<P> | undefined> | undefined },
): JSXNode {
	const { component, ...rest } = props;
	const current = structural(() => (isAccessor(component) ? component() : component));
	return () => {
		const type = current();
		return type ? untrack(() => jsx(type, rest)) : null;
	};
}
