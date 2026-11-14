import type { Tool } from "@oh-my-pi/pi-ai";

/**
 * Every {@link Tool} field and nothing else: `satisfies` stops compiling when `Tool` gains or drops a field, so a
 * declaration cannot drift from what providers serialize. Anything else on a live tool object (sessions, runners,
 * caches) is execution state that never reaches the wire (#17819).
 */
const TOOL_DECLARATION_KEYS = Object.keys({
	name: true,
	description: true,
	parameters: true,
	strict: true,
	deferLoading: true,
	customFormat: true,
	customWireName: true,
	native: true,
	examples: true,
} satisfies Record<keyof Tool, true>) as (keyof Tool)[];

/**
 * `tools` as providers declare them: each tool's {@link Tool} fields only. The agent loop spreads live tool objects
 * into the request, so their own fields (an extension wrapper's inner tool and runner, a tool's session) ride along.
 */
export function declaredTools(tools: readonly Tool[] | undefined): Tool[] | undefined {
	return tools?.map(tool => {
		const declared: Partial<Record<keyof Tool, unknown>> = {};
		for (const key of TOOL_DECLARATION_KEYS) declared[key] = tool[key];
		return declared as Tool;
	});
}
