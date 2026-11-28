import type { HostEvalPreludeDefinition } from "../../eval/preludes";
import type { ToolSession } from "../registry";
import type { BrowserRelayGuidance } from "./prelude-definition";
import { isRelayOnly } from "./relay/kind";
import { selectBrowserKind } from "./select-kind";

/** Create the enabled-only browser host prelude for one tool session. */
export function createBrowserPrelude(session: ToolSession): HostEvalPreludeDefinition {
	// Eval-first-use boundary: source/declaration assets stay unloaded until a
	// JavaScript or Python kernel actually asks for its enabled preludes.
	const { createBrowserPreludeDefinition } = require("./prelude-definition") as typeof import("./prelude-definition");
	return createBrowserPreludeDefinition(session, {
		async invoke(parameters, context) {
			const { invokeBrowser } = await import("./actions");
			return invokeBrowser(session, parameters, context);
		},
		status(parameters, result) {
			const { describeBrowserCall } = require("./actions") as typeof import("./actions");
			return describeBrowserCall(parameters, result);
		},
		// The documentation promises omp's own browser for an open without `app`; while
		// the relay takes that open, the prompt says so: the only browser in relay-only
		// mode, otherwise naming where `app: "auto"` goes instead.
		get relay(): BrowserRelayGuidance | undefined {
			if (isRelayOnly()) return { mode: "only" };
			return selectBrowserKind({ action: "open" }, session).kind === "relay"
				? { mode: "default", fallback: selectBrowserKind({ action: "open", app: "auto" }, session) }
				: undefined;
		},
	});
}
