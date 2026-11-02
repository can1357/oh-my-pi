import { afterEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./helpers";

const dirs: TempDir[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => dir.remove()));
});

class DeferredFileStorage extends FileSessionStorage {
	readonly defersSyncPublish = true;
}
function user(content: string) {
	return { role: "user" as const, content, timestamp: Date.now() };
}
function users(file: string): unknown[] {
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line))
		.filter(entry => entry.type === "message" && entry.message.role === "user")
		.map(entry => entry.message.content);
}
async function materialized(origin: "ensure" | "draft" | "open" = "ensure", storage = new FileSessionStorage()) {
	const dir = TempDir.createSync("@pi-materialization-readonly-");
	dirs.push(dir);
	let manager = SessionManager.create(dir.path(), path.join(dir.path(), "sessions"), storage);
	if (origin === "draft") await manager.saveDraft("in-progress user draft");
	else await manager.ensureOnDisk();
	manager.appendMessage(user("before"));
	const file = manager.getSessionFile()!;
	if (origin === "open") {
		await manager.close();
		manager.releaseRetainedEntries();
		manager = await SessionManager.open(file, undefined, storage);
	}
	return { manager, file, root: dir.path(), storage };
}
function appendWhileFull(manager: SessionManager, text: string): void {
	const full = spyOn(fs, "writeSync").mockImplementation(() => {
		throw Object.assign(new Error("ENOSPC: queued user-only session"), { code: "ENOSPC" });
	});
	try {
		manager.appendMessage(user(text));
	} finally {
		full.mockRestore();
	}
}

describe("materialization intent survives pending user-only state", () => {
	for (const origin of ["ensure", "draft", "open"] as const) {
		for (const state of ["clone", "rollback"] as const) {
			for (const finish of ["flush", "flushSync", "close"] as const) {
				it(`preserves ${origin} materialization through ${state} and ${finish} without an assistant`, async () => {
					const { manager, file } = await materialized(origin);
					appendWhileFull(manager, "queued-user-prompt");
					let target = manager;
					if (state === "clone") target = manager.cloneCurrentSession({ persist: true });
					else {
						const snapshot = manager.captureState();
						appendWhileFull(manager, "rolled-back");
						manager.restoreState(snapshot);
					}
					try {
						if (finish === "flushSync") target.flushSync();
						else await target[finish]();
						expect(users(file)).toEqual(["before", "queued-user-prompt"]);
						expect(
							target.getEntries().some(entry => entry.type === "message" && entry.message.role === "assistant"),
						).toBe(false);
					} finally {
						await target.close();
						target.releaseRetainedEntries();
						if (target !== manager) {
							await manager.close();
							manager.releaseRetainedEntries();
						}
					}
				});
			}
		}
	}
	it("does not materialize a deliberately nonpersistent clone", async () => {
		const { manager, file } = await materialized();
		appendWhileFull(manager, "queued-user-prompt");
		const before = fs.readFileSync(file, "utf8");
		const clone = manager.cloneCurrentSession({ persist: false });
		try {
			await clone.flush();
			await clone.close();
			expect(clone.getSessionFile()).toBeUndefined();
			expect(fs.readFileSync(file, "utf8")).toBe(before);
		} finally {
			clone.releaseRetainedEntries();
			await manager.close();
			manager.releaseRetainedEntries();
		}
	});
});

describe("read-only open and close never publish lazy repairs", () => {
	for (const backend of ["file", "deferred"] as const) {
		for (const repair of ["malformed", "migrated", "sanitized"] as const) {
			for (const owned of [false, true]) {
				for (const sealed of [false, true]) {
					it(`leaves ${repair} ${backend} bytes untouched with owner=${owned} sealed=${sealed}`, async () => {
						const storage = backend === "deferred" ? new DeferredFileStorage() : new FileSessionStorage();
						const { manager, file } = await materialized("ensure", storage);
						let assistantId: string | undefined;
						if (repair === "sanitized") {
							assistantId = manager.appendMessage({
								...makeAssistantMessage(),
								api: "openai-responses",
								provider: "github-copilot",
								model: "copilot-fixture",
								providerPayload: createOpenAIResponsesHistoryPayload("github-copilot", [
									{ type: "reasoning", encrypted_content: "stale-native-history" },
								]),
							});
						}
						const id = manager.getSessionId();
						await manager.close();
						manager.releaseRetainedEntries();
						if (repair === "malformed") fs.appendFileSync(file, '{"type":"message","torn":');
						if (repair === "migrated")
							fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"version":3', '"version":2'));
						const before = fs.readFileSync(file, "utf8");
						const files = fs.readdirSync(path.dirname(file)).sort();
						const owner = owned ? tryAcquireSessionLease(id) : undefined;
						if (owned && !owner) throw new Error("Expected another owner's lease");
						const writes = [
							spyOn(storage, "writeLinesSync"),
							spyOn(storage, "writeLinesAtomic"),
							spyOn(storage, "writeTextSync"),
							spyOn(storage, "writeTextAtomic"),
						] as unknown as Mock<(...args: never[]) => unknown>[];
						const claims = spyOn(storage, "claimSession");
						const renames = spyOn(storage, "rename");
						let reader: SessionManager | undefined;
						try {
							reader = await SessionManager.open(file, undefined, storage);
							expect(reader.captureState().needsRewrite).toBe(true);
							if (assistantId) {
								const entry = reader.getEntry(assistantId);
								if (entry?.type !== "message" || entry.message.role !== "assistant")
									throw new Error("Expected assistant");
								expect(entry.message.providerPayload).toBeUndefined();
							}
							if (sealed) reader.seal();
							await reader.close();
							expect(reader.getSessionFile()).toBe(file);
							expect(reader.getSessionId()).toBe(id);
							expect(fs.readFileSync(file, "utf8")).toBe(before);
							expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(files);
							for (const write of writes) expect(write).not.toHaveBeenCalled();
							expect(claims).not.toHaveBeenCalled();
							expect(renames).not.toHaveBeenCalled();
						} finally {
							for (const write of writes) write.mockRestore();
							claims.mockRestore();
							renames.mockRestore();
							await reader?.close().catch(() => {});
							reader?.releaseRetainedEntries();
							owner?.release();
						}
					});
				}
			}
		}
		for (const mutation of ["cache-key", "workspace"] as const) {
			it(`persists a caller's ${mutation} header mutation at sealed ${backend} shutdown`, async () => {
				const storage = backend === "deferred" ? new DeferredFileStorage() : new FileSessionStorage();
				const { manager, file, root } = await materialized("ensure", storage);
				const pending =
					mutation === "cache-key"
						? manager.setTaskPromptCacheKey("caller-key")
						: manager.addWorkspaceDirectory(path.join(root, "extra"));
				manager.seal();
				await pending;
				await manager.close();
				const header = fs
					.readFileSync(file, "utf8")
					.split("\n")
					.filter(Boolean)
					.map(line => JSON.parse(line))
					.find(entry => entry.type === "session");
				if (mutation === "cache-key") expect(header.taskPromptCacheKey).toBe("caller-key");
				else expect(header.additionalDirectories).toContain(path.join(root, "extra"));
				manager.releaseRetainedEntries();
			});
		}
	}
});
