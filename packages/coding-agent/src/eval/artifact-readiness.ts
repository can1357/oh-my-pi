import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { contextLocalProtocolOptions } from "../internal-urls/context";
import { artifactsDirsFromRegistry } from "../internal-urls/registry-helpers";
import { artifactCopyActivity, whenArtifactCopiesSettle } from "../session/session-manager";
import type { ToolSession } from "../tools";
import type { ArtifactRequest, SettledArtifact } from "./artifact-wire";

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

/** Give up every held root and every pin; for tests and for a process winding down. */
export async function releaseArtifactRoots(): Promise<void> {
	const open = [...accounts.values()];
	accounts.clear();
	await Promise.all(open.map(account => account.close()));
	const held = [...heldRoots.values()];
	heldRoots.clear();
	tokensByPath.clear();
	rootHolds.clear();
	for (const root of held) await root.close();
}

/** Who a request comes from, beyond the session it is answered for. */
export interface ArtifactRequestContext {
	/** Cancels the wait and the answer alike. */
	signal?: AbortSignal;
	/**
	 * The cell, or the kernel a finished cell's work runs on, that the asking
	 * reader is part of. Its pins end when it does. A caller that names none
	 * has its pins end with its session, its lease, or its own release.
	 */
	owner?: ArtifactPinOwner;
}

/** Answer one request a reader sent across the bridge. */
export async function answerArtifactRequest(
	session: ToolSession,
	request: ArtifactRequest,
	context: ArtifactRequestContext = {},
): Promise<SettledArtifact | null> {
	switch (request.op) {
		case "release":
			await releasePinnedArtifact(request.file);
			return null;
		case "take":
			return await takePinnedArtifact(request.file);
		case "answer":
		case "locate":
			return await resolveSettledArtifact(session, request.id, request.root, request.token, context.signal, {
				owner: context.owner,
				locate: request.op === "locate",
			});
	}
}

/**
 * What an `artifact://` id is: a number, as `artifact://` itself and both
 * readers read it. The id picks a file by prefix, so anything else picks
 * something that is not an artifact — an empty one, the first dotfile.
 */
const ARTIFACT_ID = /^\d+$/;

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
 * artifact under this session's number. Unless the caller only wants the
 * location, the answer carries a pin on the file it is about, charged to the
 * asking session, for the reader to take if the name has stopped meaning it.
 *
 * Every answer names the hold it was resolved through, as `root`, whether the
 * request carried one or this call took it. A reader that has already bound a
 * hold refuses an answer naming another: two first reads in flight together
 * can each reach this function with no token, and the directory at the name
 * may change between them.
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
	options: { owner?: ArtifactPinOwner; locate?: boolean } = {},
): Promise<SettledArtifact | null> {
	// The reader is charged, never the directory the artifact turns out to be
	// in: a session reading another's artifacts spends its own quota. The
	// account is the one open now, taken before anything is awaited, so a
	// session that ends while this answer is on its way refuses the charge
	// instead of taking a pin after its own disposal.
	const handout: Handout = options.locate ? "location" : { account: pinAccountOf(session), owner: options.owner };
	// Each of these is read once, here, and by one rule; the rest of this
	// function only asks whether a value is present. An empty string arrives
	// from the wire as a present string, and taken as absent at one read and
	// present at the next it would be a token that neither names a hold nor
	// gets one taken for it, and an answer with no hold named in it.
	if (!ARTIFACT_ID.test(id)) throw new ToolError(`artifact://${id} is not an artifact: ids are numbers`);
	if (root === "") throw new ToolError(`artifact://${id} was asked for with an empty artifacts directory`);
	// A cell started before its artifacts directory existed carries no token,
	// because there was nothing to hold. The directory may exist by now, and
	// reading it by name alone is reading with no identity behind it, so the
	// hold is taken here instead — and a directory that exists and cannot be
	// held refuses the read rather than falling back to the name. A token that
	// is present, whatever it says, has to name a hold this process has.
	const effective = token !== undefined ? token : root !== undefined ? await holdArtifactRoot(root) : undefined;
	// Checked and taken in the same tick: a hold validated here and used after
	// an await is a descriptor number the cap may have closed and the kernel
	// handed to something else by then.
	const held = effective !== undefined ? heldRoots.get(effective) : undefined;
	if (effective !== undefined && !held) {
		throw new ToolError(`the artifacts directory this cell was started on is no longer held open: ${root ?? ""}`);
	}
	if (held) held.refs++;
	try {
		const answer = await answerFromHold(session, id, root, held, signal, handout);
		return answer && effective !== undefined ? { ...answer, root: effective } : answer;
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
	handout: Handout,
): Promise<SettledArtifact | null> {
	// One rule decides a read, and it is about the object rather than the
	// route: a read is refused when what is reached is not what this answer
	// was about. A cell whose root was moved and put back — the same inode,
	// restored — is refused too, and the reason is not that the directory must
	// be a different one: it is that this cell, holding no descriptor across
	// the gap, cannot prove it is the same. A new cell acquires it and reads
	// it in the ordinary way. A root that was moved, replaced or recreated but still
	// reaches the same file is not a reason to refuse — the reader has the
	// artifact, by another name — and that is why the substituted file, the
	// foreign symlink and the fifo are all caught, each of them by being a
	// different object rather than by the root having changed.
	//
	// The directory the reader is reading, which a cell suspended across a
	// re-adoption is not the session's current one.
	const dir = held?.path ?? root ?? contextLocalProtocolOptions(session)?.getArtifactsDir?.();
	if (!dir) return null;
	const found = await settledArtifactIn(held?.at ?? dir, dir, id, signal, handout);
	if (found) return found;
	const elsewhere = await artifactElsewhere(session, dir, id, held, signal, handout);
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
	signal: AbortSignal | undefined,
	handout: Handout,
): Promise<SettledArtifact | null> {
	for (let attempt = 1; ; attempt++) {
		await whenArtifactCopiesSettle(where, signal);
		const before = artifactCopyActivity(where);
		const found = await artifactInDirectory(at, where, id);
		const after = artifactCopyActivity(where);
		const settled = after.announced === before.announced && after.pending === 0;
		if (settled && !signal?.aborted) {
			// Only now, with the answer about to be handed out: a file pinned
			// for an answer this loop is going to throw away holds a slot
			// nobody will ever come back for, and a listing overtaken by a
			// copy is exactly that.
			return found ? await finalAnswer(found, handout) : null;
		}
		await found?.handle.close();
		if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
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
	held: HeldRoot | undefined,
	signal: AbortSignal | undefined,
	handout: Handout,
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
		const found = await settledArtifactIn(other, other, id, signal, handout);
		if (found) return found;
	}
	return null;
}

/**
 * The clock a lease is measured on.
 *
 * `performance.now()` because a lease is a duration, not a time of day: a
 * wall clock that steps forward retires a lease a reader still holds, and one
 * that steps back keeps a lapsed slot out of use. Neither is a thing a reader
 * did.
 */
const leaseClock = (): number => performance.now();
/**
 * The fewest answers a session may hold pinned at once, whatever the machine.
 */
const PINNED_FILES_FLOOR = 32;
/**
 * The share of the process's open-descriptor limit one session's pins may
 * take: one sixty-fourth. Every pin is an open descriptor, and the rest of the
 * limit is for everything else the process opens — its other sessions, their
 * subagents, sockets, logs, held directories.
 */
const DESCRIPTOR_SHARE = 64;
/**
 * The C runtime's fixed table of low-level descriptors on Windows, which has
 * no adjustable per-process limit to read.
 */
const WINDOWS_LOW_LEVEL_DESCRIPTORS = 8_192;

/**
 * The soft limit on open descriptors this process runs with, or `undefined`
 * where it cannot be read. Bun raises the soft limit to the hard one at
 * startup, so this is the limit after that.
 *
 * Linux reports it in `/proc/self/limits`. Elsewhere on POSIX a child shell
 * inherits it and `ulimit -n` reports it — one short child, once.
 */
function openDescriptorLimit(): number | undefined {
	try {
		if (process.platform === "win32") return WINDOWS_LOW_LEVEL_DESCRIPTORS;
		if (process.platform === "linux") {
			const line = fs
				.readFileSync("/proc/self/limits", "utf8")
				.split("\n")
				.find(entry => entry.startsWith("Max open files"));
			const soft = Number(line?.slice("Max open files".length).trim().split(/\s+/)[0]);
			return Number.isSafeInteger(soft) && soft > 0 ? soft : undefined;
		}
		const soft = Number(execFileSync("/bin/sh", ["-c", "ulimit -n"], { encoding: "utf8", timeout: 2_000 }).trim());
		return Number.isSafeInteger(soft) && soft > 0 ? soft : undefined;
	} catch {
		return undefined;
	}
}

/** The ceiling a process with `limit` open descriptors gives each session's pins. */
export function artifactPinCeilingFor(limit: number | undefined): number {
	return Math.max(PINNED_FILES_FLOOR, Math.floor((limit ?? 0) / DESCRIPTOR_SHARE));
}

let pinCeiling: number | undefined;

/**
 * Answers one session may hold pinned at once, so one cannot deny another.
 *
 * A pin lasts from an answer to the end of its read, so the limit is on reads
 * in flight at once, not on reads. It is a sixty-fourth of what this process
 * may hold open, never fewer than {@link PINNED_FILES_FLOOR} — so it is a
 * statement about the machine rather than a chosen number, and no ordinary
 * cell reaches it: 8,192 on a process with 524,288 descriptors, the soft limit
 * Bun runs with under systemd's default. A session that does reach it has the
 * reads past it refused with an explicit error, never answered with another
 * file; a refused read can be asked again, and the limit raised with
 * `ulimit -n`. Read once, at the first pin.
 */
export function artifactPinCeiling(): number {
	pinCeiling ??= artifactPinCeilingFor(openDescriptorLimit());
	return pinCeiling;
}

/** Fix the ceiling for a test; the returned function puts the derived one back. */
export function setArtifactPinCeilingForTests(ceiling: number): () => void {
	const previous = pinCeiling;
	pinCeiling = ceiling;
	return () => {
		pinCeiling = previous;
	};
}
/**
 * How long an answer is its reader's before the pin lapses.
 *
 * A bounded recovery window, not a slow-reader guarantee. It limits how long
 * a reader may wait before it comes back for the file it was answered about —
 * one bridge round trip: the reader opens what it was told about and comes
 * straight back if that is not what it found. It does not limit a read: a
 * reader that has opened its file, or taken its pin, owns that descriptor and
 * reads for as long as the read takes. A reader that comes back after the
 * window is told the file is no longer held, never given what stands at the
 * name. A pin lapses at the end of it whether or not anyone else wants the
 * slot: a reader that never came back is not holding a file open for
 * anything.
 */
const PINNED_FILE_LEASE_MS = 2_000;

/**
 * A cell, or the kernel a finished cell's work runs on: something a reader is
 * part of, which can end, and whose pins end with it.
 *
 * An answer's pin exists for the gap between answering and the reader's read,
 * and a reader inside something that has ended has no read left to do: a
 * killed consumer, a completed cell whose last answer was never taken, a
 * kernel that was disposed. So each pin is held by the owner its request came
 * through, and ending the owner gives back every pin it still holds. One that
 * has ended takes no new ones.
 */
export class ArtifactPinOwner {
	readonly #pins = new Set<ArtifactPin>();
	#ended = false;

	/** Hold `pin` for as long as it lasts; refused once this owner has ended. */
	hold(pin: ArtifactPin): () => void {
		if (this.#ended) {
			throw new ToolError("the cell this read belongs to has ended; its answer cannot be held for it");
		}
		this.#pins.add(pin);
		return () => {
			this.#pins.delete(pin);
		};
	}

	/** End this owner, and with it every pin it holds. */
	async end(): Promise<void> {
		this.#ended = true;
		await Promise.all(Array.from(this.#pins, pin => pin.release()));
	}
}

/** Who an answer is pinned for: the session charged for it, and what it ends with. */
interface PinReader {
	account: PinAccount;
	owner: ArtifactPinOwner | undefined;
}

/** What an answer hands over: a pin for its reader, or only where the file is. */
type Handout = PinReader | "location";

/**
 * One session's pins, for the life of that session.
 *
 * The quota is the size of the set. Closing it ends every pin in it and
 * refuses every pin after: an answer takes the account when it is asked and
 * charges it when it is ready, so one still on its way when the session ends
 * is refused rather than pinned after the disposal that was meant to leave
 * none. Releasing the pins a session holds at one instant would not do that —
 * a snapshot of a set is not the set. A session id seen again later, as a
 * revived session's is, gets a new account; the closed one stays closed.
 */
class PinAccount {
	readonly pins = new Set<ArtifactPin>();
	#closed = false;

	get closed(): boolean {
		return this.#closed;
	}

	/** End this account: every pin in it now, and every charge after. */
	async close(): Promise<void> {
		this.#closed = true;
		await Promise.all(Array.from(this.pins, pin => pin.release()));
	}
}

/** Every pin not yet taken, by the token its answer carried. */
const pins = new Map<string, ArtifactPin>();
/**
 * The open account of each session.
 *
 * An account leaves this table only when it is closed, never when it empties:
 * an answer on its way holds the account it was asked under, and dropping an
 * empty one while that answer is in flight would split the session's quota
 * across two accounts and hide the in-flight one from the session's close.
 */
const accounts = new Map<string, PinAccount>();

/**
 * The open account of the session a reader is part of, which is what its
 * pins are charged to.
 *
 * Keyed by the session's id where it has one. An embedder that gives none is
 * told apart by its own artifacts directory — the directory it reads as its
 * own, never the one an answer was found in.
 */
function pinAccountOf(session: ToolSession): PinAccount {
	const id = session.getSessionId?.();
	const own = contextLocalProtocolOptions(session)?.getArtifactsDir?.();
	const key = id ? `session:${id}` : own ? `artifacts:${path.resolve(own)}` : "unscoped";
	let account = accounts.get(key);
	if (!account) accounts.set(key, (account = new PinAccount()));
	return account;
}

/**
 * One reader's claim on the file an answer was about.
 *
 * A reader opens the pathname it was given, and a name can stop meaning its
 * file between the answer and that open — a different file put there, or a
 * symlink to one outside the directory entirely. The reader comes back for the
 * bytes, and this is what serves them: the object that was opened when the
 * answer was made, which nothing standing at the name can take its place in.
 *
 * The pin is the claim, not a number kept near it. From the moment it is made
 * it is in the token table, its session's account and its owner; taking it
 * removes it from all three in one synchronous step and hands over the
 * descriptor. So one reader takes it and the next finds nothing, a release
 * after a take or a lapse gives nothing back twice, and a session's count is
 * the pins it holds because it *is* the set of them.
 *
 * The token is a bearer capability, deliberately: whoever presents it may take
 * or release the pin, and nothing checks who that is — not the runtime, not
 * the kernel, not the session. Possession is the whole check. What keeps a
 * token where it was issued is only how it is delivered: it is random, and it
 * goes back only in the answer to the cell that asked. Code that has it can
 * pass it on — code beside the reader in the same runtime has it already, and
 * in a kernel two sessions share that includes the other session's — and
 * whatever receives it, in another kernel or another session, can redeem it:
 * take the bytes, which once the name was replaced or removed it could not
 * have read by number (keeping the file readable then is what a pin is for),
 * or release the pin, so that the reader that asked is refused. Either only
 * within the lease.
 *
 * The pin is charged to the session the answer was asked for, which is not a
 * session the host has verified either. A JavaScript cell asks through its own
 * worker's session. A Python kernel asks over the one bridge every kernel of
 * this process shares, with the one bridge token they share; every other call
 * there must also name a run registered to that session, and this question
 * alone is answered on the session id the request names — so a kernel can
 * ask, and be charged, in another registered session's name.
 *
 * The token is not bound to the asking session because that would refuse a
 * legitimate reader: work a finished cell left running asks through the
 * kernel's latest session, which in a shared kernel is not always the one its
 * answer was charged to.
 */
class ArtifactPin {
	readonly token = `file-${crypto.randomUUID()}`;
	readonly #since = leaseClock();
	#handle: fs.promises.FileHandle | undefined;
	readonly #account: PinAccount;
	readonly #letGo: (() => void) | undefined;
	readonly #lapse: NodeJS.Timeout;

	constructor(
		handle: fs.promises.FileHandle,
		readonly answer: SettledArtifact,
		reader: PinReader,
	) {
		// Both refusals before anything is recorded, so neither leaves a part
		// of this pin behind: a session that has ended, then an owner that has.
		if (reader.account.closed) {
			throw new ToolError("the session this read belongs to has ended; its answer cannot be held for it");
		}
		this.#letGo = reader.owner?.hold(this);
		this.#handle = handle;
		this.#account = reader.account;
		reader.account.pins.add(this);
		pins.set(this.token, this);
		this.#lapse = setTimeout(() => void this.release(), PINNED_FILE_LEASE_MS);
		this.#lapse.unref();
	}

	/**
	 * Whether the lease is over, so the slot is no longer the reader's.
	 *
	 * The one reading of "expired": `take` refuses a lapsed pin and capacity
	 * displaces only a lapsed one, both by this clock. The lease timer only
	 * closes promptly what has already lapsed; a take that lands at the
	 * boundary before the timer has run is refused all the same.
	 */
	get lapsed(): boolean {
		return leaseClock() - this.#since >= PINNED_FILE_LEASE_MS;
	}

	/**
	 * The descriptor, to the first caller only, and only within the lease.
	 * Taken or refused, the pin is gone from every table before this returns;
	 * the caller owns closing what it got.
	 */
	take(): fs.promises.FileHandle | undefined {
		if (this.lapsed) {
			void this.release();
			return undefined;
		}
		return this.#end();
	}

	/** End the claim without reading it. A second release has nothing to give back. */
	async release(): Promise<void> {
		await this.#end()
			?.close()
			.catch(() => {});
	}

	/** Out of every table, in one synchronous step, and the descriptor to whoever ended it. */
	#end(): fs.promises.FileHandle | undefined {
		const handle = this.#handle;
		if (!handle) return undefined;
		this.#handle = undefined;
		clearTimeout(this.#lapse);
		pins.delete(this.token);
		this.#account.pins.delete(this);
		this.#letGo?.();
		return handle;
	}
}

/**
 * Give back the pin on an answer its reader has read.
 *
 * Sent by the reader after its read, whatever the read found. A token that is
 * no longer pinned — taken, lapsed, or ended with its owner — is already back.
 */
export async function releasePinnedArtifact(file: string): Promise<void> {
	await pins.get(file)?.release();
}

/**
 * End a session's account: give back every pin it holds and refuse every
 * answer still on its way to it. For the session ending.
 */
export async function closeArtifactPinAccount(sessionId: string | null | undefined): Promise<void> {
	if (!sessionId) return;
	const key = `session:${sessionId}`;
	const account = accounts.get(key);
	accounts.delete(key);
	await account?.close();
}

/**
 * The bytes of a file answered for earlier, read from the descriptor that
 * answered, and the end of its pin.
 *
 * Taken before anything is awaited: a second reader of the same token finds
 * nothing to take and is refused, instead of reading on from wherever the
 * first left the shared descriptor's offset.
 */
export async function takePinnedArtifact(file: string): Promise<SettledArtifact> {
	const pin = pins.get(file);
	const handle = pin?.take();
	if (!pin || !handle) {
		throw new ToolError("the artifact this session was told to read is no longer held open");
	}
	try {
		return { ...pin.answer, text: await handle.readFile("utf8") };
	} finally {
		await handle.close().catch(() => {});
	}
}

/**
 * Pin `handle` for `reader`, or refuse.
 *
 * An answer already handed to a reader is that reader's until it comes back,
 * gives up, or its lease ends: capacity must not revoke one, because a reader
 * whose name was replaced has nothing else left to read from. So the one that
 * goes to make room is the oldest that has lapsed, and when none has the
 * *new* answer is refused instead.
 *
 * The count is read, the lapsed pin taken and the new one made in one tick:
 * an await between them lets a second answer for the same session see the
 * slot that was freed and fill it too.
 */
async function pinFile(handle: fs.promises.FileHandle, answer: SettledArtifact, reader: PinReader): Promise<string> {
	const account = reader.account;
	let displaced: Promise<void> | undefined;
	const ceiling = artifactPinCeiling();
	if (account.pins.size >= ceiling) {
		let lapsed: ArtifactPin | undefined;
		for (const pin of account.pins) {
			if (pin.lapsed) {
				lapsed = pin;
				break;
			}
		}
		if (!lapsed) {
			await handle.close().catch(() => {});
			throw new ToolError(
				`${ceiling} artifact answers are outstanding for this session and none has lapsed; ${answer.path} cannot be answered for until one is read, or the open-file limit (ulimit -n) this ceiling is derived from is raised`,
			);
		}
		// Out of the account now, synchronously; its descriptor closes below.
		displaced = lapsed.release();
	}
	let token: string;
	try {
		token = new ArtifactPin(handle, answer, reader).token;
	} catch (error) {
		await handle.close().catch(() => {});
		throw error;
	} finally {
		await displaced;
	}
	return token;
}

/** The `<id>.<tool>.log` file in the directory reached by `at`, with what it is. */
interface OpenArtifact {
	answer: SettledArtifact;
	handle: fs.promises.FileHandle;
}

/** The answer to hand out: pinned for its reader, or just the location. */
async function finalAnswer(found: OpenArtifact, handout: Handout): Promise<SettledArtifact> {
	if (handout === "location") {
		await found.handle.close();
		return found.answer;
	}
	return { ...found.answer, file: await pinFile(found.handle, found.answer, handout) };
}

async function artifactInDirectory(at: string, where: string, id: string): Promise<OpenArtifact | null> {
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
		// before anything can be checked; `O_NOFOLLOW` because a symlink at
		// the name is a route to a file this directory does not hold, and
		// following it would stat the thing it points at and call it ours.
		const handle = await fs.promises.open(
			`${at}/${name}`,
			fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
		);
		const stat = await handle.stat({ bigint: true });
		if (!stat.isFile()) {
			await handle.close();
			// The id *is* here; what answers to it is not a file this
			// directory can hand over. That is a refusal, not a miss: looking
			// elsewhere would answer this session's number from another
			// conversation's directory, which is the one thing the name being
			// taken must never buy.
			throw new ToolError(`artifact://${id} in ${where} is not a regular file`);
		}
		// Open, and left open for the caller to decide: the bytes are read and
		// the pin is taken only when this is the answer being handed out.
		return {
			answer: {
				path: path.join(path.resolve(where), name),
				device: String(stat.dev),
				inode: String(stat.ino),
			},
			handle,
		};
	} catch (error) {
		if (error instanceof ToolError) throw error;
		if (isEnoent(error)) return null;
		// `ELOOP` from the `O_NOFOLLOW`, `EACCES`, anything else: the name is
		// taken by something this directory cannot hand over, which is the
		// same answer as above.
		throw new ToolError(
			`artifact://${id} in ${where} could not be opened: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
