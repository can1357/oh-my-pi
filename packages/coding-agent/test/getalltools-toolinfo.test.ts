import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function createTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: name }] };
		},
	};
}

describe("AgentSession.getAllToolInfos", () => {
	it("returns ToolInfo objects with sourceInfo so upstream-pi extensions read sourceInfo.source", async () => {
		const tempDir = TempDir.createSync("@getalltools-toolinfo-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const settings = Settings.isolated({ "compaction.enabled": false });
		const model = buildModel({
			id: "mock",
			name: "mock",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		});
		const read = createTool("read");
		const custom = createTool("my_ext_tool");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [read] },
			streamFn: createMockModel({ responses: [{ content: ["ok"] }] }).stream,
		});
		// `read` is a built-in; `my_ext_tool` is registered without being marked
		// built-in, so it must classify as an extension-sourced tool.
		const toolRegistry = new Map<string, AgentTool>([
			[read.name, read],
			[custom.name, custom],
		]);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			toolRegistry,
			builtInToolNames: [read.name],
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [toolNames.join(",")] }),
		});

		try {
			const allTools = session.getAllToolInfos();
			const byName = new Map(allTools.map(t => [t.name, t]));

			expect(byName.get("read")?.sourceInfo.source).toBe("builtin");
			expect(byName.get("my_ext_tool")?.sourceInfo.source).toBe("extension");
			// ToolInfo carries schema + description, not just a name.
			expect(byName.get("read")?.description).toBe("read tool");
			expect(byName.get("read")?.parameters).toBeDefined();

			// gentle-pi's startup-banner.ts filter must not throw and must treat
			// only non-builtin/non-sdk tools as "custom".
			const customTools = allTools.filter(t => !["builtin", "sdk"].includes(t.sourceInfo.source));
			expect(customTools.map(t => t.name)).toEqual(["my_ext_tool"]);
			expect(byName.get("my_ext_tool")?.sourceInfo.path).toBe("<extension:my_ext_tool>");
		} finally {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		}
	});

	it("reports the originating custom-tool file path instead of a synthetic stub", async () => {
		const tempDir = TempDir.createSync("@getalltools-sourcepath-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const settings = Settings.isolated({ "compaction.enabled": false });
		const model = buildModel({
			id: "mock",
			name: "mock",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		});
		const custom = createTool("git");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [custom] },
			streamFn: createMockModel({ responses: [{ content: ["ok"] }] }).stream,
		});
		const sourcePath = "/tmp/tools/git.ts";
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			toolRegistry: new Map<string, AgentTool>([[custom.name, custom]]),
			builtInToolNames: [],
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [toolNames.join(",")] }),
			extensionRunner: {
				getRegisteredTool: (name: string) =>
					name === "git"
						? {
								extensionPath: "<inline-0>",
								definition: { sourcePath },
							}
						: undefined,
			} as never,
		});

		try {
			const info = session.getAllToolInfos().find(tool => tool.name === "git");
			expect(info?.sourceInfo.source).toBe("extension");
			expect(info?.sourceInfo.path).toBe(sourcePath);
		} finally {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		}
	});
});
