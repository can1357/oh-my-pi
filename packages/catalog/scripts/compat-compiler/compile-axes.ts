/**
 * Axis-directive parsing shared by the cascade (`classes/`, `providers/`) and
 * provider-entry seed (`providers/`) compilers: validates one KDL directive against the closed
 * vocabulary in `src/compat/axes.ts` and emits its value keyed by resolved
 * camelCase field.
 */
import { AXES, type AxisDef } from "../../src/compat/axes";
import { CompatCompileError, type KdlNodeView, type KdlScalar, malformed } from "./kdl-reader";

/** Axis assignments of one rule block, split by namespace. */
export interface RuleAxes {
	wire: Record<string, unknown>;
	thinking: Record<string, unknown>;
	catalog: Record<string, unknown>;
}

function scalarValue(node: KdlNodeView, value: KdlScalar): unknown {
	if (value === null) malformed(node);
	return value;
}

/**
 * Object-payload child name → resolved JSON key. Authored names are
 * kebab-case; an axis-directive spelling maps to its resolved axis key
 * (`template-reasoning-effort` → `qwenTemplateReasoningEffort`), anything else
 * converts mechanically (`input-threshold` → `inputThreshold`).
 */
function payloadKey(child: KdlNodeView): string {
	if (/[A-Z]/.test(child.name)) {
		throw new CompatCompileError(child.file, child.line, `object payload key \`${child.name}\` must be kebab-case`);
	}
	return AXES[child.name]?.key ?? child.name.replace(/-([a-z0-9])/g, (_, first: string) => first.toUpperCase());
}

/**
 * Nested payload node → JSON. `verbatim` copies child names as literal wire
 * keys (`extra-body` payloads); otherwise kebab-case names compile to
 * camelCase resolved keys, and a nested `extra-body` child switches its
 * subtree back to verbatim wire keys.
 */
function objectValue(children: KdlNodeView[], verbatim: boolean): Record<string, unknown> {
	const object: Record<string, unknown> = {};
	for (const child of children) {
		if (child.props.length > 0) malformed(child);
		const key = verbatim ? child.name : payloadKey(child);
		if (child.args.length === 1 && !child.children) {
			object[key] = scalarValue(child, child.args[0]);
		} else if (child.args.length === 0 && child.children) {
			object[key] = objectValue(child.children, verbatim || child.name === "extra-body");
		} else {
			malformed(child);
		}
	}
	return object;
}

function axisValue(node: KdlNodeView, axis: AxisDef): unknown {
	switch (axis.shape) {
		case "scalar": {
			if (node.args.length !== 1 || node.children) malformed(node);
			const value = scalarValue(node, node.args[0]);
			if (axis.values && !(axis.values as readonly unknown[]).includes(value)) {
				throw new CompatCompileError(node.file, node.line, `axis \`${node.name}\` rejects value \`${value}\``);
			}
			if (axis.key === "editRevision" && (typeof value !== "string" || !value.trim())) malformed(node);
			return value;
		}
		case "array": {
			if (node.args.length === 0 || node.children) malformed(node);
			return node.args.map(raw => {
				const value = scalarValue(node, raw);
				if (axis.values && !(axis.values as readonly unknown[]).includes(value)) {
					throw new CompatCompileError(node.file, node.line, `axis \`${node.name}\` rejects value \`${value}\``);
				}
				return value;
			});
		}
		case "object":
			if (node.args.length > 0 || !node.children) malformed(node);
			return objectValue(node.children, axis.verbatimKeys === true);
	}
}

/** The axis definition for a directive node, or a compile error naming the unknown directive. */
export function axisFor(node: KdlNodeView): AxisDef {
	const axis = AXES[node.name];
	if (!axis) {
		throw new CompatCompileError(node.file, node.line, `unknown directive \`${node.name}\``);
	}
	return axis;
}

/** Parses one axis directive into `axes`; a repeated axis in one block is an error. */
export function collectAxis(node: KdlNodeView, axes: RuleAxes): void {
	if (node.props.length > 0) malformed(node);
	const axis = axisFor(node);
	const map = axes[axis.set];
	if (axis.key in map) {
		throw new CompatCompileError(node.file, node.line, `axis \`${axis.key}\` assigned twice in one block`);
	}
	map[axis.key] = axisValue(node, axis);
}
