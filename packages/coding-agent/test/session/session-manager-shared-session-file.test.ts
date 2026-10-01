import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager, type SessionPersistenceNotice } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const SESSION_MANAGER_MODULE = path.join(import.meta.dir, "../../src/session/session-manager.ts");

/** What the other process reports after each command. */
interface OtherProcessState {
	sessionFile: string;
	notices: SessionPersistenceNotice[];
	errors: string[];
}

/**
 * A second omp-like process that resumes `sessionFile` (which writes nothing)
 * and then runs one command per line: `append <text>`, `rewrite`, or `close`.
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
		const script = tempDir.join("other-process.ts");
		await Bun.write(
			script,
			[
				`import { SessionManager } from ${JSON.stringify(SESSION_MANAGER_MODULE)};`,
				"const manager = await SessionManager.open(process.argv[2], undefined, undefined, { suppressBreadcrumb: true });",
				"const notices = [];",
				"const errors = [];",
				"manager.onPersistenceNotice(notice => notices.push(notice));",
				"manager.onPersistenceError(error => errors.push(error.message));",
				'const report = () => process.stdout.write(JSON.stringify({ sessionFile: manager.getSessionFile(), notices, errors }) + "\\n");',
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
			Bun.spawn([process.execPath, script, sessionFile], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
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

async function createSession(tempDir: TempDir): Promise<string> {
	const creator = SessionManager.create(tempDir.path(), tempDir.path(), new FileSessionStorage());
	await creator.ensureOnDisk();
	creator.appendMessage(userTurn("before"));
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
		expect(otherState.notices).toEqual([{ reason: "open-elsewhere", from: original, to: sibling }]);
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
});
