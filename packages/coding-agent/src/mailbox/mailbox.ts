/**
 * Per-session mailbox with maildir semantics: `tmp/` → `new/` (published) →
 * `cur/` (claimed by exactly one consumer via rename) → `done/` (the message
 * is in the session file), or `failed/` (unreadable, malformed, or out of
 * attempts).
 *
 * A claim is not delivery: a message that does not reach the session file
 * (an interrupt dropped it, the write failed, its consumer died) goes back to
 * `new/` and is delivered again. Each attempt is counted in the file itself,
 * so a message that keeps failing stops after {@link MAX_MAIL_ATTEMPTS}
 * across every process.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { OmpErrors } from "@oh-my-pi/omptype";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { tryAcquireSessionLease } from "../session/session-storage";
import { mailDir } from "./paths";
import { listSessionPresence } from "./presence";
import { KnownMailSchema, MailEnvelopeSchema, type SessionMail, SessionMailSchema } from "./types";

/** Injection attempts per message, summed over every consumer that claimed it. */
export const MAX_MAIL_ATTEMPTS = 3;

export function newMailId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

/** File name of a message in `new/`, `cur/` and `done/`. */
export function mailFileName(id: string): string {
	return `${id}.json`;
}

/** Publish a message atomically: readers only ever see complete files in `new/`. */
export async function postMail(mail: SessionMail): Promise<string> {
	const dir = mailDir(mail.sessionId);
	const name = mailFileName(mail.id);
	const tmp = path.join(dir, "tmp", name);
	await Bun.write(tmp, JSON.stringify(mail));
	await fs.promises.mkdir(path.join(dir, "new"), { recursive: true });
	const target = path.join(dir, "new", name);
	await fs.promises.rename(tmp, target);
	return target;
}

function listDirSync(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir)
			.filter(name => name.endsWith(".json"))
			.sort();
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
}

export function listNewMail(sessionId: string): string[] {
	return listDirSync(path.join(mailDir(sessionId), "new"));
}

/** Claimed but not yet found in the session file. */
export function listClaimedMail(sessionId: string): string[] {
	return listDirSync(path.join(mailDir(sessionId), "cur"));
}

type MailBox = "new" | "cur" | "done" | "failed";

function moveMail(sessionId: string, name: string, from: MailBox, to: MailBox): void {
	const dir = mailDir(sessionId);
	fs.mkdirSync(path.join(dir, to), { recursive: true });
	try {
		fs.renameSync(path.join(dir, from, name), path.join(dir, to, name));
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}

/**
 * Read a message in `new/` or `cur/`: `undefined` when it is gone (claimed or
 * moved meanwhile) or is a valid message of a version or kind only a newer omp
 * delivers, which stays where it is. An unreadable or malformed file moves to
 * `failed/`, so it never stops the messages behind it.
 */
function readMailSync(sessionId: string, box: "new" | "cur", name: string): SessionMail | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(path.join(mailDir(sessionId), box, name), "utf8"));
	} catch (err) {
		if (isEnoent(err)) return undefined;
		failMail(sessionId, name, box, String(err));
		return undefined;
	}
	const mail = SessionMailSchema(raw);
	if (!(mail instanceof OmpErrors)) return mail;
	if (KnownMailSchema(raw) instanceof OmpErrors && !(MailEnvelopeSchema(raw) instanceof OmpErrors)) return undefined;
	failMail(sessionId, name, box, mail.summary);
	return undefined;
}

function failMail(sessionId: string, name: string, from: "new" | "cur", reason: string): void {
	logger.warn("mail moved to failed/", { sessionId, name, reason });
	moveMail(sessionId, name, from, "failed");
}

/** Read an unclaimed message without claiming it (to decide whether to claim). */
export function peekNewMail(sessionId: string, name: string): SessionMail | undefined {
	return readMailSync(sessionId, "new", name);
}

export function readClaimedMail(sessionId: string, name: string): SessionMail | undefined {
	return readMailSync(sessionId, "cur", name);
}

/**
 * Claim one message: rename `new/<name>` → `cur/<name>`. Exactly one caller
 * wins, across threads and processes; the rest get `undefined`. Synchronous so
 * a claim can happen inside a prompt's synchronous setup.
 */
export function claimMail(sessionId: string, name: string): SessionMail | undefined {
	const dir = mailDir(sessionId);
	const cur = path.join(dir, "cur", name);
	fs.mkdirSync(path.dirname(cur), { recursive: true });
	try {
		fs.renameSync(path.join(dir, "new", name), cur);
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
	return readMailSync(sessionId, "cur", name);
}

/**
 * Count one injection attempt on a claimed message (atomic rewrite in `cur/`).
 * Returns the new count, or `undefined` when the message is no longer claimed.
 */
export function recordMailAttempt(sessionId: string, name: string): number | undefined {
	const mail = readMailSync(sessionId, "cur", name);
	if (!mail) return undefined;
	const attempts = (mail.attempts ?? 0) + 1;
	const cur = path.join(mailDir(sessionId), "cur", name);
	const tmp = `${cur}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify({ ...mail, attempts }));
	fs.renameSync(tmp, cur);
	return attempts;
}

/** The message is in the session file: move `cur/` → `done/`. */
export function completeMail(sessionId: string, name: string): void {
	moveMail(sessionId, name, "cur", "done");
}

/**
 * The message did not reach the session file: return it to `new/` to be
 * delivered again, or to `failed/` once it is out of attempts.
 */
export function releaseMail(sessionId: string, name: string): void {
	const mail = readMailSync(sessionId, "cur", name);
	if (!mail) return;
	if ((mail.attempts ?? 0) < MAX_MAIL_ATTEMPTS) {
		moveMail(sessionId, name, "cur", "new");
		return;
	}
	logger.warn("mail not delivered after every attempt; moved to failed/", { sessionId, mailId: mail.id });
	moveMail(sessionId, name, "cur", "failed");
}

/** Whether `mailId` reached the session file (its message sits in `done/`). */
export function isMailDone(sessionId: string, mailId: string): boolean {
	return fs.existsSync(path.join(mailDir(sessionId), "done", mailFileName(mailId)));
}

/**
 * Where mail for a session goes now:
 * - `live`: a process with the session open delivers it; `deferred` when that
 *   process's turns wait for its client's next prompt (ACP);
 * - `held`: the session is open in a process that does not deliver mail (an
 *   SDK host, `OMP_MAILBOX=0`, a second opener while another consumes it),
 *   or an older omp without presence holds its write lease. Mail waits for the
 *   next process that opens the session; never resume it headless, which would
 *   leave the turn on a branch that process does not see;
 * - `free`: nobody has it open; resume it headless or hold it.
 */
export type DeliveryTarget =
	| { kind: "live"; pid: number; host: string; deferred: boolean }
	| { kind: "held"; reason: "no-watcher"; pid: number; host: string }
	| { kind: "held"; reason: "foreign-owner" }
	| { kind: "free" };

export function deliveryTarget(sessionId: string): DeliveryTarget {
	const present = listSessionPresence(sessionId);
	const deliverer = present.find(record => record.delivers);
	if (deliverer) return { kind: "live", pid: deliverer.pid, host: deliverer.host, deferred: deliverer.deferred };
	const holder = present[0];
	if (holder) return { kind: "held", reason: "no-watcher", pid: holder.pid, host: holder.host };
	// Probed only when no process announced itself: an older omp that wrote the
	// session holds the write lease without presence.
	const lease = tryAcquireSessionLease(sessionId);
	if (!lease) return { kind: "held", reason: "foreign-owner" };
	lease.release();
	return { kind: "free" };
}

/** One line for CLI output. */
export function describeDeliveryTarget(target: DeliveryTarget): string {
	switch (target.kind) {
		case "live":
			return target.deferred
				? `open in a live omp (${target.host}, pid ${target.pid}) whose client takes it with its next prompt`
				: `open in a live omp (${target.host}, pid ${target.pid}) that delivers it now`;
		case "held":
			return target.reason === "no-watcher"
				? `open in an omp process that does not deliver mail (${target.host}, pid ${target.pid})`
				: "open in an omp process without mailbox support";
		case "free":
			return "not open in any omp process";
	}
}
