/**
 * Offline rendering: a node tree to rows at a width, without a terminal.
 * Tests, previews and corpus comparisons use it.
 */
import type { UiNode } from "../node";
import { type Block, type PaintEnvironment, paintNode, staticEnvironment } from "./paint";
import type { Theme } from "../theme/contract";
import "./painters";

/** Paint `node` at `width` (and `height`) in `env`, or in a fresh static environment over `theme`. */
export function renderBlock(
	node: UiNode,
	width: number,
	options: { env?: PaintEnvironment; theme?: Theme; height?: number },
): Block {
	const env = options.env ?? staticEnvironment(options.theme ?? requireTheme());
	return paintNode(env, node, width, options.height);
}

function requireTheme(): never {
	throw new Error("renderBlock: pass a theme or an environment");
}
