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
 * once its id is in the session file; one that never got there (an interrupt
 * dropped it, the write failed, the consumer died) goes back to `new/`, where
 * the Esc hold applies to it again.
 */
import * as fs from "node:fs";
import { $env, type FileLockHandle, isEnoent, logger, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import type { CustomMessage } from "../session/messages";
import type { SessionManager } from "../session/session-manager";
import {
	claimMail,
	completeMail,
	listClaimedMail,
	listNewMail,
	MAX_MAIL_ATTEMPTS,
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
	/** Session file the message is appended to, and its size at the claim: the entry lands after it. */
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

/** Whether `mailId` appears in `file` at or after `offset` (from the start when the file was rewritten shorter). */
async function sessionFileHas(file: string | undefined, offset: number, mailId: string): Promise<boolean> {
	if (!file) return false;
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(file, "r");
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
	try {
		const { size } = await handle.stat();
		const start = size >= offset ? offset : 0;
		const bytes = new Uint8Array(size - start);
		await handle.read(bytes, 0, bytes.length, start);
		return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(mailId);
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
	#polling = false;
	#stopped = false;
	readonly #inFlight = new Map<string, InFlight>();
	/** Mail ids already logged as waiting (held by Esc, out of attempts), to log each once. */
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
			if (this.#polling) return;
			this.#polling = true;
			this.#poll()
				.catch(error => logger.warn("session mailbox poll failed", { error: String(error) }))
				.finally(() => {
					this.#polling = false;
				});
		}, POLL_MS);
		this.#interval.unref();
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
		const fresh = listNewMail(sessionId);
		if (fresh.length === 0 || !this.#ownSession(presence)) return;
		for (const name of fresh) {
			const peeked = peekNewMail(sessionId, name);
			if (!peeked || this.#waits(session, peeked)) continue;
			const mail = claimMail(sessionId, name);
			if (mail) this.#inject(session, sessionId, name, mail);
		}
	}

	/** Mail waits out an Esc until the user's next prompt unless sent with `--force`; mail out of attempts stays put. */
	#waits(session: AgentSession, mail: SessionMail): boolean {
		const exhausted = (mail.attempts ?? 0) >= MAX_MAIL_ATTEMPTS;
		const held = !exhausted && session.interruptLatched && !mail.poke.force;
		if (!exhausted && !held) return false;
		if (!this.#noted.has(mail.id)) {
			this.#noted.add(mail.id);
			if (exhausted) logger.warn("mail not delivered after every attempt; left in new/", { mailId: mail.id });
			else logger.debug("poke held until the next prompt (session interrupted)", { mailId: mail.id });
		}
		return true;
	}

	/** Complete claims whose id reached the session file; return the ones that were dropped to `new/`. */
	async #settleInFlight(session: AgentSession): Promise<void> {
		for (const [mailId, flight] of this.#inFlight) {
			if (flight.pending) continue;
			const stalled =
				Date.now() - flight.since > STALL_MS && !session.isStreaming && session.queuedMessageCount === 0;
			// Before giving a claim up, read the whole file: a rewrite may have moved the entry before the offset.
			if (await sessionFileHas(flight.file, stalled ? 0 : flight.offset, mailId)) {
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
		const file = this.#sessionManager.getSessionFile();
		for (const name of listClaimedMail(sessionId)) {
			if (tracked.has(name)) continue;
			const mail = readClaimedMail(sessionId, name);
			if (!mail) continue;
			if (await sessionFileHas(file, 0, mail.id)) completeMail(sessionId, name);
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
			if (!peeked || (peeked.attempts ?? 0) >= MAX_MAIL_ATTEMPTS) continue;
			const mail = claimMail(sessionId, name);
			if (!mail || recordMailAttempt(sessionId, name) === undefined) continue;
			this.#track(sessionId, name, mail.id, false);
			messages.push(messageFor(mail, this.#via));
		}
		return messages;
	}
}
