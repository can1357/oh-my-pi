import type { NativeToolView, ToolRenderer } from "./renderer";

import { type Component, Markdown } from "../index";
import type { RenderResultOptions } from "./renderer";
import { getMarkdownTheme, type Theme } from "../theme/theme";
import { md } from "../native/describe";
import { OwnerMemo } from "../native/memo";

/** Streamed private scratchpad text. */
export type ThinkRenderArgs = {
	thoughts?: string;
};

const thinkCallMemo = new OwnerMemo<NativeToolView | undefined>();

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
	describeCall(args: ThinkRenderArgs, options: RenderResultOptions): NativeToolView {
		const thoughts =
			typeof args === "object" && args !== null && typeof args.thoughts === "string" ? args.thoughts : "";
		const streaming = options.argsComplete === false;
		return (
			thinkCallMemo.get(args, [streaming, thoughts], () => ({
				inline: true,
				body: thoughts ? [md(thoughts, { role: "omp.think", tone: "muted", stream: streaming })] : [],
			})) ?? { inline: true }
		);
	},
	describeResult(): undefined {
		return undefined;
	},
} satisfies ToolRenderer<ThinkRenderArgs, unknown>;
