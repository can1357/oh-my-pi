/**
 * `/tan` forks the session into a clone transcript, then registers the
 * background job. When the registration fails, the clone must not survive:
 * neither its transcript nor its local artifacts, nor the ownership lease its
 * manager took, which would otherwise mark the deleted session as owned by
 * this process until it exits. Under `session.storage: sql` the clone
 * transcript is a row; removing only filesystem paths leaves it in the store,
 * where the picker and `history://` still find it.
 */
import { SQL } from "bun";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import type { AsyncJobRegisterOptions } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TanCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/tan-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	defaultSessionStorage,
	FileSessionStorage,
	isSessionLeaseHeld,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const model = { provider: "anthropic", id: "claude-sonnet-4-5" } as Model;

describe("/tan clone cleanup storage", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	for (const kind of ["file", "sql"] as const) {
		it(`removes the clone transcript, its artifacts, and its lease from ${kind} storage when dispatch fails`, async () => {
			const previous = defaultSessionStorage();
			let storage: SessionStorage = new FileSessionStorage();
			let reopen = async (): Promise<SessionStorage> => new FileSessionStorage();
			if (kind === "sql") {
				const client = new SQL("sqlite::memory:");
				storage = await SqlSessionStorage.create({ client });
				reopen = () => SqlSessionStorage.create({ client });
				cleanups.push(() => client.end());
			}
			setDefaultSessionStorage(storage);
			cleanups.push(() => setDefaultSessionStorage(previous));
			const dir = TempDir.createSync("@omp-tan-cleanup-storage-");
			cleanups.push(() => dir.removeSync());
			const parentFile = dir.join("parent.jsonl");
			const parentArtifactsDir = parentFile.slice(0, -".jsonl".length);
			await storage.writeText(
				parentFile,
				`${[
					{
						type: "session",
						version: 3,
						id: "parent-session",
						timestamp: "2026-11-02T00:00:00.000Z",
						cwd: dir.path(),
					},
					{
						type: "message",
						id: "u1",
						parentId: null,
						timestamp: "2026-11-02T00:00:01.000Z",
						message: { role: "user", content: "parent turn", timestamp: 1 },
					},
				]
					.map(entry => JSON.stringify(entry))
					.join("\n")}\n`,
			);

			const realForkFrom = SessionManager.forkFrom.bind(SessionManager);
			let clone: SessionManager | undefined;
			vi.spyOn(SessionManager, "forkFrom").mockImplementation(async (...args) => {
				clone = await realForkFrom(...args);
				return clone;
			});
			let cloneFile: string | undefined;
			let cloneArtifact: string | undefined;
			let cloneStoredBeforeFailure = false;
			let cloneLeasedBeforeFailure = false;
			const register = vi.fn(
				(_type: string, _label: string, _run: unknown, options?: AsyncJobRegisterOptions): string => {
					const cloneId = options?.agentId;
					if (!cloneId) throw new Error("expected the clone's agent id");
					cloneFile = path.join(parentArtifactsDir, `${cloneId}.jsonl`);
					cloneStoredBeforeFailure = storage.existsSync(cloneFile);
					cloneLeasedBeforeFailure = clone !== undefined && isSessionLeaseHeld(clone.getSessionId()) === true;
					// A tool artifact of the clone: a local file in either storage mode.
					cloneArtifact = path.join(parentArtifactsDir, cloneId, "1.read.log");
					fs.mkdirSync(path.dirname(cloneArtifact), { recursive: true });
					fs.writeFileSync(cloneArtifact, "artifact");
					throw new Error("background job limit reached");
				},
			);
			const ctx = {
				session: {
					isStreaming: false,
					agent: { promptCacheKey: undefined },
					model,
					asyncJobManager: { register },
					sessionId: "parent-session",
					configuredThinkingLevel: () => undefined,
					systemPrompt: ["system prompt"],
					getActiveToolNames: () => ["read"],
					getEnabledToolNames: () => ["read"],
					getMountedXdevToolNames: () => [],
					modelRegistry: { authStorage: {} },
					getAgentId: () => undefined,
				},
				sessionManager: {
					getHeader: () => undefined,
					getStorage: () => storage,
					getSessionFile: () => parentFile,
					getCwd: () => dir.path(),
					getSessionDir: () => dir.path(),
					getArtifactsDir: () => parentArtifactsDir,
					getSessionId: () => "parent-session",
					ensureOnDisk: async () => {},
					flush: async () => {},
				},
				settings: Settings.isolated(),
				showStatus: vi.fn(),
				showWarning: vi.fn(),
				showError: vi.fn(),
				rebuildChatFromMessages: vi.fn(),
			} as unknown as InteractiveModeContext;

			expect(await new TanCommandController(ctx).start("follow the tangent")).toBe(false);

			expect(ctx.showError).toHaveBeenCalledWith("background job limit reached");
			if (!cloneFile || !cloneArtifact || !clone) throw new Error("dispatch never reached job registration");
			expect(cloneStoredBeforeFailure).toBe(true);
			// File storage leases a session its manager writes; SQL storage has no lease.
			expect(cloneLeasedBeforeFailure).toBe(kind === "file");
			expect(isSessionLeaseHeld(clone.getSessionId())).toBe(false);
			expect(await (await reopen()).exists(cloneFile)).toBe(false);
			expect(fs.existsSync(path.dirname(cloneArtifact))).toBe(false);
			// The parent session is untouched.
			expect(await storage.exists(parentFile)).toBe(true);
		});
	}

	it("still removes the clone's artifacts when the storage refuses to delete its transcript", async () => {
		const previous = defaultSessionStorage();
		const storage = new FileSessionStorage();
		setDefaultSessionStorage(storage);
		cleanups.push(() => setDefaultSessionStorage(previous));
		const dir = TempDir.createSync("@omp-tan-cleanup-refused-");
		cleanups.push(() => dir.removeSync());
		const parentFile = dir.join("parent.jsonl");
		const parentArtifactsDir = parentFile.slice(0, -".jsonl".length);
		await storage.writeText(
			parentFile,
			`${[
				{
					type: "session",
					version: 3,
					id: "parent-session",
					timestamp: "2026-11-02T00:00:00.000Z",
					cwd: dir.path(),
				},
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: "2026-11-02T00:00:01.000Z",
					message: { role: "user", content: "parent turn", timestamp: 1 },
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		// A transcript the store will not give up: not ENOENT, so the clone's
		// local artifacts are all the cleanup can still reclaim.
		const refused = Object.assign(new Error("EACCES: permission denied, unlink"), {
			code: "EACCES",
			syscall: "unlink",
		});
		const deleteSpy = vi
			.spyOn(storage, "deleteSessionWithArtifacts")
			.mockImplementation(() => Promise.reject(refused));

		const realForkFrom = SessionManager.forkFrom.bind(SessionManager);
		let clone: SessionManager | undefined;
		vi.spyOn(SessionManager, "forkFrom").mockImplementation(async (...args) => {
			clone = await realForkFrom(...args);
			return clone;
		});
		let cloneArtifact: string | undefined;
		const register = vi.fn(
			(_type: string, _label: string, _run: unknown, options?: AsyncJobRegisterOptions): string => {
				const cloneId = options?.agentId;
				if (!cloneId) throw new Error("expected the clone's agent id");
				cloneArtifact = path.join(parentArtifactsDir, cloneId, "1.read.log");
				fs.mkdirSync(path.dirname(cloneArtifact), { recursive: true });
				fs.writeFileSync(cloneArtifact, "artifact");
				throw new Error("background job limit reached");
			},
		);
		const ctx = {
			session: {
				isStreaming: false,
				agent: { promptCacheKey: undefined },
				model,
				asyncJobManager: { register },
				sessionId: "parent-session",
				configuredThinkingLevel: () => undefined,
				systemPrompt: ["system prompt"],
				getActiveToolNames: () => ["read"],
				getEnabledToolNames: () => ["read"],
				getMountedXdevToolNames: () => [],
				modelRegistry: { authStorage: {} },
				getAgentId: () => undefined,
			},
			sessionManager: {
				getHeader: () => undefined,
				getStorage: () => storage,
				getSessionFile: () => parentFile,
				getCwd: () => dir.path(),
				getSessionDir: () => dir.path(),
				getArtifactsDir: () => parentArtifactsDir,
				getSessionId: () => "parent-session",
				ensureOnDisk: async () => {},
				flush: async () => {},
			},
			settings: Settings.isolated(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
			rebuildChatFromMessages: vi.fn(),
		} as unknown as InteractiveModeContext;

		expect(await new TanCommandController(ctx).start("follow the tangent")).toBe(false);

		if (!cloneArtifact || !clone) throw new Error("dispatch never reached job registration");
		expect(deleteSpy).toHaveBeenCalled();
		expect(fs.existsSync(path.dirname(cloneArtifact))).toBe(false);
		expect(isSessionLeaseHeld(clone.getSessionId())).toBe(false);
		expect(await storage.exists(parentFile)).toBe(true);
	});
});
