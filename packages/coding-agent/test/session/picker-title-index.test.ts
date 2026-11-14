import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "../session-manager/helpers";

/**
 * The resume picker opens on rows built from history.db titles, before any
 * session file is read, then completes with the full scan, which backfills
 * the titles the index lacks.
 */
describe("resume picker title index", () => {
	let testAgentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-picker-titles-"));
		cwd = path.join(testAgentDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		setAgentDir(testAgentDir);
	});

	afterEach(() => {
		// Windows cannot delete the open history.db.
		closeSessionIndex();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		removeSyncWithRetries(testAgentDir);
	});

	async function createSession(title?: string): Promise<string> {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: `prompt for ${title ?? "untitled"}`, timestamp: 1 });
		if (title) await session.setSessionName(title, "user");
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const file = session.getSessionFile();
		if (!file) throw new Error("session did not materialize");
		await session.close();
		return file;
	}

	it("lists indexed titles without reading session files, then completes with the full scan", async () => {
		const titled = await createSession("Indexed title");
		const untitled = await createSession();
		// Unreadable now: only the index can still name this session.
		fs.truncateSync(titled, 0);

		const listing = await SessionManager.listForPicker(cwd);

		expect(listing.sessions.map(session => [session.path, session.title])).toEqual([[titled, "Indexed title"]]);
		expect((await listing.complete).map(session => session.path)).toEqual([untitled]);
	});

	it("backfills header titles the index lacks, so the next listing starts with them", async () => {
		const sessionDir = SessionManager.getDefaultSessionDir(cwd);
		fs.mkdirSync(sessionDir, { recursive: true });
		const id = Bun.randomUUIDv7();
		const legacy = path.join(sessionDir, `2024-01-01T00-00-00-000Z_${id}.jsonl`);
		const header = { type: "session", version: 4, id, timestamp: "2024-01-01T00:00:00.000Z", cwd, title: "Legacy" };
		fs.writeFileSync(legacy, `${JSON.stringify(header)}\n`);

		// Nothing indexed: the first listing waits for the full scan.
		const first = await SessionManager.listForPicker(cwd);
		expect(first.sessions.map(session => session.title)).toEqual(["Legacy"]);
		await first.complete;

		fs.truncateSync(legacy, 0);
		const second = await SessionManager.listForPicker(cwd);
		expect(second.sessions.map(session => [session.path, session.title, session.created.toISOString()])).toEqual([
			[legacy, "Legacy", "2024-01-01T00:00:00.000Z"],
		]);
	});
});
