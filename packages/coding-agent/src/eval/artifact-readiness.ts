import { contextLocalProtocolOptions } from "../internal-urls/context";
import { whenArtifactCopiesSettle } from "../session/session-manager";
import type { ToolSession } from "../tools";

export { EVAL_ARTIFACTS_READY_BRIDGE_NAME } from "./artifact-readiness-name";

/**
 * Settle once every artifact copy this process is running into `session`'s
 * artifacts directory has finished.
 *
 * The helpers that answer `artifact://<n>` inside a cell list that directory
 * from a worker (JavaScript) or a subprocess kernel (Python), neither of which
 * can see the table where the copies are recorded. The directory cannot stand
 * in for it: during a merge it holds part of an inheritance, and before a copy
 * creates its staging tree it holds none of it while the copy is already under
 * way. So the reader asks across the bridge, and this is what answers.
 *
 * The caller's signal cancels the wait: a pending answer is still not
 * something to make a cancelled read sit through.
 */
export async function awaitEvalArtifactsSettled(session: ToolSession, signal?: AbortSignal): Promise<void> {
	const dir = contextLocalProtocolOptions(session)?.getArtifactsDir?.();
	if (!dir) return;
	await whenArtifactCopiesSettle(dir, signal);
}
