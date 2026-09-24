import { untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { Page } from "puppeteer-core";
import { requireReactHookResult } from "./devtools-hook";

/** Options controlling React component tree traversal. */
export interface ReactTreeOptions {
	maxDepth?: number;
	includeHost?: boolean;
}

/** A bounded React component entry with nested rendered children. */
export interface ReactTreeNode {
	id: number;
	name: string;
	type: string;
	key?: string;
	props: Record<string, unknown>;
	children: ReactTreeNode[];
}

/** One hook state entry returned by React component inspection. */
export interface ReactHookState {
	index: number;
	kind: string;
	value: unknown;
}

/** Source metadata available on a development React fiber. */
export interface ReactSourceInfo {
	fileName?: string;
	lineNumber?: number;
	columnNumber?: number;
	owner?: string;
}

/** Bounded details for one React fiber selected by its tree id. */
export interface ReactInspectResult {
	name: string;
	props: unknown;
	state?: unknown | ReactHookState[];
	source?: ReactSourceInfo;
	domSelector?: string;
}

interface ReactPageEnvelope<T> {
	missingHook?: boolean;
	notFound?: boolean;
	value?: T;
}

const TREE_SOURCE_PREFIX = `(() => {
	const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
	if (!hook || !hook.__ompReact) return { missingHook: true };
	const internals = hook.__ompReact;
	const options = `;

const TREE_SOURCE_SUFFIX = `;
	const maxDepth = Number.isFinite(options.maxDepth) ? Math.max(0, Math.min(100, Math.floor(options.maxDepth))) : 20;
	const primitive = value => {
		if (value === null || typeof value === "boolean" || typeof value === "number") return value;
		if (typeof value === "string") return value.length > 160 ? value.slice(0, 157) + "..." : value;
		if (typeof value === "undefined") return "undefined";
		if (typeof value === "function") return "[Function]";
		if (Array.isArray(value)) return "[Array(" + value.length + ")]";
		return "[Object]";
	};
	const summarizeProps = props => {
		if (!props || typeof props !== "object") return {};
		const summary = {};
		const keys = Object.keys(props).filter(key => key !== "children").slice(0, 20);
		for (const key of keys) {
			try { summary[key] = primitive(props[key]); } catch { summary[key] = "[Unavailable]"; }
		}
		if (Object.keys(props).filter(key => key !== "children").length > keys.length) summary["..."] = "truncated";
		return summary;
	};
	const visit = (fiber, depth) => {
		if (!fiber || depth > maxDepth) return [];
		const kind = internals.fiberType(fiber);
		const internalWrapper = kind === "fragment" || kind === "mode" || kind === "offscreen";
		const include =
			fiber.tag !== 3 &&
			fiber.tag !== 6 &&
			!internalWrapper &&
			(options.includeHost === true || kind !== "host");
		let children = [];
		let child = fiber.child;
		while (child) {
			children.push(...visit(child, include ? depth + 1 : depth));
			child = child.sibling;
		}
		if (!include) return children;
		const name = internals.fiberName(fiber) || kind;
		const node = {
			id: internals.getFiberId(fiber),
			name,
			type: kind,
			props: summarizeProps(fiber.memoizedProps),
			children,
		};
		if (fiber.key != null) node.key = String(fiber.key);
		return [node];
	};
	const value = [];
	for (const rendererRoots of internals.roots.values()) {
		for (const root of rendererRoots) value.push(...visit(root && root.current, 0));
	}
	return { value };
})()`;

const INSPECT_SOURCE_PREFIX = `(() => {
	const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
	if (!hook || !hook.__ompReact) return { missingHook: true };
	const internals = hook.__ompReact;
	const fiber = internals.fibersById.get(`;

const INSPECT_SOURCE_SUFFIX = `);
	if (!fiber) return { notFound: true };
	const bounded = (value, depth, seen) => {
		if (value === null || typeof value === "boolean" || typeof value === "number") return value;
		if (typeof value === "string") return value.length > 500 ? value.slice(0, 497) + "..." : value;
		if (typeof value === "undefined") return "undefined";
		if (typeof value === "bigint" || typeof value === "symbol") return String(value);
		if (typeof value === "function") return "[Function " + (value.name || "anonymous") + "]";
		if (typeof value !== "object") return String(value);
		if (depth >= 4) return Array.isArray(value) ? "[Array(" + value.length + ")]" : "[Object]";
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		if (Array.isArray(value)) {
			const result = value.slice(0, 20).map(item => bounded(item, depth + 1, seen));
			if (value.length > 20) result.push("... truncated");
			return result;
		}
		const result = {};
		const keys = Object.keys(value).slice(0, 20);
		for (const key of keys) {
			try { result[key] = bounded(value[key], depth + 1, seen); } catch { result[key] = "[Unavailable]"; }
		}
		if (Object.keys(value).length > keys.length) result["..."] = "truncated";
		return result;
	};
	const summarize = value => bounded(value, 0, new WeakSet());
	const hookKind = (name, hookNode) => {
		if (typeof name === "string" && name.length > 0) {
			const clean = name.startsWith("use") ? name.slice(3) : name;
			return clean || "Unknown";
		}
		const state = hookNode && hookNode.memoizedState;
		if (hookNode && hookNode.queue && typeof hookNode.queue.dispatch === "function") return "State";
		if (state && typeof state === "object" && "current" in state) return "Ref";
		if (state && typeof state === "object" && "create" in state && "deps" in state) return "Effect";
		if (Array.isArray(state) && state.length === 2 && Array.isArray(state[1])) return "Memo";
		return "Unknown";
	};
	const hooks = [];
	let hookNode = fiber.memoizedState;
	let index = 0;
	const debugTypes = Array.isArray(fiber._debugHookTypes) ? fiber._debugHookTypes : [];
	while (hookNode && index < 100) {
		hooks.push({ index, kind: hookKind(debugTypes[index], hookNode), value: summarize(hookNode.memoizedState) });
		hookNode = hookNode.next;
		index += 1;
	}
	const source = {};
	if (fiber._debugSource) {
		if (typeof fiber._debugSource.fileName === "string") source.fileName = fiber._debugSource.fileName;
		if (typeof fiber._debugSource.lineNumber === "number") source.lineNumber = fiber._debugSource.lineNumber;
		if (typeof fiber._debugSource.columnNumber === "number") source.columnNumber = fiber._debugSource.columnNumber;
	}
	if (fiber._debugOwner) source.owner = internals.fiberName(fiber._debugOwner) || undefined;
	const firstHost = start => {
		const stack = start ? [start] : [];
		while (stack.length > 0) {
			const current = stack.pop();
			if (current && current.tag === 5 && current.stateNode instanceof Element) return current.stateNode;
			if (current && current.sibling) stack.push(current.sibling);
			if (current && current.child) stack.push(current.child);
		}
		return null;
	};
	const selectorFor = element => {
		if (!element) return undefined;
		if (element.id) return "#" + CSS.escape(element.id);
		const parts = [];
		let current = element;
		while (current && current.nodeType === 1 && parts.length < 6) {
			let part = current.localName;
			const parent = current.parentElement;
			if (parent) {
				const sameTag = Array.from(parent.children).filter(child => child.localName === current.localName);
				if (sameTag.length > 1) part += ":nth-of-type(" + (sameTag.indexOf(current) + 1) + ")";
			}
			parts.unshift(part);
			current = parent;
		}
		return parts.join(" > ");
	};
	const kind = internals.fiberType(fiber);
	const value = {
		name: internals.fiberName(fiber) || kind,
		props: summarize(fiber.memoizedProps),
	};
	if (kind === "class") value.state = summarize(fiber.memoizedState);
	else if (hooks.length > 0) value.state = hooks;
	if (Object.keys(source).length > 0) value.source = source;
	const domSelector = selectorFor(firstHost(fiber));
	if (domSelector) value.domSelector = domSelector;
	return { value };
})()`;

/** Walk every mounted React fiber root into a bounded nested component tree. */
export async function readReactTree(
	page: Page,
	options: ReactTreeOptions = {},
	signal?: AbortSignal,
): Promise<ReactTreeNode[]> {
	const normalized: ReactTreeOptions = {
		maxDepth: options.maxDepth,
		includeHost: options.includeHost === true,
	};
	const source = `${TREE_SOURCE_PREFIX}${JSON.stringify(normalized)}${TREE_SOURCE_SUFFIX}`;
	const result = (await untilAborted(signal, () =>
		page.mainFrame().mainRealm().evaluate(source),
	)) as ReactPageEnvelope<ReactTreeNode[]>;
	return requireReactHookResult(result);
}

/** Inspect props, state, source, and host DOM location for one React fiber id. */
export async function inspectReactFiber(page: Page, id: number, signal?: AbortSignal): Promise<ReactInspectResult> {
	if (!Number.isInteger(id) || id <= 0)
		throw new ToolError("tab.reactInspect(id) expects a positive integer fiber id");
	const source = `${INSPECT_SOURCE_PREFIX}${JSON.stringify(id)}${INSPECT_SOURCE_SUFFIX}`;
	const result = (await untilAborted(signal, () =>
		page.mainFrame().mainRealm().evaluate(source),
	)) as ReactPageEnvelope<ReactInspectResult>;
	if (result.notFound) throw new ToolError(`React fiber ${id} was not found in the current commit`);
	return requireReactHookResult(result);
}
