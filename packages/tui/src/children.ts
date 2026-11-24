/**
 * Child resolution: JSX children → the list of nodes a parent holds.
 *
 * Arrays flatten; `false`/`null`/`undefined`/`true`/`""` drop out; strings
 * and numbers become `text` nodes. Each function child is a dynamic region
 * with its own structural computed, so a change re-runs only that region
 * (recreating only the nodes it builds), never its siblings.
 */
import { UiNode } from "./node";
import { type Accessor, structural } from "./reactive";

type Part = UiNode | Accessor<readonly UiNode[]>;

function sameNodes(a: readonly UiNode[], b: readonly UiNode[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

const SAME_NODES = { equals: sameNodes };

function describe(value: unknown): string {
	if (typeof value === "function") return "function";
	if (typeof value === "object" && value !== null) return value.constructor?.name ?? "object";
	return typeof value;
}

/** Collect `value` into `out`; returns whether it held a dynamic region. */
function collect(value: unknown, out: Part[]): boolean {
	if (value === undefined || value === null || value === "" || typeof value === "boolean") return false;
	if (Array.isArray(value)) {
		let dynamic = false;
		for (const item of value) dynamic = collect(item, out) || dynamic;
		return dynamic;
	}
	if (value instanceof UiNode) {
		out.push(value);
		return false;
	}
	if (typeof value === "string" || typeof value === "number") {
		out.push(new UiNode("text", { text: String(value) }));
		return false;
	}
	if (typeof value === "function") {
		const fn = value as () => unknown;
		out.push(
			structural(() => {
				const nodes: UiNode[] = [];
				flatten(fn(), nodes);
				return nodes;
			}, SAME_NODES),
		);
		return true;
	}
	throw new TypeError(`JSX: a ${describe(value)} cannot be a child node`);
}

/** Flatten `value` fully, reading dynamic regions, into `out`. */
function flatten(value: unknown, out: UiNode[]): void {
	const parts: Part[] = [];
	collect(value, parts);
	for (const part of parts) {
		if (part instanceof UiNode) out.push(part);
		else out.push(...part());
	}
}

/** A parent's children as an accessor; the list keeps its identity while no region changed. */
export function resolveChildren(children: unknown): Accessor<readonly UiNode[]> {
	const parts: Part[] = [];
	if (!collect(children, parts)) {
		const fixed = parts as UiNode[];
		return () => fixed;
	}
	return structural(() => {
		const out: UiNode[] = [];
		for (const part of parts) {
			if (part instanceof UiNode) out.push(part);
			else out.push(...part());
		}
		return out;
	}, SAME_NODES);
}
