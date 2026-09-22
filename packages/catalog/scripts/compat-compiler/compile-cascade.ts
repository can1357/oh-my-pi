/**
 * Compiles `rules/classes/*.kdl` + `rules/providers/*.kdl` into
 * {@link CompiledCascade}.
 *
 * Nested selector scopes (`class` / `provider` / `on` / `on-api` / `family` /
 * `revision` / `models`) collapse into flat conjunction rules; axis directives
 * are validated against the closed vocabulary in `src/compat/axes.ts` and
 * emitted keyed by resolved camelCase field. Duplicate axes in one block and
 * misplaced selectors are hard errors.
 */
import { parseRevisionConstraint } from "../../src/compat/revision";
import type { CompiledCascade, CompiledRule, CompiledSelector } from "../../src/compat/types";
import { collectAxis, type RuleAxes } from "./compile-axes";
import { PROVIDER_CATALOG_NODES } from "./compile-providers";
import { type KdlNodeView, malformed, parseKdl, unexpected } from "./kdl-reader";

const CHILD_ON = 1 << 0;
const CHILD_CLASS = 1 << 1;
const CHILD_FAMILY = 1 << 2;
const CHILD_REVISION = 1 << 3;
const CHILD_MODELS = 1 << 4;
const CHILD_API = 1 << 5;
const CLASS_CHILDREN = CHILD_ON | CHILD_API | CHILD_FAMILY | CHILD_REVISION | CHILD_MODELS;
const CLASS_FILTER_CHILDREN = CHILD_FAMILY | CHILD_REVISION | CHILD_MODELS;
const PROVIDER_CHILDREN = CHILD_CLASS | CHILD_MODELS;
const FAMILY_CHILDREN = CHILD_REVISION | CHILD_MODELS;
const REVISION_CHILDREN = CHILD_MODELS;

interface RuleScope {
	class?: string;
	providers?: string[];
	apis?: string[];
	family?: string;
	revision?: CompiledRule["revision"];
	models?: CompiledSelector[];
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
	// Catalog-entry nodes (`default-model`, `env`, `seed`, …) share the root
	// provider block with the cascade; `compile-providers.ts` owns them. Only a
	// provider root skips them — a root `on-api` scope rejects them like any
	// other non-axis directive.
	const isProviderRoot = scope.providers !== undefined && allowed === PROVIDER_CHILDREN;
	for (const child of node.children ?? []) {
		if (isProviderRoot && PROVIDER_CATALOG_NODES.has(child.name)) continue;
		let kind: number;
		let nextAllowed: number;
		switch (child.name) {
			case "on":
				kind = CHILD_ON;
				nextAllowed = CLASS_FILTER_CHILDREN;
				break;
			case "on-api":
				kind = CHILD_API;
				nextAllowed = CLASS_FILTER_CHILDREN;
				break;
			case "class":
				kind = CHILD_CLASS;
				nextAllowed = CLASS_FILTER_CHILDREN;
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
			case CHILD_API:
				nested.apis = stringArguments(child);
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
	if (scope.apis !== undefined) rule.apis = scope.apis;
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
				case "on-api":
					parseScope(node, { apis: stringArguments(node) }, PROVIDER_CHILDREN, rules);
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
