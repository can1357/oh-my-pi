import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	drainOffline,
	enqueueOffline,
	enqueueOfflineNotice,
	listOfflineSessions,
	mailboxDir,
	OFFLINE_INBOX_CAP,
	OFFLINE_INBOX_TTL_MS,
	type StoredMessage,
	withOfflineMailboxLock,
	type StoredRefusalNotice,
} from "../../src/messaging/mailbox";
import { defaultSessionName, sessionShortId } from "../../src/messaging/names";
import { listSessions, type SessionInfo } from "../../src/session/session-listing";
import { MemorySessionStorage } from "../../src/session/session-storage";

const directories: TempDir[] = [];
const now = 1_800_000_000_000;
const sessionId = "offline-session";

function tempDir(): string {
	const dir = TempDir.createSync("@omp-mailbox-");
	directories.push(dir);
	return dir.path();
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of directories.splice(0)) dir[Symbol.dispose]();
});

function message(id: string, sentAt = now): StoredMessage {
	return {
		id,
		from: {
			sessionId: "sender-session",
			name: "sender",
			shortId: "12345678",
			cwd: "/sender",
			entryId: "sender-entry",
			class: "bypass",
		},
		body: `message ${id}`,
		chain: ["12345678"],
		sentAt,
	};
}

function session(id: string, modified: number, fields: Partial<SessionInfo> = {}): SessionInfo {
	return {
		id,
		path: `/sessions/${id}.jsonl`,
		cwd: "/work/My Project",
		created: new Date(modified),
		modified: new Date(modified),
		messageCount: 1,
		size: 100,
		firstMessage: "Hello",
		allMessagesText: "Hello",
		...fields,
	};
}

describe("offline mailbox", () => {
	it("keeps sorted messages durable until individually acknowledged", async () => {
		const dir = tempDir();
		const messages = [message("latest", now + 10), message("earliest", now - 10), message("middle")];
		for (const item of messages) expect(await enqueueOffline(sessionId, item, { dir, now })).toBe("queued");
		const inbox = mailboxDir(sessionId, { dir });
		expect((await fs.readdir(inbox)).sort()).toEqual(messages.map(item => `${item.sentAt}-${item.id}.json`).sort());
		expect(
			(await fs.readdir(path.dirname(inbox), { withFileTypes: true }))
				.filter(entry => entry.isDirectory())
				.map(entry => entry.name),
		).toEqual([sessionId]);
		const drained = await drainOffline(sessionId, { dir, now });
		expect(drained.map(item => item.message)).toEqual([messages[1], messages[2], messages[0]]);
		expect(await fs.readdir(inbox)).toHaveLength(3);
		await drained[0].ack();
		expect((await drainOffline(sessionId, { dir, now })).map(item => item.message)).toEqual([
			messages[2],
			messages[0],
		]);
		await drained[1].ack();
		await drained[2].ack();
		expect(await fs.readdir(inbox)).toEqual([]);
		expect(await drainOffline(sessionId, { dir, now })).toEqual([]);
	});

	it("returns full for the 51st message without writing it", async () => {
		const dir = tempDir();
		for (let i = 0; i < OFFLINE_INBOX_CAP; i++) {
			expect(await enqueueOffline(sessionId, message(`message-${i}`), { dir, now })).toBe("queued");
		}
		expect(await enqueueOffline(sessionId, message("overflow"), { dir, now })).toBe("full");
		expect(await fs.readdir(mailboxDir(sessionId, { dir }))).toHaveLength(OFFLINE_INBOX_CAP);
		expect((await drainOffline(sessionId, { dir, now })).some(item => item.message.id === "overflow")).toBe(false);
	});

	it("purges expired files before applying the cap", async () => {
		const dir = tempDir();
		for (let i = 0; i < OFFLINE_INBOX_CAP; i++) {
			await enqueueOffline(sessionId, message(`old-${i}`, now), { dir, now });
		}
		const later = now + OFFLINE_INBOX_TTL_MS + 1;
		const fresh = message("fresh", later);
		expect(await enqueueOffline(sessionId, fresh, { dir, now: later })).toBe("queued");
		expect(await fs.readdir(mailboxDir(sessionId, { dir }))).toEqual([`${later}-fresh.json`]);
		expect((await drainOffline(sessionId, { dir, now: later })).map(item => item.message)).toEqual([fresh]);
	});

	it("drops and deletes expired messages but retains the exact TTL boundary", async () => {
		const dir = tempDir();
		const boundary = message("boundary", now - OFFLINE_INBOX_TTL_MS);
		const expired = message("expired", boundary.sentAt - 1);
		await enqueueOffline(sessionId, expired, { dir, now: expired.sentAt });
		await enqueueOffline(sessionId, boundary, { dir, now: boundary.sentAt });
		const drained = await drainOffline(sessionId, { dir, now });
		expect(drained.map(item => item.message)).toEqual([boundary]);
		expect(await fs.readdir(mailboxDir(sessionId, { dir }))).toEqual([`${boundary.sentAt}-boundary.json`]);
		await drained[0].ack();
		expect(await fs.readdir(mailboxDir(sessionId, { dir }))).toEqual([]);
	});

	it("deletes malformed JSON and invalid stored records alongside valid messages", async () => {
		const dir = tempDir();
		const valid = message("valid");
		await enqueueOffline(sessionId, valid, { dir, now });
		const inbox = mailboxDir(sessionId, { dir });
		const malformed = [
			"not JSON",
			"null",
			JSON.stringify({ ...valid, sentAt: "yesterday" }),
			JSON.stringify({ ...valid, from: { ...valid.from, class: "unknown" } }),
			JSON.stringify({ ...valid, chain: [42] }),
			JSON.stringify({ ...valid, chain: undefined }),
			JSON.stringify({ ...valid, body: 42 }),
		];
		for (let i = 0; i < malformed.length; i++) {
			await fs.writeFile(path.join(inbox, `malformed-${i}.txt`), malformed[i]);
		}
		const drained = await drainOffline(sessionId, { dir, now });
		expect(drained.map(item => item.message)).toEqual([valid]);
		expect(await fs.readdir(inbox)).toEqual([`${valid.sentAt}-valid.json`]);
		await drained[0].ack();
		expect(await fs.readdir(inbox)).toEqual([]);
	});

	it("returns an empty drain for a missing mailbox without creating it", async () => {
		const dir = tempDir();
		expect(await drainOffline(sessionId, { dir, now })).toEqual([]);
		expect(await fs.readdir(dir)).toEqual(["mail"]);
	});

	it("rejects traversal and invalid session ids on every mailbox entry point", async () => {
		const dir = tempDir();
		for (const id of ["../escape", "..\\escape", ".", "..", "", "a/b", "a".repeat(129)]) {
			expect(() => mailboxDir(id, { dir })).toThrow("Invalid offline mailbox sessionId");
			await expect(enqueueOffline(id, message("valid"), { dir, now })).rejects.toThrow(
				"Invalid offline mailbox sessionId",
			);
			await expect(drainOffline(id, { dir, now })).rejects.toThrow("Invalid offline mailbox sessionId");
		}
		expect(mailboxDir("session_1.2-3", { dir })).toBe(path.join(dir, "mail", "session_1.2-3"));
		expect(await fs.readdir(dir)).toEqual([]);
	});

	it("rejects unsafe message filenames without writing outside the inbox", async () => {
		const dir = tempDir();
		await expect(enqueueOffline(sessionId, message("../../escape"), { dir, now })).rejects.toThrow(
			"Invalid offline message",
		);
		expect((await fs.readdir(path.join(dir, "mail"))).filter(name => !name.endsWith(".lock"))).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("creates private directories and 0600 message files", async () => {
		const dir = path.join(tempDir(), "registry");
		await enqueueOffline(sessionId, message("private"), { dir, now });
		const inbox = mailboxDir(sessionId, { dir });
		for (const privateDir of [dir, path.join(dir, "mail"), inbox]) {
			expect((await fs.stat(privateDir)).mode & 0o777).toBe(0o700);
		}
		expect((await fs.stat(path.join(inbox, `${now}-private.json`))).mode & 0o777).toBe(0o600);
	});

	it("uses user titles only and includes the exact offline TTL window", async () => {
		const cutoff = now - OFFLINE_INBOX_TTL_MS;
		const source = [
			session("user", now, { title: "release notes", titleSource: "user" }),
			session("auto", cutoff, { title: "Generated title", titleSource: "auto" }),
			session("legacy", now, { title: "Legacy title" }),
			session("untitled", now),
			session("expired", cutoff - 1, { title: "Too old", titleSource: "user" }),
		];
		const listed = await listOfflineSessions({ now, sessions: async () => source });
		expect(listed).toEqual(
			source.slice(0, 4).map(item => ({
				sessionId: item.id,
				path: item.path,
				shortId: sessionShortId(item.id),
				name: item.titleSource === "user" ? item.title! : defaultSessionName(item.cwd, item.id),
				cwd: item.cwd,
				title: item.title ?? null,
				modified: item.modified.getTime(),
			})),
		);
	});

	it("preserves header title sources and the current title-slot source, including prefix fallback", async () => {
		const storage = new MemorySessionStorage();
		const root = "/sessions/mailbox-listing";
		for (const truncated of [false, true]) {
			for (const slotSource of [undefined, "auto", "user"] as const) {
				const id = `header-${truncated}-${slotSource}`;
				const header = {
					type: "session",
					id,
					cwd: "/workspace",
					title: "header title",
					titleSource: slotSource === "user" ? "auto" : "user",
					timestamp: "2026-10-05T00:00:00.000Z",
					padding: truncated ? "x".repeat(8_000) : "",
				};
				const lines = slotSource
					? [JSON.stringify({ type: "title", title: "slot title", source: slotSource })]
					: [];
				lines.push(JSON.stringify(header), "");
				storage.writeTextSync(`${root}/${id}.jsonl`, lines.join("\n"));
			}
		}
		const listed = await listSessions(root, storage);
		expect(listed).toHaveLength(6);
		for (const info of listed) {
			const slotSource = info.id.endsWith("-auto") ? "auto" : info.id.endsWith("-user") ? "user" : undefined;
			expect(info.title).toBe(slotSource ? "slot title" : "header title");
			expect(info.titleSource).toBe(slotSource ?? "user");
		}
	});
});

describe("locked offline receipt storage", () => {
	it("enforces the cap for competing writers and releases a failed transaction", async () => {
		const dir = tempDir();
		for (let i = 0; i < OFFLINE_INBOX_CAP - 1; i++)
			await enqueueOffline(sessionId, message(`filled-${i}`), { dir, now });
		const outcomes = await Promise.all([
			enqueueOffline(sessionId, message("racer-one"), { dir, now }),
			enqueueOffline(sessionId, message("racer-two"), { dir, now }),
		]);
		expect(outcomes.sort()).toEqual(["full", "queued"]);
		expect(await drainOffline(sessionId, { dir, now })).toHaveLength(OFFLINE_INBOX_CAP);
		await expect(
			withOfflineMailboxLock(
				sessionId,
				async () => {
					throw new Error("transaction failure");
				},
				{ dir },
			),
		).rejects.toThrow("transaction failure");
		await withOfflineMailboxLock(
			sessionId,
			async () => {
				expect(await fs.readdir(mailboxDir(sessionId, { dir }))).toHaveLength(OFFLINE_INBOX_CAP);
			},
			{ dir },
		);
		const abort = new AbortController();
		abort.abort();
		await expect(
			enqueueOffline(sessionId, message("cancelled"), { dir, now, signal: abort.signal }),
		).rejects.toThrow();
		expect((await drainOffline(sessionId, { dir, now })).some(item => item.message.id === "cancelled")).toBe(false);
	});

	it("stores one deterministic refusal notice despite retry at capacity and applies the ordinary TTL", async () => {
		const dir = tempDir();
		const notice: StoredRefusalNotice = {
			type: "notice",
			id: "refused-original",
			from: message("original").from,
			kind: "refused",
			subject: "message",
			aboutId: "original",
			toSessionId: sessionId,
			sentAt: now,
		};
		expect(await enqueueOfflineNotice(sessionId, notice, { dir, now })).toBe("queued");
		for (let i = 1; i < OFFLINE_INBOX_CAP; i++) await enqueueOffline(sessionId, message(`filled-${i}`), { dir, now });
		expect(await enqueueOfflineNotice(sessionId, { ...notice, sentAt: now + 1 }, { dir, now })).toBe("queued");
		const drained = await drainOffline(sessionId, { dir, now });
		expect(drained.filter(item => item.message.id === notice.id).map(item => item.message)).toEqual([notice]);
		expect(drained).toHaveLength(OFFLINE_INBOX_CAP);
		expect(await drainOffline(sessionId, { dir, now: now + OFFLINE_INBOX_TTL_MS + 1 })).toEqual([]);
	});
});
