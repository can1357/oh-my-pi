/**
 * Background-instance listing contract: the Agent Hub discovers persistent
 * background sessions by scanning session files for an *active*
 * `background_instance` marker — read from the header cache when present, else
 * recovered from a body entry for long transcripts. Archived markers and plain
 * sessions must not surface as background lanes.
 */
import { describe, expect, it } from "bun:test";
import {
	BACKGROUND_INSTANCE_DEFAULT_RETENTION_MS,
	backgroundInstanceDisplayName,
	isBackgroundInstanceSession,
	type SessionInfo,
} from "@pk-nerdsaver-ai/pi-coding-agent/session/session-listing";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-storage";

const SESSION_DIR = "/sessions/bg-proj";

function line(obj: unknown): string {
	return `${JSON.stringify(obj)}\n`;
}

let entrySeq = 0;
function bodyEntry(obj: Record<string, unknown>): string {
	entrySeq += 1;
	return line({ id: `e${entrySeq}`, parentId: null, timestamp: new Date().toISOString(), ...obj });
}

function header(id: string, backgroundInstance?: unknown): string {
	return line({
		type: "session",
		version: 3,
		id,
		cwd: "/proj",
		timestamp: new Date().toISOString(),
		...(backgroundInstance !== undefined ? { backgroundInstance } : {}),
	});
}

function sessionInfoWithBackground(backgroundInstance: SessionInfo["backgroundInstance"], modified: Date): SessionInfo {
	return {
		path: `${SESSION_DIR}/synthetic.jsonl`,
		id: "synthetic",
		cwd: "/proj",
		created: modified,
		modified,
		messageCount: 0,
		size: 0,
		firstMessage: "(no messages)",
		allMessagesText: "",
		backgroundInstance,
	};
}

async function listById(storage: MemorySessionStorage): Promise<Map<string, SessionInfo>> {
	const sessions = await SessionManager.list("/proj", SESSION_DIR, storage);
	return new Map(sessions.map(s => [s.id, s]));
}

describe("background-instance session listing", () => {
	it("surfaces an active background instance from the header cache with its name and model", async () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync(
			`${SESSION_DIR}/bg-active.jsonl`,
			header("bg-active", { name: "api-worker", status: "active", model: "anthropic/claude" }),
		);
		const byId = await listById(storage);
		const info = byId.get("bg-active");
		expect(info).toBeDefined();
		expect(isBackgroundInstanceSession(info!)).toBe(true);
		expect(info!.backgroundInstance?.model).toBe("anthropic/claude");
		expect(backgroundInstanceDisplayName(info!)).toBe("api-worker");
	});

	it("recovers the marker from a body entry when the header has no cache (long transcript path)", async () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync(
			`${SESSION_DIR}/bg-body.jsonl`,
			header("bg-body") + bodyEntry({ type: "background_instance", name: "scout", status: "active" }),
		);
		const info = (await listById(storage)).get("bg-body");
		expect(info).toBeDefined();
		expect(isBackgroundInstanceSession(info!)).toBe(true);
		expect(backgroundInstanceDisplayName(info!)).toBe("scout");
	});

	it("treats the latest archived marker as not a background instance", async () => {
		const storage = new MemorySessionStorage();
		// Header cache reflects the most recent state: archived.
		storage.writeTextSync(
			`${SESSION_DIR}/bg-archived.jsonl`,
			header("bg-archived", { name: "old", status: "archived", model: "m" }),
		);
		const info = (await listById(storage)).get("bg-archived");
		expect(info).toBeDefined();
		expect(isBackgroundInstanceSession(info!)).toBe(false);
	});

	it("expires unpinned active background lanes after the default 24-hour retention window", () => {
		const oldModified = new Date(Date.now() - BACKGROUND_INSTANCE_DEFAULT_RETENTION_MS - 1);
		const info = sessionInfoWithBackground({ name: "expired", status: "active" }, oldModified);
		expect(isBackgroundInstanceSession(info)).toBe(false);
	});

	it("keeps pinned manual background lanes active until archived", () => {
		const oldModified = new Date(Date.now() - BACKGROUND_INSTANCE_DEFAULT_RETENTION_MS - 1);
		const expiredPinned = sessionInfoWithBackground(
			{ name: "manual", status: "active", pinned: true, expiresAt: new Date(Date.now() - 1000).toISOString() },
			oldModified,
		);
		expect(isBackgroundInstanceSession(expiredPinned)).toBe(true);

		const archivedPinned = sessionInfoWithBackground(
			{ name: "manual", status: "archived", pinned: true },
			oldModified,
		);
		expect(isBackgroundInstanceSession(archivedPinned)).toBe(false);
	});

	it("does not flag a plain session as a background instance", async () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync(`${SESSION_DIR}/plain.jsonl`, header("plain"));
		const info = (await listById(storage)).get("plain");
		expect(info).toBeDefined();
		expect(isBackgroundInstanceSession(info!)).toBe(false);
		expect(info!.backgroundInstance).toBeUndefined();
	});
});

describe("SessionManager background-instance round trip", () => {
	it("promotes the current session, reports the active marker, then archives it", async () => {
		const sm = SessionManager.inMemory("/proj");
		expect(sm.getBackgroundInstance()).toBeUndefined();

		const ok = await sm.backgroundCurrentSession({ name: "worker", model: "anthropic/claude" });
		expect(ok).toBe(true);
		const active = sm.getBackgroundInstance();
		expect(active?.name).toBe("worker");
		expect(active?.status).toBe("active");
		expect(active?.model).toBe("anthropic/claude");
		expect(active?.pinned).toBe(true);

		// Archiving drops it out of the background roster while leaving the session intact.
		expect(sm.archiveBackgroundInstance()).toBeDefined();
		expect(sm.getBackgroundInstance()).toBeUndefined();
	});
});
