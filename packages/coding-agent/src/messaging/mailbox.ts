import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { assertPrivateDir, ensurePrivateDir } from "../ipc/local-endpoint-registry";
import { listAllSessions, type SessionInfo } from "../session/session-listing";
import { defaultSessionName, sessionShortId } from "./names";
import { MAX_SERIALIZED_CHARS, MESSAGING_WIRE_VERSION, parseInboxRequest, type SenderInfo } from "./protocol";
import { messagingRegistryDir } from "./transport";

export const OFFLINE_INBOX_CAP = 50;
export const OFFLINE_INBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface StoredMessage {
	id: string;
	from: SenderInfo;
	body: string;
	chain: string[];
	sentAt: number;
}

export interface OfflineSession {
	sessionId: string;
	shortId: string;
	name: string;
	cwd: string;
	title: string | null;
	modified: number;
}

export function mailboxDir(sessionId: string, options?: { dir?: string }): string {
	if (!/^[A-Za-z0-9_.-]{1,128}$/.test(sessionId) || sessionId === "." || sessionId === "..") {
		throw new Error("Invalid offline mailbox sessionId");
	}
	return path.join(options?.dir ?? messagingRegistryDir(), "mail", sessionId);
}

export async function listOfflineSessions(options?: {
	now?: number;
	sessions?: () => Promise<SessionInfo[]>;
}): Promise<OfflineSession[]> {
	const cutoff = (options?.now ?? Date.now()) - OFFLINE_INBOX_TTL_MS;
	const sessions = await (options?.sessions ?? listAllSessions)();
	return sessions
		.filter(session => session.modified.getTime() >= cutoff)
		.map(session => ({
			sessionId: session.id,
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

function parseStoredMessage(raw: unknown): StoredMessage | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const value = raw as Record<string, unknown>;
	if (typeof value.sentAt !== "number" || !Number.isFinite(value.sentAt)) return undefined;
	const request = parseInboxRequest({
		type: "message",
		id: value.id,
		from: value.from,
		body: value.body,
		chain: value.chain,
	});
	if (request?.type !== "message" || !request.from || !request.chain) return undefined;
	return { id: request.id, from: request.from, body: request.body, chain: request.chain, sentAt: value.sentAt };
}

async function readStoredMessage(file: string): Promise<StoredMessage | undefined> {
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

export async function enqueueOffline(
	sessionId: string,
	message: StoredMessage,
	options?: { dir?: string; now?: number },
): Promise<"queued" | "full"> {
	const dir = mailboxDir(sessionId, options);
	if (!parseStoredMessage(message) || /[/\\\x00-\x1f<>:"|?*]/.test(message.id)) {
		throw new Error("Invalid offline message");
	}
	const cutoff = (options?.now ?? Date.now()) - OFFLINE_INBOX_TTL_MS;
	let remaining = 0;
	for (const file of await mailboxFiles(dir, true)) {
		const stored = await readStoredMessage(file);
		if (stored && stored.sentAt < cutoff) await fs.promises.rm(file, { force: true });
		else remaining++;
	}
	// ponytail: cap is best-effort under concurrent senders; bursts can overshoot by a few.
	// Upgrade to per-mailbox file locking if strict concurrent capacity matters.
	if (remaining >= OFFLINE_INBOX_CAP) return "full";
	const file = path.join(dir, `${message.sentAt}-${message.id}.json`);
	// Stage outside the inbox so a concurrent drain cannot consume a partial write.
	const tmp = path.join(path.dirname(dir), `.message-${crypto.randomUUID()}.tmp`);
	try {
		await fs.promises.writeFile(tmp, JSON.stringify(message), { flag: "wx", mode: 0o600 });
		await fs.promises.rename(tmp, file);
	} finally {
		await fs.promises.rm(tmp, { force: true });
	}
	return "queued";
}

export async function drainOffline(
	sessionId: string,
	options?: { dir?: string; now?: number },
): Promise<StoredMessage[]> {
	const dir = mailboxDir(sessionId, options);
	const cutoff = (options?.now ?? Date.now()) - OFFLINE_INBOX_TTL_MS;
	const messages: StoredMessage[] = [];
	for (const file of await mailboxFiles(dir, false)) {
		const message = await readStoredMessage(file);
		await fs.promises.rm(file, { force: true });
		if (message && message.sentAt >= cutoff) messages.push(message);
	}
	return messages.sort((a, b) => a.sentAt - b.sentAt);
}
