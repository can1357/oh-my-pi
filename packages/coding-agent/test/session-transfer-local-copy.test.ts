import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FileEntry, SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { resetSessionIndexForTests } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { findSessionFiles } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	lastSessionTransfer,
	markSessionMoved,
	packSession,
	unpackSession,
} from "@oh-my-pi/pi-coding-agent/session/session-transfer";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./session-manager/helpers";

function headerOf(entries: FileEntry[]): SessionHeader {
	const header = entries[0];
	if (header?.type !== "session") throw new Error("missing session header");
	return header;
}

function userTexts(entries: FileEntry[]): string[] {
	const texts: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user" && typeof message.content === "string") texts.push(message.content);
	}
	return texts;
}

async function appendTurn(sessionFile: string, text: string): Promise<void> {
	const session = await SessionManager.open(sessionFile);
	session.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	session.appendMessage(makeAssistantMessage());
	await session.flush();
	await session.close();
}

describe("omp session unpack against a local copy", () => {
	let root: string;
	let laptopAgent: string;
	let cloudAgent: string;
	let laptopCwd: string;
	let cloudCwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(async () => {
		root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-transfer-copy-"));
		laptopAgent = path.join(root, "laptop-agent");
		cloudAgent = path.join(root, "cloud-agent");
		laptopCwd = path.join(root, "laptop", "project");
		cloudCwd = path.join(root, "cloud", "project");
		fs.mkdirSync(laptopCwd, { recursive: true });
		fs.mkdirSync(cloudCwd, { recursive: true });
		setAgentDir(laptopAgent);
	});

	afterEach(async () => {
		resetSessionIndexForTests();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(root, { recursive: true, force: true });
	});

	/** Laptop session with one turn, packed to `<root>/out.tar`; returns its file. */
	async function laptopSessionPacked(): Promise<string> {
		const session = SessionManager.create(laptopCwd);
		session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const file = session.getSessionFile();
		if (!file) throw new Error("session has no file");
		await session.close();
		await packSession(file, path.join(root, "out.tar"));
		return file;
	}

	/** Unpack `<root>/out.tar` on the cloud machine, add a turn there, and pack it to `<root>/back.tar`. */
	async function continueOnCloud(): Promise<void> {
		setAgentDir(cloudAgent);
		const unpacked = await unpackSession(path.join(root, "out.tar"), { cwd: cloudCwd });
		await appendTurn(unpacked.sessionFile, "cloud work");
		await packSession(unpacked.sessionFile, path.join(root, "back.tar"));
		setAgentDir(laptopAgent);
	}

	it("replaces a stale prefix copy, keeping one live copy", async () => {
		const laptopFile = await laptopSessionPacked();
		const id = headerOf(await loadEntriesFromFile(laptopFile)).id;
		// The copy left behind is marked moved after packing, so only it holds that marker.
		await markSessionMoved(laptopFile, "cloud");
		await continueOnCloud();

		const result = await unpackSession(path.join(root, "back.tar"), { cwd: laptopCwd });

		expect(result.mode).toBe("replaced");
		expect(result.id).toBe(id);
		expect(await findSessionFiles(id)).toEqual([result.sessionFile]);
		const entries = await loadEntriesFromFile(result.sessionFile);
		expect(userTexts(entries)).toEqual(["first", "cloud work"]);
		expect(lastSessionTransfer(entries)).toEqual({
			kind: "arrived",
			fromCwd: path.resolve(cloudCwd),
			cwd: path.resolve(laptopCwd),
		});
	});

	it("unpacks as a fork when the local copy diverged", async () => {
		const laptopFile = await laptopSessionPacked();
		const id = headerOf(await loadEntriesFromFile(laptopFile)).id;
		await appendTurn(laptopFile, "laptop work");
		await continueOnCloud();

		const result = await unpackSession(path.join(root, "back.tar"), { cwd: laptopCwd });

		expect(result.mode).toBe("forked");
		expect(result.id).not.toBe(id);
		const forked = await loadEntriesFromFile(result.sessionFile);
		expect(headerOf(forked).parentSession).toBe(id);
		expect(headerOf(forked).cwd).toBe(path.resolve(laptopCwd));
		expect(userTexts(forked)).toEqual(["first", "cloud work"]);
		// The diverged local copy is untouched.
		expect(userTexts(await loadEntriesFromFile(laptopFile))).toEqual(["first", "laptop work"]);
	});
});
