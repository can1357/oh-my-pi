import type { ToolCommandInput, ToolCommandMounted } from "../../../src/ui/tools/tool-command";
import { toolCommandPresenter } from "../../../src/ui/tools/tool-command";
import type { ExtensionRows } from "../../../src/extensibility/extensions/render-types";
import { wrap } from "@oh-my-pi/pi-tui/text/width";
import { type ToolCaseInputs, type ToolScreen, toolScreenSuite } from "./screens";

/** A component drawing `text` wrapped at the width (an extension's plain text). */
function textRows(text: string): ExtensionRows {
	return {
		render: width => text.split("\n").flatMap(line => wrap(line, width)),
	};
}

/** The corpus's mounted tool `t`: label `my\ttool`, call `call <json args>`, result `result <text>` and a wide line. */
function mounted(merge: boolean): ToolCommandMounted {
	return {
		label: "my\ttool",
		legacy: {
			mergeCallAndResult: merge,
			renderCall: (args: never) => textRows(`call ${JSON.stringify(args)}`),
			renderResult: (result: never) =>
				textRows(
					`result ${(result as { content: { text?: string }[] }).content[0]?.text ?? "∅"}\n漢字 ${"r".repeat(90)}`,
				),
		},
	};
}

export const toolCommandScreen: ToolScreen = {
	dir: "tools/tool-command",
	name: "tool-command",
	presenter: toolCommandPresenter as never,
	adapter: {
		args: (inputs: ToolCaseInputs) => {
			const input = inputs.args as ToolCommandInput;
			if (input.dispatch.tool !== "t") return input;
			const renderer = mounted(input.dispatch.exitCode !== 0);
			return { ...input, resolveMounted: () => renderer };
		},
	},
};

toolScreenSuite(toolCommandScreen);
