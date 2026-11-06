import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runSessionGc } from "@oh-my-pi/pi-coding-agent/session/session-gc";

async function tempAgentDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "session-gc-"));
}

async function touchOld(target: string, days: number): Promise<void> {
	const atime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
	await fs.utimes(target, atime, atime);
}

describe("runSessionGc", () => {
	it("prunes session trees older than retention and keeps fresh ones", async () => {
		const agentDir = await tempAgentDir();
		try {
			const cwdDir = path.join(agentDir, "sessions", "-proj");
			const oldSession = path.join(cwdDir, "2026-01-01T00-00-00-000Z_old");
			const freshSession = path.join(cwdDir, "2026-11-06T00-00-00-000Z_fresh");
			await fs.mkdir(oldSession, { recursive: true });
			await fs.mkdir(freshSession, { recursive: true });
			await fs.writeFile(path.join(oldSession, "transcript.jsonl"), "[]");
			await fs.writeFile(path.join(freshSession, "transcript.jsonl"), "[]");
			await touchOld(path.join(oldSession, "transcript.jsonl"), 60);

			const result = await runSessionGc({ agentDir, retentionDays: 30 });
			expect(result.prunedSessions).toBe(1);
			await expect(fs.stat(oldSession)).rejects.toThrow();
			await fs.access(freshSession);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("prunes old custom-session files and keeps recent ones", async () => {
		const agentDir = await tempAgentDir();
		try {
			const customDir = path.join(agentDir, "custom-session-files");
			await fs.mkdir(customDir, { recursive: true });
			const oldFile = path.join(customDir, "oldhash");
			const freshFile = path.join(customDir, "freshhash");
			await fs.writeFile(oldFile, "old");
			await fs.writeFile(freshFile, "fresh");
			await touchOld(oldFile, 60);

			const result = await runSessionGc({ agentDir, retentionDays: 30 });
			expect(result.prunedCustomFiles).toBe(1);
			await expect(fs.access(oldFile)).rejects.toThrow();
			await fs.access(freshFile);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("keeps a session id listed in keepSessionIds even when old", async () => {
		const agentDir = await tempAgentDir();
		try {
			const cwdDir = path.join(agentDir, "sessions", "-proj");
			const pinned = path.join(cwdDir, "2026-01-01T00-00-00-000Z_pinned");
			await fs.mkdir(pinned, { recursive: true });
			await fs.writeFile(path.join(pinned, "transcript.jsonl"), "[]");
			await touchOld(path.join(pinned, "transcript.jsonl"), 60);

			const result = await runSessionGc({
				agentDir,
				retentionDays: 30,
				keepSessionIds: new Set(["2026-01-01T00-00-00-000Z_pinned"]),
			});
			expect(result.prunedSessions).toBe(0);
			await fs.access(pinned);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("retention 0 disables the GC", async () => {
		const agentDir = await tempAgentDir();
		try {
			const cwdDir = path.join(agentDir, "sessions", "-proj");
			const oldSession = path.join(cwdDir, "2026-01-01T00-00-00-000Z_old");
			await fs.mkdir(oldSession, { recursive: true });
			await fs.writeFile(path.join(oldSession, "t.jsonl"), "[]");
			await touchOld(path.join(oldSession, "t.jsonl"), 60);

			const result = await runSessionGc({ agentDir, retentionDays: 0 });
			expect(result.prunedSessions).toBe(0);
			await fs.access(oldSession);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
});
