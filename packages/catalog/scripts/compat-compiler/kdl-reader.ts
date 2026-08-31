/**
 * Thin strict wrapper over `@bgotink/kdl` used by the compat-rule compiler.
 *
 * Exposes a plain node view (`name`, positional `args`, named `props`,
 * `children`, `file:line`) plus the shared validation helpers whose semantics
 * mirror the o2 reference compiler: unknown properties, duplicate properties,
 * and non-string positional arguments are hard errors with `file:line`
 * diagnostics.
 */

import type { Document, Node } from "@bgotink/kdl";
import { getLocation, parse } from "@bgotink/kdl";

/** Compile-time rule failure, always carrying a `file:line` label. */
export class CompatCompileError extends Error {
	constructor(
		readonly file: string,
		readonly line: number | undefined,
		message: string,
	) {
		super(`${file}${line === undefined ? "" : `:${line}`}: ${message}`);
		this.name = "CompatCompileError";
	}
}

/** One KDL value: string, number, boolean, or null. */
export type KdlScalar = string | number | boolean | null;

/** One parsed KDL node with source location. */
export interface KdlNodeView {
	name: string;
	file: string;
	line: number;
	/** Positional argument values in declaration order. */
	args: KdlScalar[];
	/** Named entries in declaration order (repeats preserved). */
	props: { name: string; value: KdlScalar }[];
	/** Child nodes, or null when the node has no children block. */
	children: KdlNodeView[] | null;
}

function isKdlScalar(value: unknown): value is KdlScalar {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** Parses one KDL source into node views; syntax errors carry `file`. */
export function parseKdl(file: string, text: string): KdlNodeView[] {
	let document: Document;
	try {
		document = parse(text, { storeLocations: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new CompatCompileError(file, undefined, `KDL parse failure: ${message}`);
	}
	const view = (node: Node): KdlNodeView => {
		const args: KdlScalar[] = [];
		const props: { name: string; value: KdlScalar }[] = [];
		for (const entry of node.entries) {
			const name = entry.getName();
			const value: unknown = entry.getValue();
			if (!isKdlScalar(value)) {
				throw new CompatCompileError(file, getLocation(node)?.start.line, "unsupported KDL value");
			}
			if (name === null) args.push(value);
			else props.push({ name, value });
		}
		return {
			name: node.getName(),
			file,
			line: getLocation(node)?.start.line ?? 0,
			args,
			props,
			children: node.children ? node.children.nodes.map(view) : null,
		};
	};
	return document.nodes.map(view);
}

/** Error helper: `directive` has a malformed value shape. */
export function malformed(node: KdlNodeView, directive = node.name): never {
	throw new CompatCompileError(node.file, node.line, `directive \`${directive}\` has a malformed value`);
}

/** Error helper: node kind not allowed in this context. */
export function unexpected(node: KdlNodeView, context: string): never {
	throw new CompatCompileError(node.file, node.line, `unexpected node \`${node.name}\` under \`${context}\``);
}

/**
 * Validates named entries: every property must be in `allowed` and appear at
 * most once. Mirrors o2 `validate_properties`.
 */
export function validateProps(node: KdlNodeView, allowed: readonly string[]): void {
	const seen = new Set<string>();
	for (const prop of node.props) {
		if (!allowed.includes(prop.name)) unexpected({ ...node, name: prop.name }, node.name);
		if (seen.has(prop.name)) malformed(node);
		seen.add(prop.name);
	}
}

/** Positional arguments as strings; a non-string positional is malformed. */
export function positionalStrings(node: KdlNodeView): string[] {
	return node.args.map(value => {
		if (typeof value !== "string") malformed(node);
		return value;
	});
}

/** The string value of a named property, or undefined when absent. */
export function propString(node: KdlNodeView, name: string): string | undefined {
	const prop = node.props.find(entry => entry.name === name);
	if (!prop) return undefined;
	if (typeof prop.value !== "string") malformed(node);
	return prop.value;
}

/** The boolean value of a named property, or undefined when absent. */
export function propBool(node: KdlNodeView, name: string): boolean | undefined {
	const prop = node.props.find(entry => entry.name === name);
	if (!prop) return undefined;
	if (typeof prop.value !== "boolean") malformed(node);
	return prop.value;
}

/** The non-negative integer value of a named property, or undefined when absent. */
export function propInt(node: KdlNodeView, name: string): number | undefined {
	const prop = node.props.find(entry => entry.name === name);
	if (!prop) return undefined;
	if (typeof prop.value !== "number" || !Number.isSafeInteger(prop.value)) malformed(node);
	return prop.value;
}

/** A required string property; absence is malformed. */
export function requiredProp(node: KdlNodeView, name: string): string {
	const value = propString(node, name);
	if (value === undefined) malformed(node);
	return value;
}
