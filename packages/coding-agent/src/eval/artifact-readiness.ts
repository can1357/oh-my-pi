import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { contextLocalProtocolOptions } from "../internal-urls/context";
import { artifactCopiesPending, whenArtifactCopiesSettle } from "../session/session-manager";
import type { ToolSession } from "../tools";

export { EVAL_ARTIFACTS_READY_BRIDGE_NAME } from "./artifact-readiness-name";

/**
 * The file backing `artifact://<id>` in this session's artifacts directory,
 * once every copy filling that directory has finished — or `null` when the id
 * is not there, or the session has no artifacts directory of its own.
 *
 * The helpers that answer `artifact://<n>` inside a cell run where this
 * process's record of its copies cannot be reached: a worker for JavaScript, a
 * subprocess kernel for Python. Asking them to list the directory themselves
 * is what made the answer wrong — mid-copy it holds part of an inheritance —
 * and asking first and listing afterwards only moves the gap, because a copy
 * can be announced between the two answers. So the waiting and the listing are
 * one operation, done here, and what crosses the bridge is the file.
 *
 * The loop is the same point: a copy announced while this one was listing
 * means the listing is already out of date, and the only answer that is not is
 * one taken while nothing is running.
 *
 * The caller's signal cancels the wait: a pending answer is still not
 * something to make a cancelled read sit through.
 */
export async function resolveSettledArtifact(
	session: ToolSession,
	id: string,
	root?: string,
	signal?: AbortSignal,
): Promise<string | null> {
	// The directory the reader is reading, which a cell suspended across a
	// re-adoption is not the session's current one.
	const dir = root ?? contextLocalProtocolOptions(session)?.getArtifactsDir?.();
	if (!dir) return null;
	for (;;) {
		await whenArtifactCopiesSettle(dir, signal);
		const found = await artifactInDirectory(dir, id);
		if (!artifactCopiesPending(dir)) return found;
	}
}

/** The `<id>.<tool>.log` file for `id` in `dir`, or `null`. */
async function artifactInDirectory(dir: string, id: string): Promise<string | null> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		return null;
	}
	const name = names.find(entry => entry.startsWith(`${id}.`));
	return name === undefined ? null : path.join(path.resolve(dir), name);
}

/**
 * Settle once every artifact copy into this session's artifacts directory has
 * finished. Used where the caller has no id to resolve, only a directory to
 * wait for.
 */
export async function awaitEvalArtifactsSettled(session: ToolSession, signal?: AbortSignal): Promise<void> {
	const dir = contextLocalProtocolOptions(session)?.getArtifactsDir?.();
	if (!dir) return;
	await whenArtifactCopiesSettle(dir, signal);
}
