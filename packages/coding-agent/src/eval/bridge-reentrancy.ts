import { AsyncLocalStorage } from "node:async_hooks";

import type { ToolSession } from "../tools";

/**
 * Tool session whose eval kernel is currently blocked serving a host bridge call.
 *
 * A cell reaches the host through the loopback bridge (`tool.*`, `agent()`,
 * `wait()`, …) and parks until the bridge replies. If the bridged handler turns
 * around and asks that same kernel for something — e.g. `task`/`agent()`/`workpool()`
 * preflight resolving kernel-defined `tools` via `describeEvalTools` — the kernel
 * can never answer: on Windows the runner serves requests serially, so the
 * describe line sits unread until the cell ends, and the cell waits for the
 * describe. Neither side moves (issue #18644). POSIX happens to serve tool
 * requests concurrently, so the same call works there — a platform-dependent
 * hang is worse than a clean error.
 *
 * The marker is set around the whole bridge dispatch ({@link callSessionTool}
 * in `eval/js/tool-bridge.ts`, the single funnel for both the Python and JS
 * bridges), so re-entrant kernel queries can fail fast instead of awaiting a
 * reply that cannot come. Host-side calls (model `task` tool, kernel idle) never
 * run under the marker and keep the live kernel round-trip.
 */
const activeBridgeSession = new AsyncLocalStorage<ToolSession>();

/** Run `action` as the host side of an eval bridge call owned by `session`. */
export function runWithEvalBridgeSession<T>(session: ToolSession, action: () => T): T {
	return activeBridgeSession.run(session, action);
}

/** The session whose kernel is blocked on the bridge call in flight, if any. */
export function getActiveEvalBridgeSession(): ToolSession | undefined {
	return activeBridgeSession.getStore();
}
