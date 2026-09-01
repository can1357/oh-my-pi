/**
 * Generate the TypeScript method signatures advertising eval-bridged tools
 * under Codex Code Mode (spliced into the `eval-code-mode.md` prompt),
 * mirroring codex-rs augment_tool_spec_for_code_mode.
 */
import { arkToWireSchema, isArkSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";

interface JsonSchema {
	type?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	enum?: unknown[];
}

const TS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function tsType(schema: JsonSchema | undefined, depth: number): string {
	if (!schema || depth > 2) return "unknown";
	if (Array.isArray(schema.enum) && schema.enum.every(value => typeof value === "string")) {
		return schema.enum.map(value => JSON.stringify(value)).join(" | ");
	}
	switch (schema.type) {
		case "string":
			return "string";
		case "number":
		case "integer":
			return "number";
		case "boolean":
			return "boolean";
		case "array": {
			const item = tsType(schema.items, depth + 1);
			// `"a" | "b"[]` parses as `"a" | ("b"[])`, so a union item needs parens.
			return /[|&]/.test(item) ? `(${item})[]` : `${item}[]`;
		}
		case "object": {
			if (!schema.properties) return "Record<string, unknown>";
			const required = new Set(schema.required ?? []);
			const entries = Object.entries(schema.properties).map(([key, value]) => {
				const printedKey = TS_IDENTIFIER.test(key) ? key : JSON.stringify(key);
				return `${printedKey}${required.has(key) ? "" : "?"}: ${tsType(value, depth + 1)}`;
			});
			return `{ ${entries.join("; ")} }`;
		}
		default:
			return "unknown";
	}
}

export function generateCodeModeDeclarations(tools: ReadonlyArray<{ name: string; parameters: unknown }>): string {
	const lines = tools.map(tool => {
		const printedName = TS_IDENTIFIER.test(tool.name) ? tool.name : JSON.stringify(tool.name);
		const wire = isArkSchema(tool.parameters)
			? (arkToWireSchema(tool.parameters) as JsonSchema)
			: (tool.parameters as JsonSchema | undefined);
		const args = wire?.type === "object" && wire.properties ? tsType(wire, 0) : "unknown";
		return `  ${printedName}(args: ${args}): Promise<unknown>;`;
	});
	return lines.join("\n");
}
