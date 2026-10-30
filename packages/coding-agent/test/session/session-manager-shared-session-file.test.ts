import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ArtifactProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/artifact-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { registerArtifactsDir } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentOutputManager } from "@oh-my-pi/pi-coding-agent/task/output-manager";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { findSessionContinuation } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadEntriesFromFile, readSessionHeaderId } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import {
	type ResumedSessionFork,
	SessionManager,
	type SessionPersistenceNotice,
	SessionSourceReplacedError,
} from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	adoptResumedSession,
	lastSessionTransfer,
	markSessionMoved,
	noteResumedSessionFork,
	SESSION_TRANSFER_MESSAGE_TYPE,
	type SessionTransferDetails,
} from "@oh-my-pi/pi-coding-agent/session/session-transfer";
import { TempDir } from "@oh-my-pi/pi-utils";

const SESSION_MANAGER_MODULE = path.join(import.meta.dir, "../../src/session/session-manager.ts");
const SESSION_TRANSFER_MODULE = path.join(import.meta.dir, "../../src/session/session-transfer.ts");

/** What the other process reports after each command. */
interface OtherProcessState {
	sessionFile: string;
	sessionId: string;
	transfer: SessionTransferDetails | undefined;
	notices: SessionPersistenceNotice[];
	errors: string[];
}

/**
 * A second omp-like process that resumes `sessionFile` (which writes nothing)
 * and then runs one command per line: `append <text>`, `rewrite`, or `close`.
 *
 * `resume` opens the file the way an inspector does; `adopt` goes through the
 * startup resume guard, as `omp --resume` does, and stops before its first
 * write so a second resume can reach the same file while it sits there.
 */
class OtherProcess {
	readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly #stdout: { read(): Promise<{ done: boolean; value?: Uint8Array }> };
	#buffered = "";

	private constructor(child: Bun.Subprocess<"pipe", "pipe", "pipe">) {
		this.#child = child;
		this.#stdout = child.stdout.getReader();
	}

	static async resume(
		tempDir: TempDir,
		sessionFile: string,
	): Promise<{ other: OtherProcess; opened: OtherProcessState }> {
		return OtherProcess.#start(tempDir, sessionFile, false);
	}

	static async adopt(
		tempDir: TempDir,
		sessionFile: string,
	): Promise<{ other: OtherProcess; opened: OtherProcessState }> {
		return OtherProcess.#start(tempDir, sessionFile, true);
	}

	static async #start(
		tempDir: TempDir,
		sessionFile: string,
		throughResumeGuard: boolean,
	): Promise<{ other: OtherProcess; opened: OtherProcessState }> {
		const script = tempDir.join(throughResumeGuard ? "adopting-process.ts" : "other-process.ts");
		await Bun.write(
			script,
			[
				`import { SessionManager } from ${JSON.stringify(SESSION_MANAGER_MODULE)};`,
				`import { adoptResumedSession, lastSessionTransfer } from ${JSON.stringify(SESSION_TRANSFER_MODULE)};`,
				"const opened = await SessionManager.open(process.argv[2], undefined, undefined, { suppressBreadcrumb: true });",
				throughResumeGuard
					? "const manager = await adoptResumedSession(opened, process.argv[3]);"
					: "const manager = opened;",
				"const notices = [];",
				"const errors = [];",
				"manager.onPersistenceNotice(notice => notices.push(notice));",
				"manager.onPersistenceError(error => errors.push(error.message));",
				"const report = () => process.stdout.write(JSON.stringify({",
				"	sessionFile: manager.getSessionFile(),",
				"	sessionId: manager.getSessionId(),",
				"	transfer: lastSessionTransfer(manager.getEntries()),",
				"	notices,",
				"	errors,",
				'}) + "\\n");',
				"report();",
				"for await (const line of console) {",
				'	if (line === "close") break;',
				'	if (line.startsWith("append ")) {',
				'		manager.appendMessage({ role: "user", content: line.slice("append ".length), timestamp: Date.now() });',
				"		await manager.flush();",
				'	} else if (line === "rewrite") {',
				"		await manager.rewriteEntries();",
				"	}",
				"	report();",
				"}",
				"await manager.close();",
			].join("\n"),
		);
		const other = new OtherProcess(
			// The live `process.env` (Bun.spawn defaults to the launch env), so the
			// other process meets this test's private session-owner leases.
			Bun.spawn([process.execPath, script, sessionFile, path.dirname(sessionFile)], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: process.env,
			}),
		);
		return { other, opened: await other.#nextState() };
	}

	async #nextState(): Promise<OtherProcessState> {
		let newline = this.#buffered.indexOf("\n");
		while (newline === -1) {
			const { done, value } = await this.#stdout.read();
			if (done) throw new Error(`The other process exited early: ${await new Response(this.#child.stderr).text()}`);
			this.#buffered += new TextDecoder().decode(value);
			newline = this.#buffered.indexOf("\n");
		}
		const line = this.#buffered.slice(0, newline);
		this.#buffered = this.#buffered.slice(newline + 1);
		return JSON.parse(line) as OtherProcessState;
	}

	async run(command: string): Promise<OtherProcessState> {
		this.#child.stdin.write(`${command}\n`);
		this.#child.stdin.flush();
		return this.#nextState();
	}

	async close(): Promise<void> {
		this.#child.stdin.write("close\n");
		this.#child.stdin.end();
		await this.#child.exited;
	}

	/** A crash, not a clean close: the dead process never releases its claim itself. */
	async kill(): Promise<void> {
		this.#child.kill("SIGKILL");
		await this.#child.exited;
	}
}

function userTurn(content: string) {
	return { role: "user" as const, content, timestamp: Date.now() };
}

async function userTurnsIn(sessionFile: string, sessionDir: string): Promise<unknown[]> {
	const reader = await SessionManager.open(sessionFile, sessionDir, new FileSessionStorage(), {
		suppressBreadcrumb: true,
	});
	return reader
		.getEntries()
		.flatMap(entry => (entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : []));
}

/** The `session` header `sessionFile` records, as written. */
async function sessionHeaderIn(sessionFile: string): Promise<SessionHeader> {
	const entries = await loadEntriesFromFile(sessionFile, new FileSessionStorage(), { throwIfMissing: true });
	const header = entries.find(entry => entry.type === "session");
	if (!header) throw new Error(`No session header in ${sessionFile}`);
	return header;
}

/** Resume `sessionFile` here, append one turn, and report where it saved and what it was told. */
async function resumeAndAppend(
	sessionFile: string,
	sessionDir: string,
): Promise<{ savedTo: string | undefined; notices: SessionPersistenceNotice[] }> {
	const manager = await SessionManager.open(sessionFile, sessionDir, new FileSessionStorage(), {
		suppressBreadcrumb: true,
	});
	const notices: SessionPersistenceNotice[] = [];
	manager.onPersistenceNotice(notice => notices.push(notice));
	manager.appendMessage(userTurn("resumed here"));
	await manager.close();
	return { savedTo: manager.getSessionFile(), notices };
}

async function createSession(tempDir: TempDir, firstTurn = "before"): Promise<string> {
	const creator = SessionManager.create(tempDir.path(), tempDir.path(), new FileSessionStorage());
	await creator.ensureOnDisk();
	creator.appendMessage(userTurn(firstTurn));
	const sessionFile = creator.getSessionFile();
	if (!sessionFile) throw new Error("Expected session file");
	await creator.close();
	return sessionFile;
}

function sessionFilesIn(dir: string): string[] {
	return fs
		.readdirSync(dir)
		.filter(name => name.endsWith(".jsonl"))
		.map(name => path.join(dir, name))
		.sort();
}

/** Add a turn that refers to `artifact://<id>`, so the transcript has spent that identifier. */
async function appendTurnReferringToArtifact(sessionFile: string, dir: TempDir, id: number): Promise<void> {
	await appendTurnReferringTo(sessionFile, dir, `artifact://${id}`);
}

/** Add a turn citing `reference`, so the transcript has spent whatever it names. */
async function appendTurnReferringTo(sessionFile: string, dir: TempDir, reference: string): Promise<void> {
	const writer = await SessionManager.open(sessionFile, dir.path(), new FileSessionStorage(), {
		suppressBreadcrumb: true,
	});
	writer.appendMessage(userTurn(`see ${reference}`));
	await writer.close();
}

/**
 * A real {@link AgentSession} over a session this process owns, as a resume
 * leaves it: written once, so the ownership claim is held.
 */
async function liveSession(
	dir: TempDir,
	firstTurn: string,
	settings?: Record<string, unknown>,
): Promise<{
	sessionManager: SessionManager;
	session: AgentSession;
	sessionFile: string;
	sessionId: string;
	[Symbol.asyncDispose](): Promise<void>;
}> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected the bundled anthropic model");
	const sessionManager = SessionManager.create(dir.path(), dir.path(), new FileSessionStorage());
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false, ...settings }),
		modelRegistry: new ModelRegistry(authStorage),
		allowSessionModelFallback: true,
	});
	await sessionManager.ensureOnDisk();
	sessionManager.appendMessage(userTurn(firstTurn));
	// The write is what takes this process's claim on the session.
	await sessionManager.flush();
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a session file");
	return {
		sessionManager,
		session,
		sessionFile,
		sessionId: sessionManager.getSessionId(),
		async [Symbol.asyncDispose]() {
			await session.dispose();
			authStorage.close();
		},
	};
}

describe("SessionManager on a session file another omp process writes", () => {
	it("keeps the file with the process that wrote it first and moves the other to one sibling", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const original = await createSession(tempDir);

		const owner = await SessionManager.open(original, tempDir.path(), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		const ownerNotices: SessionPersistenceNotice[] = [];
		const ownerErrors: Error[] = [];
		owner.onPersistenceNotice(notice => ownerNotices.push(notice));
		owner.onPersistenceError(error => ownerErrors.push(error));
		owner.appendMessage(userTurn("owner 1"));

		const { other } = await OtherProcess.resume(tempDir, original);
		let otherState: OtherProcessState;
		try {
			// Both append and both rewrite, interleaved.
			otherState = await other.run("append other 1");
			owner.appendMessage(userTurn("owner 2"));
			otherState = await other.run("rewrite");
			await owner.rewriteEntries();
			otherState = await other.run("append other 2");
			await owner.flush();
		} finally {
			await other.close();
		}

		const sibling = otherState.sessionFile;
		expect(owner.getSessionFile()).toBe(original);
		expect(path.dirname(sibling)).toBe(path.dirname(original));
		expect(sessionFilesIn(tempDir.path())).toEqual([original, sibling].sort());
		expect(otherState.notices.map(notice => ({ reason: notice.reason, from: notice.from, to: notice.to }))).toEqual([
			{ reason: "open-elsewhere", from: original, to: sibling },
		]);
		expect(otherState.errors).toEqual([]);
		expect(ownerNotices).toEqual([]);
		expect(ownerErrors).toEqual([]);
		await owner.close();

		// Neither process's entries leak into the other's file.
		expect(await userTurnsIn(original, tempDir.path())).toEqual(["before", "owner 1", "owner 2"]);
		expect(await userTurnsIn(sibling, tempDir.path())).toEqual(["before", "owner 1", "other 1", "other 2"]);
	}, 30_000);

	it("does not count a process that only opened the session as its owner", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const original = await createSession(tempDir);

		// `omp share`, `--export`, and `render` open a session the same way and never write it.
		const { other: inspector } = await OtherProcess.resume(tempDir, original);
		try {
			expect(await resumeAndAppend(original, tempDir.path())).toEqual({ savedTo: original, notices: [] });
		} finally {
			await inspector.close();
		}
	}, 30_000);

	it("hands the file to the next writer once its owner crashed", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const original = await createSession(tempDir);

		const { other } = await OtherProcess.resume(tempDir, original);
		await other.run("append other 1");
		await other.kill();

		expect(await resumeAndAppend(original, tempDir.path())).toEqual({ savedTo: original, notices: [] });
	}, 30_000);

	for (const [kind, link] of [
		["symlink", fs.symlinkSync],
		["hard link", fs.linkSync],
	] as const) {
		it(`keeps the file with its owner when another process resumes it through a ${kind}`, async () => {
			using tempDir = TempDir.createSync("@omp-shared-session-file-");
			const original = await createSession(tempDir);

			const { other } = await OtherProcess.resume(tempDir, original);
			try {
				await other.run("append other 1");
				const alias = path.join(tempDir.path(), "alias.jsonl");
				link(original, alias);
				const { savedTo, notices } = await resumeAndAppend(alias, tempDir.path());
				if (!savedTo) throw new Error("Expected the resumed session to save somewhere");
				expect(notices.map(notice => ({ reason: notice.reason, from: notice.from, to: notice.to }))).toEqual([
					{ reason: "open-elsewhere", from: alias, to: savedTo },
				]);
				expect(await userTurnsIn(savedTo, tempDir.path())).toContain("resumed here");
			} finally {
				await other.close();
			}
			// The owner's journal holds only the owner's turns.
			expect(await userTurnsIn(original, tempDir.path())).toEqual(["before", "other 1"]);
		}, 30_000);
	}

	it("carries the owner's artifacts to the sibling of a session resumed through a symlink", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const original = await createSession(tempDir);
		// Artifacts live beside the journal's real name.
		const artifactsDir = original.slice(0, -".jsonl".length);
		fs.mkdirSync(artifactsDir, { recursive: true });
		fs.writeFileSync(path.join(artifactsDir, "1.bash.log"), "tool output");

		const { other } = await OtherProcess.resume(tempDir, original);
		try {
			await other.run("append other 1");
			const alias = path.join(tempDir.path(), "alias.jsonl");
			fs.symlinkSync(original, alias);
			const { savedTo } = await resumeAndAppend(alias, tempDir.path());
			if (!savedTo) throw new Error("Expected the resumed session to save somewhere");
			const copied = path.join(savedTo.slice(0, -".jsonl".length), "1.bash.log");
			expect(fs.readFileSync(copied, "utf8")).toBe("tool output");
		} finally {
			await other.close();
		}
	}, 30_000);

	for (const [destination, prepare, refusal] of [
		["a copy of this session", (source: string, target: string) => fs.copyFileSync(source, target), /writes it\./],
		[
			"another session under the same name",
			(_source: string, target: string, other: string) => fs.renameSync(other, target),
			/writes the session there/,
		],
	] as const) {
		it(`refuses to move a session onto ${destination} that another process writes, moving nothing`, async () => {
			using tempDir = TempDir.createSync("@omp-shared-session-file-");
			const srcDir = path.join(tempDir.path(), "src");
			const dstDir = path.join(tempDir.path(), "dst");
			fs.mkdirSync(srcDir);
			fs.mkdirSync(dstDir);
			const source = await createSession(tempDir);
			const movedSource = path.join(srcDir, path.basename(source));
			fs.renameSync(source, movedSource);
			const target = path.join(dstDir, path.basename(source));
			prepare(movedSource, target, await createSession(tempDir));

			const { other } = await OtherProcess.resume(tempDir, target);
			try {
				await other.run("append theirs");
				const targetBefore = fs.readFileSync(target, "utf8");
				const sourceBefore = fs.readFileSync(movedSource, "utf8");

				const ours = await SessionManager.open(movedSource, srcDir, new FileSessionStorage(), {
					suppressBreadcrumb: true,
				});
				await expect(ours.moveTo(tempDir.path(), dstDir)).rejects.toThrow(refusal);
				expect(ours.getSessionFile()).toBe(movedSource);
				await ours.close();

				expect(fs.readFileSync(target, "utf8")).toBe(targetBefore);
				expect(fs.readFileSync(movedSource, "utf8")).toBe(sourceBefore);
			} finally {
				await other.close();
			}
		}, 30_000);
	}

	it("moves over a destination nobody writes and leaves that session's lease free", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const srcDir = path.join(tempDir.path(), "src");
		const dstDir = path.join(tempDir.path(), "dst");
		fs.mkdirSync(srcDir);
		fs.mkdirSync(dstDir);
		const source = await createSession(tempDir);
		const movedSource = path.join(srcDir, path.basename(source));
		fs.renameSync(source, movedSource);
		const target = path.join(dstDir, path.basename(source));
		fs.renameSync(await createSession(tempDir), target);
		const replacedId = await readSessionHeaderId(target);
		if (!replacedId) throw new Error("Expected a session header at the destination");

		const ours = await SessionManager.open(movedSource, srcDir, new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		await ours.moveTo(tempDir.path(), dstDir);
		expect(ours.getSessionFile()).toBe(target);
		expect(await readSessionHeaderId(target)).toBe(ours.getSessionId());
		await ours.close();
		// The destination's lease was held only while the move ran.
		const probe = tryAcquireSessionLease(replacedId);
		probe?.release();
		expect(probe).not.toBeNull();
	}, 30_000);

	it("refuses to change the cwd of a session another process writes, even when the file stays put", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const original = await createSession(tempDir);
		const { other } = await OtherProcess.resume(tempDir, original);
		try {
			await other.run("append theirs");
			const before = fs.readFileSync(original, "utf8");
			const ours = await SessionManager.open(original, tempDir.path(), new FileSessionStorage(), {
				suppressBreadcrumb: true,
			});
			// Same session dir, new cwd: the file does not move, but its header would be rewritten.
			await expect(ours.moveTo(path.join(tempDir.path(), "elsewhere"), tempDir.path())).rejects.toThrow(
				/writes it\./,
			);
			await ours.close();
			expect(fs.readFileSync(original, "utf8")).toBe(before);
		} finally {
			await other.close();
		}
	}, 30_000);

	it("refuses to move a source path that another live session replaced since this manager opened it", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const dstDir = path.join(tempDir.path(), "dst");
		fs.mkdirSync(dstDir);
		const original = await createSession(tempDir);
		const ours = await SessionManager.open(original, tempDir.path(), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		// Another session takes over the path, and another process writes it.
		fs.renameSync(await createSession(tempDir), original);
		const { other } = await OtherProcess.resume(tempDir, original);
		try {
			await other.run("append theirs");
			const before = fs.readFileSync(original, "utf8");
			await expect(ours.moveTo(tempDir.path(), dstDir)).rejects.toThrow(/holds a different session/);
			expect(fs.readFileSync(original, "utf8")).toBe(before);
			expect(fs.readdirSync(dstDir)).toEqual([]);
		} finally {
			await ours.close();
			await other.close();
		}
	}, 30_000);

	it("does not append into another session that was moved onto the path after this manager opened it", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const original = await createSession(tempDir);
		// Opened, not yet written: this manager holds no lease.
		const ours = await SessionManager.open(original, tempDir.path(), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		const notices: SessionPersistenceNotice[] = [];
		ours.onPersistenceNotice(notice => notices.push(notice));
		// Another session takes over the path; another process writes it.
		fs.renameSync(await createSession(tempDir), original);
		const { other } = await OtherProcess.resume(tempDir, original);
		try {
			await other.run("append theirs");
			ours.appendMessage(userTurn("ours"));
			await ours.flush();
			expect(notices.map(n => n.reason)).toEqual(["open-elsewhere"]);
			expect(await userTurnsIn(original, tempDir.path())).not.toContain("ours");
		} finally {
			await ours.close();
			await other.close();
		}
	}, 30_000);

	it("resumes a session its owner still holds as a fork, not under the owner's id", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const original = await createSession(tempDir);
		const originalId = await readSessionHeaderId(original);
		if (!originalId) throw new Error("Expected a session header");

		const { other: owner } = await OtherProcess.resume(tempDir, original);
		try {
			// The first write is what takes ownership of the session.
			await owner.run("append owner 1");

			const resumed = await adoptResumedSession(
				await SessionManager.open(original, tempDir.path(), new FileSessionStorage(), {
					suppressBreadcrumb: true,
				}),
				tempDir.path(),
			);
			const fork = resumed.getSessionFile();
			if (!fork) throw new Error("Expected the resumed session to have a file");
			try {
				// A copy from the start: the owner's id is never this process's id,
				// not even for the window before it writes.
				expect(resumed.getSessionId()).not.toBe(originalId);
				expect(fork).not.toBe(original);
				expect(await userTurnsIn(fork, tempDir.path())).toEqual(["before", "owner 1"]);
				expect(lastSessionTransfer(resumed.getEntries())).toEqual({
					kind: "owned-elsewhere",
					source: original,
					sessionId: originalId,
				});

				const header = await sessionHeaderIn(fork);
				expect(header.parentSession).toBe(originalId);
				// Not a continuation of the owner: it is still running under that id,
				// so a resume of its file must land on it and not follow this copy.
				expect(header.continuationOf).toBeUndefined();
				expect(await findSessionContinuation(original)).toBeUndefined();

				resumed.appendMessage(userTurn("resumed here"));
				await resumed.flush();
			} finally {
				await resumed.close();
			}
			// The owner keeps its id, its file, and everything in it.
			expect(await readSessionHeaderId(original)).toBe(originalId);
			expect(await userTurnsIn(original, tempDir.path())).toEqual(["before", "owner 1"]);
		} finally {
			await owner.close();
		}
	}, 30_000);

	it("forks in place when a running session resumes a file its owner still holds", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const original = await createSession(tempDir);
		const originalId = await readSessionHeaderId(original);
		if (!originalId) throw new Error("Expected a session header");

		const { other: owner } = await OtherProcess.resume(tempDir, original);
		try {
			await owner.run("append owner 1");

			// `/resume` inside a live session: one manager, a different file.
			const resuming = SessionManager.create(tempDir.path(), tempDir.path(), new FileSessionStorage());
			await resuming.ensureOnDisk();
			const { forkedFrom } = await resuming.setSessionFile(original, { forkIfContested: true });
			const fork = resuming.getSessionFile();
			if (!fork) throw new Error("Expected the resumed session to have a file");
			try {
				expect(forkedFrom).toEqual({ reason: "owned-elsewhere", sessionId: originalId, sessionFile: original });
				expect(resuming.getSessionId()).not.toBe(originalId);
				expect(fork).not.toBe(original);
				resuming.appendMessage(userTurn("resumed here"));
				await resuming.flush();
				const header = await sessionHeaderIn(fork);
				expect(header.parentSession).toBe(originalId);
				expect(header.continuationOf).toBeUndefined();
				expect(await userTurnsIn(fork, tempDir.path())).toEqual(["before", "owner 1", "resumed here"]);
			} finally {
				await resuming.close();
			}
			expect(await userTurnsIn(original, tempDir.path())).toEqual(["before", "owner 1"]);
		} finally {
			await owner.close();
		}
	}, 30_000);

	it("tells the agent about artifacts an in-session resume lost, as a startup resume does", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const original = await createSession(tempDir);
		const originalId = await readSessionHeaderId(original);
		if (!originalId) throw new Error("Expected a session header");
		const replacement = await createSession(tempDir, "someone else's conversation");
		const artifacts = original.slice(0, -".jsonl".length);
		fs.mkdirSync(artifacts, { recursive: true });
		fs.writeFileSync(path.join(artifacts, "0.bash.log"), "this session's artifact");
		// The transcript refers to the artifact, which is what makes its
		// identifier one this conversation has already spent.
		await appendTurnReferringToArtifact(original, tempDir, 0);

		const { other: owner } = await OtherProcess.adopt(tempDir, original);
		try {
			const resuming = SessionManager.create(tempDir.path(), tempDir.path(), new FileSessionStorage());
			await resuming.ensureOnDisk();
			// The journal is taken over while the fork's artifacts are copied,
			// exactly as in the startup case — and this caller has to say so too.
			const realpath = fs.promises.realpath;
			const raceOnRealpath = (async (target: fs.PathLike) => {
				if (target === original) fs.renameSync(replacement, original);
				return realpath(target);
			}) as typeof fs.promises.realpath;
			const spy = spyOn(fs.promises, "realpath").mockImplementation(raceOnRealpath);
			let forkedFrom: ResumedSessionFork | undefined;
			try {
				({ forkedFrom } = await resuming.setSessionFile(original, { forkIfContested: true }));
			} finally {
				spy.mockRestore();
			}
			if (!forkedFrom) throw new Error("Expected the in-session resume to fork");
			await noteResumedSessionFork(resuming, forkedFrom);
			try {
				expect(await resuming.artifactsReproduced()).toBe(false);
				await resuming.flush();
				expect(lastSessionTransfer(resuming.getEntries())).toEqual({
					kind: "artifacts-missing",
					source: original,
					sessionId: originalId,
					reservedThroughId: 0,
					sourceChanged: true,
				});
			} finally {
				await resuming.close();
			}
		} finally {
			await owner.close();
		}
	}, 30_000);

	/** A fork whose inherited artifacts were lost to a takeover during the copy. */
	async function forkThatLostItsArtifacts(
		tempDir: TempDir,
		ids: readonly number[],
		outputNames: readonly string[] = [],
	): Promise<{ resumed: SessionManager; requested: string }> {
		const requested = await createSession(tempDir);
		await markSessionMoved(requested, "another-machine");
		const replacement = await createSession(tempDir, "someone else's conversation");
		const artifacts = requested.slice(0, -".jsonl".length);
		fs.mkdirSync(artifacts, { recursive: true });
		for (const id of ids) {
			fs.writeFileSync(path.join(artifacts, `${id}.bash.log`), `artifact ${id}`);
			await appendTurnReferringToArtifact(requested, tempDir, id);
		}
		for (const name of outputNames) {
			fs.writeFileSync(path.join(artifacts, `${name}.jsonl`), "{}\n");
			await appendTurnReferringTo(requested, tempDir, `agent://${name}`);
		}
		const manager = await SessionManager.open(requested, tempDir.path(), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		const realpath = fs.promises.realpath;
		const raceOnRealpath = (async (target: fs.PathLike) => {
			if (target === requested) fs.renameSync(replacement, requested);
			return realpath(target);
		}) as typeof fs.promises.realpath;
		const spy = spyOn(fs.promises, "realpath").mockImplementation(raceOnRealpath);
		try {
			const resumed = await adoptResumedSession(manager, tempDir.path());
			expect(await resumed.artifactsReproduced()).toBe(false);
			return { resumed, requested };
		} finally {
			spy.mockRestore();
		}
	}

	it("keeps reserving the identifiers it lost after the session is closed and reopened", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const { resumed } = await forkThatLostItsArtifacts(tempDir, [0, 7]);
		const forkFile = resumed.getSessionFile();
		if (!forkFile) throw new Error("Expected a fork session file");
		expect(resumed.reservedArtifactId()).toBe(7);
		await resumed.close();

		// A later process reads the promise out of the header rather than
		// starting over at zero and answering for `artifact://0` with new output.
		const reopened = await SessionManager.open(forkFile, tempDir.path(), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		try {
			expect(reopened.reservedArtifactId()).toBe(7);
			const allocated = await reopened.allocateArtifactPath("read");
			expect(Number(allocated.id)).toBeGreaterThan(7);
		} finally {
			await reopened.close();
		}
	}, 30_000);

	it("carries what a lost fork reserved into an ordinary fork of it, and drops it for a new session", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const { resumed } = await forkThatLostItsArtifacts(tempDir, [0, 7], ["Worker"]);
		const forkFile = resumed.getSessionFile();
		if (!forkFile) throw new Error("Expected a fork session file");
		expect(resumed.reservedArtifactId()).toBe(7);
		expect(resumed.reservedOutputNames()).toContain("Worker");
		await resumed.close();

		// `/fork` of a session that lost its artifacts inherits its transcript,
		// so it inherits the claims that transcript has already spent.
		const forked = await SessionManager.forkFrom(forkFile, tempDir.path(), tempDir.path(), new FileSessionStorage());
		try {
			expect(forked.reservedArtifactId()).toBe(7);
			expect(forked.reservedOutputNames()).toContain("Worker");
			const allocated = await forked.allocateArtifactPath("read");
			expect(Number(allocated.id)).toBeGreaterThan(7);
			// A session started from nothing inherits no transcript and no claim.
			await forked.newSession();
			expect(forked.reservedArtifactId()).toBeUndefined();
			expect(forked.reservedOutputNames()).toEqual([]);
			expect((await forked.allocateArtifactPath("read")).id).toBe("0");
		} finally {
			await forked.close();
		}
	}, 30_000);

	it("does not let a subagent take an inherited name whose file never arrived", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const { resumed } = await forkThatLostItsArtifacts(tempDir, [0], ["Worker"]);
		try {
			// The allocator holds only a directory: the name it must not take is
			// one whose file is missing, so no scan of what is there can find it.
			const outputs = new AgentOutputManager(() => resumed.getArtifactsDir());
			expect(await outputs.allocate("Worker")).not.toBe("Worker");
		} finally {
			await resumed.close();
		}
	}, 30_000);

	it("tells the model it is talking to that the artifacts are missing, not only the journal", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const { resumed } = await forkThatLostItsArtifacts(tempDir, [0]);
		const authStorage = await AuthStorage.create(":memory:");
		try {
			authStorage.keys.setRuntime("anthropic", "test-key");
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected the bundled anthropic model");
			const session = new AgentSession({
				agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager: resumed,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: new ModelRegistry(authStorage),
			});
			try {
				// The copy has already settled, so the notice is one microtask
				// behind the constructor.
				await resumed.artifactsReproduced();
				await Promise.resolve();
				const live = session.agent.state.messages.filter(
					message => message.role === "custom" && message.customType === SESSION_TRANSFER_MESSAGE_TYPE,
				);
				expect(JSON.stringify(live)).toContain("did not reach this fork");
			} finally {
				await session.dispose();
			}
		} finally {
			authStorage.close();
		}
	}, 30_000);

	it("never answers a public artifact read with another session's bytes while a copy is pending", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const original = await createSession(tempDir);
		const artifacts = original.slice(0, -".jsonl".length);
		fs.mkdirSync(artifacts, { recursive: true });
		fs.writeFileSync(path.join(artifacts, "0.bash.log"), "ORIGINAL");
		await appendTurnReferringToArtifact(original, tempDir, 0);
		// A live, unrelated session holding its own artifact with the same id.
		const unrelated = path.join(tempDir.path(), "unrelated-artifacts");
		fs.mkdirSync(unrelated, { recursive: true });
		fs.writeFileSync(path.join(unrelated, "0.read.log"), "UNRELATED ACTIVE SESSION");
		const unregister = registerArtifactsDir(unrelated);

		const { other: owner } = await OtherProcess.adopt(tempDir, original);
		try {
			const resumed = await adoptResumedSession(
				await SessionManager.open(original, tempDir.path(), new FileSessionStorage(), {
					suppressBreadcrumb: true,
				}),
				tempDir.path(),
			);
			try {
				const handler = new ArtifactProtocolHandler();
				const url = parseInternalUrl("artifact://0");
				// The read waits for this session's own copy — as the artifact
				// manager always has — and then answers with its own artifact.
				const resource = await handler.resolve(url, {
					localProtocolOptions: {
						getArtifactsDir: () => resumed.getArtifactsDir(),
						getSessionId: () => resumed.getSessionId(),
					},
				});
				expect(resource.content).toBe("ORIGINAL");
			} finally {
				await resumed.close();
			}
		} finally {
			unregister();
			await owner.close();
		}
	}, 30_000);

	it("does not let a subagent take an output name the inherited transcript already uses", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const original = await createSession(tempDir);
		const artifacts = original.slice(0, -".jsonl".length);
		fs.mkdirSync(artifacts, { recursive: true });
		fs.writeFileSync(path.join(artifacts, "Worker.md"), "the inherited worker's result");

		const { other: owner } = await OtherProcess.adopt(tempDir, original);
		try {
			const resumed = await adoptResumedSession(
				await SessionManager.open(original, tempDir.path(), new FileSessionStorage(), {
					suppressBreadcrumb: true,
				}),
				tempDir.path(),
			);
			try {
				const outputs = new AgentOutputManager(() => resumed.getArtifactsDir());
				// Allocated while the copy is still arriving: seeding from an
				// empty directory would hand out `Worker` again, and the copy
				// leaves a name the destination already has alone — so the
				// inherited result would be the one lost.
				const id = await outputs.allocate("Worker");
				expect(id).not.toBe("Worker");
				expect(fs.readFileSync(path.join(resumed.getArtifactsDir() as string, "Worker.md"), "utf8")).toBe(
					"the inherited worker's result",
				);
			} finally {
				await resumed.close();
			}
		} finally {
			await owner.close();
		}
	}, 30_000);

	it("returns from a resume without waiting for the artifacts to be copied", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const original = await createSession(tempDir);
		const artifacts = original.slice(0, -".jsonl".length);
		fs.mkdirSync(artifacts, { recursive: true });
		fs.writeFileSync(path.join(artifacts, "0.bash.log"), "a big one, in spirit");

		const { other: owner } = await OtherProcess.adopt(tempDir, original);
		const copyReachedStaging = Promise.withResolvers<void>();
		const letTheCopyFinish = Promise.withResolvers<void>();
		// Held open in the staging tree: the copy cannot finish until this test
		// says so, so a resume that waits for it cannot return at all.
		const open = fs.promises.open;
		const holdTheCopy = (async (target: fs.PathLike, flags?: string | number) => {
			if (String(target).includes(".staging")) {
				copyReachedStaging.resolve();
				await letTheCopyFinish.promise;
			}
			return open(target, flags as string);
		}) as typeof fs.promises.open;
		const spy = spyOn(fs.promises, "open").mockImplementation(holdTheCopy);
		try {
			const resumed = await adoptResumedSession(
				await SessionManager.open(original, tempDir.path(), new FileSessionStorage(), {
					suppressBreadcrumb: true,
				}),
				tempDir.path(),
			);
			const fork = resumed.getSessionFile();
			if (!fork) throw new Error("Expected the resumed session to have a file");
			// The resume is done and the fork is usable while the copy is still
			// blocked: nothing of the artifacts has been published yet.
			await copyReachedStaging.promise;
			expect(fs.existsSync(path.join(fork.slice(0, -".jsonl".length), "0.bash.log"))).toBe(false);
			letTheCopyFinish.resolve();
			expect(await resumed.artifactsReproduced()).toBe(true);
			expect(fs.readFileSync(path.join(fork.slice(0, -".jsonl".length), "0.bash.log"), "utf8")).toBe(
				"a big one, in spirit",
			);
			await resumed.close();
		} finally {
			letTheCopyFinish.resolve();
			spy.mockRestore();
			await owner.close();
		}
	}, 30_000);

	it("gives the session to the process that resumed it first, before either has written", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const original = await createSession(tempDir);
		const originalId = await readSessionHeaderId(original);
		if (!originalId) throw new Error("Expected a session header");

		// Both resume the same idle session and stop before their first write:
		// the window in which a lease that is probed and dropped again tells
		// each of them that nobody owns this session.
		const { other: first, opened: firstResume } = await OtherProcess.adopt(tempDir, original);
		const { other: second, opened: secondResume } = await OtherProcess.adopt(tempDir, original);
		let firstWrote: OtherProcessState;
		let secondWrote: OtherProcessState;
		try {
			expect(firstResume.sessionId).toBe(originalId);
			expect(firstResume.sessionFile).toBe(original);
			// The second one loses at the resume, not at its first write: a
			// different id, a file of its own, and it was told why.
			expect(secondResume.sessionId).not.toBe(originalId);
			expect(secondResume.sessionFile).not.toBe(original);
			expect(secondResume.transfer).toEqual({
				kind: "owned-elsewhere",
				source: original,
				sessionId: originalId,
			});
			firstWrote = await first.run("append first");
			secondWrote = await second.run("append second");
		} finally {
			await first.close();
			await second.close();
		}
		expect(firstWrote.sessionFile).toBe(original);
		expect(secondWrote.sessionFile).toBe(secondResume.sessionFile);
		// The second process never had to move off the shared file, so nothing
		// records the still-live first process as a session that was continued.
		expect(secondWrote.notices).toEqual([]);
		expect(await findSessionContinuation(original)).toBeUndefined();
		expect(await userTurnsIn(original, tempDir.path())).toEqual(["before", "first"]);
		expect(await userTurnsIn(secondWrote.sessionFile, tempDir.path())).toEqual(["before", "second"]);
	}, 30_000);

	it("does not take a session from its next owner just because something read it", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const original = await createSession(tempDir);
		const originalId = await readSessionHeaderId(original);
		if (!originalId) throw new Error("Expected a session header");

		// What `omp sessions`, `--export` and `render` do: open the session and
		// read it, without resuming it. Held open across the resume below.
		const reader = await SessionManager.open(original, tempDir.path(), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		try {
			expect(await userTurnsIn(original, tempDir.path())).toEqual(["before"]);
			const { other, opened } = await OtherProcess.adopt(tempDir, original);
			try {
				expect(opened.sessionId).toBe(originalId);
				expect(opened.sessionFile).toBe(original);
				expect(opened.transfer).toBeUndefined();
			} finally {
				await other.close();
			}
		} finally {
			await reader.close();
		}
	}, 30_000);

	it("refuses the resume, and inherits nothing, when another session took over the file", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const requested = await createSession(tempDir);
		const requestedId = await readSessionHeaderId(requested);
		const replacement = await createSession(tempDir, "someone else's conversation");
		const replacementId = await readSessionHeaderId(replacement);
		if (!requestedId || !replacementId) throw new Error("Expected session headers");
		// The artifacts beside the path belong to whatever holds it now.
		const artifacts = requested.slice(0, -".jsonl".length);
		fs.mkdirSync(artifacts, { recursive: true });
		fs.writeFileSync(path.join(artifacts, "1.bash.log"), "someone else's artifact");

		const manager = await SessionManager.open(requested, tempDir.path(), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		// Between the load and the resume guard another session takes the path
		// (`omp session unpack`, a gc rewrite, a restored backup).
		fs.renameSync(replacement, requested);
		const before = sessionFilesIn(tempDir.path());

		// Nothing about the loaded transcript can still be attributed to it: a
		// fork would carry files that belong to another conversation under
		// `artifact://` ids this one already refers to.
		await expect(adoptResumedSession(manager, tempDir.path())).rejects.toThrow(SessionSourceReplacedError);
		await expect(adoptResumedSession(manager, tempDir.path())).rejects.toThrow(
			new RegExp(`${requestedId}[\\s\\S]*${replacementId}`),
		);

		await manager.close();
		// Nothing was written: no fork, and the journal that holds the path kept
		// its session, its content, and its artifacts.
		expect(sessionFilesIn(tempDir.path())).toEqual(before);
		expect(await readSessionHeaderId(requested)).toBe(replacementId);
		expect(await userTurnsIn(requested, tempDir.path())).toEqual(["someone else's conversation"]);
		expect(fs.readFileSync(path.join(artifacts, "1.bash.log"), "utf8")).toBe("someone else's artifact");
	}, 30_000);

	it("refuses, and copies nothing, when the file is taken over while the claim is being taken", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const requested = await createSession(tempDir);
		const requestedId = await readSessionHeaderId(requested);
		const replacement = await createSession(tempDir, "someone else's conversation");
		const replacementId = await readSessionHeaderId(replacement);
		if (!requestedId || !replacementId) throw new Error("Expected session headers");
		const artifacts = requested.slice(0, -".jsonl".length);
		fs.mkdirSync(artifacts, { recursive: true });
		fs.writeFileSync(path.join(artifacts, "1.bash.log"), "someone else's artifact");

		/** Replaces the journal in the window the storage itself reads it in. */
		class ReplacingStorage extends FileSessionStorage {
			#armed = true;

			override claimSession(sessionId: string, sessionPath: string): (() => void) | null {
				if (this.#armed) {
					this.#armed = false;
					fs.renameSync(replacement, requested);
				}
				return super.claimSession(sessionId, sessionPath);
			}
		}
		const manager = await SessionManager.open(requested, tempDir.path(), new ReplacingStorage(), {
			suppressBreadcrumb: true,
		});
		const before = sessionFilesIn(tempDir.path());

		// The claim is refused because the path holds another session now, not
		// because a live process owns this one — and only one of those two is a
		// session whose artifacts this resume may take.
		await expect(adoptResumedSession(manager, tempDir.path())).rejects.toThrow(SessionSourceReplacedError);

		await manager.close();
		// No fork was written; the replacement's own path is gone because it was
		// renamed onto this one.
		expect(sessionFilesIn(tempDir.path()).filter(file => !before.includes(file))).toEqual([]);
		expect(fs.readFileSync(path.join(artifacts, "1.bash.log"), "utf8")).toBe("someone else's artifact");
	}, 30_000);

	it("inherits nothing, and says so, when the file is taken over while the artifacts are copied", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const requested = await createSession(tempDir);
		const requestedId = await readSessionHeaderId(requested);
		if (!requestedId) throw new Error("Expected a session header");
		// A stale copy: the resume guard forks it whoever holds the lease, so
		// this is the path that reaches the artifact copy without a claim.
		await markSessionMoved(requested, "another-machine");
		const replacement = await createSession(tempDir, "someone else's conversation");
		const artifacts = requested.slice(0, -".jsonl".length);
		fs.mkdirSync(artifacts, { recursive: true });
		fs.writeFileSync(path.join(artifacts, "1.bash.log"), "this session's artifact");
		await appendTurnReferringToArtifact(requested, tempDir, 1);

		const manager = await SessionManager.open(requested, tempDir.path(), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		// The journal is taken over while the copy of its artifacts is running.
		// The copy is already under way by then, so the resume cannot be refused
		// any more: what it must not do is keep the files.
		const realpath = fs.promises.realpath;
		// `realpath` is overloaded on its encoding option; this stands in for the
		// one call shape the copy uses.
		const raceOnRealpath = (async (target: fs.PathLike) => {
			if (target === requested) {
				fs.renameSync(replacement, requested);
				fs.writeFileSync(path.join(artifacts, "1.bash.log"), "someone else's artifact");
			}
			return realpath(target);
		}) as typeof fs.promises.realpath;
		const spy = spyOn(fs.promises, "realpath").mockImplementation(raceOnRealpath);
		let resumed: SessionManager;
		try {
			resumed = await adoptResumedSession(manager, tempDir.path());
		} finally {
			spy.mockRestore();
		}
		const fork = resumed.getSessionFile();
		if (!fork) throw new Error("Expected the resumed session to have a file");
		expect(await resumed.artifactsReproduced()).toBe(false);
		// Nothing of the replacement's is in the fork: the only thing in its
		// artifacts directory is this session's own record of what it may not
		// hand out again. The transcript says the artifacts are missing rather
		// than leaving the agent to find out.
		expect(fs.readdirSync(fork.slice(0, -".jsonl".length))).toEqual([".omp-reserved"]);
		expect(lastSessionTransfer(resumed.getEntries())).toEqual({
			kind: "artifacts-missing",
			source: requested,
			sessionId: requestedId,
			reservedThroughId: 1,
			sourceChanged: true,
		});
		// The identifier the lost artifact carried is never handed out again, so
		// a reference this transcript already makes cannot come to mean new output.
		const allocated = await resumed.allocateArtifactPath("read");
		expect(Number(allocated.id)).toBeGreaterThan(1);
		await resumed.close();
	}, 30_000);

	it("refuses a departed copy whose file another session took over, instead of resuming that one", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const requested = await createSession(tempDir);
		const requestedId = await readSessionHeaderId(requested);
		if (!requestedId) throw new Error("Expected a session header");
		// This copy was handed to another machine: the stale-copy guard runs
		// first, and it used to fork by re-reading the path.
		await markSessionMoved(requested, "another-machine");
		const replacement = await createSession(tempDir, "someone else's conversation");
		const replacementId = await readSessionHeaderId(replacement);
		if (!replacementId) throw new Error("Expected a session header");

		const manager = await SessionManager.open(requested, tempDir.path(), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		fs.renameSync(replacement, requested);
		const before = sessionFilesIn(tempDir.path());

		await expect(adoptResumedSession(manager, tempDir.path())).rejects.toThrow(SessionSourceReplacedError);

		await manager.close();
		expect(sessionFilesIn(tempDir.path())).toEqual(before);
		expect(await userTurnsIn(requested, tempDir.path())).toEqual(["someone else's conversation"]);
	}, 30_000);

	it("tells the model the outcome of a tool the session it forked from may still be running", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const original = await createSession(tempDir);
		// A turn that ends in a tool call with no result: the owner is running it.
		const writer = await SessionManager.open(original, tempDir.path(), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		writer.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "deploy.sh" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		await writer.close();

		// The owner resumes it and holds it; the tool call is still unresolved.
		const { other: owner } = await OtherProcess.adopt(tempDir, original);
		try {
			const resumed = await adoptResumedSession(
				await SessionManager.open(original, tempDir.path(), new FileSessionStorage(), {
					suppressBreadcrumb: true,
				}),
				tempDir.path(),
			);
			try {
				const results = resumed
					.getEntries()
					.flatMap(entry =>
						entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
					);
				// Without this the dangling call is stripped from the model's
				// context and the fork may run a side-effecting tool a second time.
				expect(results).toHaveLength(1);
				expect(results[0]?.toolCallId).toBe("call-1");
				expect(JSON.stringify(results[0]?.content)).toContain("may still be running this tool");
			} finally {
				await resumed.close();
			}
		} finally {
			await owner.close();
		}
	}, 30_000);

	it("keeps the session it lives in when a switch to another one is cancelled", async () => {
		using sourceDir = TempDir.createSync("@omp-switch-ownership-source-");
		using targetDir = TempDir.createSync("@omp-switch-ownership-target-");
		const authStorage = await AuthStorage.create(":memory:");
		try {
			authStorage.keys.setRuntime("anthropic", "test-key");
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected the bundled anthropic model");
			const sessionManager = SessionManager.create(sourceDir.path(), sourceDir.path(), new FileSessionStorage());
			const session = new AgentSession({
				agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: new ModelRegistry(authStorage),
			});
			try {
				await sessionManager.ensureOnDisk();
				sessionManager.appendMessage(userTurn("source"));
				// The write is what takes this process's claim on the source.
				await sessionManager.flush();
				const sourceFile = sessionManager.getSessionFile();
				const sourceId = sessionManager.getSessionId();
				if (!sourceFile) throw new Error("Expected a source session file");
				const target = await createSession(targetDir, "target");
				const targetId = await readSessionHeaderId(target);
				if (!targetId) throw new Error("Expected a target session header");

				// `/resume` into another project, with the working-directory
				// change refused: the switch rolls all the way back.
				expect(await session.switchSession(target, { onCwdChange: async () => false })).toBe(false);
				expect(sessionManager.getSessionFile()).toBe(sourceFile);
				expect(sessionManager.getSessionId()).toBe(sourceId);

				// Ownership rolled back with it: a second live process resuming
				// the source still has to fork, instead of answering to the id
				// this session is still living under.
				const { other, opened } = await OtherProcess.adopt(sourceDir, sourceFile);
				try {
					expect(opened.sessionId).not.toBe(sourceId);
					expect(opened.sessionFile).not.toBe(sourceFile);
				} finally {
					await other.close();
				}
				// And the target this session never entered is free for its own.
				const targetLease = tryAcquireSessionLease(targetId);
				expect(targetLease).not.toBeNull();
				targetLease?.release();
			} finally {
				await session.dispose();
			}
		} finally {
			authStorage.close();
		}
	}, 30_000);

	it("keeps the session it lives in when a switch started inside another one is cancelled", async () => {
		using sourceDir = TempDir.createSync("@omp-switch-overlap-source-");
		using middleDir = TempDir.createSync("@omp-switch-overlap-middle-");
		using targetDir = TempDir.createSync("@omp-switch-overlap-target-");
		await using live = await liveSession(sourceDir, "source");
		const { sessionManager, session, sessionFile: sourceFile, sessionId: sourceId } = live;
		const middle = await createSession(middleDir, "middle");
		const target = await createSession(targetDir, "target");

		const reachedCwdPrompt = Promise.withResolvers<void>();
		const answerCwdPrompt = Promise.withResolvers<boolean>();
		// The outer switch stops at its working-directory prompt, after it has
		// taken the middle session.
		const outer = session.switchSession(middle, {
			onCwdChange: async () => {
				reachedCwdPrompt.resolve();
				return answerCwdPrompt.promise;
			},
		});
		try {
			await reachedCwdPrompt.promise;
			// A second switch runs to completion inside the first one's window.
			expect(await session.switchSession(target, { onCwdChange: async () => false })).toBe(false);
			// The inner switch must not have ended the outer one's hold on the
			// session this process is still living in.
			const duringLease = tryAcquireSessionLease(sourceId);
			expect(duringLease).toBeNull();
			duringLease?.release();
		} finally {
			answerCwdPrompt.resolve(false);
		}
		expect(await outer).toBe(false);
		expect(sessionManager.getSessionId()).toBe(sourceId);

		const { other, opened } = await OtherProcess.adopt(sourceDir, sourceFile);
		try {
			expect(opened.sessionId).not.toBe(sourceId);
		} finally {
			await other.close();
		}
	}, 30_000);

	it("does not answer for a session a close gave up, even when a switch then rolls back", async () => {
		using sourceDir = TempDir.createSync("@omp-switch-close-source-");
		using targetDir = TempDir.createSync("@omp-switch-close-target-");
		await using live = await liveSession(sourceDir, "source");
		const { sessionManager, session, sessionFile: sourceFile, sessionId: sourceId } = live;
		const target = await createSession(targetDir, "target");

		const reachedCwdPrompt = Promise.withResolvers<void>();
		const answerCwdPrompt = Promise.withResolvers<boolean>();
		const switching = session.switchSession(target, {
			onCwdChange: async () => {
				reachedCwdPrompt.resolve();
				return answerCwdPrompt.promise;
			},
		});
		await reachedCwdPrompt.promise;
		// The manager is closed mid-switch: every claim it held is given back,
		// including the one the switch's snapshot kept.
		await sessionManager.close();
		answerCwdPrompt.resolve(false);
		expect(await switching).toBe(false);

		// Another process takes the source, as it may: this one gave it up.
		const { other, opened } = await OtherProcess.adopt(sourceDir, sourceFile);
		try {
			expect(opened.sessionId).toBe(sourceId);
			expect(opened.sessionFile).toBe(sourceFile);
			// The rolled-back manager must not mistake its released claim for
			// ownership and append into the file the other process now owns.
			sessionManager.appendMessage(userTurn("after close and rollback"));
			await sessionManager.flush();
			expect(sessionManager.getSessionFile()).not.toBe(sourceFile);
			expect(sessionManager.getSessionId()).not.toBe(sourceId);
			expect(await userTurnsIn(sourceFile, sourceDir.path())).not.toContain("after close and rollback");
		} finally {
			await other.close();
		}
	}, 30_000);

	it("keeps the session it lives in when a host callback throws after the switch is otherwise done", async () => {
		using sourceDir = TempDir.createSync("@omp-switch-callback-source-");
		using targetDir = TempDir.createSync("@omp-switch-callback-target-");
		await using live = await liveSession(sourceDir, "source", { "retry.modelFallback": true });
		const { sessionManager, session, sessionFile: sourceFile, sessionId: sourceId } = live;
		// A target whose saved model is gone, so the switch ends in a fallback
		// the host is told about — and this host throws from that callback.
		const targetManager = SessionManager.create(targetDir.path(), targetDir.path(), new FileSessionStorage());
		await targetManager.ensureOnDisk();
		targetManager.appendMessage(userTurn("target"));
		targetManager.appendModelChange("nonexistent-provider/nonexistent-model");
		const target = targetManager.getSessionFile();
		if (!target) throw new Error("Expected a target session file");
		await targetManager.close();

		await expect(
			session.switchSession(target, {
				onCwdChange: async () => true,
				onModelFallback: () => {
					throw new Error("host fallback callback failed");
				},
			}),
		).rejects.toThrow("host fallback callback failed");
		expect(sessionManager.getSessionId()).toBe(sourceId);

		// The switch rolled back, so this process still lives in the source and
		// still owns it: a failure after ownership was given up would leave the
		// restored session free for anyone.
		const { other, opened } = await OtherProcess.adopt(sourceDir, sourceFile);
		try {
			expect(opened.sessionId).not.toBe(sourceId);
		} finally {
			await other.close();
		}
	}, 30_000);

	it("holds no ownership of a session a switch failed before it even started", async () => {
		using sourceDir = TempDir.createSync("@omp-switch-prepare-source-");
		using targetDir = TempDir.createSync("@omp-switch-prepare-target-");
		await using live = await liveSession(sourceDir, "source");
		const { sessionManager, session, sessionFile: sourceFile, sessionId: sourceId } = live;
		const target = await createSession(targetDir, "target");

		// A failure while the switch is still preparing, before the transaction
		// that commits or rolls it back begins.
		const prepare = spyOn(sessionManager, "getTaskSiblingCandidate").mockImplementation(() => {
			throw new Error("switch preparation failed");
		});
		try {
			await expect(session.switchSession(target)).rejects.toThrow("switch preparation failed");
		} finally {
			prepare.mockRestore();
		}

		// Nothing of that attempt is left holding the source: once the session
		// switches away for real, the next process that resumes the source gets
		// it, rather than finding it reserved for the rest of this one's life.
		expect(await session.switchSession(target, { onCwdChange: async () => true })).toBe(true);
		const { other, opened } = await OtherProcess.adopt(sourceDir, sourceFile);
		try {
			expect(opened.sessionId).toBe(sourceId);
			expect(opened.sessionFile).toBe(sourceFile);
		} finally {
			await other.close();
		}
	}, 30_000);
});
