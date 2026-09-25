import computerDescription from "../../prompts/tools/computer.md" with { type: "text" };
// @ts-expect-error Bun imports this declaration source as text instead of a TypeScript module.
import computerCodeModeDeclarations from "./declarations.d.ts" with { type: "text" };
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import computerJavascript from "./prelude.js" with { type: "text" };
import computerPython from "./prelude.py" with { type: "text" };

/** Static eval-facade assets loaded only when a kernel first requests computer preludes. */
export const computerPreludeAssets = {
	documentation: computerDescription,
	javascript: computerJavascript,
	python: computerPython,
	codeModeDeclarations: computerCodeModeDeclarations,
} as const;
