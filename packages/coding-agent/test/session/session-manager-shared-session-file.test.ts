import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager, type SessionPersistenceNotice } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const SESSION_MANAGER_MODULE = path.join(import.meta.dir, "../../src/session/session-manager.ts");

/**
 * Open `sessionFile` in another omp-like process and keep it open until stdin
 * closes. `write` appends a turn first, as a resumed session that is used does;
 * otherwise the process only reads it, as `omp share`/`--export` do.
 */
async function openInOtherProcess(
	tempDir: TempDir,
	sessionFile: string,
	mode: "read" | "write",
): Promise<Bun.Subprocess<"pipe", "pipe", "pipe">> {
	const script = tempDir.join("open-and-hold.ts");
	await Bun.write(
		script,
		[
			`import { SessionManager } from ${JSON.stringify(SESSION_MANAGER_MODULE)};`,
			"const manager = await SessionManager.open(process.argv[2], undefined, undefined, { suppressBreadcrumb: true });",
			'if (process.argv[3] === "write") manager.appendMessage({ role: "user", content: "other process turn", timestamp: Date.now() });',
			'process.stdout.write("ready\\n");',
			"await Bun.stdin.text();",
			"await manager.close();",
		].join("\n"),
	);
	const child = Bun.spawn([process.execPath, script, sessionFile, mode], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const reader = child.stdout.getReader();
	let output = "";
	while (!output.includes("ready\n")) {
		const { done, value } = await reader.read();
		if (done) throw new Error(`Other process exited early: ${await new Response(child.stderr).text()}`);
		output += new TextDecoder().decode(value);
	}
	reader.releaseLock();
	return child;
}

/** Resume `sessionFile` here and append a turn: the first write claims the session. */
async function noticesFromResumingAndWriting(
	sessionFile: string,
	sessionDir: string,
): Promise<SessionPersistenceNotice[]> {
	const manager = await SessionManager.open(sessionFile, sessionDir, new FileSessionStorage(), {
		suppressBreadcrumb: true,
	});
	const notices: SessionPersistenceNotice[] = [];
	manager.onPersistenceNotice(notice => notices.push(notice));
	manager.appendMessage({ role: "user", content: "this process turn", timestamp: Date.now() });
	await manager.close();
	return notices;
}

describe("SessionManager resume of a session open in another process", () => {
	it("warns only while another live process writes the session, not for a reader or a dead owner", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const creator = SessionManager.create(tempDir.path(), tempDir.path(), new FileSessionStorage());
		await creator.ensureOnDisk();
		const sessionFile = creator.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await creator.close();

		// A process that only reads the session never takes its lease.
		const reader = await openInOtherProcess(tempDir, sessionFile, "read");
		try {
			expect(await noticesFromResumingAndWriting(sessionFile, tempDir.path())).toEqual([]);
		} finally {
			reader.kill("SIGKILL");
			await reader.exited;
		}

		const writer = await openInOtherProcess(tempDir, sessionFile, "write");
		try {
			const notices = await noticesFromResumingAndWriting(sessionFile, tempDir.path());
			expect(notices.map(notice => notice.sessionFile)).toEqual([sessionFile]);
		} finally {
			// A crash, not a clean close: the dead owner never releases its claim itself.
			writer.kill("SIGKILL");
			await writer.exited;
		}

		expect(await noticesFromResumingAndWriting(sessionFile, tempDir.path())).toEqual([]);
	}, 30_000);
});
