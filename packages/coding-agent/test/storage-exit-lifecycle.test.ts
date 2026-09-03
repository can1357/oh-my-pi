import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let tempDir = "";
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const HISTORY_STORAGE_MODULE = path.resolve(import.meta.dir, "../src/session/history-storage.ts");
const AGENT_STORAGE_MODULE = path.resolve(import.meta.dir, "../src/session/agent-storage.ts");

async function freshStorage(prefix = "omp-history-write-through-"): Promise<HistoryStorage> {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	const dbPath = path.join(tempDir, "history.db");
	HistoryStorage.close();
	return HistoryStorage.open(dbPath);
}

beforeEach(() => {
	HistoryStorage.close();
});

afterEach(async () => {
	HistoryStorage.close();
	if (tempDir) {
		await removeWithRetries(tempDir).catch(() => {});
		tempDir = "";
	}
});

/**
 * Prompt submission is human-paced, so history writes through synchronously:
 * every accepted prompt is durable the moment `add()` resolves, with no batch
 * window a fast exit could race.
 */
describe("HistoryStorage write-through", () => {
	it("persists each submitted prompt without waiting on a timer", async () => {
		const storage = await freshStorage();
		await storage.add("first prompt");
		await storage.add("second prompt");
		await storage.add("third prompt");

		expect(storage.getRecent(10).map(r => r.prompt)).toEqual(["third prompt", "second prompt", "first prompt"]);
	});

	it("replaces provenance when the same prompt is resubmitted", async () => {
		const storage = await freshStorage();
		await storage.add("repeat", "/first", "session-a");
		await storage.add("repeat", "/second", "session-b");

		const entries = storage.getRecent(10);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ prompt: "repeat", cwd: "/second", sessionId: "session-b" });
	});
});

describe("storage process-exit cleanup", () => {
	it("persists a synchronous prompt and flushes the deferred perf sample before a hard exit", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-storage-exit-"));
		const historyDbPath = path.join(tempDir, "history.db");
		const agentDbPath = path.join(tempDir, "agent.db");
		const historyModule = HISTORY_STORAGE_MODULE;
		const agentModule = AGENT_STORAGE_MODULE;
		const script = [
			`import { HistoryStorage } from ${JSON.stringify(historyModule)};`,
			`import { AgentStorage } from ${JSON.stringify(agentModule)};`,
			`const history = HistoryStorage.open(${JSON.stringify(historyDbPath)});`,
			`const agent = await AgentStorage.open(${JSON.stringify(agentDbPath)});`,
			'void history.add("written immediately before exit", "/tmp", "exit-session");',
			'void agent.recordModelPerf("openai/repro", { outputTokens: 10, durationMs: 1000 });',
			"process.exit(0);",
		].join("\n");
		const child = Bun.spawn([process.execPath, "--eval", script], {
			cwd: REPO_ROOT,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(exitCode, stderr).toBe(0);
		const historyCheckpoint = path.join(tempDir, "history-checkpoint.db");
		const agentCheckpoint = path.join(tempDir, "agent-checkpoint.db");
		await Promise.all([
			Bun.write(historyCheckpoint, Bun.file(historyDbPath)),
			Bun.write(agentCheckpoint, Bun.file(agentDbPath)),
		]);

		// Read copies of the main database files without their WALs. Both rows are
		// visible only if process-exit cleanup flushed the deferred perf batch and
		// checkpointed committed frames into the main file.
		// Writable open: SQLite rejects read-only access to a WAL-mode file with no
		// -shm/-wal beside it; the copies still expose only main-file content.
		const historyDb = new Database(historyCheckpoint);
		const agentDb = new Database(agentCheckpoint);
		try {
			expect(historyDb.query<{ prompt: string }, []>("SELECT prompt FROM history").get()).toEqual({
				prompt: "written immediately before exit",
			});
			expect(
				agentDb
					.query<{ samples: number; output_tokens: number; gen_ms: number }, []>(
						"SELECT samples, output_tokens, gen_ms FROM model_perf WHERE model_key = 'openai/repro'",
					)
					.get(),
			).toEqual({ samples: 1, output_tokens: 10, gen_ms: 1000 });
		} finally {
			historyDb.close();
			agentDb.close();
		}
	});

	it("keeps stores opened after manual postmortem cleanup usable", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-storage-late-open-"));
		const historyDbPath = path.join(tempDir, "history.db");
		const agentDbPath = path.join(tempDir, "agent.db");
		const script = [
			'import { postmortem } from "@oh-my-pi/pi-utils";',
			`import { HistoryStorage } from ${JSON.stringify(HISTORY_STORAGE_MODULE)};`,
			`import { AgentStorage } from ${JSON.stringify(AGENT_STORAGE_MODULE)};`,
			"await postmortem.cleanup();",
			`const history = HistoryStorage.open(${JSON.stringify(historyDbPath)});`,
			'void history.add("opened after cleanup", "/tmp", "late-session");',
			"HistoryStorage.close();",
			`const reopenedHistory = HistoryStorage.open(${JSON.stringify(historyDbPath)});`,
			"const prompts = reopenedHistory.getRecent(10).map(row => row.prompt);",
			"HistoryStorage.close();",
			`const agent = await AgentStorage.open(${JSON.stringify(agentDbPath)});`,
			'agent.recordCommandUsage("after-cleanup");',
			"const commands = agent.listCommandUsage();",
			"AgentStorage.close();",
			"console.log(JSON.stringify({ prompts, commands }));",
		].join("\n");
		const child = Bun.spawn([process.execPath, "--eval", script], {
			cwd: REPO_ROOT,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		expect(stdout.trim()).toBe(
			JSON.stringify({ prompts: ["opened after cleanup"], commands: { "after-cleanup": 1 } }),
		);
	});

	it("arms storage opened while a keep-alive cleanup is still running", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-storage-running-cleanup-"));
		const agentDbPath = path.join(tempDir, "agent.db");
		const checkpointed = path.join(tempDir, "agent-checkpoint.db");
		const script = [
			'import { postmortem } from "@oh-my-pi/pi-utils";',
			`import { AgentStorage } from ${JSON.stringify(AGENT_STORAGE_MODULE)};`,
			"const gate = Promise.withResolvers();",
			'postmortem.register("blocker", () => gate.promise);',
			"const cleanup = postmortem.cleanup();",
			// Open while the blocker keeps cleanupStage="running". The exit-only
			// registration must stay armed rather than firing before publication.
			`const agent = await AgentStorage.open(${JSON.stringify(agentDbPath)});`,
			'void agent.recordModelPerf("openai/running", { outputTokens: 30, durationMs: 3000 });',
			"gate.resolve();",
			"await cleanup;",
			"process.exit(0);",
		].join("\n");
		const child = Bun.spawn([process.execPath, "--eval", script], {
			cwd: REPO_ROOT,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(exitCode, stderr).toBe(0);

		// Read the main file without its WAL: only the real-exit callback flushes
		// the deferred sample and checkpoints it into this copy.
		// Writable open: SQLite rejects read-only access to a WAL-mode file with no
		// -shm/-wal beside it; the copy still exposes only main-file content.
		await Bun.write(checkpointed, Bun.file(agentDbPath));
		const agentDb = new Database(checkpointed);
		try {
			expect(
				agentDb
					.query<{ samples: number; output_tokens: number; gen_ms: number }, []>(
						"SELECT samples, output_tokens, gen_ms FROM model_perf WHERE model_key = 'openai/running'",
					)
					.get(),
			).toEqual({ samples: 1, output_tokens: 30, gen_ms: 3000 });
		} finally {
			agentDb.close();
		}
	});

	it("re-arms exit cleanup for a store opened after a manual postmortem cleanup", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-storage-rearm-"));
		const agentDbPath = path.join(tempDir, "agent.db");
		// A manual cleanup keeps the process alive; the store is opened afterward,
		// then only a real exit flushes its deferred perf batch. If postmortem did
		// not re-arm, the exit callback would never fire and the sample would be lost.
		const script = [
			'import { postmortem } from "@oh-my-pi/pi-utils";',
			`import { AgentStorage } from ${JSON.stringify(AGENT_STORAGE_MODULE)};`,
			"await postmortem.cleanup();",
			`const agent = await AgentStorage.open(${JSON.stringify(agentDbPath)});`,
			'void agent.recordModelPerf("openai/rearm", { outputTokens: 20, durationMs: 2000 });',
			"process.exit(0);",
		].join("\n");
		const child = Bun.spawn([process.execPath, "--eval", script], {
			cwd: REPO_ROOT,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(exitCode, stderr).toBe(0);

		const agentDb = new Database(agentDbPath, { readonly: true });
		try {
			expect(
				agentDb
					.query<{ samples: number; output_tokens: number; gen_ms: number }, []>(
						"SELECT samples, output_tokens, gen_ms FROM model_perf WHERE model_key = 'openai/rearm'",
					)
					.get(),
			).toEqual({ samples: 1, output_tokens: 20, gen_ms: 2000 });
		} finally {
			agentDb.close();
		}
	});

	it("keeps a handle held across a manual cleanup usable", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-storage-keepalive-"));
		const agentDbPath = path.join(tempDir, "agent.db");
		// A cached handle (Settings, MCP cache, the editor) survives a keep-alive
		// cleanup that keeps the process running: its statements must not be
		// finalized, so writes through the same handle keep working afterward.
		const script = [
			'import { postmortem } from "@oh-my-pi/pi-utils";',
			`import { AgentStorage } from ${JSON.stringify(AGENT_STORAGE_MODULE)};`,
			`const agent = await AgentStorage.open(${JSON.stringify(agentDbPath)});`,
			'agent.recordCommandUsage("before-cleanup");',
			"await postmortem.cleanup();",
			// Same handle after cleanup: writing here throws if statements were finalized.
			'agent.recordCommandUsage("after-cleanup");',
			"console.log(JSON.stringify(agent.listCommandUsage()));",
			"process.exit(0);",
		].join("\n");
		const child = Bun.spawn([process.execPath, "--eval", script], {
			cwd: REPO_ROOT,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout.trim())).toEqual({ "before-cleanup": 1, "after-cleanup": 1 });
	});
});
