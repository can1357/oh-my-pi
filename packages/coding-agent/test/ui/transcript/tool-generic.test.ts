import { type FlowHooks, flowSuite, textComponent } from "./tool-flows";

/** The extension tool `framed` draws `call <q>` and an empty box as its result. */
export const flowHooks: FlowHooks = flow =>
	flow.tool?.renderCall
		? {
				mergeCallAndResult: flow.tool.mergeCallAndResult,
				renderCall: (args: never) => textComponent(`call ${(args as { q?: string }).q ?? "?"}`),
				renderResult: () => textComponent(""),
			}
		: undefined;

for (const id of ["mystery_tool", "custom", "extension-framed-merged", "bash-builtin-renderer-off"])
	flowSuite(id, flowHooks);
