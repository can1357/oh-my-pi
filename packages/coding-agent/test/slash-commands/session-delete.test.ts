import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { readSessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

/**
 * `/session delete` outside the TUI (RPC/ACP share `executeAcpBuiltinSlashCommand`)
 * must detach the live session before removing its file. Deleting the file while
 * the session still points at it leaves `get_state` reporting the deleted path,
 * and the next turn resurrects a headerless file that resume rejects
 * ("session header is missing or malformed", #18665).
 */
describe("/session delete detaches the live session (issue #18665)", () => {
	let tempDir = "";
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		authStorage?.close();
		authStorage = undefined;
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
		tempDir = "";
	});

	async function startSession() {
		tempDir = path.join(os.tmpdir(), `pi-session-delete-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		const sessionDir = path.join(tempDir, "sessions");

		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
			"async.enabled": false,
		});
		const sessionManager = SessionManager.create(tempDir, sessionDir);
		const mock = createMockModel({
			responses: [{ content: ["one"] }, { content: ["two"] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
			toolRegistry: new Map(),
		});

		const output: string[] = [];
		let titleNotifications = 0;
		const runtime = {
			session,
			sessionManager: session.sessionManager,
			settings,
			cwd: tempDir,
			output: (text: string) => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
			notifyTitleChanged: () => {
				titleNotifications += 1;
			},
		} as unknown as SlashCommandRuntime;
		return { session, runtime, output, titleNotifications: () => titleNotifications };
	}

	it("rotates the session identity and the next turn writes a resumable file", async () => {
		const { session, runtime, output, titleNotifications } = await startSession();
		try {
			await session.prompt("Reply with the single word: one");
			await session.flushToDisk();
			const oldFile = session.sessionFile;
			const oldId = session.sessionManager.getSessionId();
			if (!oldFile) throw new Error("expected the first turn to persist a session file");
			expect(fs.existsSync(oldFile)).toBe(true);

			const result = await executeAcpBuiltinSlashCommand("/session delete", runtime);
			expect(result).toEqual({ consumed: true });
			expect(fs.existsSync(oldFile)).toBe(false);
			expect(output.join("\n")).toContain(`Session deleted: ${oldFile}`);

			// get_state reads these live: they must no longer point at the deleted path.
			const newFile = session.sessionFile;
			const newId = session.sessionManager.getSessionId();
			expect(newFile).toBeDefined();
			expect(newFile).not.toBe(oldFile);
			expect(newId).not.toBe(oldId);
			expect(titleNotifications()).toBe(1);

			await session.prompt("Reply with the single word: two");
			await session.flushToDisk();

			// The deleted path stays gone: the turn must not resurrect it.
			expect(fs.existsSync(oldFile)).toBe(false);
			if (!newFile) throw new Error("expected a successor session file");
			expect(fs.existsSync(newFile)).toBe(true);
			// The on-disk layout leads with a title slot; the session header
			// follows it (same as any fresh file). The #18665 failure mode was a
			// file with no session line at all.
			const records = fs
				.readFileSync(newFile, "utf8")
				.split("\n")
				.filter(line => line.length > 0)
				.map(line => JSON.parse(line) as { type?: string; id?: string });
			expect(records.length).toBeGreaterThan(2);
			expect(records.find(record => record.type === "session")?.id).toBe(newId);
			// The resume picker accepts the successor file (a headerless
			// resurrection would be skipped as "not a session").
			const info = await readSessionInfo(newFile);
			expect(info?.id).toBe(newId);
		} finally {
			await session.dispose();
		}
	});

	it("refuses to delete while streaming", async () => {
		const { session, runtime, output } = await startSession();
		// Hold a real turn open: delayMs stalls the mock stream before its first
		// event, so isStreaming is live state rather than a stubbed flag. The
		// delay honors the prompt's abort, so the turn settles on abort.
		session.agent.streamFn = createMockModel({ responses: [{ content: ["late"], delayMs: 60_000 }] }).stream;
		const admitted = Promise.withResolvers<void>();
		const flight = session.prompt("never resolves in time", { onPromptAdmitted: () => admitted.resolve() });
		try {
			// The admission callback is the turn's own signal: no wall-clock guess.
			await admitted.promise;
			const result = await executeAcpBuiltinSlashCommand("/session delete", runtime);
			expect(result).toEqual({ consumed: true, failed: true });
			expect(output.join("\n")).toContain("Cannot delete the session while streaming.");
		} finally {
			await session.abort();
			await flight.catch(() => undefined);
			await session.dispose();
		}
	});
});
