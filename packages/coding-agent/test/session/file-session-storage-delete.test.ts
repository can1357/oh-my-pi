import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as mailbox from "@oh-my-pi/pi-coding-agent/messaging/mailbox";
import * as transport from "@oh-my-pi/pi-coding-agent/messaging/transport";

describe("FileSessionStorage.deleteSessionWithArtifacts", () => {
	let tmpRoot = "";

	afterEach(async () => {
		vi.restoreAllMocks();
		if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
		tmpRoot = "";
	});

	it("removes stale .bak siblings so the picker cannot resurrect the session (issue #11499)", async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-delete-bak-"));
		const sessionPath = path.join(tmpRoot, "2026-09-21T00-00-00-000Z_abc123.jsonl");
		await Bun.write(sessionPath, '{"type":"session"}\n');
		const ownBak = `${sessionPath}.999.bak`;
		const otherBak = path.join(tmpRoot, "other.jsonl.111.bak");
		await Bun.write(ownBak, "stale backup");
		await Bun.write(otherBak, "unrelated backup");

		const storage = new FileSessionStorage();
		await storage.deleteSessionWithArtifacts(sessionPath);

		expect(await Bun.file(sessionPath).exists()).toBe(false);
		expect(await Bun.file(ownBak).exists()).toBe(false);
		expect(await Bun.file(otherBak).exists()).toBe(true);
	});
});

it("retires mail only after successful transcript deletion, including guarded deletion", async () => {
	const temp = TempDir.createSync("@omp-delete-mail-");
	try {
		vi.spyOn(transport, "messagingRegistryDir").mockReturnValue(path.join(temp.path(), "messaging"));
		const storage = new FileSessionStorage();
		const sessionId = "full-header-identity";
		const file = path.join(temp.path(), "unrelated-filename.jsonl");
		await Bun.write(file, JSON.stringify({ type: "session", id: sessionId }) + "\n");
		await mailbox.enqueueOffline(sessionId, {
			id: "delete-mail",
			from: {
				sessionId: "sender",
				name: "sender",
				shortId: "12345678",
				cwd: temp.path(),
				entryId: "sender-entry",
				class: "bypass",
			},
			body: "delete with owner",
			chain: [],
			sentAt: Date.now(),
			sessionFile: file,
		});
		expect(await storage.deleteSessionWithArtifactsIf(file, () => false)).toBe(false);
		expect(await mailbox.drainOffline(sessionId)).toHaveLength(1);
		expect(await storage.deleteSessionWithArtifactsIf(file, () => true)).toBe(true);
		expect(await mailbox.drainOffline(sessionId)).toEqual([]);
		await Bun.write(file, JSON.stringify({ type: "session", id: sessionId }) + "\n");
		await mailbox.enqueueOffline(sessionId, {
			id: "delete-again",
			from: {
				sessionId: "sender",
				name: "sender",
				shortId: "12345678",
				cwd: temp.path(),
				entryId: "sender-entry",
				class: "bypass",
			},
			body: "delete normally",
			chain: [],
			sentAt: Date.now(),
			sessionFile: file,
		});
		await storage.deleteSessionWithArtifacts(file);
		expect(await mailbox.drainOffline(sessionId)).toEqual([]);
	} finally {
		vi.restoreAllMocks();
		temp[Symbol.dispose]();
	}
});

it("retires mail after unlink even when conditional artifact cleanup fails", async () => {
	const temp = TempDir.createSync("@omp-delete-mail-error-");
	try {
		vi.spyOn(transport, "messagingRegistryDir").mockReturnValue(path.join(temp.path(), "messaging"));
		const file = path.join(temp.path(), "owner.jsonl");
		await Bun.write(file, '{"type":"session","id":"artifact-failure-owner"}\n');
		await mailbox.enqueueOffline("artifact-failure-owner", {
			id: "retire-despite-artifacts",
			from: {
				sessionId: "sender",
				name: "sender",
				shortId: "12345678",
				cwd: temp.path(),
				entryId: "sender-entry",
				class: "bypass",
			},
			body: "retire",
			chain: [],
			sentAt: Date.now(),
			sessionFile: file,
		});
		const storage = new FileSessionStorage();
		const rm = nodeFs.rmSync;
		vi.spyOn(nodeFs, "rmSync").mockImplementation((target, options) => {
			if (String(target) === file.slice(0, -6)) throw new Error("artifact cleanup failed");
			return rm(target, options);
		});
		await expect(storage.deleteSessionWithArtifactsIf(file, () => true)).rejects.toThrow("artifact cleanup failed");
		expect(await Bun.file(file).exists()).toBe(false);
		expect(await mailbox.drainOffline("artifact-failure-owner")).toEqual([]);
	} finally {
		vi.restoreAllMocks();
		temp[Symbol.dispose]();
	}
});

it("does not create messaging directories while deleting a session that has no mailbox", async () => {
	const temp = TempDir.createSync("@omp-delete-no-mail-");
	try {
		const registry = path.join(temp.path(), "messaging");
		await fs.mkdir(registry, { mode: 0o700 });
		vi.spyOn(transport, "messagingRegistryDir").mockReturnValue(registry);
		const file = path.join(temp.path(), "owner.jsonl");
		await Bun.write(file, '{"type":"session","id":"never-had-mail"}\n');
		await new FileSessionStorage().deleteSessionWithArtifacts(file);
		expect(await fs.readdir(registry)).toEqual([]);
		expect(await fs.readdir(temp.path())).toEqual(["messaging"]);
	} finally {
		vi.restoreAllMocks();
		temp[Symbol.dispose]();
	}
});

it.each(["mail", "registry"] as const)(
	"cleans artifacts and own backups before surfacing a %s cleanup failure",
	async failureKind => {
		const temp = TempDir.createSync("@omp-delete-mail-failure-");
		try {
			vi.spyOn(transport, "messagingRegistryDir").mockReturnValue(path.join(temp.path(), "messaging"));
			const file = path.join(temp.path(), "owner.jsonl");
			await Bun.write(file, '{"type":"session","id":"cleanup-failure-owner"}\n');
			const artifacts = file.slice(0, -6);
			await fs.mkdir(artifacts);
			await Bun.write(path.join(artifacts, "tool.log"), "old artifact");
			const backup = `${file}.999.bak`;
			const unrelatedBackup = path.join(temp.path(), "unrelated.jsonl.999.bak");
			await Bun.write(backup, "old transcript");
			await Bun.write(unrelatedBackup, "keep");
			await mailbox.enqueueOffline("cleanup-failure-owner", {
				id: "mail",
				from: {
					sessionId: "sender",
					name: "sender",
					shortId: "12345678",
					cwd: temp.path(),
					entryId: "sender-entry",
					class: "bypass",
				},
				body: "mail",
				chain: [],
				sentAt: Date.now(),
				sessionFile: file,
			});
			const failure = new Error(`${failureKind} cleanup failed`);
			if (failureKind === "mail") vi.spyOn(mailbox, "retireOfflineMailbox").mockRejectedValueOnce(failure);
			else vi.spyOn(transport, "resolveRegistry").mockRejectedValueOnce(failure);
			await expect(new FileSessionStorage().deleteSessionWithArtifacts(file)).rejects.toThrow(failure.message);
			expect(await Bun.file(file).exists()).toBe(false);
			expect(await Bun.file(backup).exists()).toBe(false);
			await expect(fs.stat(artifacts)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await Bun.file(unrelatedBackup).text()).toBe("keep");
		} finally {
			vi.restoreAllMocks();
			temp[Symbol.dispose]();
		}
	},
);
