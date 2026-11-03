// Type-checked copy of block 2 under "### Delegating to a native built-in (`ctx.invokeTool`)" in docs/extensions.md; test/extensibility/doc-snippets.test.ts keeps the two identical.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

declare const pi: ExtensionAPI;
// ---- documented snippet below, verbatim ----
import { Text } from "@oh-my-pi/pi-tui";

const z = pi.zod;

pi.registerTool({
	name: "my_tool",
	label: "My Tool",
	description: "...",
	parameters: z.object({}),
	hidden: false,
	defaultInactive: false,
	deferrable: false,
	async execute(_id, _params, signal, onUpdate, ctx) {
		if (signal?.aborted) {
			return { content: [{ type: "text", text: "Cancelled" }] };
		}
		onUpdate?.({ content: [{ type: "text", text: "Working..." }] });
		return { content: [{ type: "text", text: "Done" }], details: {} };
	},
	onSession(event, ctx) {
		// reason: start|switch|branch|tree|shutdown
	},
	// Optional TUI renderers; each returns a component.
	renderCall(_args, _options, theme) {
		return new Text(theme.fg("toolTitle", "my_tool"), 0, 0);
	},
	renderResult(result, _options, theme) {
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		return new Text(theme.fg("muted", text), 0, 0);
	},
});
