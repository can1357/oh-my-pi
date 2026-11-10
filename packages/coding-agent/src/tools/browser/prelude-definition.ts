import { prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import type { EvalPreludeDefinition } from "../../eval/preludes";
import { redactUrlForLog } from "../../mcp/json-rpc";
import relayGuidance from "../../prompts/system/browser-relay.md" with { type: "text" };
import browserCoreDescription from "../../prompts/tools/browser-core.md" with { type: "text" };
import browserDescription from "../../prompts/tools/browser.md" with { type: "text" };
import type { ToolSession } from "../../sdk";
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import browserJavascript from "./prelude.js" with { type: "text" };
import browserPython from "./prelude.py" with { type: "text" };
import type { BrowserKind } from "./registry";
import { isLoopbackRelayUrl } from "./relay/daemon";
import { cfgBrowserCdpUrl, cfgBrowserEnabled, cfgBrowserRelayUrl } from "./settings";

/**
 * The browser eval documentation. Its Linux X11 notes follow the browser's host: they reach agents on Linux, and
 * elsewhere when a configured browser (`browser.cdpUrl`, `browser.relayUrl`) is on another machine, which may be Linux.
 */
export function browserDocumentation(settings: Settings, platform: NodeJS.Platform = process.platform): string {
	const remoteBrowser = [cfgBrowserCdpUrl.get(settings), cfgBrowserRelayUrl.get(settings)].some(
		url => typeof url === "string" && url.trim() !== "" && !isLoopbackRelayUrl(url.trim()),
	);
	return prompt.render(browserDescription, { linux: platform === "linux" || remoteBrowser });
}

/** Build the browser eval facade after an eval runtime first requests preludes. */
export function createBrowserPreludeDefinition(
	session: ToolSession,
	host: Pick<EvalPreludeDefinition, "invoke" | "status"> & {
		/** Where an open with `app: "auto"` goes; set only while an open without `app` goes to the relay. */
		relayFallback?: BrowserKind;
	},
): EvalPreludeDefinition {
	const fallback = host.relayFallback;
	return {
		name: "browser",
		// Read per use: the definition is built once per session, while the browser settings it follows can change.
		get documentation() {
			return browserDocumentation(session.settings);
		},
		firstCallDocumentation: browserCoreDescription,
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
