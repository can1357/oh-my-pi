import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CURRENT_SESSION_VERSION,
	SESSION_TITLE_SLOT_BYTES,
	type SessionHeader,
	TITLE_CHANGE_ENTRY_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { SessionTitleUpdate } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

import { makeAssistantMessage } from "./helpers";

class CountingTitleSlotStorage extends FileSessionStorage {
	titleUpdates = 0;
	syncWrites = 0;
	atomicWrites = 0;

	override async updateSessionTitle(filePath: string, title: SessionTitleUpdate): Promise<void> {
		this.titleUpdates++;
		await super.updateSessionTitle(filePath, title);
	}

	override writeTextSync(filePath: string, content: string): void {
		this.syncWrites++;
		super.writeTextSync(filePath, content);
	}

	override async writeTextAtomic(filePath: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.atomicWrites++;
		await super.writeTextAtomic(filePath, content, options);
	}

	resetCounts(): void {
		this.titleUpdates = 0;
		this.syncWrites = 0;
		this.atomicWrites = 0;
	}
}

function parseJsonLine(line: string): Record<string, unknown> {
	return JSON.parse(line) as Record<string, unknown>;
}

function readRawLines(filePath: string): string[] {
	return fs.readFileSync(filePath, "utf8").trimEnd().split("\n");
}

function getHeader(entries: unknown[]): SessionHeader | undefined {
	return entries.find(
		(entry): entry is SessionHeader =>
			typeof entry === "object" && entry !== null && "type" in entry && entry.type === "session",
	);
}

describe("session title source persistence", () => {
	let testAgentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(() => {
		testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-title-source-"));
		cwd = path.join(testAgentDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		setAgentDir(testAgentDir);
	});

	afterEach(() => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		removeSyncWithRetries(testAgentDir);
	});

	it("persists auto title source across reopen", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.setSessionName("Auto title", "auto");
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();

		const entries = await loadEntriesFromFile(sessionFile!);
		expect(getHeader(entries)?.titleSource).toBe("auto");
		const rawLines = readRawLines(sessionFile!);
		expect(Buffer.byteLength(`${rawLines[0]}\n`, "utf8")).toBe(SESSION_TITLE_SLOT_BYTES);
		expect(parseJsonLine(rawLines[0])).toMatchObject({
			type: "title",
			v: 1,
			title: "Auto title",
			source: "auto",
		});
		expect(parseJsonLine(rawLines[1]).type).toBe("session");
		const reopened = await SessionManager.open(sessionFile!);
		expect(reopened.getSessionName()).toBe("Auto title");
		expect(reopened.titleSource).toBe("auto");
	});

	it("persists user title source across reopen", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.setSessionName("Manual title", "user");
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();

		const entries = await loadEntriesFromFile(sessionFile!);
		expect(getHeader(entries)?.titleSource).toBe("user");

		const reopened = await SessionManager.open(sessionFile!);
		expect(reopened.getSessionName()).toBe("Manual title");
		expect(reopened.titleSource).toBe("user");
	});

	it("loads legacy slotless files with header titles", async () => {
		const sessionDir = SessionManager.getDefaultSessionDir(cwd);
		fs.mkdirSync(sessionDir, { recursive: true });
		const file = path.join(sessionDir, "legacy.jsonl");
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "legacy-session",
			title: "Legacy title",
			titleSource: "user",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
		};
		fs.writeFileSync(file, `${JSON.stringify(header)}\n`);

		const entries = await loadEntriesFromFile(file);
		expect(getHeader(entries)?.title).toBe("Legacy title");
		expect(getHeader(entries)?.titleSource).toBe("user");

		const reopened = await SessionManager.open(file);
		expect(reopened.getSessionName()).toBe("Legacy title");
		expect(reopened.titleSource).toBe("user");
	});

	it("renames slotted sessions by updating the fixed title slot and appending an audit entry", async () => {
		const storage = new CountingTitleSlotStorage();
		const session = SessionManager.create(cwd, undefined, storage);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.setSessionName("Auto title", "auto", "initial");
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();
		storage.resetCounts();

		await session.setSessionName("Manual title", "user", "rename");
		await session.flush();

		expect(storage.titleUpdates).toBe(1);
		expect(storage.syncWrites).toBe(0);
		expect(storage.atomicWrites).toBe(0);

		const rawLines = readRawLines(sessionFile!);
		expect(parseJsonLine(rawLines[0])).toMatchObject({
			type: "title",
			title: "Manual title",
			source: "user",
		});
		expect(parseJsonLine(rawLines[1]).type).toBe("session");

		const entries = await loadEntriesFromFile(sessionFile!);
		expect(getHeader(entries)?.title).toBe("Manual title");
		const titleChanges = entries.filter(entry => entry.type === TITLE_CHANGE_ENTRY_TYPE);
		expect(titleChanges.map(entry => entry.title)).toEqual(["Auto title", "Manual title"]);
		expect(titleChanges.map(entry => entry.trigger)).toEqual(["initial", "rename"]);
	});

	it("notifies name-change subscribers only after successful applied names", async () => {
		const session = SessionManager.inMemory(cwd);
		const names: Array<string | undefined> = [];
		const unsubscribe = session.onSessionNameChanged(() => {
			names.push(session.getSessionName());
		});

		try {
			await expect(session.setSessionName("   ", "user")).resolves.toBe(false);
			expect(names).toEqual([]);

			await expect(session.setSessionName("Manual title", "user")).resolves.toBe(true);
			expect(names).toEqual(["Manual title"]);

			await expect(session.setSessionName("Ignored auto title", "auto")).resolves.toBe(false);
			expect(names).toEqual(["Manual title"]);
		} finally {
			unsubscribe();
		}

		await expect(session.setSessionName("Second title", "user")).resolves.toBe(true);
		expect(names).toEqual(["Manual title"]);
	});
});
