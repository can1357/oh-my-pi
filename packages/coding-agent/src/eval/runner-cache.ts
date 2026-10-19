/**
 * Shared on-disk staging for subprocess kernel runner scripts.
 *
 * Each language kernel (Python/Julia/Ruby) ships its runner as a compiled-in
 * text asset, then stages it under a per-user directory in `os.tmpdir()` so
 * the interpreter can load it as a normal file. Staging is cached per language
 * directory so repeated kernel starts within a process avoid redundant writes.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { assertOwnerPrivateDir } from "../utils/owner-private-dir";

// Memoized staged path per cache directory. The value is re-validated on every
// call: a tmpdir sweep (e.g. macOS `periodic daily clean_tmps`) or any external
// clear must self-heal within a long-lived process, not only across restarts.
const stagedPaths = new Map<string, string>();

/**
 * Stage `script` under `os.tmpdir()/<dirName>-<uid>` and return the runner path.
 *
 * The directory is per-uid because `os.tmpdir()` is shared between accounts: a
 * single shared name lets whichever account creates it first own it, and every
 * other account's runner write then fails with EACCES. The per-uid name is
 * still predictable, so an existing entry must be a real directory owned by us
 * with mode 0700; otherwise another account could block staging or plant the
 * runner file (whose name is a deterministic hash) for us to execute. A
 * squatted path falls back to a fresh `mkdtemp` directory for this process.
 *
 * The staged path is memoized per `dirName` but re-checked with `fs.existsSync`
 * before reuse, so a runner deleted mid-session is re-written on the next call
 * instead of handing back a path to a missing file (issue #8140).
 *
 * @param dirName Cache subdirectory prefix under the OS temp dir (unique per language).
 * @param ext Runner file extension without the dot (e.g. `py`).
 * @param script Runner source, hashed to key the cached file per version.
 */
export async function stageRunnerScript(dirName: string, ext: string, script: string): Promise<string> {
	const memoized = stagedPaths.get(dirName);
	if (memoized) {
		if (isReusableStagedPath(memoized)) return memoized;
		stagedPaths.delete(dirName);
	}
	const dir = await resolveStagingDir(dirName);
	const hash = Bun.hash(script).toString(36);
	const target = path.join(dir, `runner-${hash}.${ext}`);
	if (!fs.existsSync(target)) {
		await Bun.write(target, script);
	}
	stagedPaths.set(dirName, target);
	return target;
}

/**
 * Whether a memoized runner path is still safe to reuse. On POSIX the parent
 * dir is re-checked with the owner guard: after a tmp sweep another account
 * can recreate the predictable per-uid dir and plant the hashed runner name.
 */
function isReusableStagedPath(target: string): boolean {
	if (process.getuid) {
		const dir = path.dirname(target);
		try {
			assertOwnerPrivateDir(dir, "Runner staging directory");
		} catch (err) {
			// ENOENT is the ordinary sweep case; anything else is a rejected dir.
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				logger.warn("Memoized runner staging dir rejected; re-staging", { dir, error: String(err) });
			}
			return false;
		}
	}
	return fs.existsSync(target);
}

async function resolveStagingDir(dirName: string): Promise<string> {
	const uid = process.getuid?.();
	// No uid (Windows): the temp dir is already per-user, and O_NOFOLLOW is unavailable.
	if (uid === undefined) {
		const dir = path.join(os.tmpdir(), dirName);
		await fs.promises.mkdir(dir, { recursive: true });
		return dir;
	}
	const dir = path.join(os.tmpdir(), `${dirName}-${uid}`);
	try {
		await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
		assertOwnerPrivateDir(dir, "Runner staging directory");
		return dir;
	} catch (err) {
		logger.warn("Runner staging dir unusable; staging in a fresh private dir", { dir, error: String(err) });
		return await fs.promises.mkdtemp(`${dir}-`);
	}
}
