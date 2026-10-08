/** Derives per-label output-schema section shapes for incremental yield assembly. */
import { dereferenceJsonSchema } from "@oh-my-pi/pi-ai/utils/schema";
import type { YieldSectionShapes } from "@oh-my-pi/pi-tui/tools/task-yield-assembly";
import { isRecord } from "@oh-my-pi/pi-utils";
import { buildOutputValidator, isArraySectionSchema } from "../tools/output-schema-validator";

/**
 * Record the shape of every property declared by `schema` or by its `allOf`/`oneOf`/`anyOf`
 * branches (JTD discriminators compile to a root `oneOf`). A label declared array in one
 * branch and non-array in another is marked `mixed`.
 */
function collectPropertyShapes(schema: Record<string, unknown>, shapes: Map<string, "array" | "scalar" | "mixed">) {
	const properties = schema.properties;
	if (isRecord(properties)) {
		for (const key in properties) {
			const shape = isArraySectionSchema(properties[key]) ? "array" : "scalar";
			const existing = shapes.get(key);
			shapes.set(key, existing === undefined || existing === shape ? shape : "mixed");
		}
	}
	for (const key of ["allOf", "oneOf", "anyOf"] as const) {
		const branches = schema[key];
		if (!Array.isArray(branches)) continue;
		for (const branch of branches) {
			if (isRecord(branch)) collectPropertyShapes(branch, shapes);
		}
	}
}

/**
 * Shape of every top-level output-schema property, for `assembleYieldResult`.
 *
 * Properties are collected from the root and its `allOf`/`oneOf`/`anyOf` branches, matching
 * the labels the yield gate accepts. Array-declared properties (JTD `elements` → JSON
 * `type: "array"`) accumulate into a list even when the agent emits exactly one section —
 * otherwise a single `type: ["findings"]` yield would assemble as a bare object and fail
 * array-typed validation. Other declared properties are scalar: a repeated yield (e.g. a
 * revised `explanation` after async jobs settle) replaces the earlier value instead of
 * assembling an array the schema rejects. A label declared array in one branch and scalar
 * in another gets no shape, keeping the undeclared-label merge.
 */
export function yieldSectionShapes(outputSchema: unknown): YieldSectionShapes {
	const shapes = new Map<string, "array" | "scalar">();
	// Use the JTD-converted JSON Schema (matches what validation runs against):
	// JTD `optionalProperties.findings.elements` becomes `properties.findings`
	// with `type: "array"`, which raw `normalizeSchema` would not expose.
	const { jsonSchema, validator } = buildOutputValidator(outputSchema);
	if (jsonSchema === undefined) return shapes;
	const dereferenced = dereferenceJsonSchema(jsonSchema);
	const collected = new Map<string, "array" | "scalar" | "mixed">();
	collectPropertyShapes(isRecord(dereferenced) ? dereferenced : jsonSchema, collected);
	for (const [key, shape] of collected) {
		if (shape !== "mixed") shapes.set(key, shape);
	}
	return Object.assign(shapes, { acceptsItem: validator?.isSectionItem });
}
