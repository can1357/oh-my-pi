import type { AriaSnapshotOptions } from "./browser/aria/aria-snapshot";
import { dropHeadlessTabs, setWebKitTabsShown } from "./browser/tab-supervisor";

export { createBrowserPrelude } from "./browser/host-prelude";
export { resolveBrowserKind } from "./browser/select-kind";
export type { AriaSnapshotOptions } from "./browser/aria/aria-snapshot";

/** First-use boundary for the generated Playwright ARIA evaluator bundle. */
export function buildAriaSnapshotScript(selector: string | undefined, options: AriaSnapshotOptions = {}): string {
	return require("./browser/aria/aria-snapshot").buildAriaSnapshotScript(selector, options);
}

/** First-use boundary for ARIA-ref parsing; keeps evaluator construction out of tool registration. */
export function parseAriaRefSelector(selector: string): string | null {
	return require("./browser/aria/aria-snapshot").parseAriaRefSelector(selector);
}

export { cmuxSnapshotToObservation, mapWaitUntil, resolveCmuxKind, serializeEval } from "./browser/cmux/rpc";
export { CmuxSocketClient } from "./browser/cmux/socket-client";
export {
	extractMarkdownOutline,
	extractReadableFromHtml,
	filterMarkdownSections,
	type ReadableExtractOptions,
	type ReadableFormat,
	type ReadableResult,
} from "./browser/readable";
export {
	ariaSnapshotBaselineKey,
	collectAriaSnapshotRefs,
	diffAriaSnapshot,
	postProcessAriaSnapshot,
	type AriaSnapshotBaseline,
	type AriaSnapshotDiffResult,
	type SnapshotPostProcessOptions,
} from "./browser/snapshot-plus";
export { isRelayOnly, type RelayKind, resolveRelayKind } from "./browser/relay/kind";
export { type TernKind, resolveTernKind } from "./browser/tern/kind";
export { resolveWebKitKind, type WebKitKind } from "./browser/webkit/kind";
export type { Observation, ObservationEntry } from "./browser/tab-protocol";

/**
 * Apply a change of the browser mode (`/browser headless|visible`). WebKit
 * tabs change now: each gains or loses its window, the page going on
 * untouched. A Chromium cannot change mode while it runs, so its headless
 * tabs are dropped and the next open launches it in the new mode.
 */
export async function applyBrowserModeChange(headless: boolean): Promise<void> {
	try {
		await setWebKitTabsShown(!headless);
	} finally {
		await dropHeadlessTabs();
	}
}
