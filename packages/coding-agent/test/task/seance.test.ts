import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { sessionDirForCwd } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { resolveSeanceSource, restoreSeanceSession } from "@oh-my-pi/pi-coding-agent/task/seance";
import { getAgentDir, getSessionsDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

function sessionHeader(id: string, cwd: string) {
	return {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-10-01T00:00:00.000Z",
		cwd,
	};
}

function modelChange(id: string, parentId: string | null, model: string, role: string) {
	return {
		type: "model_change",
		id,
		parentId,
		timestamp: "2026-10-01T00:00:01.000Z",
		model,
		role,
	};
}

function modelUsage(id: string, parentId: string, activeLeafId: string | null) {
	return {
		type: "model_usage",
		id,
		parentId,
		timestamp: "2026-10-01T00:00:02.000Z",
		purpose: "task-completion-probe",
		role: "smol",
		api: "openai-completions",
		provider: "openai",
		model: "gpt-4o",
		usage: {
			input: 11,
			output: 2,
			cacheRead: 3,
			cacheWrite: 0,
			totalTokens: 16,
			cost: { input: 0.0011, output: 0.0004, cacheRead: 0.00003, cacheWrite: 0, total: 0.00153 },
		},
		stopReason: "stop",
		activeLeafId,
	};
}

async function writeSession(file: string, id: string, cwd: string, entries: unknown[] = []): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, `${[sessionHeader(id, cwd), ...entries].map(entry => JSON.stringify(entry)).join("\n")}\n`);
}

/** Point the agent dir (and so every project's session bucket) at a temp root for one test. */
async function withAgentDir<T>(agentDir: string, fn: () => Promise<T>): Promise<T> {
	const originalAgentDir = getAgentDir();
	const originalAgentDirOverride = process.env.PI_CODING_AGENT_DIR;
	setAgentDir(agentDir);
	try {
		return await fn();
	} finally {
		if (originalAgentDirOverride !== undefined) {
			setAgentDir(originalAgentDirOverride);
		} else {
			setAgentDir(originalAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("seance source resolution", () => {
	it("resolves paths and stored IDs to read-only source metadata with the active model and default fallback", async () => {
		using tempDir = TempDir.createSync("@omp-seance-source-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const file = path.join(sessionDir, "saved.jsonl");
		await writeSession(file, "saved-source-id", cwd, [
			modelChange("default-model", null, "anthropic/claude-sonnet-4-5", "default"),
			modelChange("active-model", "default-model", "anthropic/claude-sonnet-4-6", "fast"),
		]);
		const original = await fs.readFile(file);
		const options = { cwd, sessionDirHint: sessionDir };

		await expect(resolveSeanceSource(file, options)).resolves.toEqual({
			file,
			id: "saved-source-id",
			modelSelectors: ["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-5"],
		});
		await expect(resolveSeanceSource("saved-source-id", options)).resolves.toEqual({
			file,
			id: "saved-source-id",
			modelSelectors: ["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-5"],
		});
		expect(await fs.readFile(file)).toEqual(original);
	});

	it("restores the model from the active branch after late usage and returns no models for a null active leaf", async () => {
		using tempDir = TempDir.createSync("@omp-seance-active-model-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const file = path.join(sessionDir, "late-usage.jsonl");
		const entries = [
			modelChange("default-model", null, "anthropic/claude-sonnet-4-5", "default"),
			modelChange("probe-owner", "default-model", "openai/gpt-4o", "fast"),
			modelChange("active-model", "default-model", "anthropic/claude-sonnet-4-6", "fast"),
			modelUsage("late-usage", "probe-owner", "active-model"),
		];
		await writeSession(file, "active-model-source", cwd, entries);
		await expect(resolveSeanceSource(file, { cwd, sessionDirHint: sessionDir })).resolves.toMatchObject({
			id: "active-model-source",
			modelSelectors: ["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-5"],
		});

		const clearedFile = path.join(sessionDir, "cleared-usage.jsonl");
		await writeSession(clearedFile, "cleared-model-source", cwd, [
			...entries.slice(0, 3),
			modelUsage("cleared-usage", "probe-owner", null),
		]);
		await expect(resolveSeanceSource(clearedFile, { cwd, sessionDirHint: sessionDir })).resolves.toMatchObject({
			id: "cleared-model-source",
			modelSelectors: [],
		});
	});

	it("fails closed for missing paths and IDs, ambiguous prefixes, and files without a session header", async () => {
		using tempDir = TempDir.createSync("@omp-seance-source-invalid-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const options = { cwd, sessionDirHint: sessionDir };
		await writeSession(path.join(sessionDir, "first.jsonl"), "ambiguous-first", cwd);
		await writeSession(path.join(sessionDir, "second.jsonl"), "ambiguous-second", cwd);
		const malformedFile = path.join(sessionDir, "malformed.jsonl");
		await Bun.write(malformedFile, `${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION })}\n`);

		await expect(resolveSeanceSource(path.join(sessionDir, "missing.jsonl"), options)).rejects.toThrow(
			"The selected session file was not found or could not be accessed.",
		);
		await expect(resolveSeanceSource("not-present", options)).rejects.toThrow('Session "not-present" was not found.');
		await expect(resolveSeanceSource("ambiguous", options)).rejects.toThrow(
			'Session selector "ambiguous" is ambiguous.',
		);
		await expect(resolveSeanceSource(malformedFile, options)).rejects.toThrow(
			"The selected file does not contain a valid session header.",
		);
	});

	it("leaves orphaned backups untouched during local source ID lookup", async () => {
		using tempDir = TempDir.createSync("@omp-seance-read-only-source-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const orphanFile = path.join(sessionDir, "orphan.jsonl");
		const backupFile = `${orphanFile}.1700000000000.bak`;
		await writeSession(sourceFile, "source-id", cwd);
		await writeSession(backupFile, "orphan-id", cwd);
		const originalBackup = await fs.readFile(backupFile);

		await expect(resolveSeanceSource("source-id", { cwd, sessionDirHint: sessionDir })).resolves.toMatchObject({
			file: sourceFile,
			id: "source-id",
		});
		expect(await fs.readFile(backupFile)).toEqual(originalBackup);
		await expect(fs.stat(orphanFile)).rejects.toThrow();
	});

	it("rejects ambiguous duplicate IDs among nested artifact histories", async () => {
		using tempDir = TempDir.createSync("@omp-seance-nested-ambiguity-");
		const cwd = path.join(tempDir.path(), "project");
		const artifactsDir = path.join(tempDir.path(), "artifacts");
		await writeSession(path.join(artifactsDir, "history-one", "worker.jsonl"), "worker-id", cwd);
		await writeSession(path.join(artifactsDir, "history-two", "worker.jsonl"), "worker-id", cwd);

		await expect(resolveSeanceSource("worker", { cwd, artifactsDirHint: artifactsDir })).rejects.toThrow(
			'Session selector "worker" is ambiguous.',
		);
	});

	it("prefers a direct artifact child over a nested history with the same ID", async () => {
		using tempDir = TempDir.createSync("@omp-seance-direct-child-");
		const cwd = path.join(tempDir.path(), "project");
		const artifactsDir = path.join(tempDir.path(), "artifacts");
		const directFile = path.join(artifactsDir, "worker.jsonl");
		await writeSession(directFile, "worker-id", cwd);
		await writeSession(path.join(artifactsDir, "history", "worker.jsonl"), "worker-id", cwd);

		await expect(resolveSeanceSource("worker", { cwd, artifactsDirHint: artifactsDir })).resolves.toMatchObject({
			file: directFile,
			id: "worker-id",
		});
	});

	it("finds an id stored only in another project only when global lookup is requested", async () => {
		using tempDir = TempDir.createSync("@omp-seance-global-lookup-");
		await withAgentDir(path.join(tempDir.path(), "agent"), async () => {
			const cwd = path.join(tempDir.path(), "project");
			const otherCwd = path.join(tempDir.path(), "other-project");
			const foreignFile = path.join(sessionDirForCwd(otherCwd), "foreign.jsonl");
			await writeSession(foreignFile, "foreign-project-id", otherCwd);

			await expect(resolveSeanceSource("foreign-project-id", { cwd })).rejects.toThrow(
				'Session "foreign-project-id" was not found.',
			);
			await expect(resolveSeanceSource("foreign-project-id", { cwd, includeGlobal: true })).resolves.toMatchObject({
				file: foreignFile,
				id: "foreign-project-id",
			});
		});
	});

	it("expands a home-relative source path", async () => {
		using tempDir = TempDir.createSync("@omp-seance-home-path-");
		const home = path.join(tempDir.path(), "home");
		vi.spyOn(os, "homedir").mockReturnValue(home);
		const file = path.join(home, "saved", "home-source.jsonl");
		await writeSession(file, "home-source-id", home);

		const resolved = await resolveSeanceSource("~/saved/home-source.jsonl", {
			cwd: path.join(tempDir.path(), "project"),
		});
		expect(path.resolve(resolved.file)).toBe(file);
		expect(resolved.id).toBe("home-source-id");
	});

	it("does not create a default session bucket or migrate legacy directories on unhinted lookup", async () => {
		using tempDir = TempDir.createSync("@omp-seance-unhinted-read-only-");
		await withAgentDir(path.join(tempDir.path(), "agent"), async () => {
			const cwd = path.join(tempDir.path(), "project");
			const sessionsRoot = getSessionsDir();
			const defaultSessionDir = sessionDirForCwd(cwd);
			const homeEncoded = os
				.homedir()
				.replace(/^[/\\]/, "")
				.replace(/[/\\:]/g, "-");
			const legacyDir = path.join(sessionsRoot, `--${homeEncoded}-seance-readonly-probe--`);
			const migratedLegacyDir = path.join(sessionsRoot, "-seance-readonly-probe");
			const backupFile = path.join(legacyDir, "orphan.jsonl.1700000000000.bak");
			await writeSession(backupFile, "orphan-id", cwd);
			const originalBackup = await fs.readFile(backupFile);

			const sourceFile = path.join(defaultSessionDir, "source.jsonl");
			await writeSession(sourceFile, "source-id", cwd);
			await expect(resolveSeanceSource("source-id", { cwd })).resolves.toMatchObject({
				file: sourceFile,
				id: "source-id",
			});

			const emptyCwd = path.join(tempDir.path(), "empty-project");
			const emptySessionDir = sessionDirForCwd(emptyCwd);
			await expect(fs.stat(emptySessionDir)).rejects.toThrow();
			await expect(
				resolveSeanceSource("missing-unhinted-source", { cwd: emptyCwd, includeGlobal: true }),
			).rejects.toThrow('Session "missing-unhinted-source" was not found.');
			await expect(fs.stat(emptySessionDir)).rejects.toThrow();
			expect(await fs.readFile(backupFile)).toEqual(originalBackup);
			expect((await fs.stat(legacyDir)).isDirectory()).toBe(true);
			await expect(fs.stat(migratedLegacyDir)).rejects.toThrow();
		});
	});
});

describe("seance cold restore", () => {
	it("revives with whichever bundled read-only tools were persisted and refuses a contract without read", async () => {
		const authStorage = await AuthStorage.create(":memory:");
		try {
			authStorage.keys.setRuntime("anthropic", "test-key");
			const modelRegistry = new ModelRegistry(authStorage);
			using tempDir = TempDir.createSync("@omp-seance-restore-");
			const cwd = tempDir.path();
			const init = {
				systemPrompt: ["restricted seance prompt"],
				task: "Read the source transcript.",
				// `glob.enabled: false` trimmed glob at spawn; `write` never belongs to a seance.
				tools: ["read", "grep", "write", "yield"],
				agent: "seance",
				resolvedModel: "anthropic/claude-sonnet-4-5",
				restrictToolNames: true,
				spawns: "",
			};

			await expect(restoreSeanceSession({ init, cwd, modelRegistry })).resolves.toEqual({
				cwd,
				modelPattern: "anthropic/claude-sonnet-4-5",
				toolNames: ["read", "grep", "yield"],
			});
			await expect(
				restoreSeanceSession({ init: { ...init, tools: ["grep", "glob", "yield"] }, cwd, modelRegistry }),
			).resolves.toBeUndefined();
		} finally {
			authStorage.close();
		}
	});
});
