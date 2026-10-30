import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { contextLocalProtocolOptions } from "../internal-urls/context";
import { artifactsDirsFromRegistry } from "../internal-urls/registry-helpers";
import { artifactCopyActivity, whenArtifactCopiesSettle } from "../session/session-manager";
import type { ToolSession } from "../tools";

export { EVAL_ARTIFACTS_READY_BRIDGE_NAME } from "./artifact-readiness-name";

/** What a reader is told about the file it asked for, so it can check what it opens. */
export interface SettledArtifact {
	path: string;
	device: string;
	inode: string;
	/**
	 * The artifact's text, read through the descriptor this process holds on
	 * the directory. Sent only when the reader asks for it, which it does when
	 * the file its pathname reaches is no longer the one answered for: the
	 * directory has been replaced under it, and the hold is the only way left
	 * to the file.
	 */
	text?: string;
}

/**
 * An artifacts directory held open for the cells that were given it.
 *
 * A pathname is not an identity. A directory moved aside and replaced, or
 * deleted and recreated onto the same inode, answers to the same name, and a
 * `(device, inode)` pair recorded at one moment and compared at another is the
 * same re-derivation in smaller print. An open descriptor is the directory: it
 * belongs to whoever opened it, it pins the inode so no recycling can alias
 * it, and on Linux `/proc/self/fd/<n>` reads through it rather than through
 * the name.
 */
interface HeldRoot {
	/** Path that resolves through the descriptor, or the plain path off Linux. */
	at: string;
	path: string;
	identity: string;
	close(): Promise<void>;
}

const CAN_HOLD_DIRECTORIES = process.platform === "linux";

/** The directory `dir` is now, as a device and inode pair, or `undefined`. */
function directoryIdentity(dir: string): string | undefined {
	try {
		const stat = fs.statSync(dir, { bigint: true });
		return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The roots this process holds open, by the token a cell was given.
 *
 * Keyed by the token rather than by the pathname: two cells can be started on
 * one pathname naming two different directories, and the second must not
 * overwrite what the first is reading. A token is reused while the pathname
 * still reaches the same directory, so an ordinary session holds one
 * descriptor however many cells it runs.
 */
const heldRoots = new Map<string, HeldRoot>();
/** Tokens by resolved pathname, so a cell on an unchanged root reuses its hold. */
const tokensByPath = new Map<string, string>();
/** Held roots kept at once; the oldest is closed, and a read through it is refused. */
const HELD_ROOTS_MAX = 64;

async function holdDirectory(dir: string): Promise<HeldRoot | undefined> {
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
	} catch {
		return undefined;
	}
	const stat = await handle.stat({ bigint: true });
	return {
		at: CAN_HOLD_DIRECTORIES ? `/proc/self/fd/${handle.fd}` : dir,
		path: dir,
		identity: `${stat.dev}:${stat.ino}`,
		close: () => handle.close(),
	};
}

/**
 * Hold the artifacts directory a cell is being started on, and return the
 * token that reaches it.
 *
 * The token travels with the cell and comes back with every read it makes, so
 * the directory a read is answered from is the one that cell was given — not
 * whatever its pathname reaches when the read lands.
 */
export async function holdArtifactRoot(dir: string): Promise<string | undefined> {
	const resolved = path.resolve(dir);
	const existing = tokensByPath.get(resolved);
	const held = existing ? heldRoots.get(existing) : undefined;
	const now = await holdDirectory(resolved);
	if (!now) return undefined;
	if (held && held.identity === now.identity) {
		// The same directory, still open: one hold serves every cell on it.
		await now.close();
		return existing;
	}
	const token = `root-${crypto.randomUUID()}`;
	heldRoots.set(token, now);
	tokensByPath.set(resolved, token);
	while (heldRoots.size > HELD_ROOTS_MAX) {
		const oldest = heldRoots.keys().next().value;
		if (oldest === undefined) break;
		const dropped = heldRoots.get(oldest);
		heldRoots.delete(oldest);
		if (dropped && tokensByPath.get(path.resolve(dropped.path)) === oldest) {
			tokensByPath.delete(path.resolve(dropped.path));
		}
		await dropped?.close();
	}
	return token;
}

/** Give up every held root; for tests and for a process winding down. */
export async function releaseArtifactRoots(): Promise<void> {
	const held = [...heldRoots.values()];
	heldRoots.clear();
	tokensByPath.clear();
	for (const root of held) await root.close();
}

/**
 * The file backing `artifact://<id>` for the cell that holds `token`, once
 * every copy filling the directory it was given has finished — or an error
 * naming what it looked in.
 *
 * The waiting and the listing are one operation, done here. Asking first and
 * listing afterwards only moves the gap, because a copy can be announced
 * between the two answers, and what is compared across the listing is the
 * number of copies ever announced into that directory, which only goes up: a
 * copy that started *and* finished during the listing leaves an empty pending
 * table behind an answer that is already old.
 *
 * What comes back is the file *and* what it is, because the reader consumes
 * this answer later still. A reader opens the path and checks the object it
 * opened against the identity here; a directory replaced in between gives a
 * different file, and the read is refused instead of returning somebody else's
 * artifact under this session's number.
 *
 * The caller's signal cancels the wait and the answer alike: a listing taken
 * before an abort is not something to hand back afterwards as though the read
 * had succeeded.
 */
export async function resolveSettledArtifact(
	session: ToolSession,
	id: string,
	root?: string,
	token?: string,
	signal?: AbortSignal,
	wantText = false,
): Promise<SettledArtifact | null> {
	const held = token ? heldRoots.get(token) : undefined;
	if (token && !held) {
		throw new ToolError(`the artifacts directory this cell was started on is no longer held open: ${root ?? ""}`);
	}
	// The descriptor is the directory, but what comes back is a pathname the
	// reader opens. So the name has to still mean the directory being read: a
	// root moved aside, replaced or removed makes every path answered from it
	// resolve through somebody else's tree, whatever the file behind it turns
	// out to be. Refusing is the only honest answer there, and it is the
	// direction that fails closed — unless the reader is asking for the bytes
	// rather than a name, which is what it does when it has met exactly this,
	// and which nothing standing at the pathname can intercept.
	if (held && !wantText && directoryIdentity(held.path) !== held.identity) {
		throw new ToolError(`${held.path} is no longer the artifacts directory this cell was started on`);
	}
	// The directory the reader is reading, which a cell suspended across a
	// re-adoption is not the session's current one.
	const dir = held?.path ?? root ?? contextLocalProtocolOptions(session)?.getArtifactsDir?.();
	if (!dir) return null;
	const found = await settledArtifactIn(held?.at ?? dir, dir, id, signal, wantText);
	if (found) return found;
	const elsewhere = await artifactElsewhere(session, dir, id, signal);
	if (elsewhere) return elsewhere;
	throw new ToolError(`artifact://${id} is in none of the artifacts directories this cell may read: ${dir}`);
}

/** How many times a reader re-lists a directory that keeps gaining copies before it gives up. */
const ARTIFACT_RESOLVE_ATTEMPTS = 16;

/**
 * The artifact `id` in one directory, once the copies into it have settled.
 *
 * `at` is how the directory is reached — a descriptor path where this process
 * holds it open — and `where` is where it is, which is what the copy table and
 * the mount-independent answer are keyed by.
 */
async function settledArtifactIn(
	at: string,
	where: string,
	id: string,
	signal?: AbortSignal,
	wantText = false,
): Promise<SettledArtifact | null> {
	for (let attempt = 1; ; attempt++) {
		await whenArtifactCopiesSettle(where, signal);
		const before = artifactCopyActivity(where);
		const found = await artifactInDirectory(at, where, id, wantText);
		const after = artifactCopyActivity(where);
		if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
		if (after.announced === before.announced && after.pending === 0) return found;
		// Copies arriving back to back with no gap between them would keep a
		// reader here forever. Saying so is better than answering from a
		// listing that was out of date before it finished.
		if (attempt >= ARTIFACT_RESOLVE_ATTEMPTS) {
			throw new ToolError(
				`artifact://${id} could not be read: copies into ${where} kept arriving through ${attempt} attempts to list it`,
			);
		}
	}
}

/**
 * The file for `id` in the other directories this cell may read, once the
 * copies into them have settled.
 *
 * Searched here, not by the reader: a reader told "not there" would look it up
 * again later, and by then "there" can mean another directory entirely.
 *
 * Which directories those are is the whole question. A cell reading the
 * session's own current directory may also read the artifacts of any session
 * this process knows — that is what reading `artifact://<n>` of another
 * conversation has always meant. A cell whose session has moved on, or whose
 * session has no directory at all, may not: for it, every other directory
 * belongs to a conversation it is not in, and an absent current directory is
 * not a licence to look anywhere. What it keeps is the source a seance was
 * started to consult, which is its own to read by construction.
 */
async function artifactElsewhere(
	session: ToolSession,
	dir: string,
	id: string,
	signal?: AbortSignal,
): Promise<SettledArtifact | null> {
	const current = contextLocalProtocolOptions(session)?.getArtifactsDir?.();
	const consulted = session.seanceSourceArtifactsDir;
	const ownRoot = Boolean(current && path.resolve(current) === path.resolve(dir));
	const reachable = [...(consulted ? [consulted] : []), ...(ownRoot ? artifactsDirsFromRegistry() : [])];
	for (const other of reachable) {
		if (path.resolve(other) === path.resolve(dir)) continue;
		// The same waiting the asking root gets: a copy still filling the
		// directory an artifact was inherited into is the ordinary case, and a
		// search that does not wait for it reports the artifact missing while
		// it is on its way.
		const found = await settledArtifactIn(other, other, id, signal);
		if (found) return found;
	}
	return null;
}

/** The `<id>.<tool>.log` file in the directory reached by `at`, with what it is. */
async function artifactInDirectory(
	at: string,
	where: string,
	id: string,
	wantText = false,
): Promise<SettledArtifact | null> {
	let names: string[];
	try {
		names = await fs.promises.readdir(at);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		return null;
	}
	const name = names.find(entry => entry.startsWith(`${id}.`));
	if (name === undefined) return null;
	try {
		const handle = await fs.promises.open(`${at}/${name}`, "r");
		try {
			const stat = await handle.stat({ bigint: true });
			const answer: SettledArtifact = {
				path: path.join(path.resolve(where), name),
				device: String(stat.dev),
				inode: String(stat.ino),
			};
			// Read through the descriptor, which is the file this answer is
			// about however the directory's name has been reused since.
			if (wantText) answer.text = await handle.readFile("utf8");
			return answer;
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
		return null;
	}
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
