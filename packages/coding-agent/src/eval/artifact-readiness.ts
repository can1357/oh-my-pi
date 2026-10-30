import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { contextLocalProtocolOptions } from "../internal-urls/context";
import { artifactsDirsFromRegistry } from "../internal-urls/registry-helpers";
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
			// A miss belongs to the directory that asked, and is answered here
			// rather than handed back. Anything the reader does with "not
			// there" resolves the id again, under whatever directory the
			// session reads by then — and between this answer and the reader
			// receiving it the session can be re-adopted, which is a different
			// conversation's artifact wearing the same number.
			const current = contextLocalProtocolOptions(session)?.getArtifactsDir?.();
			// A cell whose session has moved on reads its own directory and no
			// other: every other one belongs to a conversation it is not in.
			if (current && path.resolve(current) !== path.resolve(dir)) {
				throw new ToolError(
					`artifact://${id} is not in ${dir}, the artifacts directory this cell was started with`,
				);
			}
			const elsewhere = await artifactElsewhere(dir, id, signal);
			if (elsewhere) return elsewhere;
			throw new ToolError(`artifact://${id} is in no artifacts directory this process knows, including ${dir}`);
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

/**
 * The file for `id` in any artifacts directory this process knows other than
 * `dir`, once the copies into it have settled — which is how a session reads
 * an artifact another session produced.
 *
 * Searched here, not by the reader: a reader told "not there" would look it up
 * again later, and by then "there" can mean another directory entirely.
 */
async function artifactElsewhere(dir: string, id: string, signal?: AbortSignal): Promise<string | null> {
	for (const other of artifactsDirsFromRegistry()) {
		if (path.resolve(other) === path.resolve(dir)) continue;
		await whenArtifactCopiesSettle(other, signal);
		const found = await artifactInDirectory(other, id);
		if (found) return found;
	}
	return null;
}

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
