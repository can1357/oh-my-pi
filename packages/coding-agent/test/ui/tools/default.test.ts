import { defaultPresenter } from "../../../src/ui/tools/default";
import type { ToolResult } from "../../../src/ui/tools/contract";
import { type ToolCaseInputs, type ToolScreen, toolScreenSuite } from "./screens";

/** The corpus drove the generic card with `{ label, args }` and a `{ skipped }` result flag. */
interface DefaultInput {
	readonly label: string;
	readonly args: unknown;
}

export const defaultScreen: ToolScreen = {
	dir: "tools/default",
	name: "mystery_tool",
	presenter: defaultPresenter,
	adapter: {
		args: (inputs: ToolCaseInputs) => (inputs.args as DefaultInput).args,
		result: (inputs: ToolCaseInputs): ToolResult | undefined => inputs.result,
		renderContext: (inputs: ToolCaseInputs) => ({
			label: (inputs.args as DefaultInput).label,
		}),
	},
};

toolScreenSuite(defaultScreen);
