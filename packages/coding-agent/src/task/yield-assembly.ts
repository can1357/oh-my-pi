/** Derives per-label output-schema section shapes for incremental yield assembly. */
import { dereferenceJsonSchema } from "@oh-my-pi/pi-ai/utils/schema";
import type { YieldSectionShapes } from "@oh-my-pi/pi-tui/tools/task-yield-assembly";
import { isRecord } from "@oh-my-pi/pi-utils";
import { buildOutputValidator, buildSectionSchemas, yieldSectionShape } from "../tools/output-schema-validator";

/**
 * Shape of every top-level output-schema property, for `assembleYieldResult`.
 *
 * Properties are collected from the root and its `allOf`/`oneOf`/`anyOf` branches, matching
 * the labels the yield gate accepts. Array-declared properties (JTD `elements` → JSON
 * `type: "array"`) accumulate into a list even when the agent emits exactly one section —
 * otherwise a single `type: ["findings"]` yield would assemble as a bare object and fail
 * array-typed validation. Other declared properties are scalar: a repeated yield (e.g. a
 * revised `explanation` after async jobs settle) replaces the earlier value instead of
 * assembling an array the schema rejects. Array-capable labels also carry payload metadata:
 * a valid item takes precedence over a batch or scalar, while a scalar-only value stays direct.
 */
export function yieldSectionShapes(outputSchema: unknown): YieldSectionShapes {
	const shapes = new Map<string, "array" | "scalar">();
	// Use the JTD-converted JSON Schema (matches what validation runs against):
	// JTD `optionalProperties.findings.elements` becomes `properties.findings`
	// with `type: "array"`, which raw `normalizeSchema` would not expose.
	const { jsonSchema, validator } = buildOutputValidator(outputSchema);
	if (jsonSchema === undefined) return shapes;
	const dereferenced = dereferenceJsonSchema(jsonSchema);
	for (const [label, schema] of buildSectionSchemas(isRecord(dereferenced) ? dereferenced : jsonSchema)) {
		shapes.set(label, yieldSectionShape(schema));
	}
	return Object.assign(shapes, {
		acceptsItem: validator?.isSectionItem,
		acceptsArray: validator?.isArraySectionValue,
	});
}
