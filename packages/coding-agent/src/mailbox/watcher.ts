/**
 * A session's mailbox in the process that has the session open.
 *
 * Every persisted session announces presence from the moment it opens (see
 * `presence.ts`), so `omp poke --resume` never resumes it headless while it
 * is open here. A process opened with `deliver` also injects the mail:
 *
 * - idle: the message starts a turn;
 * - streaming: it joins the running turn at its next step boundary, without
 *   interrupting the tool batch in flight;
 * - mail that arrives while an Esc still holds the session stays in `new/`
 *   until the user's next prompt, which carries it in ahead of the user's
 *   message (`omp poke --force` delivers at once).
 *
 * One consumer per session: the session's consumer lock is exclusive across
 * processes and across session managers within a process. The consumer takes
 * the session's write lease only once mail is waiting, so opening a session
 * leaves the first-writer rule alone. A claimed message counts as delivered
 * once its `session-poke` entry is in the session file; one that never got
 * there (an interrupt dropped it, the write failed, the consumer died) goes
 * back to `new/`, where the Esc hold applies to it again.
 */
import * as fs from "node:fs";
import { OmpErrors, type } from "@oh-my-pi/omptype";
import { $env, type FileLockHandle, isEnoent, logger, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import type { CustomMessage } from "../session/messages";
import type { SessionManager } from "../session/session-manager";
import {
	claimMail,
	completeMail,
	listClaimedMail,
	listNewMail,
	peekNewMail,
	readClaimedMail,
	recordMailAttempt,
	releaseMail,
} from "./mailbox";
import { type MailDeliveryVia, type MailMessageDetails, renderMail, SESSION_POKE_MESSAGE_TYPE } from "./message";
import { consumerLockPath, MAILBOX_ENV, MAILBOX_HEADLESS_ENV, mailDir } from "./paths";
import { claimSessionPresence, type SessionPresence } from "./presence";
import type { SessionMail } from "./types";

const POLL_MS = 1000;
/** A claimed message neither in the session file, running nor queued this long after its send settled was dropped. */
const STALL_MS = 15_000;

export interface SessionMailboxOptions {
	/** Inject mail as turns. Without it the process only announces presence, so mail is held for it. */
	deliver: boolean;
	/** Process kind recorded with the presence entry (`interactive`, `rpc`, `print`, `acp`, `sdk`, …). */
	host: string;
}

interface InFlight {
	/** Mailbox the claim sits in (the session may have switched since). */
	sessionId: string;
	name: string;
	/** Session file the message is appended to, and how far it has been scanned: the entry lands after the claim. */
	file: string | undefined;
	offset: number;
	/** `sendCustomMessage` has not settled yet: the message is still being admitted or its turn runs. */
	pending: boolean;
	/** When the send settled (or the message was handed to a prompt). */
	since: number;
}

function fileSize(file: string | undefined): number {
	if (!file) return 0;
	try {
		return fs.statSync(file).size;
	} catch (err) {
		if (isEnoent(err)) return 0;
		throw err;
	}
}

/** The transcript entry a delivered message leaves behind. */
const DeliveryEntrySchema = type({
	type: "'custom_message'",
	customType: `'${SESSION_POKE_MESSAGE_TYPE}'`,
	details: { mailId: "string" },
});

/**
 * Ids of the messages whose delivery entries are in the complete lines of
 * `file` from `offset` (from the start when the file was rewritten shorter),
 * and the offset after the last complete line, where the next scan starts.
 */
async function scanDeliveries(
	file: string | undefined,
	offset: number,
): Promise<{ mailIds: Set<string>; offset: number }> {
	const mailIds = new Set<string>();
	if (!file) return { mailIds, offset };
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(file, "r");
	} catch (err) {
		if (isEnoent(err)) return { mailIds, offset };
		throw err;
	}
	try {
		const { size } = await handle.stat();
		const start = size >= offset ? offset : 0;
		const buffer = Buffer.allocUnsafe(size - start);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
		const bytes = buffer.subarray(0, bytesRead);
		const complete = bytes.lastIndexOf(0x0a) + 1;
		for (const line of bytes.toString("utf8", 0, complete).split("\n")) {
			if (!line.includes(SESSION_POKE_MESSAGE_TYPE)) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			const delivery = DeliveryEntrySchema(entry);
			if (!(delivery instanceof OmpErrors)) mailIds.add(delivery.details.mailId);
		}
		return { mailIds, offset: start + complete };
	} finally {
		await handle.close();
	}
}

function messageFor(mail: SessionMail, via: MailDeliveryVia): CustomMessage<MailMessageDetails> {
	return {
		role: "custom",
		customType: SESSION_POKE_MESSAGE_TYPE,
		content: renderMail(mail, Date.now()),
		display: true,
		details: { mailId: mail.id, kind: mail.kind, via },
		attribution: "agent",
		timestamp: Date.now(),
	};
}

export class SessionMailbox {
	readonly #sessionManager: SessionManager;
	readonly #host: string;
	readonly #deliver: boolean;
	readonly #via: MailDeliveryVia;
	#presence: SessionPresence | undefined;
	#consumer: FileLockHandle | undefined;
	/** Session whose leftover claims the next poll checks: set when this process becomes its consumer. */
	#recover: string | undefined;
	#session: AgentSession | undefined;
	#interval: NodeJS.Timeout | undefined;
	/** The pass in flight; the interval starts none while it runs. */
	#pass: Promise<void> | undefined;
	#stopped = false;
	readonly #inFlight = new Map<string, InFlight>();
	/** Mail ids already logged as held by Esc, to log each once. */
	readonly #noted = new Set<string>();
	#refusalLogged: string | undefined;

	/** Claims presence for the manager's current session immediately. */
	constructor(sessionManager: SessionManager, options: SessionMailboxOptions) {
		this.#sessionManager = sessionManager;
		this.#host = options.host;
		this.#deliver = options.deliver && $env[MAILBOX_ENV] !== "0";
		this.#via = $env[MAILBOX_HEADLESS_ENV] ? "headless" : "live";
		this.#syncPresence();
	}

	/** Session id this process currently announces, if any. */
	get sessionId(): string | undefined {
		return this.#presence?.sessionId;
	}

	/** Follow the session through `/new`, `/resume`, forks and sibling moves, and start delivering when enabled. */
	bind(session: AgentSession): void {
		this.#session = session;
		session.registerSessionChangeCallback(() => this.#syncPresence());
		const unsubscribeNotices = this.#sessionManager.onPersistenceNotice(() => this.#syncPresence());
		session.addDisposer(unsubscribeNotices);
		session.onClosed(() => this.stop());
		if (!this.#deliver) return;
		session.setHeldMailProvider(() => this.#takeHeldMail());
		this.#interval = setInterval(() => {
			if (!this.#pass) void this.poll();
		}, POLL_MS);
		this.#interval.unref();
	}

	/**
	 * Check the mailbox now: settle claims in flight, then deliver what can be
	 * delivered. Resolves once a pass that started after the call has finished;
	 * the interval runs one every second.
	 */
	async poll(): Promise<void> {
		while (this.#pass) await this.#pass;
		this.#pass = this.#poll()
			.catch(error => logger.warn("session mailbox poll failed", { error: String(error) }))
			.finally(() => {
				this.#pass = undefined;
			});
		await this.#pass;
	}

	/** Withdraw presence and stop delivering. Idempotent. */
	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		clearInterval(this.#interval);
		this.#session?.setHeldMailProvider(undefined);
		this.#releaseSession();
	}

	#releaseSession(): void {
		this.#consumer?.release();
		this.#consumer = undefined;
		this.#presence?.release();
		this.#presence = undefined;
	}

	#syncPresence(): void {
		if (this.#stopped) return;
		const sessionId = this.#sessionManager.getSessionId();
		const persisted = this.#sessionManager.getSessionFile() !== undefined;
		if (persisted && this.#presence?.sessionId === sessionId) return;
		this.#releaseSession();
		if (!persisted) return;
		try {
			this.#presence = claimSessionPresence(sessionId, { host: this.#host });
		} catch (error) {
			logger.warn("could not announce session presence", { sessionId, error: String(error) });
			return;
		}
		this.#takeConsumer();
	}

	/** Become the session's mail consumer, unless another process or session manager already is. */
	#takeConsumer(): boolean {
		const presence = this.#presence;
		if (!this.#deliver || !presence) return false;
		if (this.#consumer) return true;
		fs.mkdirSync(mailDir(presence.sessionId), { recursive: true });
		const lock = tryAcquireFileLock(consumerLockPath(presence.sessionId));
		if (!lock) return false;
		this.#consumer = lock;
		this.#recover = presence.sessionId;
		presence.update({ delivers: true });
		return true;
	}

	/**
	 * Take the session's write lease before injecting, so the message never moves
	 * the session to a sibling file; `false` while another process holds it.
	 */
	#ownSession(presence: SessionPresence): boolean {
		const owned = this.#sessionManager.claimOwnership();
		presence.update({ delivers: owned });
		if (!owned && this.#refusalLogged !== presence.sessionId) {
			this.#refusalLogged = presence.sessionId;
			logger.warn("mail waiting: another omp process owns this session", { sessionId: presence.sessionId });
		}
		return owned;
	}

	async #poll(): Promise<void> {
		const session = this.#session;
		if (!session || this.#stopped || session.isDisposed) return;
		this.#syncPresence();
		await this.#settleInFlight(session);
		const presence = this.#presence;
		if (!presence || !this.#takeConsumer()) return;
		const sessionId = presence.sessionId;
		presence.update({ deferred: session.defersAgentInitiatedTurns });
		if (this.#recover === sessionId) {
			this.#recover = undefined;
			await this.#recoverClaims(sessionId);
		}
		// A message claimed now would be dispatched into whichever session is
		// current once extensions finish loading or the switch completes.
		if (session.hasPendingDeferredExtensions || session.isSessionTransitioning) return;
		// The write lease is taken only for mail delivered now: mail an Esc holds
		// or that only a newer omp reads leaves it free.
		const deliverable: string[] = [];
		for (const name of listNewMail(sessionId)) {
			try {
				const mail = peekNewMail(sessionId, name);
				if (mail && !this.#waits(session, mail)) deliverable.push(name);
			} catch (error) {
				logger.warn("could not read mail", { sessionId, name, error: String(error) });
			}
		}
		if (deliverable.length === 0 || !this.#ownSession(presence)) return;
		for (const name of deliverable) {
			const mail = claimMail(sessionId, name);
			if (mail) this.#inject(session, sessionId, name, mail);
		}
	}

	/** Mail waits out an Esc until the user's next prompt unless sent with `--force`. */
	#waits(session: AgentSession, mail: SessionMail): boolean {
		if (!session.interruptLatched || mail.poke.force) return false;
		if (!this.#noted.has(mail.id)) {
			this.#noted.add(mail.id);
			logger.debug("poke held until the next prompt (session interrupted)", { mailId: mail.id });
		}
		return true;
	}

	/** Complete claims whose entry reached the session file; return the ones that were dropped to `new/`. */
	async #settleInFlight(session: AgentSession): Promise<void> {
		for (const [mailId, flight] of this.#inFlight) {
			if (flight.pending) continue;
			const stalled =
				Date.now() - flight.since > STALL_MS && !session.isStreaming && session.queuedMessageCount === 0;
			// Before giving a claim up, read the whole file: a rewrite may have moved the entry before the offset.
			const scan = await scanDeliveries(flight.file, stalled ? 0 : flight.offset);
			flight.offset = scan.offset;
			if (scan.mailIds.has(mailId)) {
				completeMail(flight.sessionId, flight.name);
			} else if (stalled) {
				logger.warn("mail did not reach the session file; returned to the mailbox", { mailId });
				releaseMail(flight.sessionId, flight.name);
			} else {
				continue;
			}
			this.#inFlight.delete(mailId);
			this.#noted.delete(mailId);
		}
	}

	/** Claims a previous consumer left behind (it died, or closed before they reached the session file). */
	async #recoverClaims(sessionId: string): Promise<void> {
		const tracked = new Set([...this.#inFlight.values()].map(flight => flight.name));
		const left = listClaimedMail(sessionId).filter(name => !tracked.has(name));
		if (left.length === 0) return;
		const { mailIds } = await scanDeliveries(this.#sessionManager.getSessionFile(), 0);
		for (const name of left) {
			const mail = readClaimedMail(sessionId, name);
			if (!mail) continue;
			if (mailIds.has(mail.id)) completeMail(sessionId, name);
			else releaseMail(sessionId, name);
		}
	}

	#track(sessionId: string, name: string, mailId: string, pending: boolean): InFlight {
		const file = this.#sessionManager.getSessionFile();
		const flight: InFlight = { sessionId, name, file, offset: fileSize(file), pending, since: Date.now() };
		this.#inFlight.set(mailId, flight);
		return flight;
	}

	#inject(session: AgentSession, sessionId: string, name: string, mail: SessionMail): void {
		const attempt = recordMailAttempt(sessionId, name);
		if (attempt === undefined) return;
		const flight = this.#track(sessionId, name, mail.id, true);
		const { role: _role, timestamp: _timestamp, ...message } = messageFor(mail, this.#via);
		// Streaming: join the running turn at its next step boundary. Idle: start
		// a turn (a follow-up only if a turn began in between). Not awaited: an
		// idle session's send resolves only when the whole turn ends.
		const options = session.isStreaming
			? ({ deliverAs: "aside" } as const)
			: ({ triggerTurn: true, deliverAs: "followUp" } as const);
		logger.debug("mail delivered", { sessionId, mailId: mail.id, via: this.#via, attempt });
		void session
			.sendCustomMessage<MailMessageDetails>(message, options)
			.catch(error => logger.warn("mail injection failed", { mailId: mail.id, error: String(error) }))
			.finally(() => {
				flight.pending = false;
				flight.since = Date.now();
			});
	}

	/**
	 * Called synchronously by a user-authored prompt once it is committed to
	 * running or queueing: claim the waiting mail (the pokes an Esc held back)
	 * so it enters context ahead of the user's message.
	 */
	#takeHeldMail(): CustomMessage[] {
		const presence = this.#presence;
		if (!presence || this.#stopped || !this.#consumer || !this.#ownSession(presence)) return [];
		const sessionId = presence.sessionId;
		const messages: CustomMessage[] = [];
		for (const name of listNewMail(sessionId)) {
			const peeked = peekNewMail(sessionId, name);
			if (!peeked) continue;
			const mail = claimMail(sessionId, name);
			if (!mail || recordMailAttempt(sessionId, name) === undefined) continue;
			this.#track(sessionId, name, mail.id, false);
			messages.push(messageFor(mail, this.#via));
		}
		return messages;
	}
}
