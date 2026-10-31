import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EVAL_STATE_CONTEXT_TYPE } from "@oh-my-pi/pi-coding-agent/eval/state";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { openRpcSession, type RpcOpenSessionSession } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { SESSION_EXIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import type { SessionContinuation } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { readSessionHeaderId } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager, type SessionPersistenceNotice } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { writeTerminalBreadcrumb } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { __resetDirsFromEnvForTests, getTerminalSessionsDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const SESSION_MANAGER_MODULE = path.join(import.meta.dir, "../../src/session/session-manager.ts");
const EXIT_DIAGNOSTICS_MODULE = path.join(import.meta.dir, "../../src/session/exit-diagnostics.ts");

const stubSettings = { get: () => undefined } as unknown as Settings;

// Resume writes breadcrumbs and the custom-session-file registry under the agent dir.
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir: TempDir | undefined;

beforeEach(() => {
	agentDir = TempDir.createSync("@omp-resume-continuation-agent-");
	setAgentDir(agentDir.join("agent"));
});

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	__resetDirsFromEnvForTests();
	agentDir?.removeSync();
	agentDir = undefined;
});

/** Writes a holder makes while nobody types; none of them is a turn. */
type IdleWrite = "warm" | "compact";

/**
 * Another live omp process that resumed `sessionFile`. Commands, one per line:
 * `append <text>` writes a user turn (the first write makes it the file's
 * owner); `warm` records the usage of an idle cache refresh; `compact` writes
 * an idle compaction and the eval-state snapshot that follows it; `clear`
 * records the reset boundary `/clear` leaves; `exit` records the
 * `session_exit` marker every omp process appends on its way out, then closes.
 */
class Holder {
	readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly #stdout: { read(): Promise<{ done: boolean; value?: Uint8Array }> };
	#buffered = "";

	private constructor(child: Bun.Subprocess<"pipe", "pipe", "pipe">) {
		this.#child = child;
		this.#stdout = child.stdout.getReader();
	}

	static async resume(tempDir: TempDir, sessionFile: string): Promise<Holder> {
		const script = tempDir.join("holder-process.ts");
		await Bun.write(
			script,
			[
				`import { SessionManager } from ${JSON.stringify(SESSION_MANAGER_MODULE)};`,
				`import { SESSION_EXIT_CUSTOM_TYPE } from ${JSON.stringify(EXIT_DIAGNOSTICS_MODULE)};`,
				"const manager = await SessionManager.open(process.argv[2], undefined, undefined, { suppressBreadcrumb: true });",
				'const report = () => process.stdout.write(manager.getSessionFile() + "\\n");',
				"report();",
				"for await (const line of console) {",
				'	if (line === "exit") {',
				'		manager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, { reason: "dispose", kind: "normal", recordedAt: new Date().toISOString() });',
				"		await manager.flush();",
				"		break;",
				"	}",
				'	if (line === "warm") {',
				"		manager.appendModelUsage(",
				'			{ purpose: "cache-warm", api: "openai-completions", provider: "stub", model: "stub", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" },',
				"			{ sessionId: manager.getSessionId(), parentId: manager.getLeafId() },",
				"		);",
				'	} else if (line === "compact") {',
				'		manager.appendCompaction("summary", undefined, manager.getLeafId(), 0);',
				`		manager.appendMessage({ role: "custom", customType: ${JSON.stringify(EVAL_STATE_CONTEXT_TYPE)}, content: "eval state", display: false, attribution: "agent", timestamp: Date.now() });`,
				'	} else if (line === "clear") {',
				"		manager.appendResetBoundary();",
				"	} else {",
				'		manager.appendMessage({ role: "user", content: line.slice("append ".length), timestamp: Date.now() });',
				"	}",
				"	await manager.flush();",
				"	report();",
				"}",
				"await manager.close();",
			].join("\n"),
		);
		// The live `process.env`, so the holder meets this process's session-owner leases.
		const holder = new Holder(
			Bun.spawn([process.execPath, script, sessionFile], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: process.env,
			}),
		);
		await holder.#nextLine();
		return holder;
	}

	async #nextLine(): Promise<string> {
		let newline = this.#buffered.indexOf("\n");
		while (newline === -1) {
			const { done, value } = await this.#stdout.read();
			if (done) throw new Error(`The holder exited early: ${await new Response(this.#child.stderr).text()}`);
			this.#buffered += new TextDecoder().decode(value);
			newline = this.#buffered.indexOf("\n");
		}
		const line = this.#buffered.slice(0, newline);
		this.#buffered = this.#buffered.slice(newline + 1);
		return line;
	}

	/** Append one user turn; returns the file it was saved to. */
	async append(text: string): Promise<string> {
		this.#child.stdin.write(`append ${text}\n`);
		this.#child.stdin.flush();
		return this.#nextLine();
	}

	/** Make one write that is not a turn; returns the file it was saved to. */
	async idle(write: IdleWrite): Promise<string> {
		this.#child.stdin.write(`${write}\n`);
		this.#child.stdin.flush();
		return this.#nextLine();
	}

	/** Record a `/clear`; returns the file it was saved to. */
	async clear(): Promise<string> {
		this.#child.stdin.write("clear\n");
		this.#child.stdin.flush();
		return this.#nextLine();
	}

	async exit(): Promise<void> {
		this.#child.stdin.write("exit\n");
		this.#child.stdin.end();
		await this.#child.exited;
	}
}

function resumeArgs(resume: string, sessionDir?: string): Args {
	return {
		resume,
		sessionDir,
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
		invalidFlagValues: [],
	};
}

function continueArgs(sessionDir: string): Args {
	return {
		continue: true,
		sessionDir,
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
		invalidFlagValues: [],
	};
}

function userTurn(content: string) {
	return { role: "user" as const, content, timestamp: Date.now() };
}

function open(sessionFile: string, sessionDir: string): Promise<SessionManager> {
	return SessionManager.open(sessionFile, sessionDir, new FileSessionStorage(), { suppressBreadcrumb: true });
}

async function userTurnsIn(sessionFile: string, sessionDir: string): Promise<unknown[]> {
	const reader = await open(sessionFile, sessionDir);
	return reader
		.getEntries()
		.flatMap(entry => (entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : []));
}

async function createSession(tempDir: TempDir): Promise<string> {
	const creator = SessionManager.create(tempDir.path(), tempDir.path(), new FileSessionStorage());
	await creator.ensureOnDisk();
	creator.appendMessage(userTurn("before"));
	const sessionFile = creator.getSessionFile();
	if (!sessionFile) throw new Error("Expected session file");
	await creator.close();
	return sessionFile;
}

/**
 * Resume `sessionFile` while another process owns it and write once (a user
 * turn with text `write`, or the given write): the session moves to a sibling.
 */
async function continueElsewhere(
	sessionFile: string,
	sessionDir: string,
	write: string | ((manager: SessionManager) => void),
): Promise<string> {
	const manager = await open(sessionFile, sessionDir);
	const notices: SessionPersistenceNotice[] = [];
	manager.onPersistenceNotice(notice => notices.push(notice));
	if (typeof write === "string") manager.appendMessage(userTurn(write));
	else write(manager);
	await manager.close();
	const sibling = manager.getSessionFile();
	if (!sibling) throw new Error("Expected the session to save somewhere");
	expect(notices).toEqual([{ reason: "open-elsewhere", from: sessionFile, to: sibling }]);
	return sibling;
}

/**
 * Grow the header of `sessionFile` past the 4 KB prefix the session listing
 * reads, the way many recorded moves (`previousSessionFiles`) do.
 */
async function inflateHeader(sessionFile: string): Promise<void> {
	const lines = (await Bun.file(sessionFile).text()).split("\n");
	const index = lines.findIndex(line => line.includes('"type":"session"'));
	const header = JSON.parse(lines[index]);
	header.previousSessionFiles = Array.from({ length: 40 }, (_, i) =>
		path.join(path.dirname(sessionFile), `moved-${i}`.padEnd(120, "x"), path.basename(sessionFile)),
	);
	lines[index] = JSON.stringify(header);
	await Bun.write(sessionFile, lines.join("\n"));
}

/**
 * The scenario resume must recover from: a holder owns `original`, this process
 * resumes it and continues in a sibling, then the holder exits last (so the old
 * file's last write is its exit marker, after all of the sibling's turns).
 */
async function movedOffSession(
	tempDir: TempDir,
	idleAfterMove?: IdleWrite,
	createdSession?: string,
): Promise<{ original: string; continuation: string }> {
	const original = createdSession ?? (await createSession(tempDir));
	const holder = await Holder.resume(tempDir, original);
	let continuation: string;
	try {
		await holder.append("holder turn");
		// Entries are stamped by two processes' wall clocks at millisecond
		// resolution; fake timers cannot reach the holder, so the short sleeps
		// keep "which copy is newer" from being a same-millisecond tie.
		await Bun.sleep(5);
		continuation = await continueElsewhere(original, tempDir.path(), "continued turn");
		await Bun.sleep(5);
		if (idleAfterMove) expect(await holder.idle(idleAfterMove)).toBe(original);
	} finally {
		await holder.exit();
	}
	return { original, continuation };
}

/**
 * Both copies went on after the move: the holder kept writing `original` after
 * the continuation was made, so `original` has the newest turn. Then a process
 * on the continuation wrote its exit record, so the continuation is the most
 * recently written file.
 */
async function divergedWithContinuationWrittenLast(
	tempDir: TempDir,
	createdSession?: string,
): Promise<{ original: string; continuation: string }> {
	const original = createdSession ?? (await createSession(tempDir));
	const holder = await Holder.resume(tempDir, original);
	let continuation: string;
	try {
		await holder.append("holder turn");
		await Bun.sleep(5);
		continuation = await continueElsewhere(original, tempDir.path(), "continued turn");
		await Bun.sleep(5);
		await holder.append("holder kept going");
	} finally {
		await holder.exit();
	}
	await Bun.sleep(5);
	const exiting = await open(continuation, tempDir.path());
	exiting.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
		reason: "dispose",
		kind: "normal",
		recordedAt: new Date().toISOString(),
	});
	await exiting.close();
	expect(exiting.getSessionFile()).toBe(continuation);
	return { original, continuation };
}

/** An RPC process still on its startup session elsewhere; records the files `open_session` switches to. */
function rpcHost(switchedTo: string[]): RpcOpenSessionSession {
	return {
		sessionFile: agentDir?.join("startup.jsonl"),
		sessionId: "startup",
		messages: [],
		model: undefined,
		setModel: async () => ({ switched: true }),
		newSession: async () => true,
		switchSession: async (sessionPath: string) => {
			switchedTo.push(sessionPath);
			return true;
		},
	} as unknown as RpcOpenSessionSession;
}

describe("--resume of a session that continued in a sibling file", () => {
	// `continue`: the old file holds the holder's exit record, so it is the most recently written file.
	const idleWrites: Record<string, IdleWrite> = {
		"path after an idle cache refresh": "warm",
		"path after an idle compaction": "compact",
	};
	for (const by of ["path", "id", "continue", ...Object.keys(idleWrites)]) {
		it(`resumes the continuation, not the superseded file, when resumed by ${by}`, async () => {
			using tempDir = TempDir.createSync("@omp-resume-continuation-");
			const { original, continuation } = await movedOffSession(tempDir, idleWrites[by]);
			const sessionId = await readSessionHeaderId(original);
			if (!sessionId) throw new Error("Expected a session id");
			const args =
				by === "id"
					? resumeArgs(sessionId, tempDir.path())
					: by === "continue"
						? continueArgs(tempDir.path())
						: resumeArgs(original);

			const followed: SessionContinuation[] = [];
			const manager = await createSessionManager(args, tempDir.path(), stubSettings, async () => "unavailable", {
				onSessionContinuation: c => followed.push(c),
			});
			if (!manager) throw new Error("Expected a resumed session");
			try {
				expect(manager.getSessionFile()).toBe(continuation);
				expect(followed.map(c => ({ from: c.from, to: c.session.path, copies: c.copies }))).toEqual([
					{ from: original, to: continuation, copies: 2 },
				]);
			} finally {
				await manager.close();
			}
			expect(await userTurnsIn(continuation, tempDir.path())).toEqual(["before", "holder turn", "continued turn"]);
		}, 30_000);
	}

	it("opens the continuation when an RPC host opens the session directory", async () => {
		using tempDir = TempDir.createSync("@omp-resume-continuation-");
		const { continuation } = await movedOffSession(tempDir);
		const switchedTo: string[] = [];
		const opened = await openRpcSession(rpcHost(switchedTo), tempDir.path());
		expect(opened.resumed).toBe(true);
		expect(switchedTo).toEqual([continuation]);
	}, 30_000);

	it("continues the copy with the newest turn when the continuation was written last but the original went on", async () => {
		using tempDir = TempDir.createSync("@omp-resume-continuation-");
		const { original } = await divergedWithContinuationWrittenLast(tempDir);
		// A terminal with no record of its last session: `--continue` picks the most recently written file.
		await fs.rm(getTerminalSessionsDir(), { recursive: true, force: true });

		const followed: SessionContinuation[] = [];
		const manager = await createSessionManager(
			continueArgs(tempDir.path()),
			tempDir.path(),
			stubSettings,
			undefined,
			{
				onSessionContinuation: c => followed.push(c),
			},
		);
		try {
			expect(manager?.getSessionFile()).toBe(original);
			// The notice must not say the picked continuation went on in the older copy it continues.
			expect(followed.map(c => c.relation)).toEqual(["earlier"]);
		} finally {
			await manager?.close();
		}
		const switchedTo: string[] = [];
		await openRpcSession(rpcHost(switchedTo), tempDir.path());
		expect(switchedTo).toEqual([original]);
	}, 30_000);

	it("keeps the terminal's own last session when both copies went on, even if the other copy has the newest turn", async () => {
		using tempDir = TempDir.createSync("@omp-resume-continuation-");
		const { continuation } = await divergedWithContinuationWrittenLast(tempDir);
		// This terminal's record of its last session names the continuation; a
		// terminal id is needed to keep one, so give this test its own.
		const pane = process.env.TMUX_PANE;
		process.env.TMUX_PANE = "%resume-continuation-test";
		try {
			await fs.rm(getTerminalSessionsDir(), { recursive: true, force: true });
			writeTerminalBreadcrumb(tempDir.path(), continuation);
			const manager = await createSessionManager(continueArgs(tempDir.path()), tempDir.path(), stubSettings);
			try {
				expect(manager?.getSessionFile()).toBe(continuation);
			} finally {
				await manager?.close();
			}
		} finally {
			if (pane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = pane;
		}
	}, 30_000);

	it("continues the continuation when both copies went on, the continuation has the newest turn and the original was written last", async () => {
		using tempDir = TempDir.createSync("@omp-resume-continuation-");
		const original = await createSession(tempDir);
		const holder = await Holder.resume(tempDir, original);
		let continuation: string;
		try {
			await holder.append("holder turn");
			await Bun.sleep(5);
			continuation = await continueElsewhere(original, tempDir.path(), "continued turn");
			await Bun.sleep(5);
			await holder.append("holder kept going");
			await Bun.sleep(5);
			const writer = await open(continuation, tempDir.path());
			writer.appendMessage(userTurn("continuation went on later"));
			await writer.close();
			await Bun.sleep(5);
		} finally {
			// The holder's exit record makes the original the most recently written file.
			await holder.exit();
		}
		await fs.rm(getTerminalSessionsDir(), { recursive: true, force: true });

		const manager = await createSessionManager(continueArgs(tempDir.path()), tempDir.path(), stubSettings);
		try {
			expect(manager?.getSessionFile()).toBe(continuation);
		} finally {
			await manager?.close();
		}
	}, 30_000);

	it("moves off again when the continuation is itself open in another live process", async () => {
		using tempDir = TempDir.createSync("@omp-resume-continuation-");
		const { original, continuation } = await movedOffSession(tempDir);
		const continuationId = await readSessionHeaderId(continuation);
		const holder = await Holder.resume(tempDir, continuation);
		try {
			await holder.append("holder on the continuation");
			const manager = await createSessionManager(
				resumeArgs(original),
				tempDir.path(),
				stubSettings,
				async () => "unavailable",
			);
			if (!manager) throw new Error("Expected a resumed session");
			const notices: SessionPersistenceNotice[] = [];
			manager.onPersistenceNotice(notice => notices.push(notice));
			manager.appendMessage(userTurn("after resume"));
			await manager.flush();
			const savedTo = manager.getSessionFile();
			if (!savedTo) throw new Error("Expected the resumed session to save somewhere");
			expect(notices).toEqual([{ reason: "open-elsewhere", from: continuation, to: savedTo }]);
			expect(manager.getHeader()?.continuationOf).toBe(continuationId);
			await manager.close();
			expect(await userTurnsIn(savedTo, tempDir.path())).toEqual([
				"before",
				"holder turn",
				"continued turn",
				"holder on the continuation",
				"after resume",
			]);
		} finally {
			await holder.exit();
		}
		expect(await userTurnsIn(continuation, tempDir.path())).not.toContain("after resume");
	}, 30_000);

	it("keeps the asked-for file when its own conversation moved on after the continuation", async () => {
		using tempDir = TempDir.createSync("@omp-resume-continuation-");
		const original = await createSession(tempDir);
		const holder = await Holder.resume(tempDir, original);
		try {
			await holder.append("holder turn");
			await Bun.sleep(5);
			await continueElsewhere(original, tempDir.path(), "continued turn");
			await Bun.sleep(5);
			await holder.append("holder kept going");
		} finally {
			await holder.exit();
		}

		const manager = await createSessionManager(resumeArgs(original), tempDir.path(), stubSettings);
		try {
			expect(manager?.getSessionFile()).toBe(original);
		} finally {
			await manager?.close();
		}
	}, 30_000);

	it("keeps the asked-for file when both copies went on, even if the continuation wrote last", async () => {
		using tempDir = TempDir.createSync("@omp-resume-continuation-");
		const original = await createSession(tempDir);
		const holder = await Holder.resume(tempDir, original);
		let continuation: string;
		try {
			await holder.append("holder turn");
			await Bun.sleep(5);
			continuation = await continueElsewhere(original, tempDir.path(), "continued turn");
			await Bun.sleep(5);
			await holder.append("holder kept going");
			await Bun.sleep(5);
		} finally {
			await holder.exit();
		}
		const writer = await open(continuation, tempDir.path());
		writer.appendMessage(userTurn("continuation wrote last"));
		await writer.close();
		expect(writer.getSessionFile()).toBe(continuation);

		const manager = await createSessionManager(resumeArgs(original), tempDir.path(), stubSettings);
		try {
			expect(manager?.getSessionFile()).toBe(original);
		} finally {
			await manager?.close();
		}
	}, 30_000);

	it("resumes the continuation when all it did after the move was a /clear", async () => {
		using tempDir = TempDir.createSync("@omp-resume-continuation-");
		const original = await createSession(tempDir);
		const holder = await Holder.resume(tempDir, original);
		let continuation: string;
		try {
			await holder.append("holder turn");
			await Bun.sleep(5);
			continuation = await continueElsewhere(original, tempDir.path(), manager => manager.appendResetBoundary());
			await Bun.sleep(5);
		} finally {
			await holder.exit();
		}

		const manager = await createSessionManager(resumeArgs(original), tempDir.path(), stubSettings);
		try {
			expect(manager?.getSessionFile()).toBe(continuation);
		} finally {
			await manager?.close();
		}
	}, 30_000);

	it("keeps the asked-for file when its own process ran /clear after the continuation", async () => {
		using tempDir = TempDir.createSync("@omp-resume-continuation-");
		const original = await createSession(tempDir);
		const holder = await Holder.resume(tempDir, original);
		try {
			await holder.append("holder turn");
			await Bun.sleep(5);
			await continueElsewhere(original, tempDir.path(), "continued turn");
			await Bun.sleep(5);
			expect(await holder.clear()).toBe(original);
		} finally {
			await holder.exit();
		}

		const manager = await createSessionManager(resumeArgs(original), tempDir.path(), stubSettings);
		try {
			expect(manager?.getSessionFile()).toBe(original);
		} finally {
			await manager?.close();
		}
	}, 30_000);

	it("stops at a middle copy whose own process went on after the next copy was made", async () => {
		using tempDir = TempDir.createSync("@omp-resume-continuation-");
		const original = await createSession(tempDir);
		const first = await Holder.resume(tempDir, original);
		let middle: string;
		try {
			await first.append("first holder turn");
			await Bun.sleep(5);
			middle = await continueElsewhere(original, tempDir.path(), "middle turn");
		} finally {
			await first.exit();
		}
		const second = await Holder.resume(tempDir, middle);
		let last: string;
		try {
			expect(await second.append("second holder turn")).toBe(middle);
			await Bun.sleep(5);
			last = await continueElsewhere(middle, tempDir.path(), "last turn");
			await Bun.sleep(5);
			expect(await second.append("second holder kept going")).toBe(middle);
			await Bun.sleep(5);
		} finally {
			await second.exit();
		}
		const writer = await open(last, tempDir.path());
		writer.appendMessage(userTurn("last copy wrote last"));
		await writer.close();
		expect(writer.getSessionFile()).toBe(last);

		const followed: SessionContinuation[] = [];
		const manager = await createSessionManager(resumeArgs(original), tempDir.path(), stubSettings, undefined, {
			onSessionContinuation: c => followed.push(c),
		});
		try {
			expect(manager?.getSessionFile()).toBe(middle);
			expect(followed.map(c => ({ to: c.session.path, copies: c.copies }))).toEqual([{ to: middle, copies: 2 }]);
		} finally {
			await manager?.close();
		}
	}, 30_000);

	it("follows the continuation of a session whose header outgrew the listing prefix", async () => {
		using tempDir = TempDir.createSync("@omp-resume-continuation-");
		const created = await createSession(tempDir);
		await inflateHeader(created);
		const { original, continuation } = await movedOffSession(tempDir, undefined, created);

		const manager = await createSessionManager(resumeArgs(original), tempDir.path(), stubSettings);
		try {
			expect(manager?.getSessionFile()).toBe(continuation);
		} finally {
			await manager?.close();
		}
	}, 30_000);

	it("does not follow a deliberate fork", async () => {
		using tempDir = TempDir.createSync("@omp-resume-continuation-");
		const original = await createSession(tempDir);
		const forker = await open(original, tempDir.path());
		const forked = await forker.fork();
		forker.appendMessage(userTurn("on the fork"));
		await forker.close();
		if (!forked) throw new Error("Expected a fork");
		expect(forked.newSessionFile).not.toBe(original);

		const manager = await createSessionManager(resumeArgs(original), tempDir.path(), stubSettings);
		try {
			expect(manager?.getSessionFile()).toBe(original);
		} finally {
			await manager?.close();
		}
	}, 30_000);

	for (const by of ["path", "id"]) {
		it(`follows the continuation when the asked-for file no longer reads as a session, resumed by ${by}`, async () => {
			using tempDir = TempDir.createSync("@omp-resume-continuation-");
			const { original, continuation } = await movedOffSession(tempDir);
			const sessionId = await readSessionHeaderId(original);
			if (!sessionId) throw new Error("Expected a session id");
			// Conflict recovery leaves a file that no longer reads as its session as it found it.
			await Bun.write(original, "not a session journal\n");

			const followed: SessionContinuation[] = [];
			const args = by === "id" ? resumeArgs(sessionId, tempDir.path()) : resumeArgs(original);
			const manager = await createSessionManager(args, tempDir.path(), stubSettings, undefined, {
				onSessionContinuation: c => followed.push(c),
			});
			try {
				expect(manager?.getSessionFile()).toBe(continuation);
				expect(followed.map(c => ({ from: c.from, to: c.session.path, copies: c.copies }))).toEqual([
					{ from: original, to: continuation, copies: 2 },
				]);
			} finally {
				await manager?.close();
			}
		}, 30_000);
	}

	it("follows the continuation of the id a replaced file is named for, and resumes that file by path as what it holds", async () => {
		using tempDir = TempDir.createSync("@omp-resume-continuation-");
		const { original, continuation } = await movedOffSession(tempDir);
		const sessionId = await readSessionHeaderId(original);
		if (!sessionId) throw new Error("Expected a session id");
		// Another session's journal now sits at the original's path.
		using otherDir = TempDir.createSync("@omp-resume-continuation-other-");
		const other = await createSession(otherDir);
		await Bun.write(original, await Bun.file(other).text());
		const otherId = await readSessionHeaderId(original);
		expect(otherId).not.toBe(sessionId);

		const byId = await createSessionManager(resumeArgs(sessionId, tempDir.path()), tempDir.path(), stubSettings);
		try {
			expect(byId?.getSessionFile()).toBe(continuation);
		} finally {
			await byId?.close();
		}
		const byPath = await createSessionManager(resumeArgs(original), tempDir.path(), stubSettings);
		try {
			expect(byPath?.getSessionFile()).toBe(original);
			expect(byPath?.getSessionId()).toBe(otherId);
		} finally {
			await byPath?.close();
		}
	}, 30_000);

	it("continues an original with a name of its own when it has the newest turn and its continuation was written last", async () => {
		using tempDir = TempDir.createSync("@omp-resume-continuation-");
		// A session resumed by path keeps writing a file of any name.
		const named = tempDir.join("current.jsonl");
		await fs.rename(await createSession(tempDir), named);
		const { original } = await divergedWithContinuationWrittenLast(tempDir, named);
		await fs.rm(getTerminalSessionsDir(), { recursive: true, force: true });

		const manager = await createSessionManager(continueArgs(tempDir.path()), tempDir.path(), stubSettings);
		try {
			expect(manager?.getSessionFile()).toBe(original);
		} finally {
			await manager?.close();
		}
		const switchedTo: string[] = [];
		await openRpcSession(rpcHost(switchedTo), tempDir.path());
		expect(switchedTo).toEqual([original]);
	}, 30_000);

	it("opens the continuation from SessionManager.continueRecent itself, for SDK callers", async () => {
		using tempDir = TempDir.createSync("@omp-resume-continuation-");
		const { original, continuation } = await movedOffSession(tempDir);

		const followed: SessionContinuation[] = [];
		const manager = await SessionManager.continueRecent(tempDir.path(), tempDir.path(), undefined, {
			onSessionContinuation: c => followed.push(c),
		});
		try {
			expect(manager.getSessionFile()).toBe(continuation);
			expect(followed.map(c => ({ from: c.from, to: c.session.path }))).toEqual([
				{ from: original, to: continuation },
			]);
		} finally {
			await manager.close();
		}
	}, 30_000);
});
