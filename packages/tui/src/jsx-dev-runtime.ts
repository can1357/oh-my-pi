/** Development JSX runtime entry; same elements as `jsx-runtime`, source positions ignored. */
import { jsx } from "./element";
import type { JSXNode } from "./types";

export { Fragment } from "./element";
export type { JSX } from "./types";

/** Dev-mode factory: the extra arguments (static flag, source, self) carry nothing pi-tui uses. */
export function jsxDEV(type: unknown, props: Readonly<Record<string, unknown>>, key?: string): JSXNode {
	return jsx(type, props, key);
}
