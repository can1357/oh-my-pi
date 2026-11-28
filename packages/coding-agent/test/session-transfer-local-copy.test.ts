import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { FileEntry, SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { findSessionFiles } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import * as sessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	lastSessionTransfer,
	markSessionMoved,
	packSession,
	unpackSession,
} from "@oh-my-pi/pi-coding-agent/session/session-transfer";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
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
	let cleanup: AsyncDisposableStack;
	let root: string;
	let laptopAgent: string;
	let cloudAgent: string;
	let laptopCwd: string;
	let cloudCwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(async () => {
		// Disposed in reverse: mocks, the session index, the agent directory, then the temp directory. Each step
		// runs even when one before it throws.
		cleanup = new AsyncDisposableStack();
		root = cleanup.use(await TempDir.create("@omp-session-transfer-copy-")).path();
		laptopAgent = path.join(root, "laptop-agent");
		cloudAgent = path.join(root, "cloud-agent");
		laptopCwd = path.join(root, "laptop", "project");
		cloudCwd = path.join(root, "cloud", "project");
		await fsp.mkdir(laptopCwd, { recursive: true });
		await fsp.mkdir(cloudCwd, { recursive: true });
		cleanup.defer(() => {
			if (originalAgentDir) {
				setAgentDir(originalAgentDir);
			} else {
				setAgentDir(path.join(getConfigRootDir(), "agent"));
				delete process.env.PI_CODING_AGENT_DIR;
			}
		});
		setAgentDir(laptopAgent);
		cleanup.defer(() => closeSessionIndex());
		cleanup.defer(() => vi.restoreAllMocks());
	});

	afterEach(() => cleanup.disposeAsync());

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

	/**
	 * Laptop session packed, continued on the laptop so it diverged, continued on the cloud and packed back to
	 * `<root>/back.tar`, plus a second laptop copy under another name that unpack finds by its name and header.
	 */
	async function divergedWithSecondCopy(): Promise<{ laptopFile: string; secondCopy: string; id: string }> {
		const laptopFile = await laptopSessionPacked();
		const id = headerOf(await loadEntriesFromFile(laptopFile)).id;
		await appendTurn(laptopFile, "laptop work");
		await continueOnCloud();
		const secondCopy = path.join(path.dirname(laptopFile), `2000-01-01T00-00-00-000Z_${id}.jsonl`);
		await fsp.copyFile(laptopFile, secondCopy);
		return { laptopFile, secondCopy, id };
	}

	/** Run `change` once, right before unpack's prefix check reads `file`; returns whether it ran. */
	function beforePrefixCheckOf(file: string, change: () => Promise<void>): () => boolean {
		const visit = sessionLoader.visitEntriesFromFile;
		let changed = false;
		vi.spyOn(sessionLoader, "visitEntriesFromFile").mockImplementation(async (filePath, visitor, storage) => {
			if (!changed && path.basename(filePath) === path.basename(file)) {
				await change();
				changed = true;
			}
			return visit(filePath, visitor, storage);
		});
		return () => changed;
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

	it("forks when one local copy diverged and another was removed after unpack found it", async () => {
		const { laptopFile, secondCopy, id } = await divergedWithSecondCopy();
		const removed = beforePrefixCheckOf(secondCopy, () => fsp.rm(secondCopy));

		const result = await unpackSession(path.join(root, "back.tar"), { cwd: laptopCwd });

		expect(removed()).toBe(true);
		expect(result.mode).toBe("forked");
		const forked = await loadEntriesFromFile(result.sessionFile);
		expect(headerOf(forked).parentSession).toBe(id);
		expect(userTexts(forked)).toEqual(["first", "cloud work"]);
		expect(userTexts(await loadEntriesFromFile(laptopFile))).toEqual(["first", "laptop work"]);
	});

	it("refuses to unpack when a local copy it found fails to read for a reason other than its removal", async () => {
		const { laptopFile, secondCopy } = await divergedWithSecondCopy();
		const replaced = beforePrefixCheckOf(secondCopy, async () => {
			await fsp.rm(secondCopy);
			await fsp.mkdir(secondCopy);
		});

		await expect(unpackSession(path.join(root, "back.tar"), { cwd: laptopCwd })).rejects.toMatchObject({
			code: "EISDIR",
		});

		expect(replaced()).toBe(true);
		// No fork was placed beside the local copies.
		const sessionFiles = (await fsp.readdir(path.dirname(laptopFile))).filter(name => name.endsWith(".jsonl"));
		expect(sessionFiles.sort()).toEqual([path.basename(secondCopy), path.basename(laptopFile)].sort());
	});
});
