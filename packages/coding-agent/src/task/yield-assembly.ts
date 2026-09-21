/** Discovers array-valued output-schema labels for incremental yield assembly. */
import { dereferenceJsonSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { isRecord } from "@oh-my-pi/pi-utils";
import { buildOutputValidator } from "../tools/output-schema-validator";

/** True when `value` is a JSON-schema node whose instances are arrays. */
function isArrayTypedSchema(value: unknown): boolean {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (record.type === "array") return true;
	if (Array.isArray(record.type) && record.type.includes("array")) return true;
	for (const key of ["anyOf", "oneOf", "allOf"] as const) {
		const variants = record[key];
		if (Array.isArray(variants) && variants.some(isArrayTypedSchema)) return true;
	}
	return false;
}

/**
 * Top-level output-schema property names declared as arrays (JTD `elements` →
 * JSON `type: "array"`). An incremental yield section for such a label
 * accumulates into a list even when the agent emits exactly one — otherwise a
 * single `type: ["findings"]` yield would assemble as a bare object and fail
 * array-typed schema validation.
 */
export function arrayValuedLabels(outputSchema: unknown): ReadonlySet<string> {
	const labels = new Set<string>();
	// Use the JTD-converted JSON Schema (matches what validation runs against):
	// JTD `optionalProperties.findings.elements` becomes `properties.findings`
	// with `type: "array"`, which raw `normalizeSchema` would not expose.
	const { jsonSchema } = buildOutputValidator(outputSchema);
	if (jsonSchema === undefined) return labels;
	const dereferenced = dereferenceJsonSchema(jsonSchema);
	const labelSchema = isRecord(dereferenced) ? dereferenced : jsonSchema;
	const properties = labelSchema.properties;
	if (!isRecord(properties)) return labels;
	for (const key in properties) {
		if (isArrayTypedSchema(properties[key])) labels.add(key);
	}
	return labels;
}
