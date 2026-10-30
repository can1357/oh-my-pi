import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { contextLocalProtocolOptions } from "../internal-urls/context";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { artifactCopyActivity, whenArtifactCopiesSettle } from "../session/session-manager";
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
 * means the listing is already out of date. "Nothing is pending now" does not
 * say that — a copy that started *and finished* during the listing leaves an
 * empty table behind a stale answer — so what is compared is the count of
 * copies ever announced into that directory, which only goes up.
 *
 * The caller's signal cancels the wait and the answer alike: a listing taken
 * before an abort is not something to hand back afterwards as though the read
 * had succeeded.
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
	for (let attempt = 1; ; attempt++) {
		await whenArtifactCopiesSettle(dir, signal);
		const before = artifactCopyActivity(dir);
		const found = await artifactInDirectory(dir, id);
		const after = artifactCopyActivity(dir);
		if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
		if (after.announced === before.announced && after.pending === 0) {
			if (found) return found;
			// A miss belongs to the directory that asked. Handing the id back
			// for the ordinary lookup would answer it from whatever directory
			// the session reads now, which for a cell suspended across a
			// re-adoption is a different conversation's artifact wearing the
			// same number.
			const current = contextLocalProtocolOptions(session)?.getArtifactsDir?.();
			if (current && path.resolve(current) !== path.resolve(dir)) {
				throw new ToolError(
					`artifact://${id} is not in ${dir}, the artifacts directory this cell was started with`,
				);
			}
			return null;
		}
		// Copies arriving back to back with no gap between them would keep a
		// reader here forever. Saying so is better than answering from a
		// listing that was out of date before it finished.
		if (attempt >= ARTIFACT_RESOLVE_ATTEMPTS) {
			throw new ToolError(
				`artifact://${id} could not be read: copies into ${dir} kept arriving through ${attempt} attempts to list it`,
			);
		}
	}
}

/** How many times a reader re-lists a directory that keeps gaining copies before it gives up. */
const ARTIFACT_RESOLVE_ATTEMPTS = 16;

/** The `<id>.<tool>.log` file for `id` in `dir`, or `null`. */
async function artifactInDirectory(dir: string, id: string): Promise<string | null> {
	let names: string[];
	try {
		names = await fs.promises.readdir(dir);
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
