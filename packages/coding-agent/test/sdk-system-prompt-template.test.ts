import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { CONFIG_DIR_NAME, TempDir } from "@oh-my-pi/pi-utils";

type SystemPromptOption = string | string[] | ((defaultPrompt: string[]) => string | string[]);
type ExplicitSystemPromptOptions = Pick<CreateAgentSessionOptions, "systemPromptTemplate" | "customSystemPrompt">;

async function withSession<T>(
	nativeTemplate: string,
	systemPrompt: SystemPromptOption,
	fn: (session: AgentSession) => Promise<T>,
	explicitSystemPromptOptions: ExplicitSystemPromptOptions = {},
): Promise<T> {
	using tempDir = TempDir.createSync("@omp-sdk-system-prompt-template-");
	const cwd = tempDir.join("project");
	await Bun.write(path.join(cwd, CONFIG_DIR_NAME, "SYSTEM_TEMPLATE.md"), nativeTemplate);

	const authStorage = await AuthStorage.create(":memory:");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	let session: AgentSession | undefined;
	try {
		const result = await createAgentSession({
			cwd,
			agentDir: tempDir.join("agent"),
			authStorage,
			modelRegistry,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(cwd),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			systemPrompt,
			...explicitSystemPromptOptions,
		});
		session = result.session;
		return await fn(session);
	} finally {
		try {
			await session?.dispose();
		} finally {
			authStorage.close();
		}
	}
}

describe("SDK systemPrompt replacements", () => {
	it("uses a fixed string without loading a malformed native template", async () => {
		const fixedPrompt = "sdk fixed prompt";
		await withSession("{{#if eagerTasks}}", fixedPrompt, async session => {
			expect(session.systemPrompt).toEqual([fixedPrompt]);
		});
	});

	it("uses fixed prompt blocks without loading an empty native template", async () => {
		const fixedPrompt = ["sdk fixed block one", "sdk fixed block two"];
		await withSession(" \n\t", fixedPrompt, async session => {
			expect(session.systemPrompt).toEqual(fixedPrompt);
		});
	});

	it("rejects conflicting explicit template and literal with a fixed string", async () => {
		await expect(
			withSession("{{#if eagerTasks}}", "sdk fixed prompt", async () => undefined, {
				systemPromptTemplate: "explicit {{model}}",
				customSystemPrompt: "explicit literal",
			}),
		).rejects.toThrow("systemPromptTemplate cannot be combined with a literal custom system prompt");
	});

	it("rejects conflicting empty explicit inputs with empty fixed prompt blocks", async () => {
		await expect(
			withSession("{{#if eagerTasks}}", [], async () => undefined, {
				systemPromptTemplate: "",
				customSystemPrompt: "",
			}),
		).rejects.toThrow("systemPromptTemplate cannot be combined with a literal custom system prompt");
	});

	it("keeps callback prompts on the generated-template path", async () => {
		let callbackCalled = false;
		await expect(
			withSession(
				"{{#if eagerTasks}}",
				defaultPrompt => {
					callbackCalled = true;
					return defaultPrompt;
				},
				async () => undefined,
			),
		).rejects.toThrow("Invalid system prompt template");
		expect(callbackCalled).toBe(false);
	});
});
