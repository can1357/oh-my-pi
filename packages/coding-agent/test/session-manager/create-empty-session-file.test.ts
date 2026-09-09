import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";

describe("SessionManager.createEmptySessionFile", () => {
	let testAgentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-empty-session-"));
		setAgentDir(testAgentDir);
		cwd = path.join(testAgentDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
	});

	afterEach(async () => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(testAgentDir, { recursive: true, force: true });
	});

	it("creates a valid session file with a header pointing at the given cwd", async () => {
		const file = SessionManager.createEmptySessionFile(cwd);
		expect(file).toMatch(/\.jsonl$/);
		expect(fs.existsSync(file)).toBe(true);

		const entries = await loadEntriesFromFile(file);
		expect(entries.length).toBe(1);
		const header = entries[0] as SessionHeader;
		expect(header.type).toBe("session");
		expect(header.version).toBe(3);
		expect(header.id).toBeTruthy();
		expect(header.cwd).toBe(path.resolve(cwd));
	});

	it("places the file in the cwd-derived default session directory", () => {
		const file = SessionManager.createEmptySessionFile(cwd);
		const expectedDir = SessionManager.getDefaultSessionDir(cwd);
		expect(path.dirname(file)).toBe(expectedDir);
	});

	it("can be loaded by setSessionFile to start a fresh session at that path", async () => {
		const file = SessionManager.createEmptySessionFile(cwd);
		const manager = SessionManager.create(cwd);
		await manager.setSessionFile(file);

		// The session adopts the header's cwd and has no entries beyond the header.
		expect(manager.getCwd()).toBe(path.resolve(cwd));
		expect(manager.getSessionFile()).toBe(path.resolve(file));
		expect(manager.getEntries().length).toBe(0);
	});

	it("produces unique file paths across calls", () => {
		const fileA = SessionManager.createEmptySessionFile(cwd);
		const fileB = SessionManager.createEmptySessionFile(cwd);
		expect(fileA).not.toBe(fileB);
	});
});
