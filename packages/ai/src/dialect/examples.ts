import { pyCall } from "./rendering";
import type { InbandTool } from "./types";

const INTENT_PLACEHOLDER = "…";

/**
 * Render a tool's examples as an `<examples>` block. Calls render in Python
 * keyword-argument syntax (`name(key="value", n=1)`) regardless of the model's
 * tool-call dialect, so example bytes stay identical across models. Multiline
 * string args render as verbatim `"""…"""` blocks, and a call whose only
 * argument is a string renders as the bare value — the block already names the
 * tool, and payload args (commands, code, patches) read best verbatim.
 */
export function renderToolExamples(tool: InbandTool, intentField?: string): string {
	const examples = tool.examples;
	if (!examples?.length) return "";
	const renderCall = (args: Record<string, unknown>): string => {
		const bare = bareStringArg(args);
		if (bare !== undefined) {
			// Bare payload. The intent placeholder still rides on the envelope so
			// intent-traced schemas (where `i` is required) keep teaching it.
			const intentAttr = intentField ? ` ${intentField}="${INTENT_PLACEHOLDER}"` : "";
			return `<example${intentAttr}>\n${bare}\n</example>`;
		}
		// When intent tracing injects `i` into the schema, examples must show a
		// placeholder so the model learns to emit it. Keep it first, matching the
		// schema injection order.
		const finalArgs = intentField ? { [intentField]: INTENT_PLACEHOLDER, ...args } : args;
		return `<example>\n${pyCall(tool.name, finalArgs)}\n</example>`;
	};
	const parts = examples.map(ex => {
		const head = ex.caption ? `# ${ex.caption}\n` : "";
		if ("call" in ex) return head + renderCall(ex.call);
		if ("good" in ex) {
			return `${head}WRONG:\n${renderCall(ex.bad)}\nRIGHT:\n${renderCall(ex.good)}`;
		}
		return head.trimEnd() + (ex.note ? `\n${ex.note}` : "");
	});
	return `<examples>\n${parts.join("\n")}\n</examples>`;
}

/**
 * Render a tool's examples as JSDoc-style `@example` lines for comment-gutter
 * contexts (the Harmony `namespace functions` inventory): `@example "caption"`
 * followed by the call in the same Python kwargs syntax as the wire block. The
 * tag line delimits each example, so no XML envelope is needed — which is why
 * the inventory uses this instead of `//`-prefixing the `<examples>` block.
 */
export function renderToolExamplesJsdoc(tool: InbandTool): string {
	const examples = tool.examples;
	if (!examples?.length) return "";
	const renderCall = (args: Record<string, unknown>): string => bareStringArg(args) ?? pyCall(tool.name, args);
	const parts = examples.map(ex => {
		const head = ex.caption ? `@example ${JSON.stringify(ex.caption)}` : "@example";
		if ("call" in ex) return `${head}\n${renderCall(ex.call)}`;
		if ("good" in ex) return `${head}\nWRONG:\n${renderCall(ex.bad)}\nRIGHT:\n${renderCall(ex.good)}`;
		return ex.note ? `${head}\n${ex.note}` : head;
	});
	return parts.join("\n");
}

/** Sole-argument string payload, if the call has exactly one string argument. */
function bareStringArg(args: Record<string, unknown>): string | undefined {
	let sole: unknown;
	let count = 0;
	for (const key in args) {
		count++;
		sole = args[key];
	}
	return count === 1 && typeof sole === "string" ? sole : undefined;
}
