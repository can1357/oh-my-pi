/**
 * JSON Type Definition (JTD) utility types and guards.
 *
 * Shared type definitions and type guard functions for JTD schema validation.
 *
 * @see https://jsontypedef.com/
 * @see https://datatracker.ietf.org/doc/html/rfc8927
 */

export type JTDPrimitive =
	| "boolean"
	| "string"
	| "timestamp"
	| "float32"
	| "float64"
	| "int8"
	| "uint8"
	| "int16"
	| "uint16"
	| "int32"
	| "uint32";

export interface JTDType {
	type: JTDPrimitive;
}

export interface JTDEnum {
	enum: string[];
}

export interface JTDElements {
	elements: JTDSchema;
}

export interface JTDValues {
	values: JTDSchema;
}

export interface JTDProperties {
	properties?: Record<string, JTDSchema>;
	optionalProperties?: Record<string, JTDSchema>;
}

export interface JTDDiscriminator {
	discriminator: string;
	mapping: Record<string, JTDProperties>;
}

export interface JTDRef {
	ref: string;
}

export interface JTDEmpty {}

export type JTDSchema =
	| JTDType
	| JTDEnum
	| JTDElements
	| JTDValues
	| JTDProperties
	| JTDDiscriminator
	| JTDRef
	| JTDEmpty;

// Type guards

export function isJTDType(schema: unknown): schema is JTDType {
	return typeof schema === "object" && schema !== null && "type" in schema;
}

export function isJTDEnum(schema: unknown): schema is JTDEnum {
	return typeof schema === "object" && schema !== null && "enum" in schema && Array.isArray(schema.enum);
}

export function isJTDElements(schema: unknown): schema is JTDElements {
	return typeof schema === "object" && schema !== null && "elements" in schema;
}

export function isJTDValues(schema: unknown): schema is JTDValues {
	return typeof schema === "object" && schema !== null && "values" in schema;
}

export function isJTDProperties(schema: unknown): schema is JTDProperties {
	return typeof schema === "object" && schema !== null && ("properties" in schema || "optionalProperties" in schema);
}

export function isJTDDiscriminator(schema: unknown): schema is JTDDiscriminator {
	return (
		typeof schema === "object" &&
		schema !== null &&
		"discriminator" in schema &&
		"mapping" in schema &&
		typeof schema.discriminator === "string" &&
		typeof schema.mapping === "object" &&
		schema.mapping !== null &&
		!Array.isArray(schema.mapping)
	);
}

export function isJTDRef(schema: unknown): schema is JTDRef {
	return typeof schema === "object" && schema !== null && "ref" in schema;
}
