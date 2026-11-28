import { jsonDeepEquals } from "@oh-my-pi/pi-utils";
import type { JsonObject } from "./types";
import { isJsonObject } from "./types";

/**
 * Whether two JSON values are equal ({@link jsonDeepEquals}): primitives as
 * `Object.is` compares them, arrays element by element, and objects with the
 * same keys holding equal values, at any depth `JSON.parse` reads (`const`,
 * `enum` and `uniqueItems` compare a tool call's arguments). A value JSON does
 * not hold (a `Date`, a `Map`, a class instance, a key holding `undefined`)
 * compares as `Bun.deepEquals` compares it.
 */
export function areJsonValuesEqual(left: unknown, right: unknown): boolean {
	return jsonDeepEquals(left, right);
}

export function mergeCompatibleEnumSchemas(existing: unknown, incoming: unknown): JsonObject | null {
	if (!isJsonObject(existing) || !isJsonObject(incoming)) {
		return null;
	}
	const existingEnum = Array.isArray(existing.enum) ? existing.enum : null;
	const incomingEnum = Array.isArray(incoming.enum) ? incoming.enum : null;
	if (!existingEnum || !incomingEnum) {
		return null;
	}
	if (!areJsonValuesEqual(existing.type, incoming.type)) {
		return null;
	}
	let existingNonEnumCount = 0;
	for (const key in existing) {
		if (key !== "enum") existingNonEnumCount++;
	}
	let incomingNonEnumCount = 0;
	for (const key in incoming) {
		if (key !== "enum") incomingNonEnumCount++;
	}
	if (existingNonEnumCount !== incomingNonEnumCount) {
		return null;
	}
	for (const key in existing) {
		if (key === "enum") continue;
		if (!(key in incoming) || !areJsonValuesEqual(existing[key], incoming[key])) {
			return null;
		}
	}

	const mergedEnum = [...existingEnum];
	for (const enumValue of incomingEnum) {
		if (!mergedEnum.some(existingValue => areJsonValuesEqual(existingValue, enumValue))) {
			mergedEnum.push(enumValue);
		}
	}
	return {
		...existing,
		enum: mergedEnum,
	};
}

function getAnyOfVariants(schema: unknown): unknown[] {
	if (isJsonObject(schema) && Array.isArray(schema.anyOf)) {
		return schema.anyOf;
	}
	return [schema];
}

export function mergePropertySchemas(existing: unknown, incoming: unknown): unknown {
	if (areJsonValuesEqual(existing, incoming)) {
		return existing;
	}
	const mergedEnumSchema = mergeCompatibleEnumSchemas(existing, incoming);
	if (mergedEnumSchema !== null) {
		return mergedEnumSchema;
	}

	const mergedAnyOf = [...getAnyOfVariants(existing)];
	for (const variant of getAnyOfVariants(incoming)) {
		if (!mergedAnyOf.some(existingVariant => areJsonValuesEqual(existingVariant, variant))) {
			mergedAnyOf.push(variant);
		}
	}
	return mergedAnyOf.length === 1 ? mergedAnyOf[0] : { anyOf: mergedAnyOf };
}
