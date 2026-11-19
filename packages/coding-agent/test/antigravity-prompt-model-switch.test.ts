import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ANTIGRAVITY_CLI_SYSTEM_PROMPT } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Antigravity's account tier answers omp's default prompt with
// RESOURCE_EXHAUSTED (429), so a switch onto an antigravity-cli model must
// replace the active prompt before the next request — including when the Model
// line is hidden, where the model key alone would not change.
describe("antigravity-cli prompt profile across model switches", () => {
	const google = getBundledModel("google", "gemini-3-pro-preview");
	const antigravity = getBundledModel("antigravity-cli", "gemini-4-hydrogen");
	let dir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		dir = path.join(os.tmpdir(), `pi-antigravity-prompt-switch-${Snowflake.next()}`);
		await fs.mkdir(dir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		authStorage.keys.setRuntime("google", "test-key");
		authStorage.keys.setRuntime("antigravity-cli", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		await removeWithRetries(dir);
	});

	async function providerPrompt(session: AgentSession): Promise<string> {
		const context = await session.agent.buildSideRequestContext([]);
		return (context.systemPrompt ?? []).join("\n\n");
	}

	for (const includeModelInPrompt of [true, false]) {
		it(`replaces the prompt on a switch onto antigravity-cli and restores it on the way back (includeModelInPrompt=${includeModelInPrompt})`, async () => {
			const { session } = await createAgentSession({
				cwd: dir,
				agentDir: dir,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ includeModelInPrompt }),
				model: google,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				toolNames: ["read", "write", "edit", "bash", "grep", "glob"],
			});
			sessions.push(session);

			const onGoogle = await providerPrompt(session);
			expect(onGoogle).toContain("You are omp's trusted coding assistant.");
			expect(onGoogle).toContain("# Internal URLs");

			await session.setModel(antigravity);
			const onAntigravity = await providerPrompt(session);
			expect(onAntigravity).toContain(ANTIGRAVITY_CLI_SYSTEM_PROMPT);
			expect(onAntigravity).not.toContain("You are omp's trusted coding assistant.");
			expect(onAntigravity).not.toContain("# Internal URLs");
			expect(onAntigravity).not.toContain("# xd:// Tool Devices");
			// Built-in coding tools survive the profile switch.
			const toolNames = session.agent.state.tools.map(tool => tool.name);
			expect(toolNames).toEqual(expect.arrayContaining(["read", "write", "edit", "bash", "grep", "glob"]));

			await session.setModel(google);
			const back = await providerPrompt(session);
			expect(back).toContain("You are omp's trusted coding assistant.");
			expect(back).not.toContain(ANTIGRAVITY_CLI_SYSTEM_PROMPT);
		}, 20_000);
	}
});
