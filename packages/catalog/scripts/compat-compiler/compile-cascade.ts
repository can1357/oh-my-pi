/**
 * Compiles `rules/classes/*.kdl` + `rules/providers/*.kdl` into
 * {@link CompiledCascade}.
 *
 * Faithful port of the o2 reference (`cascade.rs`): nested selector scopes
 * (`class` / `provider` / `on` / `family` / `revision` / `models`) collapse
 * into flat conjunction rules; axis directives are validated against the
 * closed vocabulary in `src/compat/axes.ts` and emitted keyed by resolved
 * camelCase field. Duplicate axes in one block and misplaced selectors are
 * hard errors.
 */
import { AXES, type AxisDef } from "../../src/compat/axes";
import { parseRevisionConstraint } from "../../src/compat/revision";
import type { CompiledCascade, CompiledRule, CompiledSelector } from "../../src/compat/types";
import { CompatCompileError, type KdlNodeView, type KdlScalar, malformed, parseKdl, unexpected } from "./kdl-reader";

const CHILD_ON = 1 << 0;
const CHILD_CLASS = 1 << 1;
const CHILD_FAMILY = 1 << 2;
const CHILD_REVISION = 1 << 3;
const CHILD_MODELS = 1 << 4;
const CLASS_CHILDREN = CHILD_ON | CHILD_FAMILY | CHILD_REVISION | CHILD_MODELS;
const CLASS_ON_CHILDREN = CHILD_FAMILY | CHILD_REVISION | CHILD_MODELS;
const PROVIDER_CHILDREN = CHILD_CLASS | CHILD_MODELS;
const FAMILY_CHILDREN = CHILD_REVISION | CHILD_MODELS;
const REVISION_CHILDREN = CHILD_MODELS;

interface RuleScope {
	class?: string;
	providers?: string[];
	family?: string;
	revision?: CompiledRule["revision"];
	models?: CompiledSelector[];
}

interface RuleAxes {
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
			if (typeof value === "string" && axis.values && !axis.values.includes(value)) {
				throw new CompatCompileError(node.file, node.line, `axis \`${node.name}\` rejects value \`${value}\``);
			}
			if (axis.key === "editRevision" && (typeof value !== "string" || !value.trim())) malformed(node);
			return value;
		}
		case "array": {
			if (node.args.length === 0 || node.children) malformed(node);
			return node.args.map(raw => {
				const value = scalarValue(node, raw);
				if (typeof value === "string" && axis.values && !axis.values.includes(value)) {
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

function collectAxis(node: KdlNodeView, axes: RuleAxes): void {
	if (node.props.length > 0) malformed(node);
	const axis = AXES[node.name];
	if (!axis) {
		throw new CompatCompileError(node.file, node.line, `unknown directive \`${node.name}\``);
	}
	const map = axes[axis.set];
	if (axis.key in map) {
		throw new CompatCompileError(node.file, node.line, `axis \`${axis.key}\` assigned twice in one block`);
	}
	map[axis.key] = axisValue(node, axis);
}

/** `priority=` (and `token=` on `models`) are the only named entries selectors accept. */
function nodePriority(node: KdlNodeView): number {
	let priority: number | undefined;
	for (const prop of node.props) {
		if (node.name === "models" && prop.name === "token") continue;
		if (prop.name !== "priority" || priority !== undefined) malformed(node);
		if (typeof prop.value !== "number" || !Number.isSafeInteger(prop.value)) malformed(node);
		priority = prop.value;
	}
	return priority ?? 0;
}

function requiredName(node: KdlNodeView): string {
	if (node.args.length !== 1 || typeof node.args[0] !== "string" || !node.args[0]) malformed(node);
	return node.args[0];
}

function selectorArguments(node: KdlNodeView): CompiledSelector[] {
	const selectors: CompiledSelector[] = [];
	for (const value of node.args) {
		if (typeof value !== "string" || !value) malformed(node);
		selectors.push(value.includes("*") ? { kind: "glob", value: value.toLowerCase() } : { kind: "exact", value });
	}
	for (const prop of node.props) {
		if (prop.name === "priority") continue;
		if (prop.name !== "token" || typeof prop.value !== "string" || !prop.value) malformed(node);
		selectors.push({ kind: "token", value: prop.value.toLowerCase() });
	}
	if (selectors.length === 0) malformed(node);
	return selectors;
}

function stringArguments(node: KdlNodeView): string[] {
	const values = node.args.map(value => {
		if (typeof value !== "string" || !value) malformed(node);
		return value;
	});
	if (values.length === 0) malformed(node);
	return values;
}

function parseScope(node: KdlNodeView, scope: RuleScope, allowed: number, rules: CompiledRule[]): void {
	const priority = nodePriority(node);
	const axes: RuleAxes = { wire: {}, thinking: {}, catalog: {} };
	for (const child of node.children ?? []) {
		let kind: number;
		let nextAllowed: number;
		switch (child.name) {
			case "on":
				kind = CHILD_ON;
				nextAllowed = CLASS_ON_CHILDREN;
				break;
			case "class":
				kind = CHILD_CLASS;
				nextAllowed = CLASS_ON_CHILDREN;
				break;
			case "family":
				kind = CHILD_FAMILY;
				nextAllowed = FAMILY_CHILDREN;
				break;
			case "revision":
				kind = CHILD_REVISION;
				nextAllowed = REVISION_CHILDREN;
				break;
			case "models":
				kind = CHILD_MODELS;
				nextAllowed = 0;
				break;
			default:
				collectAxis(child, axes);
				continue;
		}
		if ((allowed & kind) === 0) unexpected(child, node.name);
		const nested: RuleScope = { ...scope };
		switch (kind) {
			case CHILD_ON:
				nested.providers = stringArguments(child);
				break;
			case CHILD_CLASS:
				nested.class = requiredName(child);
				break;
			case CHILD_FAMILY:
				nested.family = requiredName(child);
				break;
			case CHILD_REVISION: {
				const terms = parseRevisionConstraint(requiredName(child));
				if (!terms) malformed(child);
				nested.revision = terms.map(term => ({
					op: term.op,
					revision: `${term.revision[0]}.${term.revision[1]}.${term.revision[2]}`,
				}));
				break;
			}
			case CHILD_MODELS:
				nested.models = selectorArguments(child);
				break;
		}
		parseScope(child, nested, nextAllowed, rules);
	}
	if (
		Object.keys(axes.wire).length === 0 &&
		Object.keys(axes.thinking).length === 0 &&
		Object.keys(axes.catalog).length === 0
	) {
		return;
	}
	const rule: CompiledRule = { source: `${node.file}:${node.line}` };
	if (scope.class !== undefined) rule.class = scope.class;
	if (scope.providers !== undefined) rule.providers = scope.providers;
	if (scope.family !== undefined) rule.family = scope.family;
	if (scope.revision !== undefined) rule.revision = scope.revision;
	if (scope.models !== undefined) rule.models = scope.models;
	if (priority !== 0) rule.priority = priority;
	if (Object.keys(axes.wire).length > 0) rule.wire = axes.wire;
	if (Object.keys(axes.thinking).length > 0) rule.thinking = axes.thinking;
	if (Object.keys(axes.catalog).length > 0) rule.catalog = axes.catalog;
	rules.push(rule);
}

/** Compiles every cascade source (`file` is rules-relative) into one rule list. */
export function compileCascade(sources: readonly { file: string; text: string }[]): CompiledCascade {
	const rules: CompiledRule[] = [];
	for (const { file, text } of sources) {
		for (const node of parseKdl(file, text)) {
			switch (node.name) {
				case "class":
					parseScope(node, { class: requiredName(node) }, CLASS_CHILDREN, rules);
					break;
				case "provider":
					parseScope(node, { providers: [requiredName(node)] }, PROVIDER_CHILDREN, rules);
					break;
				default:
					unexpected(node, "document root");
			}
		}
	}
	return { rules };
}
