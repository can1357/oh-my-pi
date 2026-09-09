import { toolWireSchema } from "../utils/schema";
import type { InbandTool } from "./types";

export interface ToolArgShape {
	stringArgs: Set<string>;
	properties: Record<string, unknown>;
	parameterOrder: string[];
}

export function buildArgShapes(tools: readonly InbandTool[] = []): Map<string, ToolArgShape> {
	const shapes = new Map<string, ToolArgShape>();
	for (const tool of tools) {
		const schema = resolveToolSchema(tool);
		const props = schema.properties;
		const properties =
			props && typeof props === "object" && !Array.isArray(props) ? (props as Record<string, unknown>) : {};
		const stringArgs = new Set<string>();
		const parameterOrder: string[] = [];
		for (const key in properties) {
			parameterOrder.push(key);
			if (isStringOnlySchema(properties[key])) stringArgs.add(key);
		}
		shapes.set(tool.name, { stringArgs, properties, parameterOrder });
	}
	return shapes;
}

export function buildStringArgsResolver(tools: readonly InbandTool[] = []): (toolName: string) => ReadonlySet<string> {
	const shapes = buildArgShapes(tools);
	const empty = new Set<string>();
	return (toolName: string) => shapes.get(toolName)?.stringArgs ?? empty;
}

export function resolveToolSchema(tool: InbandTool): Record<string, unknown> {
	try {
		return toolWireSchema(tool);
	} catch {
		const params = tool.parameters;
		return params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
	}
}

export function isStringOnlySchema(schema: unknown): boolean {
	const types = collectSchemaTypes(schema);
	types.delete("null");
	return types.size === 1 && types.has("string");
}

export function collectSchemaTypes(schema: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
	if (depth > 8 || !schema || typeof schema !== "object" || Array.isArray(schema)) return out;
	const node = schema as Record<string, unknown>;
	const type = node.type;
	if (typeof type === "string") out.add(type);
	else if (Array.isArray(type)) for (const t of type) if (typeof t === "string") out.add(t);
	if (type === undefined && Array.isArray(node.enum)) {
		for (const value of node.enum) out.add(jsonTypeOf(value));
	}
	if (type === undefined && "const" in node) out.add(jsonTypeOf(node.const));
	for (const key of ["anyOf", "oneOf", "allOf"] as const) {
		const branch = node[key];
		if (Array.isArray(branch)) for (const sub of branch) collectSchemaTypes(sub, out, depth + 1);
	}
	return out;
}

export function jsonTypeOf(value: unknown): string {
	const type = typeof value;
	if (value === null) return "null";
	if (type === "number" || type === "bigint") return "number";
	if (type === "boolean") return "boolean";
	if (type === "string") return "string";
	return "object";
}

export function decodeValue(raw: string): unknown {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return trimmed;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return raw;
	}
}

export function coerceValue(raw: string, schema: unknown): unknown {
	return isStringOnlySchema(schema) ? raw : decodeValue(raw);
}

export function isArraySchema(schema: unknown): boolean {
	return collectSchemaTypes(schema).has("array");
}

export function isObjectSchema(schema: unknown): boolean {
	return collectSchemaTypes(schema).has("object");
}

export function getObjectProperties(schema: unknown): Record<string, unknown> {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};
	const props = (schema as Record<string, unknown>).properties;
	return props && typeof props === "object" && !Array.isArray(props) ? (props as Record<string, unknown>) : {};
}

export function getArrayItemSchema(schema: unknown): unknown {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
	return (schema as Record<string, unknown>).items;
}

let idCounter = 0;
export function mintToolCallId(): string {
	idCounter = (idCounter + 1) % Number.MAX_SAFE_INTEGER;
	return `ptc_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function partialSuffixOverlap(text: string, tag: string): number {
	const max = Math.min(text.length, tag.length - 1);
	for (let k = max; k > 0; k--) {
		if (text.endsWith(tag.slice(0, k))) return k;
	}
	return 0;
}

export function partialSuffixOverlapAny(text: string, tags: readonly string[]): number {
	let best = 0;
	for (const tag of tags) best = Math.max(best, partialSuffixOverlap(text, tag));
	return best;
}

export function normalizeKimiFunctionName(rawId: string): string {
	const beforeIndex = rawId.split(":", 1)[0] ?? rawId;
	const parts = beforeIndex.split(".");
	return parts[parts.length - 1]?.trim() ?? beforeIndex.trim();
}

export function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
