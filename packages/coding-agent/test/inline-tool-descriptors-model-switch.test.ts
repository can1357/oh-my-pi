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
import { removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// `inlineToolDescriptors: auto` inlines descriptors (and strips them from the
// provider schemas) only for Gemini. Switching away mid-session must restore
// schema descriptions, or upstreams that require them reject the request (#14200).
describe("inline tool descriptors across model switches", () => {
	const gemini = getBundledModel("google", "gemini-3-pro-preview");
	const glm = getBundledModel("opencode-go", "glm-5.3-flash");
	let dir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		dir = path.join(os.tmpdir(), `pi-inline-descriptors-switch-${Snowflake.next()}`);
		await fs.mkdir(dir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		authStorage.keys.setRuntime("google", "test-key");
		authStorage.keys.setRuntime("opencode-go", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		await removeWithRetries(dir);
	});

	async function providerView(session: AgentSession) {
		const context = await session.agent.buildSideRequestContext([]);
		const read = context.tools?.find(tool => tool.name === "read");
		if (!read) throw new Error("Missing provider read tool");
		return { readDescription: read.description, prompt: (context.systemPrompt ?? []).join("\n") };
	}

	for (const includeModelInPrompt of [true, false]) {
		it(`re-decides pruning and the prompt catalog per active model (includeModelInPrompt=${includeModelInPrompt})`, async () => {
			const { session } = await createAgentSession({
				cwd: dir,
				agentDir: dir,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ inlineToolDescriptors: "auto", includeModelInPrompt }),
				model: gemini,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				toolNames: ["read"],
			});
			sessions.push(session);

			const onGemini = await providerView(session);
			expect(onGemini.readDescription).toBe("");
			expect(onGemini.prompt).toContain("type read = (");

			await session.setModel(glm);
			const onGlm = await providerView(session);
			expect(onGlm.readDescription).not.toBe("");
			expect(onGlm.prompt).not.toContain("type read = (");

			await session.setModel(gemini);
			const back = await providerView(session);
			expect(back.readDescription).toBe("");
			expect(back.prompt).toContain("type read = (");
		});
	}
	for (const systemPrompt of ["Fixed agent instructions.", ["Fixed agent instructions."]]) {
		it(`restores required descriptions after switching with a fixed ${typeof systemPrompt === "string" ? "string" : "array"} prompt`, async () => {
			const { session } = await createAgentSession({
				cwd: dir,
				agentDir: dir,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ inlineToolDescriptors: "auto" }),
				model: gemini,
				systemPrompt,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				toolNames: ["read"],
			});
			sessions.push(session);

			expect((await providerView(session)).readDescription).toBe("");
			await session.setModel(glm);
			const onGlm = await providerView(session);
			expect(onGlm.readDescription).not.toBe("");

			await session.setModel(gemini);
			expect((await providerView(session)).readDescription).toBe("");
		});
	}
});
