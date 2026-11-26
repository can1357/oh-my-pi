/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Think: the model's private reasoning, as muted Markdown under no head.
 * Only the call shows; the result adds nothing.
 *
 * Terminal look: `think` (`src/ui/styles/tools/think.ts`).
 */
import type { ToolPresenter } from "./contract";
import { registerToolPresenter } from "./registry";

export interface ThinkArgs {
	readonly thoughts?: unknown;
}

export const thinkPresenter: ToolPresenter<ThinkArgs> = {
	inline: true,
	call(args, state) {
		const thoughts = typeof args.thoughts === "string" ? args.thoughts : "";
		return {
			body: thoughts.trim() ? (
				<md role="omp.think" text={thoughts} stream={!state.argsComplete} tone="muted" />
			) : undefined,
		};
	},
};

registerToolPresenter("think", thinkPresenter);
