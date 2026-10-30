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
	 * The handle this answer was opened on, kept here for the reader that has
	 * to come back for the bytes. A re-ask names this rather than the file,
	 * because the name is what stopped meaning the file.
	 */
	file?: string;
	/**
	 * The artifact's text, read from the descriptor this process still holds
	 * on that very file. Sent only when the reader asks for it, which it does
	 * when what its pathname reaches is no longer what it was answered about.
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
	/**
	 * Reads using this hold right now.
	 *
	 * A descriptor number is only this directory while the descriptor is open.
	 * Close it under a read that is between its token check and its listing,
	 * and the kernel hands that number to the next thing opened — the read
	 * then lists whatever that is. So a hold in use is never closed, and the
	 * count is taken in the same tick the token is checked, because the window
	 * between establishing something and using it is the whole of this bug.
	 */
	refs: number;
	/** Chosen for closing, and closed as soon as the last read lets go. */
	evicted: boolean;
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

/**
 * Open and hold `dir`, or say which of the two reasons there is no hold.
 *
 * A directory that is not there yet and one this process could not open are
 * not the same answer. The first is ordinary — a session's artifacts
 * directory is made when it first has one — and a cell started before it
 * exists must keep working. The second is this process running out of
 * descriptors, or losing permission, and it has to fail closed: a read that
 * falls back to the pathname because the hold could not be taken is a read
 * with no identity behind it at all, which is the thing the hold is for.
 */
async function holdDirectory(dir: string): Promise<HeldRoot | "absent" | "unheld"> {
	// Asked before the open, and it is the answer that is recorded: a root
	// that is there when a cell is given it has a hold from then on, and its
	// disappearance during the open is a loss rather than an absence. Read the
	// other way round, a directory deleted mid-open looks like one that never
	// arrived, and the cell goes on to hold whatever is made at that name.
	const existed = directoryIdentity(dir) !== undefined;
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
	} catch (error) {
		if (!isEnoent(error)) return "unheld";
		return existed ? "unheld" : "absent";
	}
	const stat = await handle.stat({ bigint: true });
	return {
		at: CAN_HOLD_DIRECTORIES ? `/proc/self/fd/${handle.fd}` : dir,
		path: dir,
		identity: `${stat.dev}:${stat.ino}`,
		refs: 0,
		evicted: false,
		close: () => handle.close(),
	};
}

/**
 * The work in flight for each pathname, so cells starting together share one
 * hold.
 *
 * Read and written in the same tick, before anything is awaited. Checking the
 * token table and then opening the directory is check-before-await of exactly
 * the kind this mechanism exists to remove: every cell racing a start would
 * find no hold, open its own, and the cap would then evict readers that are
 * still using theirs. The entry is the promise, not the answer, so the second
 * caller waits for the first instead of repeating it.
 */
const rootHolds = new Map<string, Promise<string | undefined>>();

/**
 * Hold the artifacts directory a cell is being started on, and return the
 * token that reaches it.
 *
 * The token travels with the cell and comes back with every read it makes, so
 * the directory a read is answered from is the one that cell was given — not
 * whatever its pathname reaches when the read lands.
 *
 * One directory is one hold, however many cells start on it at once: the calls
 * for a pathname run in a chain, and all but the first find the hold already
 * made and reuse it. A new one is made only when that name has come to mean a
 * different directory, which is when the old hold must stay open for the cells
 * still reading through it.
 */
export function holdArtifactRoot(dir: string): Promise<string | undefined> {
	const resolved = path.resolve(dir);
	const previous = rootHolds.get(resolved) ?? Promise.resolve(undefined);
	const next = previous.then(token => refreshHold(resolved, token));
	rootHolds.set(
		resolved,
		next.catch(() => undefined),
	);
	return next;
}

/** The hold for `resolved`: the one `token` names while it still reaches that directory, or a new one. */
async function refreshHold(resolved: string, token: string | undefined): Promise<string | undefined> {
	const held = token ? heldRoots.get(token) : undefined;
	if (held && directoryIdentity(resolved) === held.identity) return token;
	const now = await holdDirectory(resolved);
	if (now === "absent") return undefined;
	if (now === "unheld") {
		throw new ToolError(`${resolved} exists and could not be held open; its artifacts cannot be read`);
	}
	if (heldRoots.size >= HELD_ROOTS_MAX && !(await evictUnusedHold())) {
		await now.close();
		throw new ToolError(
			`${HELD_ROOTS_MAX} artifacts directories are held open and all are being read; ${resolved} cannot be held`,
		);
	}
	const fresh = `root-${crypto.randomUUID()}`;
	heldRoots.set(fresh, now);
	tokensByPath.set(resolved, fresh);
	return fresh;
}

/**
 * Close the oldest hold nothing is reading through, and say whether there was
 * one.
 *
 * A hold in use is skipped rather than closed: refusing a sixty-fifth distinct
 * directory is a bounded failure anyone can explain, and handing a reader the
 * bytes of whatever took its descriptor number is not.
 */
async function evictUnusedHold(): Promise<boolean> {
	for (const [token, held] of heldRoots) {
		if (held.refs > 0 || held.evicted) continue;
		heldRoots.delete(token);
		held.evicted = true;
		const where = path.resolve(held.path);
		if (tokensByPath.get(where) === token) {
			tokensByPath.delete(where);
			rootHolds.delete(where);
		}
		await held.close();
		return true;
	}
	return false;
}

/** Give up every held root; for tests and for a process winding down. */
export async function releaseArtifactRoots(): Promise<void> {
	for (const pinned of pinnedFiles.values()) await pinned.handle.close().catch(() => {});
	pinnedFiles.clear();
	const held = [...heldRoots.values()];
	heldRoots.clear();
	tokensByPath.clear();
	rootHolds.clear();
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
	file?: string,
): Promise<SettledArtifact | null> {
	// A re-ask is for the object already opened, never for the name again:
	// the reader is here because the name stopped meaning that object, and
	// resolving it a second time is what it was trying to avoid.
	if (wantText && file) return await textFromPinnedFile(file);
	// A cell started before its artifacts directory existed carries no token,
	// because there was nothing to hold. The directory may exist by now, and
	// reading it by name alone is reading with no identity behind it, so the
	// hold is taken here instead — and a directory that exists and cannot be
	// held refuses the read rather than falling back to the name.
	const effective = token ?? (root ? await holdArtifactRoot(root) : undefined);
	// Checked and taken in the same tick: a hold validated here and used after
	// an await is a descriptor number the cap may have closed and the kernel
	// handed to something else by then.
	const held = effective ? heldRoots.get(effective) : undefined;
	if (effective && !held) {
		throw new ToolError(`the artifacts directory this cell was started on is no longer held open: ${root ?? ""}`);
	}
	if (held) held.refs++;
	try {
		return await answerFromHold(session, id, root, held, signal, wantText);
	} finally {
		if (held) await releaseHold(held);
	}
}

/** Give a hold back, and close it if it was evicted while this read had it. */
async function releaseHold(held: HeldRoot): Promise<void> {
	held.refs--;
	if (held.refs === 0 && held.evicted) await held.close();
}

async function answerFromHold(
	session: ToolSession,
	id: string,
	root: string | undefined,
	held: HeldRoot | undefined,
	signal: AbortSignal | undefined,
	wantText: boolean,
): Promise<SettledArtifact | null> {
	// One rule decides a read, and it is about the object rather than the
	// route: a read is refused when what is reached is not what this answer
	// was about. A root that was moved, replaced or recreated but still
	// reaches the same file is not a reason to refuse — the reader has the
	// artifact, by another name — and that is why the substituted file, the
	// foreign symlink and the fifo are all caught, each of them by being a
	// different object rather than by the root having changed.
	//
	// The directory the reader is reading, which a cell suspended across a
	// re-adoption is not the session's current one.
	const dir = held?.path ?? root ?? contextLocalProtocolOptions(session)?.getArtifactsDir?.();
	if (!dir) return null;
	const found = await settledArtifactIn(held?.at ?? dir, dir, id, signal, wantText);
	if (found) return found;
	const elsewhere = await artifactElsewhere(session, dir, id, held, signal);
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
	held?: HeldRoot,
	signal?: AbortSignal,
): Promise<SettledArtifact | null> {
	const current = contextLocalProtocolOptions(session)?.getArtifactsDir?.();
	const consulted = session.seanceSourceArtifactsDir;
	// Reading every session's artifacts is what a cell on the session's own
	// directory may do. A cell whose root has been moved, replaced or removed
	// is not on it any more, whatever the pathname still says, so the widening
	// stops there: an artifact it cannot find in its own directory is not a
	// reason to go looking in somebody else's conversation.
	const ownName = Boolean(current && path.resolve(current) === path.resolve(dir));
	const ownRoot = ownName && (!held || directoryIdentity(held.path) === held.identity);
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

/**
 * Files answered for and still open, by the handle token in the answer.
 *
 * A reader opens the pathname it was given, and a name can stop meaning its
 * file between the answer and that open — a different file put there, or a
 * symlink to one outside the directory entirely. The reader comes back for the
 * bytes, and this is what serves them: the object that was opened when the
 * answer was made, which nothing standing at the name can take its place in.
 */
const pinnedFiles = new Map<string, { handle: fs.promises.FileHandle; answer: SettledArtifact; at: number }>();
/** Answers held open for a re-ask at once. */
const PINNED_FILES_MAX = 32;
/** How long an answer is a reader's before it counts as abandoned. */
const PINNED_FILE_LEASE_MS = 30_000;

function pinFile(handle: fs.promises.FileHandle, answer: SettledArtifact): string {
	// An answer already handed to a reader is that reader's until it comes
	// back for the bytes or gives up: capacity must not revoke one, because a
	// reader whose name was replaced has nothing else left to read from. So
	// the ones that go are the ones nobody can still be waiting on, and when
	// there are none the *new* answer is refused instead.
	while (pinnedFiles.size >= PINNED_FILES_MAX) {
		const expired = [...pinnedFiles].find(([, pinned]) => Date.now() - pinned.at >= PINNED_FILE_LEASE_MS);
		if (!expired) {
			void handle.close().catch(() => {});
			throw new ToolError(
				`${PINNED_FILES_MAX} artifact answers are outstanding and none has lapsed; ${answer.path} cannot be answered for`,
			);
		}
		pinnedFiles.delete(expired[0]);
		void expired[1].handle.close().catch(() => {});
	}
	const token = `file-${crypto.randomUUID()}`;
	pinnedFiles.set(token, { handle, answer, at: Date.now() });
	return token;
}

/** The bytes of a file answered for earlier, read from the descriptor that answered. */
async function textFromPinnedFile(file: string): Promise<SettledArtifact | null> {
	const pinned = pinnedFiles.get(file);
	if (!pinned) {
		throw new ToolError("the artifact this session was told to read is no longer held open");
	}
	pinnedFiles.delete(file);
	try {
		return { ...pinned.answer, text: await pinned.handle.readFile("utf8") };
	} finally {
		await pinned.handle.close();
	}
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
		// Non-blocking, because an ordinary open of a fifo waits for a writer
		// before anything can be checked: a name listed a moment ago can be
		// something that does not answer an open at all.
		const handle = await fs.promises.open(`${at}/${name}`, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
		const stat = await handle.stat({ bigint: true });
		if (!stat.isFile()) {
			await handle.close();
			return null;
		}
		const answer: SettledArtifact = {
			path: path.join(path.resolve(where), name),
			device: String(stat.dev),
			inode: String(stat.ino),
		};
		if (wantText) {
			// Read through the descriptor, which is the file this answer is
			// about however the name has been reused since.
			try {
				answer.text = await handle.readFile("utf8");
			} finally {
				await handle.close();
			}
			return answer;
		}
		// Kept open for the reader that finds the name no longer reaches it.
		answer.file = pinFile(handle, answer);
		return answer;
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
