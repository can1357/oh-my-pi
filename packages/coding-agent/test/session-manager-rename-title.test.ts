import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

function userTurn(content: string) {
	return { role: "user" as const, content, timestamp: Date.now() };
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

function sessionFiles(dir: string): string[] {
	return fs
		.readdirSync(dir)
		.filter(name => name.endsWith(".jsonl"))
		.sort();
}

async function reopen(sessionFile: string, tempDir: TempDir): Promise<SessionManager> {
	return SessionManager.open(sessionFile, tempDir.path(), new FileSessionStorage(), {
		suppressBreadcrumb: true,
	});
}

const SESSION_MANAGER_MODULE = path.join(import.meta.dir, "../src/session/session-manager.ts");

/**
 * Another live omp process: it opens the session, writes (claiming the
 * cross-process ownership lease), signals readiness, and holds the lease
 * until killed. Managers in one process share a lease per session, so only a
 * real second process contends.
 */
async function spawnHolder(
	tempDir: TempDir,
	sessionFile: string,
): Promise<{ holder: Bun.Subprocess<"pipe", "pipe", "pipe">; ready: Promise<void> }> {
	const script = tempDir.join("holder.ts");
	await Bun.write(
		script,
		[
			`import { SessionManager } from ${JSON.stringify(SESSION_MANAGER_MODULE)};`,
			"const manager = await SessionManager.open(process.argv[2], undefined, undefined, { suppressBreadcrumb: true });",
			'manager.appendMessage({ role: "user", content: "holder turn", timestamp: Date.now() });',
			"await manager.flush();",
			'process.stdout.write("ready\\n");',
			"for await (const _ of console) {}",
			"await manager.close();",
		].join("\n"),
	);
	const holder = Bun.spawn([process.execPath, script, sessionFile], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	const ready = (async () => {
		const reader = holder.stdout.getReader();
		let buffered = "";
		try {
			while (!buffered.includes("ready")) {
				const { done, value } = await reader.read();
				if (done) {
					const stderr = await new Response(holder.stderr).text();
					throw new Error(`Holder exited before signaling readiness: ${stderr}`);
				}
				buffered += new TextDecoder().decode(value);
			}
		} finally {
			reader.releaseLock();
		}
	})();
	return { holder, ready };
}

describe("SessionManager.renameSessionTitle", () => {
	it("sticks across a fresh open and appends a title_change entry", async () => {
		using tempDir = TempDir.createSync("@omp-rename-session-title-");
		const sessionFile = await createSession(tempDir);

		expect(await SessionManager.renameSessionTitle(sessionFile, "Renamed")).toBe("Renamed");

		const manager = await reopen(sessionFile, tempDir);
		try {
			expect(manager.getSessionName()).toBe("Renamed");
			const titles = manager.getEntries().filter(entry => entry.type === "title_change");
			expect(titles).toHaveLength(1);
			expect(titles[0]).toMatchObject({ title: "Renamed", source: "user" });
		} finally {
			await manager.close();
		}
		// Renamed in place: no sibling file.
		expect(sessionFiles(tempDir.path())).toHaveLength(1);
	});

	it("returns the title as stored, not the input", async () => {
		using tempDir = TempDir.createSync("@omp-rename-session-title-canonical-");
		const sessionFile = await createSession(tempDir);

		// The session collapses runs of whitespace, so the caller must learn
		// the stored title rather than assume its input was kept verbatim.
		expect(await SessionManager.renameSessionTitle(sessionFile, "Foo  Bar")).toBe("Foo Bar");

		const manager = await reopen(sessionFile, tempDir);
		try {
			expect(manager.getSessionName()).toBe("Foo Bar");
		} finally {
			await manager.close();
		}
	});

	it("a second manager holding the file blocks the rename", async () => {
		using tempDir = TempDir.createSync("@omp-rename-session-title-held-");
		const sessionFile = await createSession(tempDir);

		const { holder, ready } = await spawnHolder(tempDir, sessionFile);
		try {
			await ready;
			expect(await SessionManager.renameSessionTitle(sessionFile, "Blocked")).toBeNull();
		} finally {
			holder.kill("SIGKILL");
			await holder.exited;
		}

		// No sibling rename: the file still holds the holder's transcript with no title.
		expect(sessionFiles(tempDir.path())).toHaveLength(1);
		const reread = await reopen(sessionFile, tempDir);
		try {
			expect(reread.getSessionName()).toBeUndefined();
			expect(reread.getEntries().filter(entry => entry.type === "title_change")).toHaveLength(0);
			expect(
				reread
					.getEntries()
					.flatMap(entry =>
						entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
					),
			).toEqual(["before", "holder turn"]);
		} finally {
			await reread.close();
		}
	}, 30_000);
});
