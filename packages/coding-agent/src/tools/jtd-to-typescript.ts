/**
 * Convert JSON Type Definition (JTD) to TypeScript interface notation.
 *
 * Produces human-readable TypeScript for embedding in system prompts,
 * helping models understand expected output structure.
 */

import type { JTDPrimitive } from "./jtd-utils.js";
import {
	isJTDDiscriminator,
	isJTDElements,
	isJTDEnum,
	isJTDProperties,
	isJTDRef,
	isJTDType,
	isJTDValues,
} from "./jtd-utils.js";

const primitiveMap: Record<JTDPrimitive, string> = {
	boolean: "boolean",
	string: "string",
	timestamp: "string",
	float32: "number",
	float64: "number",
	int8: "number",
	uint8: "number",
	int16: "number",
	uint16: "number",
	int32: "number",
	uint32: "number",
};

function convertToTypeScript(schema: unknown, inline = false): string {
	if (schema === null || schema === undefined || (typeof schema === "object" && Object.keys(schema).length === 0)) {
		return "unknown";
	}

	if (isJTDType(schema)) {
		const tsType = primitiveMap[schema.type as JTDPrimitive];
		return tsType ?? "unknown";
	}

	if (isJTDEnum(schema)) {
		return schema.enum.map(v => `"${v}"`).join(" | ");
	}

	if (isJTDElements(schema)) {
		const itemType = convertToTypeScript(schema.elements, true);
		if (itemType.includes("\n") || itemType.length > 40) {
			return `Array<${itemType}>`;
		}
		return `${itemType}[]`;
	}

	if (isJTDValues(schema)) {
		const valueType = convertToTypeScript(schema.values, true);
		return `Record<string, ${valueType}>`;
	}

	if (isJTDProperties(schema)) {
		const lines: string[] = [];
		lines.push("{");

		if (schema.properties) {
			for (const [key, value] of Object.entries(schema.properties)) {
				const propType = convertToTypeScript(value, true);
				const safeName = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : `"${key}"`;
				lines.push(`  ${safeName}: ${propType};`);
			}
		}

		if (schema.optionalProperties) {
			for (const [key, value] of Object.entries(schema.optionalProperties)) {
				const propType = convertToTypeScript(value, true);
				const safeName = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : `"${key}"`;
				lines.push(`  ${safeName}?: ${propType};`);
			}
		}

		lines.push("}");

		if (inline && lines.length <= 4) {
			// Compact single-line for small objects
			const props = lines.slice(1, -1).map(l => l.trim());
			if (props.join(" ").length < 60) {
				return `{ ${props.join(" ")} }`;
			}
		}

		return lines.join("\n");
	}

	if (isJTDDiscriminator(schema)) {
		const variants: string[] = [];
		for (const [tag, props] of Object.entries(schema.mapping)) {
			const propsType = convertToTypeScript(props, true);
			if (propsType === "{}") {
				variants.push(`{ ${schema.discriminator}: "${tag}" }`);
			} else {
				// Merge discriminator into props
				const inner = propsType.slice(1, -1).trim();
				variants.push(`{ ${schema.discriminator}: "${tag}"; ${inner} }`);
			}
		}
		return variants.join(" | ");
	}

	if (isJTDRef(schema)) {
		return schema.ref;
	}

	return "unknown";
}

/**
 * Convert JTD schema to TypeScript interface string.
 *
 * @example
 * ```ts
 * const schema = {
 *   properties: {
 *     name: { type: "string" },
 *     count: { type: "int32" }
 *   }
 * };
 * jtdToTypeScript(schema);
 * // Returns:
 * // {
 * //   name: string;
 * //   count: number;
 * // }
 * ```
 */
export function jtdToTypeScript(schema: unknown): string {
	return convertToTypeScript(schema, false);
}
