import { prompt } from "@oh-my-pi/pi-utils";
import type { EvalPreludeDefinition } from "../../eval/preludes";
import { redactUrlForLog } from "../../mcp/json-rpc";
import relayGuidance from "../../prompts/system/browser-relay.md" with { type: "text" };
import browserDescription from "../../prompts/tools/browser.md" with { type: "text" };
import type { ToolSession } from "../../sdk";
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import browserJavascript from "./prelude.js" with { type: "text" };
import browserPython from "./prelude.py" with { type: "text" };
import type { BrowserKind } from "./registry";
import { cfgBrowserEnabled } from "./settings";

/** Build the browser eval facade after an eval runtime first requests preludes. */
export function createBrowserPreludeDefinition(
	session: ToolSession,
	host: Pick<EvalPreludeDefinition, "invoke" | "status"> & {
		/** Where an open with `app.relay: false` goes; set only while an open without `app` goes to the relay. */
		relayFallback?: BrowserKind;
	},
): EvalPreludeDefinition {
	const fallback = host.relayFallback;
	return {
		name: "browser",
		documentation: browserDescription,
		guidance: fallback
			? prompt.render(relayGuidance, {
					// The block reaches the model provider: never echo userinfo or token params.
					cdpUrl: fallback.kind === "connected" ? redactUrlForLog(fallback.cdpUrl) : undefined,
					tern: fallback.kind === "tern",
					cmux: fallback.kind === "cmux",
				})
			: undefined,
		javascript: browserJavascript,
		python: browserPython,
		exports: ["browser"],
		approval: "exec",
		enabled: () => cfgBrowserEnabled.get(session.settings),
		invoke: host.invoke,
		status: host.status,
	};
}
