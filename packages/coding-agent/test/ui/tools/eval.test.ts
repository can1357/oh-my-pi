import { evalPresenter } from "../../../src/ui/tools/eval";
import { type ToolScreen, toolScreenSuite } from "./screens";

/**
 * The corpus drove the eval renderer directly, with the transcript's viewport context. Its `inline` is the
 * old renderer's "no background box" flag, which never framed the transcript block (that stays a card).
 */
export const evalScreen: ToolScreen = {
	dir: "tools/eval",
	name: "eval",
	presenter: { ...evalPresenter, inline: true },
	steps: {
		"renderContext preview 2 lines": state => ({
			...state,
			renderContext: { ...state.renderContext, previewLines: 2, timeout: 30 },
		}),
		"renderContext collapsed 8 lines": state => ({
			...state,
			renderContext: {
				...state.renderContext,
				expanded: false,
				previewLines: 8,
			},
		}),
	},
};

toolScreenSuite(evalScreen);
