import type { EvalPreludeDefinition } from "../../eval/preludes";
import browserDescription from "../../prompts/tools/browser.md" with { type: "text" };
import type { ToolSession } from "../../sdk";
// @ts-expect-error Bun imports this declaration source as text instead of a TypeScript module.
import browserDeclarations from "./declarations.d.ts" with { type: "text" };
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import browserJavascript from "./prelude.js" with { type: "text" };
import browserPython from "./prelude.py" with { type: "text" };

import { cfgBrowserEnabled } from "./settings";

/** Build the browser eval facade after an eval runtime first requests preludes. */
export function createBrowserPreludeDefinition(
	session: ToolSession,
	host: Pick<EvalPreludeDefinition, "invoke" | "status">,
): EvalPreludeDefinition {
	return {
		name: "browser",
		documentation: browserDescription,
		javascript: browserJavascript,
		python: browserPython,
		exports: ["browser"],
		codeModeDeclarations: browserDeclarations,
		approval: "exec",
		enabled: () => cfgBrowserEnabled.get(session.settings),
		invoke: host.invoke,
		status: host.status,
	};
}
