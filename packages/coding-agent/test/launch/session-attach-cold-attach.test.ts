import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type SessionOwnerAttachSelection, createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { readSessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	isSessionLeaseHeld,
	type SessionReservation,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

interface CreatedSession {
	readonly sessionId: string;
	readonly sessionPath: string;
}

function userTurn(content: string) {
	return { role: "user" as const, content, timestamp: Date.now() };
}

async function createSession(dir: string, cwd: string, content: string): Promise<CreatedSession> {
	const creator = SessionManager.create(cwd, dir, new FileSessionStorage());
	await creator.ensureOnDisk();
	creator.appendMessage(userTurn(content));
	await creator.flush();
	const sessionPath = creator.getSessionFile();
	if (!sessionPath) throw new Error("Expected a session file");
	await creator.close();
	const session = await readSessionInfo(sessionPath);
	if (!session) throw new Error("Expected a readable session header");
	return { sessionId: session.id, sessionPath };
}

async function ownerAttachFor(
	sessionPath: string,
	reservation: SessionReservation,
	recent?: SessionOwnerAttachSelection["recent"],
): Promise<SessionOwnerAttachSelection> {
	const session = await readSessionInfo(sessionPath);
	if (!session) throw new Error("Expected a readable session header");
	return { session, reservation, recent };
}

describe("createSessionManager adopts the startup gate's reservation", () => {
	it("opens the cold --resume target under the strict reservation and releases it on close", async () => {
		using tempDir = TempDir.createSync("@omp-cold-attach-");
		const cwd = tempDir.path();
		const { sessionId, sessionPath } = await createSession(tempDir.path(), cwd, "before");
		const storage = new FileSessionStorage();
		const reservation = storage.reserveSession(sessionId, sessionPath);
		const ownerAttach = await ownerAttachFor(sessionPath, reservation);
		const parsed = parseArgs(["--resume", sessionId, "--session-dir", tempDir.path()]);

		const manager = await createSessionManager(parsed, cwd, Settings.isolated(), async () => "declined", {
			ownerAttach,
		});
		if (!manager) throw new Error("Expected a resumed manager");
		try {
			expect(manager.getSessionFile()).toBe(sessionPath);
			expect(isSessionLeaseHeld(sessionId)).toBe(true);
			manager.appendMessage(userTurn("cold resume"));
			await manager.flush();
		} finally {
			await manager.close();
		}

		expect(isSessionLeaseHeld(sessionId)).toBe(false);
		expect(fs.readFileSync(sessionPath, "utf8")).toContain("cold resume");
	});

	it("continues the target the gate resolved instead of re-deciding from the newest journal", async () => {
		using tempDir = TempDir.createSync("@omp-cold-attach-");
		const cwd = tempDir.path();
		const older = await createSession(tempDir.path(), cwd, "older conversation");
		const newer = await createSession(tempDir.path(), cwd, "newer conversation");
		const now = Date.now() / 1000;
		fs.utimesSync(older.sessionPath, now - 120, now - 120);
		fs.utimesSync(newer.sessionPath, now, now);

		const storage = new FileSessionStorage();
		const reservation = storage.reserveSession(older.sessionId, older.sessionPath);
		const ownerAttach = await ownerAttachFor(older.sessionPath, reservation, {
			sessionPath: older.sessionPath,
		});
		const parsed = parseArgs(["--continue", "--session-dir", tempDir.path()]);

		const manager = await createSessionManager(parsed, cwd, Settings.isolated(), async () => "declined", {
			ownerAttach,
		});
		if (!manager) throw new Error("Expected a continued manager");
		try {
			expect(manager.getSessionFile()).toBe(older.sessionPath);
			expect(isSessionLeaseHeld(older.sessionId)).toBe(true);
		} finally {
			await manager.close();
		}

		expect(isSessionLeaseHeld(older.sessionId)).toBe(false);
		expect(fs.existsSync(newer.sessionPath)).toBe(true);
	});
});
