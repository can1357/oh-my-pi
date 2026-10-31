/**
 * The session listing's reader for `omp gc`. Every read goes through
 * {@link openRegularFile}, so listing a session directory never waits on, or
 * drains, a FIFO named like a transcript, directly or through a link. One
 * that is not a regular file is left out of the listing, as one that cannot
 * be read always was; the run names it — see `listActiveSessions` in
 * `gc-cli.ts`.
 *
 * Its own module, not `regular-file.ts`: `session-storage.ts` and
 * `session-archive.ts` import each other, and a class that extends one of
 * them cannot be defined while that cycle is still loading.
 */
import { isArchivedSessionPath } from "./session-archive";
import { readSessionInfo, type SessionInfo } from "./session-listing";
import { FileSessionStorage } from "./session-storage";
import { isAssistantMessageLine } from "./session-entries";
import { absentFile as absent, openRegularFile } from "./regular-file";

export class RegularFileSessionStorage extends FileSessionStorage {
	override async readTextSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		// An archived transcript is inflated whole by the base class, through
		// `inflateArchivedBytes`, which reads through `openRegularFile` too.
		if (isArchivedSessionPath(path)) return await super.readTextSlices(path, prefixBytes, suffixBytes);
		const handle = await openRegularFile(path);
		if (!handle) throw absent(path);
		try {
			const { size } = await handle.stat();
			const head = Buffer.allocUnsafe(Math.min(prefixBytes, size));
			const first = await handle.read(head, 0, head.byteLength, 0);
			const tail = Buffer.allocUnsafe(Math.min(suffixBytes, size));
			const last =
				tail.byteLength > 0 ? await handle.read(tail, 0, tail.byteLength, size - tail.byteLength) : undefined;
			const decoder = new TextDecoder();
			return [
				decoder.decode(head.subarray(0, first.bytesRead)),
				decoder.decode(tail.subarray(0, last?.bytesRead ?? 0)),
			];
		} finally {
			await handle.close().catch(() => undefined);
		}
	}

	override async hasAssistantTurn(path: string): Promise<boolean> {
		const handle = await openRegularFile(path);
		if (!handle) throw absent(path);
		try {
			for await (const line of handle.readLines()) {
				if (isAssistantMessageLine(line)) return true;
			}
			return false;
		} finally {
			await handle.close().catch(() => undefined);
		}
	}
}

/** {@link readSessionInfo} for `omp gc`: the transcript read through {@link RegularFileSessionStorage}. */
export function readRegularSessionInfo(file: string): Promise<SessionInfo | undefined> {
	return readSessionInfo(file, new RegularFileSessionStorage());
}
