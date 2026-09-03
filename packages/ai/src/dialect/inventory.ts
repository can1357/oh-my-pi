import { jsonSchemaToTypeScript, toolWireSchema } from "../utils/schema";
import { renderToolExamplesJsdoc } from "./examples";
import type { InbandTool } from "./types";

/**
 * Tool catalog in the OpenAI-Harmony `namespace functions { … }` shape: each
 * tool renders as its full description (and Python-syntax examples) as `//`
 * comment lines above a flat `type <name> = (_: {…});` declaration. Shared by
 * the verbose system-prompt inventory and `/dump` so both render the catalog
 * the same way.
 */
export function renderToolInventory(tools: readonly InbandTool[]): string {
	if (tools.length === 0) return "";
	const declarations = tools.map(tool => {
		const params = jsonSchemaToTypeScript(toolWireSchema(tool), { style: "harmony" });
		const lines: string[] = [];
		const description = tool.description ?? "";
		if (description) {
			for (const line of description.split("\n")) lines.push(`// ${line}`.trimEnd());
		}
		const examples = renderToolExamplesJsdoc(tool);
		if (examples) {
			if (description) lines.push("//");
			for (const line of examples.split("\n")) lines.push(`// ${line}`.trimEnd());
		}
		lines.push(params === "{}" ? `type ${tool.name} = ();` : `type ${tool.name} = (_: ${params});`);
		return lines.join("\n");
	});
	return `## functions\n\nnamespace functions {\n\n${declarations.join("\n\n")}\n\n} // namespace functions`;
}
