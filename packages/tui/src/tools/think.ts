import type { ToolRenderer } from "./renderer";

import { type Component, Markdown } from "../index";
import type { RenderResultOptions } from "./renderer";
import { getMarkdownTheme, type Theme } from "../theme/theme";

/** Streamed private scratchpad text. */
export type ThinkRenderArgs = {
	thoughts?: string;
};

/** Render private scratchpad text without a result block. */
export const thinkToolRenderer = {
	inline: true,
	renderCall(args: ThinkRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const thoughts =
			typeof args === "object" && args !== null && "thoughts" in args && typeof args.thoughts === "string"
				? args.thoughts
				: "";
		return new Markdown(thoughts, 1, 0, getMarkdownTheme(), {
			color: (text: string) => uiTheme.fg("thinkingText", text),
			italic: true,
		});
	},
	renderResult(): undefined {
		return undefined;
	},
} satisfies ToolRenderer<ThinkRenderArgs, unknown>;
