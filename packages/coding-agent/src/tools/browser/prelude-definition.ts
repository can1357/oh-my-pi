import { prompt } from "@oh-my-pi/pi-utils";
import type { EvalPreludeDefinition } from "../../eval/preludes";
import { CHROME_MCP_SERVER_NAME } from "../../mcp/auto-chrome-mcp";
import { redactUrlForLog } from "../../mcp/json-rpc";
import chromeMcpGuidance from "../../prompts/system/browser-chrome-mcp.md" with { type: "text" };
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
		get guidance(): string | undefined {
			const blocks: string[] = [];
			if (fallback) {
				blocks.push(
					prompt.render(relayGuidance, {
						// The block reaches the model provider: never echo userinfo or token params.
						cdpUrl: fallback.kind === "connected" ? redactUrlForLog(fallback.cdpUrl) : undefined,
						tern: fallback.kind === "tern",
						cmux: fallback.kind === "cmux",
					}),
				);
			}
			// Read live: the prelude is created before deferred MCP discovery connects
			// the chrome server, and a reconnect/disable must flip the notice with it.
			if (session.mcpManager?.getConnectedServers().includes(CHROME_MCP_SERVER_NAME)) {
				blocks.push(prompt.render(chromeMcpGuidance));
			}
			return blocks.length > 0 ? blocks.join("\n\n") : undefined;
		},
		javascript: browserJavascript,
		python: browserPython,
		exports: ["browser"],
		approval: "exec",
		enabled: () => cfgBrowserEnabled.get(session.settings),
		invoke: host.invoke,
		status: host.status,
	};
}
