import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { releaseSharpshooterSession, sharpshooterBackend } from "@oh-my-pi/pi-coding-agent/sharpshooter/backend";
import { flushSharpshooterExtraction } from "@oh-my-pi/pi-coding-agent/sharpshooter/extract";
import { sharpshooterBankDir, writeSharpshooterState } from "@oh-my-pi/pi-coding-agent/sharpshooter/paths";
import { listSharpshooterDeltas } from "@oh-my-pi/pi-coding-agent/sharpshooter/queue";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(name: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
	tempDirs.push(dir);
	return dir;
}

describe("sharpshooter memory backend", () => {
	it("resolves from the memory.backend setting", async () => {
		const settings = Settings.isolated({ "memory.backend": "sharpshooter" });
		expect(await resolveMemoryBackend(settings)).toBe(sharpshooterBackend);
	});

	it("persists a trailing prompt's decision at startup but not on a cwd rebind", async () => {
		// Startup can race the first turn, so a transcript already ending in a user
		// prompt has to be caught up. A rebind is the opposite case: after `/move`
		// that trailing prompt belongs to the project the session left, and an
		// interrupted or failed turn is enough to leave the transcript in that shape.
		const agentDir = await makeTempDir("sharpshooter-catchup-agent");
		const cwd = await makeTempDir("sharpshooter-catchup-cwd");
		const model = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!model) throw new Error("Expected bundled Claude Haiku model");
		const settings = Settings.isolated({
			"memory.backend": "sharpshooter",
			"sharpshooter.model": `${model.provider}/${model.id}`,
		});
		const session = {
			isDisposed: false,
			sessionId: "session-catchup",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Keep the cyan status indicator and never replace it with magenta." }],
					timestamp: Date.now(),
				},
			],
			subscribe: () => () => {},
			sessionManager: { getCwd: () => cwd } as unknown as SessionManager,
		} as unknown as AgentSession;
		const options = {
			session,
			settings,
			modelRegistry: {
				getAll: () => [model],
				getAvailable: () => [model],
				resolver: () => async () => "test-key",
			} as unknown as ModelRegistry,
			agentDir,
			taskDepth: 0,
		};
		// The scheduler's immediate tick would consolidate the delta this test reads.
		await writeSharpshooterState(agentDir, cwd, { v: 1, lastConsolidatedAt: Date.now() });
		const completion = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-record",
					name: "record_deltas",
					arguments: {
						deltas: [
							{
								kind: "style_decision",
								statement: "Status indicator stays cyan rather than magenta.",
								source: "explicit_user",
								evidence: "cyan status indicator",
								friction: { corrective: false, regression: false, subtle: false },
							},
						],
					},
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-haiku-4-5",
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});

		sharpshooterBackend.start({ ...options, reason: "rebind" });
		await flushSharpshooterExtraction(session);
		expect(completion).not.toHaveBeenCalled();
		expect(await listSharpshooterDeltas(agentDir, cwd)).toHaveLength(0);
		releaseSharpshooterSession(session);

		sharpshooterBackend.start(options);
		await flushSharpshooterExtraction(session);
		const groups = await listSharpshooterDeltas(agentDir, cwd);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.deltas[0]?.delta.statement).toBe("Status indicator stays cyan rather than magenta.");

		releaseSharpshooterSession(session);
	});

	it("injects only populated project decision files", async () => {
		const root = await makeTempDir("sharpshooter-backend");
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "project");
		await fs.mkdir(cwd, { recursive: true });
		const settings = Settings.isolated({
			"memory.backend": "sharpshooter",
			"sharpshooter.injectionTokenLimit": 2400,
		});

		await expect(sharpshooterBackend.buildDeveloperInstructions(agentDir, cwd, settings)).resolves.toBeUndefined();

		const bankDir = sharpshooterBankDir(agentDir, cwd);
		await fs.mkdir(bankDir, { recursive: true });
		await Promise.all([
			Bun.write(path.join(bankDir, "architecture.md"), "- Keep storage project-scoped.\n"),
			Bun.write(path.join(bankDir, "product.md"), "- Prefer explicit user controls.\n"),
			Bun.write(path.join(bankDir, "style.md"), "- Keep output concise.\n"),
		]);

		const instructions = await sharpshooterBackend.buildDeveloperInstructions(agentDir, cwd, settings);
		expect(instructions).toContain("## architecture");
		expect(instructions).toContain("## product");
		expect(instructions).toContain("## style");
	});

	it("dispatches ACP queue and sync commands to backend hooks", async () => {
		const cwd = await makeTempDir("sharpshooter-acp-project");
		const settings = Settings.isolated({ "memory.backend": "sharpshooter" });
		const session = { settings } as AgentSession;
		const output: string[] = [];
		const queuePreview = spyOn(sharpshooterBackend, "queuePreview").mockResolvedValue("Pending delta");
		const enqueue = spyOn(sharpshooterBackend, "enqueue").mockResolvedValue(undefined);
		const runtime = {
			session,
			sessionManager: {} as SessionManager,
			settings,
			cwd,
			output: (text: string) => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		} satisfies SlashCommandRuntime;

		await executeAcpBuiltinSlashCommand("/memory queue", runtime);
		await executeAcpBuiltinSlashCommand("/memory sync", runtime);

		expect(queuePreview).toHaveBeenCalledWith({ agentDir: settings.getAgentDir(), cwd, session });
		expect(enqueue).toHaveBeenCalledWith(settings.getAgentDir(), cwd, session);
		expect(output).toEqual(["Pending delta", "Memory consolidation ran."]);
	});
});
