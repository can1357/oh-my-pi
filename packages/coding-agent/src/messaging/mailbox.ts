import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, withFileLock } from "@oh-my-pi/pi-utils";
import { assertPrivateDir, ensurePrivateDir } from "../ipc/local-endpoint-registry";
import { listLocalSessionsWithRegisteredFiles, type SessionInfo } from "../session/session-listing";
import { defaultSessionName, sessionShortId } from "./names";
import {
	type InboxRequest,
	isMailboxSessionId,
	MAX_SERIALIZED_CHARS,
	MESSAGING_WIRE_VERSION,
	parseInboxRequest,
	type SenderInfo,
} from "./protocol";
import { messagingRegistryDir } from "./transport";

export const OFFLINE_INBOX_CAP = 50;
export const OFFLINE_INBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface StoredMessage {
	id: string;
	from: SenderInfo;
	body: string;
	chain: string[];
	sentAt: number;
	sessionFile?: string;
}

export type StoredRefusalNotice = Extract<InboxRequest, { kind: "refused" }> & { sentAt: number; sessionFile?: string };
export type StoredMail = StoredMessage | StoredRefusalNotice;
export interface DrainedMail {
	message: StoredMail;
	ack(): Promise<void>;
}
export interface OfflineMailGcCandidate {
	sessionId: string;
	file: string;
	bytes: number;
	kind: "expiredMail" | "orphanedMail";
}

export interface OfflineSession {
	sessionId: string;
	path: string;
	shortId: string;
	name: string;
	cwd: string;
	title: string | null;
	modified: number;
}

export function mailboxDir(sessionId: string, options?: { dir?: string }): string {
	if (!isMailboxSessionId(sessionId)) {
		throw new Error("Invalid offline mailbox sessionId");
	}
	return path.join(options?.dir ?? messagingRegistryDir(), "mail", sessionId);
}

export async function listOfflineSessions(options?: {
	now?: number;
	sessions?: () => Promise<SessionInfo[]>;
}): Promise<OfflineSession[]> {
	const cutoff = (options?.now ?? Date.now()) - OFFLINE_INBOX_TTL_MS;
	const sessions = await (options?.sessions ?? listLocalSessionsWithRegisteredFiles)();
	return sessions
		.filter(session => session.modified.getTime() >= cutoff)
		.map(session => ({
			sessionId: session.id,
			path: session.path,
			shortId: sessionShortId(session.id),
			name:
				session.titleSource === "user" && session.title !== undefined
					? session.title
					: defaultSessionName(session.cwd, session.id),
			cwd: session.cwd,
			title: session.title ?? null,
			modified: session.modified.getTime(),
		}));
}

async function mailboxFiles(dir: string, create: boolean): Promise<string[]> {
	const registry = {
		dir: path.dirname(path.dirname(dir)),
		pipePrefix: "omp-msg",
		version: MESSAGING_WIRE_VERSION,
		maxRequestBytes: MAX_SERIALIZED_CHARS,
		maxResponseBytes: MAX_SERIALIZED_CHARS,
	};
	try {
		for (const privateDir of [registry.dir, path.dirname(dir), dir]) {
			if (create) await ensurePrivateDir(registry, privateDir);
			else await assertPrivateDir(registry, privateDir);
		}
		const entries = await fs.promises.readdir(dir, { withFileTypes: true });
		return entries.filter(entry => entry.isFile()).map(entry => path.join(dir, entry.name));
	} catch (err) {
		if (isEnoent(err) && !create) return [];
		throw err;
	}
}

function parseStoredMessage(raw: unknown): StoredMail | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const value = raw as Record<string, unknown>;
	if (
		typeof value.sentAt !== "number" ||
		!Number.isFinite(value.sentAt) ||
		(value.sessionFile !== undefined && typeof value.sessionFile !== "string")
	)
		return undefined;
	const request = parseInboxRequest(
		value.type === "notice"
			? {
					type: "notice",
					id: value.id,
					from: value.from,
					kind: value.kind,
					subject: value.subject,
					aboutId: value.aboutId,
					toSessionId: value.toSessionId,
				}
			: { type: "message", id: value.id, from: value.from, body: value.body, chain: value.chain },
	);
	if (!request || (request.type !== "message" && !(request.type === "notice" && request.kind === "refused")))
		return undefined;
	if (request.type === "message") {
		if (!request.from || !request.chain) return undefined;
		return {
			id: request.id,
			from: request.from,
			body: request.body,
			chain: request.chain,
			sentAt: value.sentAt,
			...(value.sessionFile === undefined ? {} : { sessionFile: value.sessionFile }),
		};
	}
	return {
		...request,
		sentAt: value.sentAt,
		...(value.sessionFile === undefined ? {} : { sessionFile: value.sessionFile }),
	};
}

async function readStoredMessage(file: string): Promise<StoredMail | undefined> {
	let text: string;
	try {
		text = await fs.promises.readFile(file, "utf8");
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
	try {
		return parseStoredMessage(JSON.parse(text));
	} catch {
		return undefined;
	}
}

export async function withOfflineMailboxLock<T>(
	sessionId: string,
	fn: () => Promise<T>,
	options?: { dir?: string; signal?: AbortSignal },
): Promise<T> {
	const inbox = mailboxDir(sessionId, options);
	const registry = {
		dir: path.dirname(path.dirname(inbox)),
		pipePrefix: "omp-msg",
		version: MESSAGING_WIRE_VERSION,
		maxRequestBytes: MAX_SERIALIZED_CHARS,
		maxResponseBytes: MAX_SERIALIZED_CHARS,
	};
	for (const dir of [registry.dir, path.dirname(inbox)]) await ensurePrivateDir(registry, dir);
	return withFileLock(path.join(path.dirname(inbox), `.${sessionId}.handoff`), fn, { signal: options?.signal });
}

/** Internal transaction primitive: caller must hold the recipient's handoff lock. */
export async function enqueueOfflineUnlocked(
	sessionId: string,
	message: StoredMail,
	options?: { dir?: string; now?: number },
): Promise<"queued" | "full"> {
	const dir = mailboxDir(sessionId, options);
	if (!parseStoredMessage(message) || /[/\\\x00-\x1f<>:"|?*]/.test(message.id))
		throw new Error("Invalid offline message");
	const cutoff = (options?.now ?? Date.now()) - OFFLINE_INBOX_TTL_MS;
	let remaining = 0;
	let duplicate: string | undefined;
	for (const file of await mailboxFiles(dir, true)) {
		const stored = await readStoredMessage(file);
		if (stored && stored.sentAt < cutoff) await fs.promises.rm(file, { force: true });
		else {
			remaining++;
			if (stored?.id === message.id) duplicate = file;
		}
	}
	if (duplicate) return "queued";
	if (remaining >= OFFLINE_INBOX_CAP) return "full";
	const file = path.join(dir, `${message.sentAt}-${message.id}.json`);
	const tmp = path.join(path.dirname(dir), `.message-${crypto.randomUUID()}.tmp`);
	try {
		await fs.promises.writeFile(tmp, JSON.stringify(message), { flag: "wx", mode: 0o600 });
		await fs.promises.rename(tmp, file);
	} finally {
		await fs.promises.rm(tmp, { force: true });
	}
	return "queued";
}

export function enqueueOffline(
	sessionId: string,
	message: StoredMessage,
	options?: { dir?: string; now?: number; signal?: AbortSignal },
): Promise<"queued" | "full"> {
	return withOfflineMailboxLock(sessionId, () => enqueueOfflineUnlocked(sessionId, message, options), options);
}

export function enqueueOfflineNotice(
	sessionId: string,
	notice: StoredRefusalNotice,
	options?: { dir?: string; now?: number },
): Promise<"queued" | "full"> {
	return withOfflineMailboxLock(sessionId, () => enqueueOfflineUnlocked(sessionId, notice, options), options);
}

/** Internal transaction primitive: caller must hold the recipient's handoff lock. */
export async function drainOfflineUnlocked(
	sessionId: string,
	options?: { dir?: string; now?: number },
): Promise<DrainedMail[]> {
	const dir = mailboxDir(sessionId, options);
	const cutoff = (options?.now ?? Date.now()) - OFFLINE_INBOX_TTL_MS;
	const messages: DrainedMail[] = [];
	for (const file of await mailboxFiles(dir, false)) {
		const message = await readStoredMessage(file);
		if (message && message.sentAt >= cutoff)
			messages.push({
				message,
				ack: () => withOfflineMailboxLock(sessionId, () => fs.promises.rm(file, { force: true }), options),
			});
		else await fs.promises.rm(file, { force: true });
	}
	return messages.sort((a, b) => a.message.sentAt - b.message.sentAt);
}

export function drainOffline(sessionId: string, options?: { dir?: string; now?: number }): Promise<DrainedMail[]> {
	return withOfflineMailboxLock(sessionId, () => drainOfflineUnlocked(sessionId, options), options);
}

export async function retireOfflineMailbox(sessionId: string, options?: { dir?: string }): Promise<void> {
	const dir = mailboxDir(sessionId, options);
	// Senders create this parent before checking transcript ownership; an absent
	// parent after unlink cannot contain an in-flight enqueue.
	try {
		await fs.promises.lstat(path.dirname(dir));
		await mailboxFiles(dir, false);
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	await withFileLock(path.join(path.dirname(dir), `.${sessionId}.handoff`), async () => {
		await mailboxFiles(dir, false);
		await fs.promises.rm(dir, { recursive: true, force: true });
	});
}

async function mailGcKind(
	file: string,
	now: number,
	graceMs: number,
): Promise<OfflineMailGcCandidate["kind"] | undefined> {
	const message = await readStoredMessage(file);
	if (!message) return undefined;
	if (message.sentAt < now - OFFLINE_INBOX_TTL_MS) return "expiredMail";
	if (!message.sessionFile || (await fs.promises.stat(file)).mtimeMs > now - graceMs) return undefined;
	try {
		await fs.promises.stat(message.sessionFile);
	} catch (error) {
		if (isEnoent(error) || (error as NodeJS.ErrnoException).code === "ENOTDIR") return "orphanedMail";
	}
	return undefined;
}

export async function collectOfflineMailGcCandidates(options?: {
	dir?: string;
	now?: number;
	graceMs?: number;
}): Promise<OfflineMailGcCandidate[]> {
	const root = options?.dir ?? messagingRegistryDir();
	const parent = path.join(root, "mail");
	const candidates: OfflineMailGcCandidate[] = [];
	// Validate the private root and parent without following inbox symlinks.
	await mailboxFiles(mailboxDir("gc-validation", { dir: root }), false);
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(parent, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || !isMailboxSessionId(entry.name)) continue;
		await withOfflineMailboxLock(
			entry.name,
			async () => {
				for (const file of await mailboxFiles(mailboxDir(entry.name, { dir: root }), false)) {
					const kind = await mailGcKind(file, options?.now ?? Date.now(), options?.graceMs ?? 300_000);
					if (kind)
						candidates.push({ sessionId: entry.name, file, kind, bytes: (await fs.promises.stat(file)).size });
				}
			},
			{ dir: root },
		);
	}
	return candidates;
}

export function removeOfflineMailGcCandidate(
	candidate: OfflineMailGcCandidate,
	options?: { dir?: string; now?: number; graceMs?: number },
): Promise<boolean> {
	return withOfflineMailboxLock(
		candidate.sessionId,
		async () => {
			const dir = mailboxDir(candidate.sessionId, options);
			const files = await mailboxFiles(dir, false);
			if (
				!files.includes(candidate.file) ||
				!(await mailGcKind(candidate.file, options?.now ?? Date.now(), options?.graceMs ?? 300_000))
			)
				return false;
			await fs.promises.rm(candidate.file, { force: true });
			if ((await fs.promises.readdir(dir)).length === 0) await fs.promises.rmdir(dir);
			return true;
		},
		options,
	);
}
